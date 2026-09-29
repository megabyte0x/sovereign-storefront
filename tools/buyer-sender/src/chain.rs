//! Lightwalletd access for the buyer wallet: connection, tip, sync, birthday
//! tree state, broadcast and transaction status.
//!
//! Every RPC runs under an explicit deadline. Server-provided strings (for
//! example `SendResponse::error_message`) are dropped and never reach output.
//! `decode_status` and `map_broadcast` are pure so they can be tested without
//! a network.

use std::time::Duration;

use sovereign_storefront_scanner::{
    cache::PersistentBlockCache,
    config::{ScannerParams, validate_lightwalletd_endpoint},
    enhance::transaction_filter,
    scan::{GRPC_CONNECT_DEADLINE, GRPC_RPC_DEADLINE, SYNC_DEADLINE, within_deadline},
};
use zcash_client_backend::{
    data_api::AccountBirthday,
    proto::service::{
        BlockId, ChainSpec, RawTransaction, SendResponse,
        compact_tx_streamer_client::CompactTxStreamerClient,
    },
    sync,
};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    TxId,
    consensus::{BlockHeight, BranchId},
};

use crate::state::Db;

pub type Client = CompactTxStreamerClient<tonic::transport::Channel>;

/// Deadline for the first (from-birthday) synchronization during `import`.
pub const IMPORT_SYNC_DEADLINE: Duration = Duration::from_secs(30 * 60);
/// Deadline for the pre-spend / status synchronization.
pub const SYNC_BUDGET: Duration = Duration::from_secs(SYNC_DEADLINE.as_secs() * 3);

const SYNC_BATCH_SIZE: u32 = 100;

/// Validates the endpoint (testnet TLS rules) and connects under
/// `GRPC_CONNECT_DEADLINE`.
pub async fn connect(endpoint: &str) -> Result<Client, &'static str> {
    validate_lightwalletd_endpoint(endpoint).map_err(|_| "lightwalletd endpoint is invalid")?;
    within_deadline(
        GRPC_CONNECT_DEADLINE,
        CompactTxStreamerClient::connect(endpoint.to_owned()),
    )
    .await
    .map_err(|_| "lightwalletd connection timed out")?
    .map_err(|_| "lightwalletd connection failed")
}

/// Current chain tip reported by lightwalletd.
pub async fn tip(client: &mut Client) -> Result<BlockHeight, &'static str> {
    let latest = within_deadline(GRPC_RPC_DEADLINE, client.get_latest_block(ChainSpec {}))
        .await
        .map_err(|_| "chain tip retrieval timed out")?
        .map_err(|_| "chain tip retrieval failed")?
        .into_inner();
    let height = u32::try_from(latest.height).map_err(|_| "chain tip is invalid")?;
    Ok(BlockHeight::from_u32(height))
}

/// Scans the wallet up to the current tip within `deadline`.
pub async fn sync(
    client: &mut Client,
    db: &mut Db,
    cache: &PersistentBlockCache,
    deadline: Duration,
) -> Result<(), &'static str> {
    let params = ScannerParams::test_network();
    within_deadline(
        deadline,
        sync::run(client, &params, cache, db, SYNC_BATCH_SIZE),
    )
    .await
    .map_err(|_| "wallet synchronization timed out")?
    .map_err(|_| "wallet synchronization failed")
}

/// Account birthday at height `h`, from the tree state at `h - 1`.
pub async fn birthday_at(client: &mut Client, h: u32) -> Result<AccountBirthday, &'static str> {
    let prior = h.checked_sub(1).ok_or("birthday cannot be genesis")?;
    let tree_state = within_deadline(
        GRPC_RPC_DEADLINE,
        client.get_tree_state(BlockId {
            height: u64::from(prior),
            hash: vec![],
        }),
    )
    .await
    .map_err(|_| "birthday tree state timed out")?
    .map_err(|_| "birthday tree state failed")?
    .into_inner();
    AccountBirthday::from_treestate(tree_state, None).map_err(|_| "birthday is invalid")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Broadcast {
    Accepted,
    Rejected,
    Unknown,
}

impl Broadcast {
    pub fn as_str(self) -> &'static str {
        match self {
            Broadcast::Accepted => "accepted",
            Broadcast::Rejected => "rejected",
            Broadcast::Unknown => "unknown",
        }
    }
}

/// Pure broadcast outcome mapping. Only `error_code` is consulted; the
/// server-provided message is deliberately dropped.
pub fn map_broadcast(r: Result<SendResponse, ()>) -> Broadcast {
    match r {
        Ok(response) if response.error_code == 0 => Broadcast::Accepted,
        Ok(_) => Broadcast::Rejected,
        Err(()) => Broadcast::Unknown,
    }
}

/// Sends the exact raw transaction bytes. Any transport error or timeout is
/// `Unknown`: the transaction may or may not have reached the network.
pub async fn broadcast(client: &mut Client, raw: &[u8]) -> Broadcast {
    let request = RawTransaction {
        data: raw.to_vec(),
        height: 0,
    };
    let result = match within_deadline(GRPC_RPC_DEADLINE, client.send_transaction(request)).await {
        Ok(Ok(response)) => Ok(response.into_inner()),
        Ok(Err(_)) | Err(_) => Err(()),
    };
    map_broadcast(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxState {
    Mined(u32),
    Mempool,
    NotFound,
    Expired,
    Forked,
}

impl TxState {
    pub fn as_str(self) -> &'static str {
        match self {
            TxState::Mined(_) => "mined",
            TxState::Mempool => "mempool",
            TxState::NotFound => "not_found",
            TxState::Expired => "expired",
            TxState::Forked => "forked",
        }
    }

    pub fn mined_height(self) -> Option<u32> {
        match self {
            TxState::Mined(height) => Some(height),
            _ => None,
        }
    }
}

const MALFORMED: &str = "status payload is malformed";
const UNAVAILABLE: &str = "transaction status unavailable";

/// Pure decode of a `GetTransaction` result.
///
/// A successful payload must parse as exactly one transaction (no trailing
/// bytes) whose txid equals `requested`. `NOT_FOUND` becomes `Expired` only
/// when `tip > expiry`; every other status code is an error, never
/// `not_found`.
pub fn decode_status(
    r: Result<RawTransaction, tonic::Status>,
    requested: TxId,
    tip: u32,
    expiry: u32,
    params: &ScannerParams,
) -> Result<TxState, &'static str> {
    match r {
        Ok(raw) => {
            let state = match raw.height {
                0 => TxState::Mempool,
                u64::MAX => TxState::Forked,
                h => TxState::Mined(u32::try_from(h).map_err(|_| MALFORMED)?),
            };
            let branch_height = match state {
                TxState::Mined(h) => h,
                _ => tip.checked_add(1).ok_or(MALFORMED)?,
            };
            let branch = BranchId::for_height(params, BlockHeight::from_u32(branch_height));
            let mut reader = &raw.data[..];
            let transaction = Transaction::read(&mut reader, branch).map_err(|_| MALFORMED)?;
            if !reader.is_empty() || transaction.txid() != requested {
                return Err(MALFORMED);
            }
            Ok(state)
        }
        Err(status) if status.code() == tonic::Code::NotFound => {
            if tip > expiry {
                Ok(TxState::Expired)
            } else {
                Ok(TxState::NotFound)
            }
        }
        Err(_) => Err(UNAVAILABLE),
    }
}

/// Looks up `txid` and decodes its state against `tip`/`expiry`.
pub async fn tx_status(
    client: &mut Client,
    txid: TxId,
    expiry: u32,
    tip: u32,
) -> Result<TxState, &'static str> {
    let result = within_deadline(
        GRPC_RPC_DEADLINE,
        client.get_transaction(transaction_filter(txid)),
    )
    .await
    .map_err(|_| UNAVAILABLE)?
    .map(tonic::Response::into_inner);
    decode_status(result, txid, tip, expiry, &ScannerParams::test_network())
}

/// Display-order (byte-reversed) lowercase hex, as shown by explorers.
pub fn txid_display(txid: &TxId) -> String {
    txid.to_string()
}

/// Parses display-order hex: exactly 64 lowercase hex characters.
pub fn parse_txid_display(value: &str) -> Result<TxId, &'static str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("txid is invalid");
    }
    TxId::from_hex(value).ok_or("txid is invalid")
}

#[cfg(test)]
pub(crate) mod tests {
    use zcash_primitives::transaction::{Authorized, TransactionData, TxVersion};

    use super::*;

    /// A real, empty v5 transaction built from public constructors (no
    /// feature-gated test helpers). Returns its txid and serialized bytes.
    pub(crate) fn tx_fixture(expiry: u32) -> (TxId, Vec<u8>) {
        let data = TransactionData::<Authorized>::from_parts(
            TxVersion::V5,
            BranchId::Nu5,
            0,
            BlockHeight::from_u32(expiry),
            None,
            None,
            None,
            None,
        );
        let tx = data.freeze().expect("fixture transaction freezes");
        let mut raw = Vec::new();
        tx.write(&mut raw).expect("fixture transaction encodes");
        (tx.txid(), raw)
    }

    fn params() -> ScannerParams {
        ScannerParams::test_network()
    }

    fn found(data: Vec<u8>, height: u64) -> Result<RawTransaction, tonic::Status> {
        Ok(RawTransaction { data, height })
    }

    #[test]
    fn not_found_is_not_found_until_tip_passes_expiry() {
        let (txid, _) = tx_fixture(120);
        let nf = || Err(tonic::Status::not_found("x"));
        assert_eq!(
            decode_status(nf(), txid, 100, 120, &params()),
            Ok(TxState::NotFound)
        );
        assert_eq!(
            decode_status(nf(), txid, 120, 120, &params()),
            Ok(TxState::NotFound)
        );
        assert_eq!(
            decode_status(nf(), txid, 121, 120, &params()),
            Ok(TxState::Expired)
        );
    }

    #[test]
    fn transport_errors_are_errors_never_not_found() {
        let (txid, _) = tx_fixture(120);
        for status in [
            tonic::Status::unavailable("down"),
            tonic::Status::deadline_exceeded("slow"),
            tonic::Status::internal("boom"),
        ] {
            // Even with tip far past expiry, a transport error is an error.
            assert_eq!(
                decode_status(Err(status), txid, 10_000, 120, &params()),
                Err(UNAVAILABLE)
            );
        }
    }

    #[test]
    fn heights_map_to_mempool_forked_and_mined() {
        let (txid, raw) = tx_fixture(3_000_020);
        assert_eq!(
            decode_status(found(raw.clone(), 0), txid, 3_000_000, 3_000_020, &params()),
            Ok(TxState::Mempool)
        );
        assert_eq!(
            decode_status(
                found(raw.clone(), u64::MAX),
                txid,
                3_000_000,
                3_000_020,
                &params()
            ),
            Ok(TxState::Forked)
        );
        let mined = decode_status(
            found(raw.clone(), 3_000_005),
            txid,
            3_000_010,
            3_000_020,
            &params(),
        );
        assert_eq!(mined, Ok(TxState::Mined(3_000_005)));
        assert_eq!(mined.unwrap().mined_height(), Some(3_000_005));
        // A height that does not fit u32 (and is not the fork sentinel) is malformed.
        assert_eq!(
            decode_status(
                found(raw, u64::from(u32::MAX) + 1),
                txid,
                3_000_000,
                3_000_020,
                &params()
            ),
            Err(MALFORMED)
        );
    }

    #[test]
    fn mismatched_txid_trailing_bytes_and_garbage_are_malformed() {
        let (txid, raw) = tx_fixture(3_000_020);
        let (other_txid, other_raw) = tx_fixture(3_000_021);
        assert_ne!(txid, other_txid);
        assert_eq!(
            decode_status(found(other_raw, 0), txid, 3_000_000, 3_000_020, &params()),
            Err(MALFORMED)
        );
        let mut trailing = raw.clone();
        trailing.push(0);
        assert_eq!(
            decode_status(found(trailing, 0), txid, 3_000_000, 3_000_020, &params()),
            Err(MALFORMED)
        );
        assert_eq!(
            decode_status(
                found(vec![1, 2, 3], 0),
                txid,
                3_000_000,
                3_000_020,
                &params()
            ),
            Err(MALFORMED)
        );
        assert_eq!(
            decode_status(found(Vec::new(), 0), txid, 3_000_000, 3_000_020, &params()),
            Err(MALFORMED)
        );
    }

    #[test]
    fn broadcast_mapping_drops_server_message() {
        assert_eq!(
            map_broadcast(Ok(SendResponse {
                error_code: 0,
                error_message: String::new(),
            })),
            Broadcast::Accepted
        );
        let rejected = map_broadcast(Ok(SendResponse {
            error_code: -26,
            error_message: "secret-ish".to_owned(),
        }));
        assert_eq!(rejected, Broadcast::Rejected);
        assert_eq!(rejected.as_str(), "rejected");
        assert!(!rejected.as_str().contains("secret-ish"));
        assert!(!format!("{rejected:?}").contains("secret-ish"));
        assert_eq!(map_broadcast(Err(())), Broadcast::Unknown);
        assert_eq!(Broadcast::Accepted.as_str(), "accepted");
        assert_eq!(Broadcast::Unknown.as_str(), "unknown");
    }

    #[test]
    fn txid_display_round_trips_and_parse_is_strict() {
        let (txid, _) = tx_fixture(7);
        let shown = txid_display(&txid);
        assert_eq!(shown.len(), 64);
        assert_eq!(parse_txid_display(&shown), Ok(txid));
        assert!(parse_txid_display(&shown.to_uppercase()).is_err());
        assert!(parse_txid_display(&shown[..63]).is_err());
        assert!(parse_txid_display(&format!("{shown}0")).is_err());
    }

    #[test]
    fn state_words_are_frozen() {
        assert_eq!(TxState::Mined(1).as_str(), "mined");
        assert_eq!(TxState::Mempool.as_str(), "mempool");
        assert_eq!(TxState::NotFound.as_str(), "not_found");
        assert_eq!(TxState::Expired.as_str(), "expired");
        assert_eq!(TxState::Forked.as_str(), "forked");
        assert_eq!(TxState::Mempool.mined_height(), None);
    }
}
