use std::{
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};

use getrandom::SysRng;
use rand_core::UnwrapErr;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use zcash_client_backend::{
    data_api::{Account as _, AccountBirthday, WalletRead},
    proto::service::{BlockId, ChainSpec, compact_tx_streamer_client::CompactTxStreamerClient},
    sync,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork};

use crate::{
    allocation::{
        AllocationIdentity, PersistedAllocations, validate_distinct_persisted_allocations,
    },
    cache::PersistentBlockCache,
    config::{decode_orchard_ufvk, open_private_config, writer_lease_name},
    lease::WriterLease,
    private_fs::PrivateDir,
    projection::read_wallet_history,
    receipt::{ReceiptObservation, ReceiptTransition, validate_receipt_transition},
    wallet::{
        allocate_next_external_orchard_address, external_orchard_receiver_hex,
        import_view_only_account,
    },
};

const REQUIRED_AMOUNT_ZAT: u64 = 100_000_000;
const SYNC_BATCH_SIZE: u32 = 100;
/// Explicit fail-closed deadlines for scanner connection, RPC, and each sync stage.
pub const GRPC_CONNECT_DEADLINE: Duration = Duration::from_secs(15);
pub const GRPC_RPC_DEADLINE: Duration = Duration::from_secs(15);
pub const SYNC_DEADLINE: Duration = Duration::from_secs(120);

#[derive(Clone, Copy)]
pub enum Stage {
    Prepare,
    BeforeTen,
    AtTen,
    VerifyRestart,
}

#[derive(Serialize, Deserialize)]
struct PrivateReceipt {
    allocation_receiver_hex: String,
    amount_zat: u64,
    receiver_hex: String,
    txid: String,
    pool: String,
    action_index: u32,
    mined_height: u32,
    mined_hash: String,
    output_id: String,
    confirmations: u32,
    confirmations_until_spendable: u32,
}

impl PrivateReceipt {
    fn observation(&self) -> ReceiptObservation {
        ReceiptObservation::with_mined_block(
            self.allocation_receiver_hex.clone(),
            self.amount_zat,
            self.confirmations_until_spendable,
            self.output_id.clone(),
            self.mined_hash.clone(),
        )
    }
}

#[derive(Serialize, Deserialize)]
struct PrivateAllocation {
    unified_address: String,
    orchard_receiver_hex: String,
}

#[derive(Serialize, Deserialize)]
struct PrivateState {
    allocation_a: PrivateAllocation,
    allocation_b: PrivateAllocation,
    before_ten: Option<PrivateReceipt>,
    at_ten: Option<PrivateReceipt>,
}

struct StatePaths {
    root: PrivateDir,
}

const WALLET_FILE: &str = "wallet.sqlite";
const CACHE_DIRECTORY: &str = "compact-block-cache";
const RESULT_FILE: &str = "result.json";

pub fn state_root_for(config: &Path) -> Result<PathBuf, &'static str> {
    let parent = config
        .parent()
        .ok_or("scanner config has no parent directory")?;
    let name = config
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("scanner config name is invalid")?;
    Ok(parent.join(format!(".{name}.live-state")))
}

fn state_root_name(config_name: &str) -> String {
    format!(".{config_name}.live-state")
}

fn create_state_paths(parent: &PrivateDir, config_name: &str) -> Result<StatePaths, &'static str> {
    let root = parent
        .create_child(&state_root_name(config_name))
        .map_err(|_| "scanner state cannot be created safely")?;
    root.verify()
        .map_err(|_| "scanner state permissions are unsafe")?;
    Ok(StatePaths { root })
}

fn open_state_paths(parent: &PrivateDir, config_name: &str) -> Result<StatePaths, &'static str> {
    let root = parent
        .open_child(&state_root_name(config_name))
        .map_err(|_| "scanner state is unavailable safely")?;
    root.verify()
        .map_err(|_| "scanner state permissions are unsafe")?;
    Ok(StatePaths { root })
}

fn write_private_state(root: &PrivateDir, state: &PrivateState) -> Result<(), &'static str> {
    let mut encoded = serde_json::to_vec(state).map_err(|_| "scanner result cannot be encoded")?;
    encoded.push(b'\n');
    root.write_file_atomic(RESULT_FILE, &encoded)
        .map_err(|_| "scanner result cannot be written safely")
}

fn read_private_state(root: &PrivateDir) -> Result<PrivateState, &'static str> {
    let bytes = root
        .read_file(RESULT_FILE)
        .map_err(|_| "scanner result cannot be read safely")?;
    serde_json::from_slice(&bytes).map_err(|_| "scanner result is invalid")
}

type Db = WalletDb<Connection, LocalNetwork, SystemClock, UnwrapErr<SysRng>>;

fn open_wallet(root: &PrivateDir, params: LocalNetwork) -> Result<Db, &'static str> {
    // Pre-create and validate the exact final component through the held state
    // descriptor before SQLite receives its descriptor-backed pathname.
    drop(
        root.ensure_file(WALLET_FILE)
            .map_err(|_| "wallet database boundary is unsafe")?,
    );
    let path = root
        .proc_path(WALLET_FILE)
        .map_err(|_| "wallet database path is invalid")?;
    let mut db = WalletDb::for_path(&path, params, SystemClock, UnwrapErr(SysRng))
        .map_err(|_| "wallet database cannot be opened")?;
    init_wallet_db(&mut db, None).map_err(|_| "wallet database cannot be initialized")?;
    drop(
        root.ensure_file(WALLET_FILE)
            .map_err(|_| "wallet database permissions are unsafe")?,
    );
    Ok(db)
}

/// Applies a fail-closed deadline to a scanner transport or synchronization step.
/// The regression suite exercises this exact helper with a pending future.
pub async fn within_deadline<T>(
    deadline: Duration,
    operation: impl Future<Output = T>,
) -> Result<T, &'static str> {
    tokio::time::timeout(deadline, operation)
        .await
        .map_err(|_| "scanner stage timed out")
}

async fn client(
    endpoint: &str,
) -> Result<CompactTxStreamerClient<tonic::transport::Channel>, &'static str> {
    within_deadline(
        GRPC_CONNECT_DEADLINE,
        CompactTxStreamerClient::connect(endpoint.to_owned()),
    )
    .await
    .map_err(|_| "lightwalletd connection timed out")?
    .map_err(|_| "lightwalletd connection failed")
}

fn project_receipt(
    db: &Db,
    wallet: &Path,
    params: &LocalNetwork,
    ufvk: &UnifiedFullViewingKey,
    allocation: &PrivateAllocation,
    target_height: BlockHeight,
) -> Result<Option<PrivateReceipt>, &'static str> {
    let account = db
        .get_account_for_ufvk(ufvk)
        .map_err(|_| "view-only wallet account lookup failed")?
        .ok_or("view-only wallet account is missing")?;
    let account_id = account.id().expose_uuid().to_string();
    let history = read_wallet_history(wallet, params, &account_id)
        .map_err(|_| "wallet history projection is unavailable")?;
    for output in history.outputs {
        if output.receiver_hex != allocation.orchard_receiver_hex {
            continue;
        }
        let Some((mined_height, mined_hash)) = output.mined else {
            continue;
        };
        let amount_zat = output
            .amount_zat
            .parse::<u64>()
            .map_err(|_| "wallet receipt amount is invalid")?;
        let confirmations = u32::from(target_height)
            .checked_sub(mined_height)
            .ok_or("wallet receipt height is ahead of the scanner tip")?;
        return Ok(Some(PrivateReceipt {
            allocation_receiver_hex: allocation.orchard_receiver_hex.clone(),
            amount_zat,
            receiver_hex: output.receiver_hex,
            txid: output.txid,
            pool: output.pool,
            action_index: output.output_index,
            mined_height,
            mined_hash,
            output_id: output.output_id,
            confirmations,
            // The legacy qualification command observes only the scanner-owned
            // projection and not an unspent-note balance; maturity is checked by
            // its explicit confirmation requirement below.
            confirmations_until_spendable: if confirmations >= 10 { 0 } else { 1 },
        }));
    }
    Ok(None)
}

fn validate_receipt(
    receipt: &PrivateReceipt,
    allocation: &PrivateAllocation,
    confirmations: Option<u32>,
    eligible: bool,
) -> Result<(), &'static str> {
    if receipt.amount_zat != REQUIRED_AMOUNT_ZAT
        || receipt.allocation_receiver_hex != allocation.orchard_receiver_hex
        || receipt.receiver_hex != allocation.orchard_receiver_hex
        || !crate::projection::is_receipt_pool(&receipt.pool)
        || receipt.txid.is_empty()
        || receipt.mined_hash.is_empty()
    {
        return Err("scanner receipt fields are invalid");
    }
    if confirmations.is_some_and(|expected| receipt.confirmations != expected) {
        return Err("scanner receipt confirmations are invalid");
    }
    if (receipt.confirmations_until_spendable == 0) != eligible {
        return Err("scanner receipt eligibility is invalid");
    }
    Ok(())
}

fn ensure_persisted_allocations(
    db: &Db,
    ufvk: &UnifiedFullViewingKey,
    state: &PrivateState,
) -> Result<(), &'static str> {
    validate_distinct_persisted_allocations(&PersistedAllocations::new(
        AllocationIdentity::new(state.allocation_a.orchard_receiver_hex.clone()),
        AllocationIdentity::new(state.allocation_b.orchard_receiver_hex.clone()),
    ))?;
    let account = db
        .get_account_for_ufvk(ufvk)
        .map_err(|_| "view-only wallet account lookup failed")?
        .ok_or("view-only wallet account is missing")?;
    let known = db
        .list_addresses(account.id())
        .map_err(|_| "wallet allocations cannot be read")?
        .into_iter()
        .filter_map(|info| match info.address() {
            zcash_keys::address::Address::Unified(address) => {
                external_orchard_receiver_hex(address)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if !known
        .iter()
        .any(|receiver_hex| receiver_hex == &state.allocation_a.orchard_receiver_hex)
        || !known
            .iter()
            .any(|receiver_hex| receiver_hex == &state.allocation_b.orchard_receiver_hex)
    {
        return Err("persisted wallet allocation is missing");
    }
    Ok(())
}

pub async fn run(
    config_path: &Path,
    endpoint: &str,
    params: LocalNetwork,
    stage: Stage,
) -> Result<(), &'static str> {
    let config = open_private_config(config_path)?;
    let _writer_lease = WriterLease::acquire(
        config
            .parent
            .ensure_file(&writer_lease_name(&config.name))
            .map_err(|_| "scanner writer lease is unavailable safely")?,
    )?;
    let ufvk = decode_orchard_ufvk(&params, "regtest", &config.config.ufvk)?;
    match stage {
        Stage::Prepare => {
            prepare(
                endpoint,
                config.config.birthday,
                params,
                ufvk,
                &config.parent,
                &config.name,
            )
            .await
        }
        Stage::BeforeTen => {
            let paths = open_state_paths(&config.parent, &config.name)?;
            sync_phase(endpoint, params, ufvk, paths, false).await
        }
        Stage::AtTen => {
            let paths = open_state_paths(&config.parent, &config.name)?;
            sync_phase(endpoint, params, ufvk, paths, true).await
        }
        Stage::VerifyRestart => {
            let paths = open_state_paths(&config.parent, &config.name)?;
            verify_restart(endpoint, params, ufvk, paths).await
        }
    }
}

async fn prepare(
    endpoint: &str,
    birthday_height: u32,
    params: LocalNetwork,
    ufvk: UnifiedFullViewingKey,
    parent: &PrivateDir,
    config_name: &str,
) -> Result<(), &'static str> {
    let prior_height = birthday_height
        .checked_sub(1)
        .ok_or("scanner birthday cannot be genesis")?;
    let paths = create_state_paths(parent, config_name)?;
    crate::rpc::qualify_lightwalletd(endpoint)
        .await
        .map_err(|_| "lightwalletd RPC matrix failed")?;
    let mut client = client(endpoint).await?;
    let tree_state = within_deadline(
        GRPC_RPC_DEADLINE,
        client.get_tree_state(BlockId {
            height: u64::from(prior_height),
            hash: vec![],
        }),
    )
    .await
    .map_err(|_| "scanner birthday tree state timed out")?
    .map_err(|_| "scanner birthday tree state failed")?
    .into_inner();
    let birthday = AccountBirthday::from_treestate(tree_state, None)
        .map_err(|_| "scanner birthday is invalid")?;
    let mut db = open_wallet(&paths.root, params)?;
    let account = import_view_only_account(&mut db, "receipt-scanner", &ufvk, &birthday)
        .map_err(|_| "view-only wallet import failed")?;
    let allocation_a_address = allocate_next_external_orchard_address(&mut db, account.id())
        .map_err(|_| "wallet allocation A failed")?
        .ok_or("wallet allocation A is unavailable")?;
    let allocation_b_address = allocate_next_external_orchard_address(&mut db, account.id())
        .map_err(|_| "wallet allocation B failed")?
        .ok_or("wallet allocation B is unavailable")?;
    let state = PrivateState {
        allocation_a: PrivateAllocation {
            unified_address: allocation_a_address.encode(&params),
            orchard_receiver_hex: external_orchard_receiver_hex(&allocation_a_address)
                .ok_or("wallet allocation A has no Orchard receiver")?,
        },
        allocation_b: PrivateAllocation {
            unified_address: allocation_b_address.encode(&params),
            orchard_receiver_hex: external_orchard_receiver_hex(&allocation_b_address)
                .ok_or("wallet allocation B has no Orchard receiver")?,
        },
        before_ten: None,
        at_ten: None,
    };
    ensure_persisted_allocations(&db, &ufvk, &state)?;
    write_private_state(&paths.root, &state)
}

async fn sync_phase(
    endpoint: &str,
    params: LocalNetwork,
    ufvk: UnifiedFullViewingKey,
    paths: StatePaths,
    at_ten: bool,
) -> Result<(), &'static str> {
    paths
        .root
        .verify()
        .map_err(|_| "scanner state permissions are unsafe")?;
    let mut state = read_private_state(&paths.root)?;
    let cache = PersistentBlockCache::open_in(&paths.root, CACHE_DIRECTORY)
        .map_err(|_| "compact block cache failed")?;
    let wallet_path = paths
        .root
        .proc_path(WALLET_FILE)
        .map_err(|_| "wallet database path is invalid")?;
    let mut db = open_wallet(&paths.root, params)?;
    ensure_persisted_allocations(&db, &ufvk, &state)?;
    let mut client = client(endpoint).await?;
    within_deadline(
        SYNC_DEADLINE,
        sync::run(&mut client, &params, &cache, &mut db, SYNC_BATCH_SIZE),
    )
    .await
    .map_err(|_| "wallet synchronization timed out")?
    .map_err(|_| "wallet synchronization failed")?;
    let latest = within_deadline(GRPC_RPC_DEADLINE, client.get_latest_block(ChainSpec {}))
        .await
        .map_err(|_| "scanner tip retrieval timed out")?
        .map_err(|_| "scanner tip retrieval failed")?
        .into_inner();
    let target = BlockHeight::from_u32(
        u32::try_from(latest.height)
            .map_err(|_| "scanner tip is invalid")?
            .checked_add(1)
            .ok_or("scanner tip is invalid")?,
    );
    let received_a = project_receipt(
        &db,
        &wallet_path,
        &params,
        &ufvk,
        &state.allocation_a,
        target,
    )?
    .ok_or("scanner did not receive allocation A")?;
    if project_receipt(
        &db,
        &wallet_path,
        &params,
        &ufvk,
        &state.allocation_b,
        target,
    )?
    .is_some()
    {
        return Err("scanner received allocation B unexpectedly");
    }
    if at_ten {
        let before = state
            .before_ten
            .as_ref()
            .ok_or("scanner before-ten result is missing")?;
        validate_receipt(&received_a, &state.allocation_a, Some(10), true)?;
        validate_receipt_transition(&ReceiptTransition::new(
            before.observation(),
            received_a.observation(),
        ))?;
        state.at_ten = Some(received_a);
    } else {
        if state.before_ten.is_some() || state.at_ten.is_some() {
            return Err("scanner before-ten result already exists");
        }
        validate_receipt(&received_a, &state.allocation_a, None, false)?;
        if received_a.confirmations >= 10 {
            return Err("scanner before-ten result is already mature");
        }
        state.before_ten = Some(received_a);
    }
    write_private_state(&paths.root, &state)
}

async fn verify_restart(
    endpoint: &str,
    params: LocalNetwork,
    ufvk: UnifiedFullViewingKey,
    paths: StatePaths,
) -> Result<(), &'static str> {
    paths
        .root
        .verify()
        .map_err(|_| "scanner state permissions are unsafe")?;
    let state = read_private_state(&paths.root)?;
    let before = state
        .before_ten
        .as_ref()
        .ok_or("scanner before-ten result is missing")?;
    let after = state
        .at_ten
        .as_ref()
        .ok_or("scanner ten-confirmation result is missing")?;
    validate_receipt_transition(&ReceiptTransition::new(
        before.observation(),
        after.observation(),
    ))?;
    let wallet_path = paths
        .root
        .proc_path(WALLET_FILE)
        .map_err(|_| "wallet database path is invalid")?;
    let mut db = open_wallet(&paths.root, params)?;
    ensure_persisted_allocations(&db, &ufvk, &state)?;
    let cache = PersistentBlockCache::open_in(&paths.root, CACHE_DIRECTORY)
        .map_err(|_| "compact block cache failed")?;
    let mut latest_client = client(endpoint).await?;
    within_deadline(
        SYNC_DEADLINE,
        sync::run(
            &mut latest_client,
            &params,
            &cache,
            &mut db,
            SYNC_BATCH_SIZE,
        ),
    )
    .await
    .map_err(|_| "wallet restart synchronization timed out")?
    .map_err(|_| "wallet restart synchronization failed")?;
    let latest = within_deadline(
        GRPC_RPC_DEADLINE,
        latest_client.get_latest_block(ChainSpec {}),
    )
    .await
    .map_err(|_| "scanner restart tip retrieval timed out")?
    .map_err(|_| "scanner restart tip retrieval failed")?
    .into_inner();
    let target = BlockHeight::from_u32(
        u32::try_from(latest.height)
            .map_err(|_| "scanner restart tip is invalid")?
            .checked_add(1)
            .ok_or("scanner restart tip is invalid")?,
    );
    let restarted = project_receipt(
        &db,
        &wallet_path,
        &params,
        &ufvk,
        &state.allocation_a,
        target,
    )?
    .ok_or("scanner restart did not retain allocation A receipt")?;
    if project_receipt(
        &db,
        &wallet_path,
        &params,
        &ufvk,
        &state.allocation_b,
        target,
    )?
    .is_some()
    {
        return Err("scanner restart found allocation B receipt");
    }
    validate_receipt(&restarted, &state.allocation_a, Some(10), true)?;
    let canonical_block = within_deadline(
        GRPC_RPC_DEADLINE,
        latest_client.get_block(BlockId {
            height: u64::from(restarted.mined_height),
            hash: vec![],
        }),
    )
    .await
    .map_err(|_| "scanner canonical block retrieval timed out")?
    .map_err(|_| "scanner canonical block retrieval failed")?
    .into_inner();
    if hex::encode(canonical_block.hash) != restarted.mined_hash {
        return Err("scanner receipt block is no longer canonical");
    }
    if restarted.output_id != after.output_id
        || restarted.txid != after.txid
        || restarted.action_index != after.action_index
        || restarted.receiver_hex != after.receiver_hex
        || restarted.mined_height != after.mined_height
        || restarted.mined_hash != after.mined_hash
    {
        return Err("scanner restart changed receipt identity");
    }
    Ok(())
}
