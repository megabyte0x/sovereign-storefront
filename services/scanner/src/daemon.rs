//! Composition of the persistent view-only scanner daemon.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use zcash_client_backend::{
    data_api::Account as _,
    proto::service::{ChainSpec, Empty, compact_tx_streamer_client::CompactTxStreamerClient},
    sync,
};
use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork};

use crate::{
    allocate::AllocationJournal,
    api::{ApiService, HttpRequest, HttpResponse},
    cache::PersistentBlockCache,
    config::{
        acquire_config_writer_lease, decode_regtest_orchard_ufvk, open_runtime_paths,
        persist_or_verify_birthday_attestation,
    },
    consensus::verify_lightd_consensus,
    enhance::{capped_backoff, fulfill_pending_transaction_requests},
    private_fs::PrivateDir,
    projection::{ProjectedOutput, read_wallet_history},
    restore::{bind_state, verify_state_binding},
    scan::{GRPC_CONNECT_DEADLINE, GRPC_RPC_DEADLINE, SYNC_DEADLINE, within_deadline},
    snapshot::{Snapshot, SnapshotStore},
    wallet::{
        PersistentWalletDb, WalletAllocationDeriver, ensure_view_only_account,
        open_persistent_wallet_db, seed_allocation_watermark,
    },
};

/// The remote chain tip observed on either side of a coherent wallet read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TipIdentity {
    pub height: u32,
    pub hash: String,
}

#[allow(dead_code)]
impl TipIdentity {
    fn validate(&self) -> Result<(), &'static str> {
        if !is_lower_hex(&self.hash, 32) {
            return Err("scanner tip identity is invalid");
        }
        Ok(())
    }
}

/// Publishes only a projection whose surrounding chain-tip reads agree.
///
/// A changed tip invalidates retained evidence before a later coherent retry;
/// the supplied outputs are not evidence from a coherent read and are dropped.
#[allow(dead_code)]
pub(crate) fn publish_coherent_snapshot(
    store: &SnapshotStore,
    before_tip: TipIdentity,
    after_tip: TipIdentity,
    outputs: Vec<ProjectedOutput>,
    enhancement_complete: bool,
    checked_at: u64,
) -> Result<Snapshot, &'static str> {
    before_tip.validate()?;
    after_tip.validate()?;
    if before_tip == after_tip {
        store.publish(
            before_tip.height,
            before_tip.hash,
            outputs,
            true,
            enhancement_complete,
            checked_at,
        )
    } else {
        drop(outputs);
        store.invalidate(after_tip.height, after_tip.hash, checked_at)
    }
}

/// Revokes the last durably served evidence after a lifecycle failure when no
/// fresh remote tip can be trusted. The next successful pass will publish a
/// coherent replacement; until then this makes release eligibility fail closed.
fn invalidate_lifecycle_snapshot(
    store: &SnapshotStore,
    checked_at: u64,
) -> Result<Snapshot, &'static str> {
    let current = store.current()?;
    store.invalidate(current.tip.height, current.tip.hash, checked_at)
}

#[allow(dead_code)]
fn is_lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub struct PersistentScanner {
    api: ApiService,
    state: Arc<PrivateDir>,
    lifecycle: LifecycleWorker,
}

struct LifecycleWorker {
    snapshots: Arc<SnapshotStore>,
    state: Arc<PrivateDir>,
    wallet: Arc<Mutex<PersistentWalletDb>>,
    wallet_path: PathBuf,
    params: LocalNetwork,
    endpoint: String,
    account_id: String,
}

impl PersistentScanner {
    pub fn open(config_path: &Path) -> Result<Self, &'static str> {
        let writer_lease = acquire_config_writer_lease(config_path)?;
        let runtime = open_runtime_paths(config_path)?;
        let ufvk = decode_regtest_orchard_ufvk(&runtime.params, &runtime.ufvk)?;
        // Restored state must be explicitly acknowledged (new source epoch,
        // freshness reset) before any writable open or snapshot is served.
        verify_state_binding(&runtime.state)?;
        // The held lifecycle lease makes this first-import record a single
        // scanner-owned trust decision, rather than a mutable reflection of
        // later configuration. Do this before opening either writable DB.
        persist_or_verify_birthday_attestation(&runtime.state, &runtime.birthday_attestation)?;
        drop(
            runtime
                .state
                .ensure_file("wallet.sqlite")
                .map_err(|_| "scanner wallet state is unavailable safely")?,
        );
        drop(
            runtime
                .state
                .ensure_file("scanner.sqlite")
                .map_err(|_| "scanner application state is unavailable safely")?,
        );
        let mut wallet = open_persistent_wallet_db(&runtime.wallet_path, runtime.params)?;
        let account = ensure_view_only_account(&mut wallet, "scanner", &ufvk, &runtime.birthday)?;
        let account_id = account.id().expose_uuid().to_string();

        // Establish the exact-version projection boundary before accepting any
        // requests. This open cannot synthesize a ready snapshot; syncing and
        // enhancement must publish one separately.
        read_wallet_history(&runtime.wallet_path, &runtime.params, &account_id)
            .map_err(|_| "wallet history projection is unavailable")?;
        let allocations = AllocationJournal::open(&runtime.application_db_path)?;
        seed_allocation_watermark(&wallet, account.id(), &account_id, &allocations)?;
        let snapshots = SnapshotStore::open(
            &runtime.application_db_path,
            &runtime.source_id,
            runtime.chain.clone(),
            &account_id,
        )?;
        bind_state(&runtime.state, &account_id)?;
        let wallet = Arc::new(Mutex::new(wallet));
        let deriver = Arc::new(WalletAllocationDeriver::from_shared(
            Arc::clone(&wallet),
            account.id(),
            runtime.params,
        ));
        let api = ApiService::with_deriver(
            writer_lease,
            allocations,
            snapshots,
            runtime.chain,
            &account_id,
            deriver,
        );
        let state = Arc::new(runtime.state);
        Ok(Self {
            lifecycle: LifecycleWorker {
                snapshots: api.shared_snapshot_store(),
                state: Arc::clone(&state),
                wallet,
                wallet_path: runtime.wallet_path,
                params: runtime.params,
                endpoint: runtime.lightwalletd,
                account_id,
            },
            api,
            state,
        })
    }

    /// The wallet-owned view-only account UUID this scanner serves.
    pub fn account_id(&self) -> &str {
        &self.lifecycle.account_id
    }

    /// Handles one in-process API request exactly as the socket would.
    pub fn handle(&self, request: HttpRequest) -> Result<HttpResponse, &'static str> {
        self.api.handle(request)
    }

    pub fn serve(self) -> Result<(), &'static str> {
        let running = Arc::new(AtomicBool::new(true));
        let worker_running = Arc::clone(&running);
        thread::Builder::new()
            .name("scanner-lifecycle".to_owned())
            .spawn(move || self.lifecycle.run_forever(worker_running))
            .map_err(|_| "scanner lifecycle worker cannot start")?;
        let result = self.api.serve_in(self.state.as_ref(), "scanner.sock");
        running.store(false, Ordering::Release);
        result
    }
}

impl LifecycleWorker {
    fn run_forever(self, running: Arc<AtomicBool>) {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .enable_io()
            .build()
        {
            Ok(runtime) => runtime,
            Err(_) => {
                let _ = invalidate_lifecycle_snapshot(&self.snapshots, checked_at());
                return;
            }
        };
        let mut attempt: u8 = 0;
        while running.load(Ordering::Acquire) {
            match runtime.block_on(self.run_once()) {
                Ok(()) => attempt = 0,
                Err(_) => {
                    let _ = invalidate_lifecycle_snapshot(&self.snapshots, checked_at());
                    attempt = attempt.saturating_add(1);
                }
            }
            thread::sleep(capped_backoff(attempt));
        }
    }

    #[allow(clippy::await_holding_lock)]
    async fn run_once(&self) -> Result<(), &'static str> {
        let mut client = within_deadline(
            GRPC_CONNECT_DEADLINE,
            CompactTxStreamerClient::connect(self.endpoint.clone()),
        )
        .await
        .map_err(|_| "lightwalletd connection timed out")?
        .map_err(|_| "lightwalletd connection failed")?;
        let before_tip = remote_tip(&mut client).await?;
        // Every cycle re-binds the endpoint to the configured consensus rules,
        // so a swapped or misconfigured backend cannot feed this wallet.
        let info = within_deadline(GRPC_RPC_DEADLINE, client.get_lightd_info(Empty {}))
            .await
            .map_err(|_| "lightwalletd status timed out")?
            .map_err(|_| "lightwalletd status failed")?
            .into_inner();
        verify_lightd_consensus(
            &self.params,
            info.sapling_activation_height,
            &info.consensus_branch_id,
            info.block_height,
        )?;
        let cache = PersistentBlockCache::open_in(&self.state, "compact-block-cache")
            .map_err(|_| "compact block cache is unavailable")?;
        // This guard is intentionally held through the pinned wallet library's
        // scan/enhancement writes and the following read-only projection. It
        // is the single in-process writer barrier shared with allocation, so a
        // socket allocation cannot race a coherent snapshot publication.
        let mut wallet = self
            .wallet
            .lock()
            .map_err(|_| "scanner wallet mutex poisoned")?;
        within_deadline(
            SYNC_DEADLINE,
            sync::run(&mut client, &self.params, &cache, &mut *wallet, 100),
        )
        .await
        .map_err(|_| "wallet synchronization timed out")?
        .map_err(|_| "wallet synchronization failed")?;
        let synced_tip = remote_tip(&mut client).await?;
        let enhancement_complete = fulfill_pending_transaction_requests(
            &mut client,
            &self.params,
            &mut *wallet,
            BlockHeight::from_u32(synced_tip.height),
        )
        .await?;
        let outputs = read_wallet_history(&self.wallet_path, &self.params, &self.account_id)
            .map_err(|_| "wallet history projection is unavailable")?
            .outputs;
        let after_tip = remote_tip(&mut client).await?;
        drop(wallet);
        publish_coherent_snapshot(
            &self.snapshots,
            before_tip,
            after_tip,
            outputs,
            enhancement_complete,
            checked_at(),
        )?;
        Ok(())
    }
}

async fn remote_tip(
    client: &mut CompactTxStreamerClient<tonic::transport::Channel>,
) -> Result<TipIdentity, &'static str> {
    let latest = within_deadline(GRPC_RPC_DEADLINE, client.get_latest_block(ChainSpec {}))
        .await
        .map_err(|_| "scanner tip retrieval timed out")?
        .map_err(|_| "scanner tip retrieval failed")?
        .into_inner();
    let tip = TipIdentity {
        height: u32::try_from(latest.height).map_err(|_| "scanner tip is invalid")?,
        hash: hex::encode(latest.hash),
    };
    tip.validate()?;
    Ok(tip)
}

fn checked_at() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{TipIdentity, invalidate_lifecycle_snapshot, publish_coherent_snapshot};
    use crate::{
        allocate::ChainIdentity,
        projection::{ProjectedOutput, ProjectionOrigin},
        snapshot::SnapshotStore,
    };

    fn private_db() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ssf-task3-daemon-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    fn output() -> ProjectedOutput {
        ProjectedOutput {
            output_id: "a".repeat(64) + ":orchard:7",
            txid: "a".repeat(64),
            pool: "orchard".to_owned(),
            output_index: 7,
            account_id: "account".to_owned(),
            scope: "external".to_owned(),
            receiver_hex: "02".repeat(43),
            amount_zat: "100000000".to_owned(),
            mined: Some((20, "b".repeat(64))),
            first_seen_at: 0,
            origin: ProjectionOrigin::Received,
            spent: false,
        }
    }

    #[test]
    fn lifecycle_persists_invalidation_when_tip_changes_across_the_coherent_read() {
        let path = private_db();
        let store = SnapshotStore::open(&path, "scanner", ChainIdentity::fixture(), "account")
            .expect("snapshot store");
        let stable = TipIdentity {
            height: 20,
            hash: "b".repeat(64),
        };
        let ready = publish_coherent_snapshot(
            &store,
            stable.clone(),
            stable.clone(),
            vec![output()],
            true,
            1_000,
        )
        .expect("stable sync/enhancement barrier publishes ready");
        assert!(ready.complete);

        let changed = TipIdentity {
            height: 20,
            hash: "c".repeat(64),
        };
        let invalidated =
            publish_coherent_snapshot(&store, stable, changed, vec![output()], true, 1_001)
                .expect("tip change persists invalidation before retry");
        assert!(!invalidated.complete);
        assert_eq!(invalidated.health, "syncing");
        assert!(
            invalidated
                .receipts
                .iter()
                .all(|receipt| !receipt.canonical)
        );
        assert_eq!(store.current().expect("durable invalidation"), invalidated);
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn initial_tip_change_persists_an_empty_nonready_generation() {
        let path = private_db();
        let store = SnapshotStore::open(&path, "scanner", ChainIdentity::fixture(), "account")
            .expect("snapshot store");
        let invalidated = publish_coherent_snapshot(
            &store,
            TipIdentity {
                height: 20,
                hash: "b".repeat(64),
            },
            TipIdentity {
                height: 21,
                hash: "c".repeat(64),
            },
            vec![output()],
            true,
            1_000,
        )
        .expect("initial tip change persists invalidation before retry");

        assert!(!invalidated.caught_up);
        assert!(!invalidated.complete);
        assert_eq!(invalidated.health, "syncing");
        assert!(invalidated.receipts.is_empty());
        assert_eq!(store.current().expect("durable invalidation"), invalidated);
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn failed_lifecycle_revokes_the_last_ready_snapshot() {
        let path = private_db();
        let store = SnapshotStore::open(&path, "scanner", ChainIdentity::fixture(), "account")
            .expect("snapshot store");
        let stable = TipIdentity {
            height: 20,
            hash: "b".repeat(64),
        };
        publish_coherent_snapshot(&store, stable.clone(), stable, vec![output()], true, 1_000)
            .expect("ready snapshot");

        let revoked = invalidate_lifecycle_snapshot(&store, 1_001)
            .expect("worker failure revokes stale evidence");

        assert!(!revoked.complete);
        assert_eq!(revoked.health, "syncing");
        assert!(revoked.receipts.iter().all(|receipt| !receipt.canonical));
        drop(store);
        let _ = fs::remove_file(path);
    }
}
