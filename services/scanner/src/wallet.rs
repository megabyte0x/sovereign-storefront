//! Exact viewing-only wallet API bindings.

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Arc, Mutex},
};

use getrandom::SysRng;
use rand_core::UnwrapErr;
use rusqlite::Connection;
use zcash_address::ZcashAddress;
use zcash_client_backend::data_api::{
    Account as _, AccountBirthday, AccountPurpose, AddressSource, WalletRead, WalletWrite,
};
use zcash_client_sqlite::{
    AccountUuid, WalletDb, error::SqliteClientError, util::SystemClock,
    wallet::init::init_wallet_db,
};
use zcash_keys::{
    address::UnifiedAddress,
    keys::{AddressGenerationError, UnifiedAddressRequest, UnifiedFullViewingKey},
};
use zcash_protocol::{consensus::Parameters, local_consensus::LocalNetwork, value::Zatoshis};
use zip32::DiversifierIndex;
use zip321::{Payment, TransactionRequest};

use crate::allocate::{
    AllocationDeriver, AllocationJournal, ReceiverDerivation, ReservedAllocation,
};

/// Concrete persisted `WalletDb` type used by this view-only scanner.
pub(crate) type PersistentWalletDb<P = LocalNetwork> =
    WalletDb<Connection, P, SystemClock, UnwrapErr<SysRng>>;

/// Opens and migrates the scanner's persisted wallet database without any
/// spending material. Callers must supply a private, non-symlinked path.
pub(crate) fn open_persistent_wallet_db<P>(
    path: &Path,
    params: P,
) -> Result<PersistentWalletDb<P>, &'static str>
where
    P: Parameters + 'static,
{
    let mut db = WalletDb::for_path(path, params, SystemClock, UnwrapErr(SysRng))
        .map_err(|_| "wallet database cannot be opened")?;
    init_wallet_db(&mut db, None).map_err(|_| "wallet database cannot be initialized")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "wallet database permissions are unsafe")?;
    Ok(db)
}

/// The only account purpose accepted by this scanner.
pub fn view_only_account_purpose() -> AccountPurpose {
    AccountPurpose::ViewOnly
}

/// Imports a previously provisioned UFVK without any spending capability.
///
/// The caller owns configuration I/O; this binding neither formats nor logs the key.
pub(crate) fn import_view_only_account<Db: WalletWrite>(
    db: &mut Db,
    account_name: &str,
    unified_key: &UnifiedFullViewingKey,
    birthday: &AccountBirthday,
) -> Result<Db::Account, <Db as WalletRead>::Error> {
    let account = db.import_account_ufvk(
        account_name,
        unified_key,
        birthday,
        view_only_account_purpose(),
        None,
    )?;
    // `get_next_available_address` requires a known chain tip. The imported
    // birthday marks the first scan height, so record that bounded height before
    // reserving the first externally exposed receiver.
    db.update_chain_tip(birthday.height())?;
    Ok(account)
}

/// Imports a configured UFVK exactly once, or proves that the persisted account
/// is the same view-only account at the same trusted birthday before reuse.
pub(crate) fn ensure_view_only_account<Db: WalletWrite>(
    db: &mut Db,
    account_name: &str,
    unified_key: &UnifiedFullViewingKey,
    birthday: &AccountBirthday,
) -> Result<Db::Account, &'static str> {
    match find_view_only_account(db, unified_key, birthday)? {
        Some(account) => Ok(account),
        None => import_view_only_account(db, account_name, unified_key, birthday)
            .map_err(|_| "view-only wallet account import failed"),
    }
}

/// Read-only lookup of the configured view-only account at the trusted
/// birthday. Restore acknowledgement uses this so it never imports a key into
/// a restored wallet that lost its account.
pub(crate) fn find_view_only_account<Db: WalletRead>(
    db: &Db,
    unified_key: &UnifiedFullViewingKey,
    birthday: &AccountBirthday,
) -> Result<Option<Db::Account>, &'static str> {
    let Some(account) = db
        .get_account_for_ufvk(unified_key)
        .map_err(|_| "view-only wallet account lookup failed")?
    else {
        return Ok(None);
    };
    if account.purpose() != AccountPurpose::ViewOnly {
        return Err("configured account is not view-only");
    }
    if db
        .get_account_birthday(account.id())
        .map_err(|_| "view-only wallet birthday lookup failed")?
        != birthday.height()
    {
        return Err("configured account birthday does not match trusted tree state");
    }
    Ok(Some(account))
}

/// Persists and returns the next externally exposed unified address.
///
/// The exact `WalletWrite::get_next_available_address` call persists allocation
/// state in the wallet database; no locally derived or synthetic receiver is used.
pub(crate) fn allocate_next_external_address<Db: WalletWrite>(
    db: &mut Db,
    account: <Db as WalletRead>::AccountId,
    request: UnifiedAddressRequest,
) -> Result<Option<UnifiedAddress>, <Db as WalletRead>::Error> {
    db.get_next_available_address(account, request)
        .map(|allocation| allocation.map(|(address, _index)| address))
}

/// Allocates an address with an Orchard receiver and no synthetic derivation.
pub(crate) fn allocate_next_external_orchard_address<Db: WalletWrite>(
    db: &mut Db,
    account: <Db as WalletRead>::AccountId,
) -> Result<Option<UnifiedAddress>, <Db as WalletRead>::Error> {
    allocate_next_external_address(db, account, UnifiedAddressRequest::ORCHARD)
}

/// Seeds the scanner-owned burned watermark from `WalletRead` metadata. Wallet
/// SQL is deliberately never read; prior wallet-only exposures stay burned and
/// are never attributed to an unknown allocation id.
pub(crate) fn seed_allocation_watermark<Db: WalletRead>(
    db: &Db,
    account: Db::AccountId,
    account_id: &str,
    allocations: &AllocationJournal,
) -> Result<(), &'static str> {
    let mut highest = None;
    for address in db
        .list_addresses(account)
        .map_err(|_| "wallet address watermark lookup failed")?
    {
        let AddressSource::Derived {
            diversifier_index, ..
        } = address.source();
        let index = *diversifier_index.as_bytes();
        if highest
            .is_none_or(|current: [u8; 11]| index.iter().rev().cmp(current.iter().rev()).is_gt())
        {
            highest = Some(index);
        }
    }
    if let Some(highest) = highest {
        allocations.seed_high_water_mark(account_id, hex::encode(highest))?;
    }
    Ok(())
}

/// Returns the canonical protocol bytes for an external Orchard receiver.
///
/// Unified Address strings are presentation encodings and are not receipt identity.
pub fn external_orchard_receiver_bytes(address: &UnifiedAddress) -> Option<[u8; 43]> {
    address
        .orchard()
        .map(|receiver| receiver.to_raw_address_bytes())
}

/// Returns the canonical external Orchard receiver identity encoded as lowercase hex.
pub fn external_orchard_receiver_hex(address: &UnifiedAddress) -> Option<String> {
    external_orchard_receiver_bytes(address).map(hex::encode)
}

/// Serialized owner of the view-only wallet's persisted address-derivation API.
///
/// It has no spending interface. Allocation always derives the journal-reserved
/// index and therefore never allocates a replacement receiver during retry.
pub(crate) struct WalletAllocationDeriver<P> {
    wallet: Arc<Mutex<PersistentWalletDb<P>>>,
    account: AccountUuid,
    params: P,
}

impl<P> WalletAllocationDeriver<P> {
    #[cfg(test)]
    pub(crate) fn new(wallet: PersistentWalletDb<P>, account: AccountUuid, params: P) -> Self {
        Self::from_shared(Arc::new(Mutex::new(wallet)), account, params)
    }

    /// Shares the scanner's sole serialized view-only wallet capability with
    /// allocation handling. This prevents in-process SQLite writer contention
    /// and lets lifecycle scans quiesce derivation for coherent snapshots.
    pub(crate) fn from_shared(
        wallet: Arc<Mutex<PersistentWalletDb<P>>>,
        account: AccountUuid,
        params: P,
    ) -> Self {
        Self {
            wallet,
            account,
            params,
        }
    }
}

impl<P: Parameters + Send + Sync> AllocationDeriver for WalletAllocationDeriver<P> {
    fn derive(&self, reserved: &ReservedAllocation) -> Result<ReceiverDerivation, &'static str> {
        let index: [u8; 11] = hex::decode(&reserved.index)
            .map_err(|_| "wallet allocation index is invalid")?
            .try_into()
            .map_err(|_| "wallet allocation index is invalid")?;
        let index = DiversifierIndex::from(index);
        let mut wallet = self
            .wallet
            .lock()
            .map_err(|_| "wallet allocation mutex poisoned")?;
        let address =
            match wallet.get_address_for_index(self.account, index, UnifiedAddressRequest::ORCHARD)
            {
                Ok(Some(address)) => address,
                Ok(None)
                | Err(SqliteClientError::AddressGeneration(
                    AddressGenerationError::InvalidSaplingDiversifierIndex(_),
                )) => return Err("wallet address derivation has no receiver"),
                Err(_) => return Err("wallet address derivation failed"),
            };
        self.receiver_derivation(address, index, &reserved.request.amount_zat)
    }
}

impl<P: Parameters> WalletAllocationDeriver<P> {
    fn receiver_derivation(
        &self,
        address: UnifiedAddress,
        index: DiversifierIndex,
        amount_zat: &str,
    ) -> Result<ReceiverDerivation, &'static str> {
        let receiver_hex = external_orchard_receiver_hex(&address)
            .ok_or("wallet-derived address has no Orchard receiver")?;
        let destination = address.encode(&self.params);
        let payment_uri = zip321_payment_uri(&destination, amount_zat)?;
        Ok(ReceiverDerivation {
            payment_uri,
            destination,
            diversifier_index: hex::encode(index.as_bytes()),
            receiver_hex,
        })
    }
}

/// Imports `ufvk` into a fresh wallet and allocates one Orchard-only unified address.
/// The encoded address uses `params` (so testnet yields a `utest1` receiver).
pub fn allocate_orchard_only_address<P>(
    params: &P,
    ufvk: &UnifiedFullViewingKey,
    wallet_path: &Path,
) -> Result<String, &'static str>
where
    P: Parameters + Clone + 'static,
{
    use zcash_protocol::consensus::{NetworkType, NetworkUpgrade};

    let network = match params.network_type() {
        NetworkType::Test => "test",
        NetworkType::Regtest => "regtest",
        NetworkType::Main => return Err("scanner network is not permitted"),
    };
    // Orchard receivers do not exist before NU5. A height-0 tip cannot allocate one.
    let prior = params
        .activation_height(NetworkUpgrade::Nu5)
        .map(|height| u64::from(u32::from(height)).saturating_sub(1))
        .unwrap_or(0);
    let birthday = AccountBirthday::from_treestate(
        zcash_client_backend::proto::service::TreeState {
            network: network.to_owned(),
            height: prior,
            hash: "00".repeat(32),
            time: 0,
            sapling_tree: String::new(),
            orchard_tree: String::new(),
            ironwood_tree: String::new(),
        },
        None,
    )
    .map_err(|_| "scanner birthday is invalid")?;
    let mut db = open_persistent_wallet_db(wallet_path, params.clone())?;
    let account = ensure_view_only_account(&mut db, "scanner", ufvk, &birthday)?;
    let address = allocate_next_external_orchard_address(&mut db, account.id())
        .map_err(|_| "wallet allocation failed")?
        .ok_or("wallet allocation is unavailable")?;
    if address.orchard().is_none() || address.transparent().is_some() {
        return Err("wallet allocation is not orchard-only");
    }
    Ok(address.encode(params))
}

fn zip321_payment_uri(destination: &str, amount_zat: &str) -> Result<String, &'static str> {
    let amount = amount_zat
        .parse::<u64>()
        .map_err(|_| "allocation amount is invalid")?;
    let amount = Zatoshis::from_u64(amount).map_err(|_| "allocation amount is invalid")?;
    if amount == Zatoshis::ZERO {
        return Err("allocation amount is invalid");
    }
    let address = destination
        .parse::<ZcashAddress>()
        .map_err(|_| "wallet destination cannot form ZIP-321 payment")?;
    let payment = Payment::without_memo(address, amount);
    TransactionRequest::new(vec![payment])
        .map(|request| request.to_uri())
        .map_err(|_| "wallet destination cannot form ZIP-321 payment")
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        WalletAllocationDeriver, allocate_next_external_address,
        allocate_next_external_orchard_address, ensure_view_only_account,
        external_orchard_receiver_hex, import_view_only_account, open_persistent_wallet_db,
        seed_allocation_watermark, view_only_account_purpose, zip321_payment_uri,
    };
    use crate::allocate::{AllocationDeriver, AllocationJournal, AllocationRequest, ChainIdentity};
    use crate::enhance::store_full_transaction;
    use zcash_client_backend::{
        data_api::{
            Account as _, AccountBirthday, AccountPurpose, WalletRead, WalletWrite,
            testing::{AddressType, TestBuilder},
        },
        proto::service::{RawTransaction, TreeState},
    };
    use zcash_client_sqlite::testing::{BlockCache, db::TestDbFactory};
    use zcash_keys::keys::UnifiedSpendingKey;
    use zcash_primitives::{
        block::BlockHash,
        transaction::{Authorized, TransactionData, TxVersion},
    };
    use zcash_protocol::{
        consensus::{BlockHeight, BranchId},
        local_consensus::LocalNetwork,
        value::Zatoshis,
    };
    use zip32::AccountId;
    use zip321::TransactionRequest;

    fn regtest_parameters() -> LocalNetwork {
        LocalNetwork {
            overwinter: Some(BlockHeight::from_u32(1)),
            sapling: Some(BlockHeight::from_u32(1)),
            blossom: Some(BlockHeight::from_u32(1)),
            heartwood: Some(BlockHeight::from_u32(1)),
            canopy: Some(BlockHeight::from_u32(1)),
            nu5: Some(BlockHeight::from_u32(1)),
            nu6: Some(BlockHeight::from_u32(1)),
            nu6_1: Some(BlockHeight::from_u32(1)),
            nu6_2: Some(BlockHeight::from_u32(1)),
            nu6_3: Some(BlockHeight::from_u32(1)),
        }
    }

    fn private_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("scanner-wallet-{label}-{nonce}"));
        fs::create_dir(&root).expect("create isolated private root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("make test root private");
        root
    }

    fn birthday() -> AccountBirthday {
        AccountBirthday::from_treestate(
            TreeState {
                network: "regtest".to_owned(),
                height: 0,
                hash: "00".repeat(32),
                time: 0,
                sapling_tree: String::new(),
                orchard_tree: String::new(),
                ironwood_tree: String::new(),
            },
            None,
        )
        .expect("empty genesis tree state is valid")
    }

    fn generated_ufvk(params: &LocalNetwork) -> zcash_keys::keys::UnifiedFullViewingKey {
        let mut seed = [0_u8; 32];
        getrandom::fill(&mut seed).expect("OS entropy for ephemeral test fixture");
        let spending_key = UnifiedSpendingKey::from_seed(params, &seed, AccountId::ZERO)
            .expect("derive ephemeral test fixture");
        seed.fill(0);
        spending_key.to_unified_full_viewing_key()
    }

    // This generic function is type-checked against the exact pinned WalletWrite
    // surface without constructing, reading, or serializing any viewing key.
    #[allow(dead_code)]
    fn scanner_wallet_entrypoints_type_check<Db: WalletWrite>() {
        let _ = import_view_only_account::<Db>;
        let _ = allocate_next_external_address::<Db>;
    }

    /// Cross-language vector shared with `tests/unit/zip321-roundtrip.test.ts`:
    /// fixed public test seed, regtest, Orchard-only default address, 100000 zat.
    /// Not a secret: derived from the all-0x5a public test seed.
    const ZIP321_VECTOR_URI: &str = "zcash:uregtest1swq6jh60987eysqul5q97nklr60h30yyf0yu44f2pa0glwffk2r562vanhmfa867vtrk36yj0tw20ex4fn390tuu25m6ptst3c4dey2e?amount=0.001";

    fn zip321_fixture_destination() -> String {
        let params = regtest_parameters();
        let spending_key = UnifiedSpendingKey::from_seed(&params, &[0x5a_u8; 32], AccountId::ZERO)
            .expect("derive fixed public test fixture");
        let (address, _) = spending_key
            .to_unified_full_viewing_key()
            .default_address(zcash_keys::keys::UnifiedAddressRequest::ORCHARD)
            .expect("fixture Orchard default address");
        address.encode(&params)
    }

    #[test]
    fn zip321_payment_uri_round_trips_through_the_zip321_parser_exactly() {
        let destination = zip321_fixture_destination();
        for (amount_zat, canonical_zec) in [
            (1_u64, "0.00000001"),
            (100_000, "0.001"),
            (2_100_000_000_000_000, "21000000"),
        ] {
            let uri = zip321_payment_uri(&destination, &amount_zat.to_string())
                .expect("form ZIP-321 payment URI");
            assert_eq!(uri, format!("zcash:{destination}?amount={canonical_zec}"));
            let parsed = TransactionRequest::from_uri(&uri).expect("zip321 parses scanner URI");
            assert_eq!(parsed.payments().len(), 1);
            let payment = parsed
                .payments()
                .get(&0)
                .expect("single payment at index 0");
            assert_eq!(payment.recipient_address().encode(), destination);
            assert_eq!(payment.amount(), Some(Zatoshis::const_from_u64(amount_zat)));
            assert!(payment.memo().is_none());
            assert!(payment.label().is_none());
            assert!(payment.message().is_none());
            assert!(payment.other_params().is_empty());
            assert_eq!(parsed.to_uri(), uri);
        }
        assert_eq!(
            zip321_payment_uri(&destination, "100000").expect("vector URI"),
            ZIP321_VECTOR_URI
        );
    }

    #[test]
    fn zip321_payment_uri_rejects_zero_overflow_and_non_canonical_amounts() {
        let destination = zip321_fixture_destination();
        for amount in ["0", "2100000000000001", "-1", "1.0", "", "abc"] {
            assert!(zip321_payment_uri(&destination, amount).is_err());
        }
        assert!(zip321_payment_uri("not-an-address", "1").is_err());
    }

    #[test]
    fn scanner_imports_accounts_with_the_exact_view_only_purpose() {
        assert_eq!(view_only_account_purpose(), AccountPurpose::ViewOnly);
    }

    #[test]
    fn real_wallet_enhancement_parses_verifies_and_records_a_full_transaction() {
        let root = private_root("enhancement");
        let wallet_path = root.join("wallet.sqlite");
        let params = regtest_parameters();
        let ufvk = generated_ufvk(&params);
        let mut wallet = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("open persisted WalletDb");
        import_view_only_account(&mut wallet, "enhancement", &ufvk, &birthday())
            .expect("import view-only account");
        let transaction = TransactionData::<Authorized>::from_parts(
            TxVersion::V5,
            BranchId::Nu5,
            0,
            BlockHeight::from_u32(20),
            None,
            None,
            None,
            None,
        )
        .freeze()
        .expect("construct a valid non-relevant V5 transaction");
        let mut data = Vec::new();
        transaction
            .write(&mut data)
            .expect("serialize valid full transaction");
        let raw = RawTransaction { data, height: 10 };

        let status = store_full_transaction(
            &params,
            &mut wallet,
            transaction.txid(),
            &raw,
            BlockHeight::from_u32(20),
        )
        .expect("enhance a validated full transaction through WalletWrite");

        assert_eq!(
            status,
            zcash_client_backend::data_api::TransactionStatus::Mined(BlockHeight::from_u32(10))
        );
        fs::remove_dir_all(root).expect("remove generated private test state");
    }

    #[test]
    fn real_wallet_enhancement_decrypts_a_fixture_payment_and_survives_reopen() {
        let params = regtest_parameters();
        let mut source = TestBuilder::new()
            .with_network(params.clone())
            .with_data_store_factory(TestDbFactory::default())
            .with_block_cache(BlockCache::new())
            .with_account_from_sapling_activation(BlockHash([0; 32]))
            .build();
        let orchard_fvk = source
            .test_account_orchard()
            .expect("source fixture has Orchard viewing capability")
            .clone();
        let (funding_height, _, _) = source.generate_next_block(
            &orchard_fvk,
            AddressType::DefaultExternal,
            Zatoshis::const_from_u64(2_000_000),
        );
        source.scan_cached_blocks(funding_height, 1);
        let source_account = source.test_account().expect("source account").clone();
        let destination = source
            .wallet_mut()
            .get_next_available_address(
                source_account.id(),
                zcash_keys::keys::UnifiedAddressRequest::ORCHARD,
            )
            .expect("derive fixture target address")
            .expect("available fixture target address")
            .0
            .encode(&params)
            .parse()
            .expect("decode fixture target destination");
        let txids = source
            .create_standard_transaction(
                &source_account,
                destination,
                Zatoshis::const_from_u64(1_000_000),
            )
            .expect("build fixture Orchard payment");
        let txid = txids.head;
        let transaction = source
            .wallet()
            .get_transaction(txid)
            .expect("read fixture transaction")
            .expect("fixture transaction was stored");
        let source_ufvk = source_account.ufvk().expect("source account UFVK").clone();
        let birthday = source_account.birthday().clone();
        let root = private_root("decrypt-store-reopen");
        let wallet_path = root.join("wallet.sqlite");
        let mut target = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("open persistent target wallet");
        import_view_only_account(&mut target, "target", &source_ufvk, &birthday)
            .expect("import source UFVK as target view-only account");
        let mut data = Vec::new();
        transaction
            .write(&mut data)
            .expect("serialize fixture transaction");

        store_full_transaction(
            &params,
            &mut target,
            txid,
            &RawTransaction { data, height: 0 },
            funding_height,
        )
        .expect("decrypt and persist fixture payment through scanner enhancement");
        drop(target);

        let reopened = open_persistent_wallet_db(&wallet_path, params)
            .expect("reopen persistent target wallet");
        assert!(
            reopened
                .get_transaction(txid)
                .expect("read reopened target transaction")
                .is_some()
        );
        fs::remove_dir_all(root).expect("remove generated private test state");
    }

    #[test]
    fn walletdb_view_only_import_and_external_orchard_allocations_survive_reopen() {
        let root = private_root("persist");
        let wallet_path = root.join("wallet.sqlite");
        let params = regtest_parameters();
        let ufvk = generated_ufvk(&params);

        let mut wallet = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("open a persisted WalletDb");
        let account = import_view_only_account(&mut wallet, "qualification", &ufvk, &birthday())
            .expect("import the UFVK using WalletWrite::import_account_ufvk");
        assert!(matches!(account.purpose(), AccountPurpose::ViewOnly));

        let allocation_a = allocate_next_external_orchard_address(&mut wallet, account.id())
            .expect("persist external Orchard allocation A")
            .expect("available allocation A");
        let allocation_b = allocate_next_external_orchard_address(&mut wallet, account.id())
            .expect("persist external Orchard allocation B")
            .expect("available allocation B");
        assert_ne!(allocation_a, allocation_b);
        let allocation_a_receiver_hex = external_orchard_receiver_hex(&allocation_a)
            .expect("allocation A has an Orchard receiver");
        let allocation_b_receiver_hex = external_orchard_receiver_hex(&allocation_b)
            .expect("allocation B has an Orchard receiver");
        assert_ne!(allocation_a_receiver_hex, allocation_b_receiver_hex);
        let allocation_a = allocation_a.encode(&params);
        let allocation_b = allocation_b.encode(&params);
        drop(wallet);

        let reopened = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("reopen persisted WalletDb");
        let reopened_account = reopened
            .get_account_for_ufvk(&ufvk)
            .expect("read persisted imported account")
            .expect("persisted imported account exists");
        assert!(matches!(
            reopened_account.purpose(),
            AccountPurpose::ViewOnly
        ));
        let persisted_addresses = reopened
            .list_addresses(reopened_account.id())
            .expect("read wallet-persisted addresses")
            .into_iter()
            .map(|address| address.address().encode(&params))
            .collect::<Vec<_>>();
        assert!(persisted_addresses.contains(&allocation_a));
        assert!(persisted_addresses.contains(&allocation_b));
        let reopened_receiver_hexes = reopened
            .list_addresses(reopened_account.id())
            .expect("read persisted wallet allocations")
            .into_iter()
            .map(|address| {
                let zcash_keys::address::Address::Unified(address) = address.address() else {
                    panic!("external Orchard allocation remains a Unified Address");
                };
                external_orchard_receiver_hex(&address)
                    .expect("persisted allocation has an Orchard receiver")
            })
            .collect::<Vec<_>>();
        assert!(reopened_receiver_hexes.contains(&allocation_a_receiver_hex));
        assert!(reopened_receiver_hexes.contains(&allocation_b_receiver_hex));
        drop(reopened);

        fs::remove_dir_all(root).expect("remove generated private test state");
    }

    #[test]
    fn reserved_diversifier_index_is_persisted_by_the_view_only_wallet_and_reused_on_retry() {
        let root = private_root("journal-bound");
        let wallet_path = root.join("wallet.sqlite");
        let journal_path = root.join("scanner-owned.sqlite");
        let params = regtest_parameters();
        let ufvk = generated_ufvk(&params);
        let mut wallet = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("open persisted WalletDb");
        let account = import_view_only_account(&mut wallet, "journal", &ufvk, &birthday())
            .expect("import view-only account");
        let account_id = account.id().expose_uuid().to_string();
        let journal = AllocationJournal::open(&journal_path).expect("open scanner-owned journal");
        let request = AllocationRequest {
            allocation_id: "allocation-a".to_owned(),
            chain: ChainIdentity::fixture(),
            account_id,
            amount_zat: "100000000".to_owned(),
            expires_at: 2_000_000,
        };
        seed_allocation_watermark(&wallet, account.id(), &request.account_id, &journal)
            .expect("burn imported wallet addresses before selecting an allocation index");
        let allocator = WalletAllocationDeriver::new(wallet, account.id(), params);
        let reserved = journal
            .reserve(request)
            .expect("durably reserve exact wallet index before exposure");

        let first = allocator
            .derive(&reserved)
            .expect("derive exact reserved index through wallet API");
        let replay = allocator
            .derive(&reserved)
            .expect("reuse exact index after interrupted finalization");
        assert_eq!(first, replay);
        assert_eq!(first.diversifier_index, reserved.index);
        assert_eq!(first.diversifier_index.len(), 22);
        assert_eq!(first.receiver_hex.len(), 86);
        assert!(first.payment_uri.starts_with("zcash:"));

        fs::remove_dir_all(root).expect("remove generated private test state");
    }

    #[test]
    fn shared_wallet_deriver_reuses_the_scanner_owned_wallet_lock() {
        let root = private_root("shared-wallet");
        let wallet_path = root.join("wallet.sqlite");
        let journal_path = root.join("scanner-owned.sqlite");
        let params = regtest_parameters();
        let ufvk = generated_ufvk(&params);
        let mut wallet = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("open persisted WalletDb");
        let account = import_view_only_account(&mut wallet, "shared", &ufvk, &birthday())
            .expect("import view-only account");
        let account_id = account.id().expose_uuid().to_string();
        let journal = AllocationJournal::open(&journal_path).expect("open scanner-owned journal");
        let request = AllocationRequest {
            allocation_id: "shared-allocation".to_owned(),
            chain: ChainIdentity::fixture(),
            account_id,
            amount_zat: "100000000".to_owned(),
            expires_at: 2_000_000,
        };
        seed_allocation_watermark(&wallet, account.id(), &request.account_id, &journal)
            .expect("seed allocation watermark");
        let shared_wallet = Arc::new(Mutex::new(wallet));
        let allocator =
            WalletAllocationDeriver::from_shared(Arc::clone(&shared_wallet), account.id(), params);
        let reserved = journal.reserve(request).expect("reserve allocation");

        allocator
            .derive(&reserved)
            .expect("derive through shared scanner wallet");
        assert!(
            shared_wallet
                .lock()
                .expect("shared wallet lock")
                .get_account_for_ufvk(&ufvk)
                .expect("read shared wallet")
                .is_some()
        );

        fs::remove_dir_all(root).expect("remove generated private test state");
    }

    #[test]
    fn view_only_import_is_idempotent_and_verifies_the_existing_account() {
        let root = private_root("idempotent-import");
        let wallet_path = root.join("wallet.sqlite");
        let params = regtest_parameters();
        let ufvk = generated_ufvk(&params);
        let mut wallet = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("open persisted WalletDb");

        let first = ensure_view_only_account(&mut wallet, "scanner", &ufvk, &birthday())
            .expect("import clean configured UFVK");
        let second = ensure_view_only_account(&mut wallet, "scanner", &ufvk, &birthday())
            .expect("verify existing configured UFVK");

        assert_eq!(first.id(), second.id());
        assert!(matches!(second.purpose(), AccountPurpose::ViewOnly));
        drop(wallet);
        fs::remove_dir_all(root).expect("remove generated private test state");
    }
}
