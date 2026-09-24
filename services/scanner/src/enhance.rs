use std::time::Duration;

use zcash_client_backend::data_api::{
    TransactionDataRequest, TransactionStatus, WalletRead, WalletWrite,
    wallet::decrypt_and_store_transaction,
};
use zcash_client_backend::proto::service::{
    RawTransaction, TxFilter, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::{
    TxId,
    consensus::{BlockHeight, BranchId, Parameters},
};

/// The enhancement worker treats `transaction_data_requests` as authoritative
/// each pass. A caller must finish every request before marking a scan complete.
pub fn pending_transaction_enhancement<Db: WalletRead>(wallet: &Db) -> Result<bool, Db::Error> {
    Ok(!wallet.transaction_data_requests()?.is_empty())
}

pub fn capped_backoff(attempt: u8) -> Duration {
    Duration::from_secs(1_u64 << attempt.min(5))
}

/// Interprets lightwalletd's `RawTransaction.height` sentinel values without
/// ever treating a mempool or fork response as canonical mined evidence.
pub fn transaction_status_from_raw_height(
    raw_height: u64,
) -> Result<TransactionStatus, &'static str> {
    match raw_height {
        0 | u64::MAX => Ok(TransactionStatus::NotInMainChain),
        height => Ok(TransactionStatus::Mined(BlockHeight::from_u32(
            u32::try_from(height).map_err(|_| "lightwalletd transaction height is invalid")?,
        ))),
    }
}

/// Parses one lightwalletd full-transaction response with the branch active at
/// its validated mined height, or at the caller's observed tip when it is not
/// canonical. Parsing happens before the wallet is permitted to mutate.
pub fn parse_raw_transaction<P: Parameters>(
    params: &P,
    raw: &RawTransaction,
    observed_tip: BlockHeight,
) -> Result<(Transaction, TransactionStatus), &'static str> {
    let status = transaction_status_from_raw_height(raw.height)?;
    let branch_height = match status {
        TransactionStatus::Mined(height) => height,
        TransactionStatus::NotInMainChain | TransactionStatus::TxidNotRecognized => observed_tip,
    };
    let transaction = Transaction::read(
        raw.data.as_slice(),
        BranchId::for_height(params, branch_height),
    )
    .map_err(|_| "lightwalletd transaction payload is invalid")?;
    Ok((transaction, status))
}

/// Builds the lightwalletd `GetTransaction` filter from the protocol's raw
/// TxId bytes. Display hex is byte-reversed and must not be sent here.
pub fn transaction_filter(txid: TxId) -> TxFilter {
    TxFilter {
        block: None,
        index: 0,
        hash: <[u8; 32]>::from(txid).to_vec(),
    }
}

/// Applies one fetched full transaction through the pinned wallet library.
/// The response must parse and reproduce the exact requested TxId before any
/// wallet write is attempted; otherwise no status or transaction data is saved.
pub fn store_full_transaction<P: Parameters, Db: WalletWrite>(
    params: &P,
    wallet: &mut Db,
    requested_txid: TxId,
    raw: &RawTransaction,
    observed_tip: BlockHeight,
) -> Result<TransactionStatus, &'static str> {
    let (transaction, status) = parse_raw_transaction(params, raw, observed_tip)?;
    if transaction.txid() != requested_txid {
        return Err("lightwalletd transaction identity does not match request");
    }
    let mined_height = match status {
        TransactionStatus::Mined(height) => Some(height),
        TransactionStatus::NotInMainChain | TransactionStatus::TxidNotRecognized => None,
    };
    decrypt_and_store_transaction(params, wallet, &transaction, mined_height)
        .map_err(|_| "wallet transaction enhancement failed")?;
    wallet
        .set_transaction_status(requested_txid, status)
        .map_err(|_| "wallet transaction status update failed")?;
    Ok(status)
}

/// Fetches and applies one wallet enhancement request through lightwalletd.
/// The network operation is bounded before any parser or wallet write runs.
pub async fn fetch_and_store_full_transaction<Db: WalletWrite>(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
    params: &impl Parameters,
    wallet: &mut Db,
    requested_txid: TxId,
    observed_tip: BlockHeight,
) -> Result<TransactionStatus, &'static str> {
    let response = crate::scan::within_deadline(
        crate::scan::GRPC_RPC_DEADLINE,
        client.get_transaction(transaction_filter(requested_txid)),
    )
    .await
    .map_err(|_| "lightwalletd full transaction retrieval timed out")?;
    let raw = match response {
        Ok(response) => response.into_inner(),
        Err(status) if status.code() == tonic::Code::NotFound => {
            wallet
                .set_transaction_status(requested_txid, TransactionStatus::TxidNotRecognized)
                .map_err(|_| "wallet transaction status update failed")?;
            return Ok(TransactionStatus::TxidNotRecognized);
        }
        Err(_) => return Err("lightwalletd full transaction retrieval failed"),
    };
    store_full_transaction(params, wallet, requested_txid, &raw, observed_tip)
}

/// Resolves the latest authoritative set of wallet enhancement requests. The
/// wallet may issue new requests while results are applied, so completion is
/// determined only by a fresh request read after the pass.
pub async fn fulfill_pending_transaction_requests<Db: WalletWrite>(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
    params: &impl Parameters,
    wallet: &mut Db,
    observed_tip: BlockHeight,
) -> Result<bool, &'static str> {
    let requests = wallet
        .transaction_data_requests()
        .map_err(|_| "wallet transaction enhancement lookup failed")?;
    for request in requests {
        let txid = match request {
            TransactionDataRequest::GetStatus(txid) | TransactionDataRequest::Enhancement(txid) => {
                txid
            }
            #[allow(unreachable_patterns)]
            _ => return Err("wallet emitted an unsupported transaction data request"),
        };
        fetch_and_store_full_transaction(client, params, wallet, txid, observed_tip).await?;
    }
    pending_transaction_enhancement(wallet)
        .map(|pending| !pending)
        .map_err(|_| "wallet transaction enhancement lookup failed")
}

#[cfg(test)]
mod tests {
    use super::{parse_raw_transaction, transaction_filter, transaction_status_from_raw_height};
    use zcash_client_backend::data_api::TransactionStatus;
    use zcash_client_backend::proto::service::RawTransaction;
    use zcash_protocol::consensus::BlockHeight;

    #[test]
    fn raw_transaction_height_never_marks_mempool_or_fork_as_mined() {
        assert_eq!(
            transaction_status_from_raw_height(0).expect("mempool sentinel is representable"),
            TransactionStatus::NotInMainChain
        );
        assert_eq!(
            transaction_status_from_raw_height(u64::MAX).expect("fork sentinel is representable"),
            TransactionStatus::NotInMainChain
        );
        assert_eq!(
            transaction_status_from_raw_height(42).expect("mined height is representable"),
            TransactionStatus::Mined(BlockHeight::from_u32(42))
        );
        assert!(
            transaction_status_from_raw_height(u64::from(u32::MAX) + 1).is_err(),
            "an unrepresentable wire height must not wrap into a canonical block"
        );
    }

    #[test]
    fn malformed_full_transaction_is_rejected_before_wallet_enhancement() {
        let raw = RawTransaction {
            data: vec![0xff],
            height: 42,
        };
        let params = zcash_protocol::local_consensus::LocalNetwork {
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
        };

        assert!(parse_raw_transaction(&params, &raw, BlockHeight::from_u32(50)).is_err());
    }

    #[test]
    fn full_transaction_filter_uses_exact_internal_txid_bytes() {
        let txid = zcash_protocol::TxId::from_bytes(std::array::from_fn(|index| index as u8));
        let filter = transaction_filter(txid);

        assert!(filter.block.is_none());
        assert_eq!(filter.index, 0);
        assert_eq!(filter.hash, <[u8; 32]>::from(txid));
    }
}
