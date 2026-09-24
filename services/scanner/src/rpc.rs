//! Mandatory lightwalletd compatibility probe.
//!
//! A successful connection is not treated as compatible: every RPC used by the
//! viewing-only scanner path is executed, including Ironwood subtree roots.

use std::{fmt, future::Future, time::Duration};

use tonic::Status;
use zcash_client_backend::proto::service::{
    BlockId, BlockRange, ChainSpec, Empty, GetSubtreeRootsArg, ShieldedProtocol, TxFilter,
    compact_tx_streamer_client::CompactTxStreamerClient,
};

pub const REQUIRED_CALLS: [&str; 7] = [
    "latest_block",
    "tree_state",
    "compact_block",
    "orchard_subtree_roots",
    "ironwood_subtree_roots",
    "full_transaction",
    "lightwalletd_status",
];

/// An individual transport operation must not outlive this fail-closed limit.
pub const RPC_DEADLINE: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub struct ProbeFailure {
    pub call: &'static str,
    pub kind: &'static str,
}

impl ProbeFailure {
    fn transport(call: &'static str) -> Self {
        Self {
            call,
            kind: "transport_error",
        }
    }

    fn deadline(call: &'static str) -> Self {
        Self {
            call,
            kind: "deadline_exceeded",
        }
    }

    fn rpc(call: &'static str, status: &Status) -> Self {
        Self {
            call,
            kind: match status.code() {
                tonic::Code::Unimplemented => "unimplemented",
                tonic::Code::Unavailable => "unavailable",
                tonic::Code::InvalidArgument => "invalid_argument",
                _ => "rpc_error",
            },
        }
    }

    fn missing_transaction() -> Self {
        Self {
            call: "full_transaction",
            kind: "compact_block_without_transaction",
        }
    }
}

impl fmt::Display for ProbeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "rpc_probe_failed call={} kind={}",
            self.call, self.kind
        )
    }
}

impl std::error::Error for ProbeFailure {}

/// Applies a cancellation deadline to an individual connect, RPC, or stream read.
/// This is public solely to let the regression suite exercise the real deadline
/// policy without a live endpoint.
pub async fn within_rpc_deadline<T>(
    call: &'static str,
    deadline: Duration,
    operation: impl Future<Output = T>,
) -> Result<T, ProbeFailure> {
    tokio::time::timeout(deadline, operation)
        .await
        .map_err(|_| ProbeFailure::deadline(call))
}

async fn rpc_with_deadline<T>(
    call: &'static str,
    operation: impl Future<Output = T>,
) -> Result<T, ProbeFailure> {
    within_rpc_deadline(call, RPC_DEADLINE, operation).await
}

async fn read_one_subtree_root(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
    call: &'static str,
    protocol: ShieldedProtocol,
) -> Result<(), ProbeFailure> {
    let mut stream = rpc_with_deadline(
        call,
        client.get_subtree_roots(GetSubtreeRootsArg {
            start_index: 0,
            shielded_protocol: protocol as i32,
            max_entries: 1,
        }),
    )
    .await?
    .map_err(|error| ProbeFailure::rpc(call, &error))?
    .into_inner();
    // A chain may legitimately have no completed subtree. Reading once still
    // proves that the method is implemented and the stream can be consumed.
    rpc_with_deadline(call, stream.message())
        .await?
        .map_err(|error| ProbeFailure::rpc(call, &error))?;
    Ok(())
}

pub async fn qualify_lightwalletd(endpoint: &str) -> Result<(), ProbeFailure> {
    let mut client = rpc_with_deadline(
        "connect",
        CompactTxStreamerClient::connect(endpoint.to_owned()),
    )
    .await?
    .map_err(|_| ProbeFailure::transport("connect"))?;

    rpc_with_deadline("lightwalletd_status", client.get_lightd_info(Empty {}))
        .await?
        .map_err(|error| ProbeFailure::rpc("lightwalletd_status", &error))?;

    let latest = rpc_with_deadline("latest_block", client.get_latest_block(ChainSpec {}))
        .await?
        .map_err(|error| ProbeFailure::rpc("latest_block", &error))?
        .into_inner();
    let block_id = BlockId {
        height: latest.height,
        hash: vec![],
    };

    rpc_with_deadline("tree_state", client.get_tree_state(block_id.clone()))
        .await?
        .map_err(|error| ProbeFailure::rpc("tree_state", &error))?;

    let compact_block = rpc_with_deadline("compact_block", client.get_block(block_id.clone()))
        .await?
        .map_err(|error| ProbeFailure::rpc("compact_block", &error))?
        .into_inner();

    let transaction = compact_block
        .vtx
        .first()
        .ok_or_else(ProbeFailure::missing_transaction)?;
    rpc_with_deadline(
        "full_transaction",
        client.get_transaction(TxFilter {
            block: None,
            index: 0,
            hash: transaction.txid.clone(),
        }),
    )
    .await?
    .map_err(|error| ProbeFailure::rpc("full_transaction", &error))?;

    // Exercise the same `GetSubtreeRoots` requests that `sync::run` performs.
    read_one_subtree_root(
        &mut client,
        "orchard_subtree_roots",
        ShieldedProtocol::Orchard,
    )
    .await?;
    read_one_subtree_root(
        &mut client,
        "ironwood_subtree_roots",
        ShieldedProtocol::Ironwood,
    )
    .await?;

    // Keep the block range request in this probe as the compact-block stream
    // used by `sync::run`, even though `GetBlock` supplied the transaction id.
    let mut range = rpc_with_deadline(
        "compact_block",
        client.get_block_range(BlockRange {
            start: Some(block_id.clone()),
            end: Some(block_id),
            pool_types: vec![],
        }),
    )
    .await?
    .map_err(|error| ProbeFailure::rpc("compact_block", &error))?
    .into_inner();
    if rpc_with_deadline("compact_block", range.message())
        .await?
        .map_err(|error| ProbeFailure::rpc("compact_block", &error))?
        .is_none()
    {
        return Err(ProbeFailure {
            call: "compact_block",
            kind: "empty_stream",
        });
    }

    Ok(())
}
