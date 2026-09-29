//! `pay`: invoice validation plus the guard → propose → sign → persist →
//! broadcast pipeline.
//!
//! The invoice is a ZIP-321 URI read from an owner-private file. Its SHA-256
//! (hex, over the exact file bytes, no trimming) is the attempt id. Nothing
//! here prints or returns the URI, the recipient or the raw transaction;
//! errors are fixed strings.

use std::{
    convert::Infallible,
    fmt,
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use nix::unistd::geteuid;
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sovereign_storefront_scanner::config::ScannerParams;
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        WalletRead,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            propose_standard_transfer_to_address,
        },
    },
    fees::StandardFeeRule,
    wallet::OvkPolicy,
};
use zcash_keys::{address::Address, keys::UnifiedSpendingKey};
use zcash_primitives::transaction::components::orchard::bundle_version_for_branch;
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    ShieldedPool,
    consensus::{BlockHeight, BranchId, NetworkType},
    memo::MemoBytes,
    value::Zatoshis,
};
use zip321::TransactionRequest;

use crate::{
    ChainFactory, CommandResult, account_for_seed, chain,
    chain::Broadcast,
    refuse,
    state::{Attempt, StateDir, validate_attempt_id},
};

/// Spendable balance kept back for fees on top of the invoice amount.
pub const FEE_RESERVE_ZAT: u64 = 100_000;
/// Largest invoice this buyer will pay.
pub const MAX_INVOICE_ZAT: u64 = 1_000_000;

const ERR_UNSAFE_FILE: &str = "invoice file permissions are unsafe";
const ERR_READ_FILE: &str = "invoice file could not be read";
const ERR_ATTEMPT_ID: &str = "attempt id does not match the invoice";
const ERR_NOT_REQUEST: &str = "invoice is not a valid payment request";
const ERR_PAYMENT_COUNT: &str = "invoice must contain exactly one payment";
const ERR_RECIPIENT: &str = "invoice recipient is not a testnet unified address";
const ERR_AMOUNT: &str = "invoice amount is out of range";

/// A validated single-payment invoice. `Debug` never prints the recipient
/// or the memo contents.
pub struct Invoice {
    pub address: Address,
    pub amount: Zatoshis,
    pub memo: Option<MemoBytes>,
}

impl fmt::Debug for Invoice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Invoice")
            .field("address", &"<redacted>")
            .field("amount", &u64::from(self.amount))
            .field("memo", &self.memo.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Read the invoice file. It must be a regular file (not a symlink) owned by
/// the effective uid with mode exactly `0600`.
pub fn read_uri_file(path: &Path) -> Result<Vec<u8>, &'static str> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| {
            // O_NOFOLLOW on a symlink yields ELOOP: treat as unsafe.
            if e.raw_os_error() == Some(nix::libc::ELOOP) {
                ERR_UNSAFE_FILE
            } else {
                ERR_READ_FILE
            }
        })?;
    let meta = file.metadata().map_err(|_| ERR_READ_FILE)?;
    if !meta.file_type().is_file()
        || meta.uid() != geteuid().as_raw()
        || meta.mode() & 0o7777 != 0o600
    {
        return Err(ERR_UNSAFE_FILE);
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| ERR_READ_FILE)?;
    Ok(bytes)
}

/// Lowercase hex SHA-256 of the exact invoice bytes (no trimming).
pub fn invoice_digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Validate invoice bytes against the attempt id and the buyer's caps.
pub fn validate_invoice(bytes: &[u8], attempt_id: &str) -> Result<Invoice, &'static str> {
    if invoice_digest(bytes) != attempt_id {
        return Err(ERR_ATTEMPT_ID);
    }
    let uri = std::str::from_utf8(bytes).map_err(|_| ERR_NOT_REQUEST)?;
    let request = TransactionRequest::from_uri(uri).map_err(|_| ERR_NOT_REQUEST)?;

    let payments = request.payments();
    if payments.len() != 1 {
        return Err(ERR_PAYMENT_COUNT);
    }
    let payment = payments.values().next().ok_or(ERR_PAYMENT_COUNT)?;

    let recipient: ZcashAddress = payment.recipient_address().clone();
    let address = recipient
        .convert_if_network::<Address>(NetworkType::Test)
        .map_err(|_| ERR_RECIPIENT)?;
    match &address {
        Address::Unified(ua) if ua.has_orchard() => {}
        _ => return Err(ERR_RECIPIENT),
    }

    let amount = payment.amount().ok_or(ERR_AMOUNT)?;
    let zat = u64::from(amount);
    if !(1..=MAX_INVOICE_ZAT).contains(&zat) {
        return Err(ERR_AMOUNT);
    }

    Ok(Invoice {
        address,
        amount,
        memo: payment.memo().cloned(),
    })
}

/// The frozen `pay` / `rebroadcast` output shape for a recorded attempt.
/// Only the txid, heights and the broadcast word are exposed; never the raw
/// transaction.
pub fn attempt_output(attempt: &Attempt, outcome: Broadcast) -> Value {
    json!({
        "attemptId": attempt.attempt_id,
        "txid": attempt.txid,
        "targetHeight": attempt.target_height,
        "expiryHeight": attempt.expiry_height,
        "broadcast": outcome.as_str(),
    })
}

/// Exit code for a broadcast outcome once the attempt file exists.
pub(crate) fn broadcast_exit(outcome: Broadcast) -> u8 {
    match outcome {
        Broadcast::Accepted => 0,
        Broadcast::Rejected | Broadcast::Unknown => 3,
    }
}

/// Guard: an attempt that already exists is reported from the file with
/// `"broadcast":"unknown"` (exit 4) before any network, wallet or sync work.
pub fn pay_guard(
    state: &StateDir,
    attempt_id: &str,
) -> Result<Option<(Value, u8)>, (u8, &'static str)> {
    validate_attempt_id(attempt_id).map_err(refuse)?;
    Ok(state
        .read_attempt(attempt_id)
        .map_err(refuse)?
        .map(|attempt| (attempt_output(&attempt, Broadcast::Unknown), 4)))
}

/// Runs `pay`. Every error before the attempt file is written is exit 2
/// (nothing broadcast); after it, only exit 0 or 3.
pub async fn pay(
    state: &StateDir,
    chain: &dyn ChainFactory,
    uri_file: &Path,
    attempt_id: &str,
    delta: u32,
) -> CommandResult {
    // 1. Guard, strictly before the chain factory is touched.
    if let Some(recorded) = pay_guard(state, attempt_id)? {
        return Ok(recorded);
    }

    // 2. Invoice and expiry delta.
    let bytes = read_uri_file(uri_file).map_err(refuse)?;
    let invoice = validate_invoice(&bytes, attempt_id).map_err(refuse)?;
    drop(bytes);
    let delta = crate::parse_expiry_delta(Some(&delta.to_string())).map_err(refuse)?;

    // 3. Wallet, account, sync and balance.
    if !state.has_seed().map_err(refuse)? {
        return Err(refuse("wallet is not imported"));
    }
    let seed = state.read_seed().map_err(refuse)?;
    let mut db = state.open_wallet(Some(&seed)).map_err(refuse)?;
    let account = account_for_seed(&db, &seed).map_err(refuse)?;
    let params = ScannerParams::test_network();
    let usk = UnifiedSpendingKey::from_seed(&params, seed.expose_secret(), zip32::AccountId::ZERO)
        .map_err(|_| refuse("spending key cannot be derived"))?;
    drop(seed);
    let cache = state.block_cache().map_err(refuse)?;
    let mut client = chain.connect().await.map_err(refuse)?;
    chain::sync(&mut client, &mut db, &cache, chain::SYNC_BUDGET)
        .await
        .map_err(refuse)?;
    let summary = db
        .get_wallet_summary(ConfirmationsPolicy::default())
        .map_err(|_| refuse("wallet summary cannot be read"))?
        .ok_or(refuse("wallet is not synchronized"))?;
    let spendable = summary
        .account_balances()
        .get(&account)
        .ok_or(refuse("wallet is not synchronized"))?
        .spendable_value()
        .into_u64();
    let amount_zat = u64::from(invoice.amount);
    if spendable < amount_zat.saturating_add(FEE_RESERVE_ZAT) {
        return Err(refuse("insufficient spendable balance"));
    }

    // 4. Proposal.
    let proposal = propose_standard_transfer_to_address::<_, _, Infallible>(
        &mut db,
        &params,
        StandardFeeRule::Zip317,
        account,
        ConfirmationsPolicy::default(),
        &invoice.address,
        invoice.amount,
        invoice.memo,
        None,
        ShieldedPool::Orchard,
        None,
        None,
    )
    .map_err(|_| refuse("payment proposal failed"))?;

    // 5. Warm-up, prove and sign with an explicit expiry.
    let target = BlockHeight::from(proposal.min_target_height());
    let target_height = u32::from(target);
    let expiry_height = target_height
        .checked_add(delta)
        .ok_or(refuse("expiry height is invalid"))?;
    let expiry = BlockHeight::from_u32(expiry_height);
    if let Some(version) = bundle_version_for_branch(
        BranchId::for_height(&params, target),
        orchard::ValuePool::Orchard,
    ) {
        zcash_client_backend::start_orchard_proving_key_warmup(version.circuit_version());
    }
    let prover = LocalTxProver::bundled();
    let txids = {
        // Spending keys live only for the build.
        let spending_keys = SpendingKeys::from_unified_spending_key(usk);
        create_proposed_transactions::<_, _, Infallible, _, Infallible, _>(
            &mut db,
            &params,
            &prover,
            &prover,
            &spending_keys,
            OvkPolicy::Sender,
            &proposal,
            Some(expiry),
        )
        .map_err(|_| refuse("transaction build failed"))?
    };
    if txids.len() != 1 {
        return Err(refuse("proposal produced more than one transaction"));
    }
    let txid = *txids.first();

    // 6. Persist the exact signed bytes before broadcasting.
    let tx = db
        .get_transaction(txid)
        .map_err(|_| refuse("signed transaction cannot be read"))?
        .ok_or(refuse("signed transaction cannot be read"))?;
    if tx.expiry_height() != expiry {
        return Err(refuse("signed transaction expiry mismatch"));
    }
    let mut raw = Vec::new();
    tx.write(&mut raw)
        .map_err(|_| refuse("signed transaction cannot be encoded"))?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let attempt = Attempt {
        attempt_id: attempt_id.to_owned(),
        txid: chain::txid_display(&txid),
        raw_hex: hex::encode(&raw),
        target_height,
        expiry_height,
        amount_zat,
        created_at,
    };
    state.write_attempt(&attempt).map_err(refuse)?;
    // After this line every exit is 0 or 3.

    // 7. Broadcast the persisted bytes.
    let outcome = chain::broadcast(&mut client, &raw).await;
    Ok((attempt_output(&attempt, outcome), broadcast_exit(outcome)))
}

/// Reads a recorded attempt; a missing one is refused (exit 2).
fn recorded_attempt(state: &StateDir, attempt_id: &str) -> Result<Attempt, (u8, &'static str)> {
    state
        .read_attempt(attempt_id)
        .map_err(refuse)?
        .ok_or(refuse("no attempt recorded"))
}

/// Runs `tx-status`: no seed, no sync. Any definite state is exit 0; an
/// unavailable status is exit 3.
pub async fn tx_status(
    state: &StateDir,
    chain: &dyn ChainFactory,
    attempt_id: &str,
) -> CommandResult {
    let attempt = recorded_attempt(state, attempt_id)?;
    let txid =
        chain::parse_txid_display(&attempt.txid).map_err(|_| refuse("attempt file is invalid"))?;
    let mut client = chain.connect().await.map_err(refuse)?;
    let tip = u32::from(chain::tip(&mut client).await.map_err(refuse)?);
    let tx_state = chain::tx_status(&mut client, txid, attempt.expiry_height, tip)
        .await
        .map_err(|error| (3, error))?;
    Ok((
        json!({
            "attemptId": attempt.attempt_id,
            "txid": attempt.txid,
            "state": tx_state.as_str(),
            "minedHeight": tx_state.mined_height(),
            "tip": tip,
            "expiryHeight": attempt.expiry_height,
        }),
        0,
    ))
}

/// Runs `rebroadcast`: re-sends exactly the recorded bytes, never a new
/// transaction. Refused (exit 2) once the tip is past the expiry height.
pub async fn rebroadcast(
    state: &StateDir,
    chain: &dyn ChainFactory,
    attempt_id: &str,
) -> CommandResult {
    let attempt = recorded_attempt(state, attempt_id)?;
    let raw = hex::decode(&attempt.raw_hex).map_err(|_| refuse("attempt file is invalid"))?;
    let mut client = chain.connect().await.map_err(refuse)?;
    let tip = u32::from(chain::tip(&mut client).await.map_err(refuse)?);
    if tip > attempt.expiry_height {
        return Err(refuse("attempt has expired; nothing was sent"));
    }
    let outcome = chain::broadcast(&mut client, &raw).await;
    Ok((attempt_output(&attempt, outcome), broadcast_exit(outcome)))
}

#[cfg(test)]
pub(crate) mod tests {
    use zcash_keys::keys::UnifiedAddressRequest;
    use zcash_protocol::consensus::{MAIN_NETWORK, Parameters};
    use zip321::Payment;

    use super::*;
    use crate::state::tests::attempt_fixture;

    fn address_for<P: Parameters>(params: &P) -> ZcashAddress {
        let usk = UnifiedSpendingKey::from_seed(params, &[7u8; 32], zip32::AccountId::ZERO)
            .expect("fixture key derives");
        let (ua, _) = usk
            .to_unified_full_viewing_key()
            .default_address(UnifiedAddressRequest::ORCHARD)
            .expect("fixture address derives");
        ZcashAddress::try_from_encoded(&ua.encode(params)).expect("fixture address encodes")
    }

    pub(crate) fn test_address() -> ZcashAddress {
        address_for(&ScannerParams::test_network())
    }

    fn uri_for(payments: Vec<Payment>) -> String {
        TransactionRequest::new(payments)
            .expect("fixture request")
            .to_uri()
    }

    fn zat(v: u64) -> Zatoshis {
        Zatoshis::from_u64(v).unwrap()
    }

    /// A valid single-payment testnet invoice URI and its attempt id.
    pub(crate) fn valid_invoice() -> (String, String) {
        let uri = uri_for(vec![Payment::without_memo(test_address(), zat(50_000))]);
        let id = invoice_digest(uri.as_bytes());
        (uri, id)
    }

    fn check(uri: &str) -> Result<Invoice, &'static str> {
        validate_invoice(uri.as_bytes(), &invoice_digest(uri.as_bytes()))
    }

    #[test]
    fn accepts_valid_testnet_invoice() {
        let (uri, id) = valid_invoice();
        assert!(test_address().encode().starts_with("utest1"));
        let invoice = validate_invoice(uri.as_bytes(), &id).expect("valid invoice");
        assert_eq!(u64::from(invoice.amount), 50_000);
        assert!(invoice.memo.is_none());
        let debug = format!("{invoice:?}");
        assert!(!debug.contains("utest1"));
        // Upper bound is inclusive.
        let max = uri_for(vec![Payment::without_memo(
            test_address(),
            zat(MAX_INVOICE_ZAT),
        )]);
        assert!(check(&max).is_ok());
    }

    #[test]
    fn rejects_mainnet_recipient() {
        let main = address_for(&MAIN_NETWORK);
        assert!(main.encode().starts_with("u1"));
        let uri = uri_for(vec![Payment::without_memo(main, zat(50_000))]);
        assert_eq!(check(&uri).unwrap_err(), ERR_RECIPIENT);
    }

    #[test]
    fn rejects_two_payments() {
        let uri = uri_for(vec![
            Payment::without_memo(test_address(), zat(10_000)),
            Payment::without_memo(test_address(), zat(20_000)),
        ]);
        assert_eq!(check(&uri).unwrap_err(), ERR_PAYMENT_COUNT);
    }

    #[test]
    fn rejects_out_of_range_amounts() {
        for amount in [0, MAX_INVOICE_ZAT + 1] {
            let uri = uri_for(vec![Payment::without_memo(test_address(), zat(amount))]);
            assert_eq!(check(&uri).unwrap_err(), ERR_AMOUNT, "amount {amount}");
        }
    }

    #[test]
    fn rejects_attempt_id_mismatch() {
        let (uri, id) = valid_invoice();
        let mut wrong = id.clone().into_bytes();
        wrong[0] = if wrong[0] == b'0' { b'1' } else { b'0' };
        let wrong = String::from_utf8(wrong).unwrap();
        assert_eq!(
            validate_invoice(uri.as_bytes(), &wrong).unwrap_err(),
            ERR_ATTEMPT_ID
        );
        assert_eq!(
            validate_invoice(uri.as_bytes(), &id.to_uppercase()).unwrap_err(),
            ERR_ATTEMPT_ID
        );
    }

    #[test]
    fn rejects_trailing_newline_file() {
        // C2: the binary digests the exact bytes, no trim.
        let (uri, ts_id) = valid_invoice();
        let with_newline = format!("{uri}\n");
        // The TS digest of the untrimmed URI does not match the file bytes.
        assert_eq!(
            validate_invoice(with_newline.as_bytes(), &ts_id).unwrap_err(),
            ERR_ATTEMPT_ID
        );
        // Even with the digest of the exact bytes, the newline is not a URI.
        assert!(
            validate_invoice(
                with_newline.as_bytes(),
                &invoice_digest(with_newline.as_bytes())
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_non_uri_bytes() {
        for bytes in [&b"not a uri"[..], &[0xff, 0xfe][..], &b""[..]] {
            assert_eq!(
                validate_invoice(bytes, &invoice_digest(bytes)).unwrap_err(),
                ERR_NOT_REQUEST
            );
        }
    }

    #[test]
    fn invoice_digest_is_sha256_hex_of_exact_bytes() {
        assert_eq!(
            invoice_digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(invoice_digest(b"abc"), invoice_digest(b"abc\n"));
    }

    #[test]
    fn broadcast_exit_codes() {
        assert_eq!(broadcast_exit(Broadcast::Accepted), 0);
        assert_eq!(broadcast_exit(Broadcast::Rejected), 3);
        assert_eq!(broadcast_exit(Broadcast::Unknown), 3);
    }

    #[test]
    fn attempt_output_exposes_only_frozen_fields() {
        let attempt = attempt_fixture(&"ab".repeat(32));
        let value = attempt_output(&attempt, Broadcast::Accepted);
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "attemptId",
                "broadcast",
                "expiryHeight",
                "targetHeight",
                "txid"
            ]
        );
        assert_eq!(value["broadcast"], "accepted");
        assert!(!value.to_string().contains(&attempt.raw_hex));
    }

    #[test]
    fn read_uri_file_requires_private_regular_file() {
        use std::os::unix::fs::PermissionsExt;
        let temp = crate::state::tests::TempRoot::new("uri");
        let ok = temp.write_private("ok.uri", b"zcash:x");
        assert_eq!(read_uri_file(&ok).unwrap(), b"zcash:x");
        let loose = temp.write_private("loose.uri", b"zcash:x");
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_uri_file(&loose).unwrap_err(), ERR_UNSAFE_FILE);
        let link = temp.root.join("link.uri");
        std::os::unix::fs::symlink(&ok, &link).unwrap();
        assert_eq!(read_uri_file(&link).unwrap_err(), ERR_UNSAFE_FILE);
        assert_eq!(
            read_uri_file(&temp.root.join("missing.uri")).unwrap_err(),
            ERR_READ_FILE
        );
    }
}
