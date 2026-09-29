//! Coordinated-restore semantics for scanner-owned state.
//!
//! A scanner state directory is bound to the application database that lives
//! in it: `scanner.sqlite` records a random token plus the directory identity,
//! and a scanner-owned marker file (never a coordinated-backup role) holds the
//! same token. A restored copy therefore always presents a mismatch, and the
//! scanner refuses to open until an operator runs `restore-ack --new-epoch`.
//! The acknowledgement records a new source epoch whose generation floor is
//! strictly above every generation the restored database knows and above a
//! wall-clock floor, revokes the restored evidence so the first snapshot after
//! restore is not release-eligible, and only then re-binds the state.
//!
//! Everything here reads or writes only scanner-owned tables; wallet-owned
//! state is reached solely through the pinned wallet API.

use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::{
    allocate::AllocationJournal,
    config::{
        acquire_config_writer_lease, decode_orchard_ufvk, open_private_config, open_runtime_paths,
        persist_or_verify_restored_birthday_attestation,
    },
    private_fs::PrivateDir,
    snapshot::SnapshotStore,
    wallet::{find_view_only_account, open_persistent_wallet_db, seed_allocation_watermark},
};
use zcash_client_backend::data_api::Account as _;

const STATE_MARKER_FILE: &str = "state-binding";
const APPLICATION_DB_FILE: &str = "scanner.sqlite";
const WALLET_DB_FILE: &str = "wallet.sqlite";
/// Generations after an acknowledged restore start at or above
/// `unix_seconds * GENERATION_FLOOR_SCALE`, which stays below 2^53.
const GENERATION_FLOOR_SCALE: u64 = 1_000_000;
/// Upper bound on `restore-ack --reserve-gap`: generous for any realistic
/// post-backup allocation burst, small enough to never exhaust the index space.
pub const MAX_RESERVE_GAP: u64 = 1_000_000;
/// Operator-facing suggestion printed by the restore tooling.
pub const SUGGESTED_RESERVE_GAP: u64 = 1_000;

/// `backup-info` refuses state that no binding-aware scanner has opened: such
/// an archive would restore without being detected as a restore.
pub const UNBOUND_BACKUP: &str = "scanner state is not bound; restart scanner once before backup";

pub(crate) const RESTORE_REQUIRED: &str =
    "scanner state was restored; run restore-ack --new-epoch --reserve-gap N before serving";

/// Creates the scanner-owned restore tables. Idempotent.
pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), &'static str> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS state_binding (
               id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
               token TEXT NOT NULL,
               dir_device INTEGER NOT NULL,
               dir_inode INTEGER NOT NULL,
               account_id TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS source_epochs (
               epoch INTEGER PRIMARY KEY NOT NULL,
               generation_floor INTEGER NOT NULL,
               prior_generation INTEGER NOT NULL,
               acknowledged_at INTEGER NOT NULL
             );",
        )
        .map_err(|_| "scanner restore state cannot initialize")
}

/// The lowest generation any snapshot of the current epoch may use.
pub(crate) fn generation_floor(connection: &Connection) -> Result<u64, &'static str> {
    let floor: Option<i64> = connection
        .query_row(
            "SELECT MAX(generation_floor) FROM source_epochs",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "scanner source epoch is unavailable")?;
    Ok(floor.map_or(0, |floor| u64::try_from(floor).unwrap_or(0)))
}

#[derive(Debug, PartialEq, Eq)]
enum Binding {
    /// No binding row and no marker: fresh or pre-binding state.
    Unbound,
    Matches,
    Restored,
}

struct StoredBinding {
    token: String,
    device: u64,
    inode: u64,
}

fn stored_binding(connection: &Connection) -> Result<Option<StoredBinding>, &'static str> {
    connection
        .query_row(
            "SELECT token, dir_device, dir_inode FROM state_binding WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "scanner state binding is unavailable")?
        .map(|(token, device, inode)| {
            Ok(StoredBinding {
                token,
                device: u64::try_from(device).map_err(|_| "scanner state binding is invalid")?,
                inode: u64::try_from(inode).map_err(|_| "scanner state binding is invalid")?,
            })
        })
        .transpose()
}

fn classify(state: &PrivateDir, connection: &Connection) -> Result<Binding, &'static str> {
    let marker = state.read_file(STATE_MARKER_FILE).ok();
    match (stored_binding(connection)?, marker) {
        (None, None) => Ok(Binding::Unbound),
        (Some(stored), Some(marker)) => {
            let (device, inode) = state.identity()?;
            if marker == stored.token.as_bytes() && stored.device == device && stored.inode == inode
            {
                Ok(Binding::Matches)
            } else {
                Ok(Binding::Restored)
            }
        }
        // Either file came from another state directory.
        _ => Ok(Binding::Restored),
    }
}

fn application_connection(state: &PrivateDir) -> Result<Connection, &'static str> {
    let path = state
        .proc_path(APPLICATION_DB_FILE)
        .map_err(|_| "scanner application path is invalid")?;
    let connection = Connection::open(path).map_err(|_| "scanner application state cannot open")?;
    ensure_schema(&connection)?;
    Ok(connection)
}

/// Fails closed when this state directory holds restored scanner state that
/// has not been explicitly acknowledged. Call before any writable open.
pub(crate) fn verify_state_binding(state: &PrivateDir) -> Result<(), &'static str> {
    if state.file_identity(APPLICATION_DB_FILE).is_err() {
        // A marker without its database is a partial restore.
        return match state.read_file(STATE_MARKER_FILE) {
            Ok(_) => Err(RESTORE_REQUIRED),
            Err(_) => Ok(()),
        };
    }
    match classify(state, &application_connection(state)?)? {
        Binding::Restored => Err(RESTORE_REQUIRED),
        Binding::Unbound | Binding::Matches => Ok(()),
    }
}

/// Binds unbound state to this directory. The database row is written before
/// the marker, so a crash in between fails closed and is recoverable through
/// `restore-ack`.
pub(crate) fn bind_state(state: &PrivateDir, account_id: &str) -> Result<(), &'static str> {
    let connection = application_connection(state)?;
    match classify(state, &connection)? {
        Binding::Matches => Ok(()),
        Binding::Restored => Err(RESTORE_REQUIRED),
        Binding::Unbound => write_binding(state, &connection, account_id),
    }
}

fn write_binding(
    state: &PrivateDir,
    connection: &Connection,
    account_id: &str,
) -> Result<(), &'static str> {
    let mut token = [0_u8; 32];
    getrandom::fill(&mut token).map_err(|_| "scanner state binding cannot be generated")?;
    let token = hex::encode(token);
    let (device, inode) = state.identity()?;
    connection
        .execute(
            "INSERT INTO state_binding (id, token, dir_device, dir_inode, account_id)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET token = excluded.token,
               dir_device = excluded.dir_device, dir_inode = excluded.dir_inode,
               account_id = excluded.account_id",
            params![
                token,
                i64::try_from(device).map_err(|_| "scanner state identity is invalid")?,
                i64::try_from(inode).map_err(|_| "scanner state identity is invalid")?,
                account_id
            ],
        )
        .map_err(|_| "scanner state binding cannot persist")?;
    state
        .write_file_atomic(STATE_MARKER_FILE, token.as_bytes())
        .map_err(|_| "scanner state binding cannot persist")
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Records a new source epoch whose floor is above every restored generation
/// and above the wall-clock floor. Returns the recorded floor.
fn record_new_epoch(connection: &mut Connection, now: u64) -> Result<u64, &'static str> {
    let transaction = connection
        .transaction()
        .map_err(|_| "scanner source epoch cannot persist")?;
    let prior: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(generation), 0) FROM snapshots",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "scanner snapshot history is unavailable")?;
    let prior = u64::try_from(prior).map_err(|_| "snapshot generation is invalid")?;
    let existing = generation_floor(&transaction)?;
    let floor = prior
        .max(existing)
        .checked_add(1)
        .ok_or("snapshot generation overflow")?
        .max(
            now.checked_mul(GENERATION_FLOOR_SCALE)
                .ok_or("snapshot generation overflow")?,
        );
    let floor_sql = i64::try_from(floor).map_err(|_| "snapshot generation overflow")?;
    let epoch: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(epoch), 0) + 1 FROM source_epochs",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "scanner source epoch is unavailable")?;
    transaction
        .execute(
            "INSERT INTO source_epochs (epoch, generation_floor, prior_generation, acknowledged_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                epoch,
                floor_sql,
                i64::try_from(prior).map_err(|_| "snapshot generation is invalid")?,
                i64::try_from(now).map_err(|_| "scanner clock is invalid")?
            ],
        )
        .map_err(|_| "scanner source epoch cannot persist")?;
    transaction
        .commit()
        .map_err(|_| "scanner source epoch cannot persist")?;
    Ok(floor)
}

/// Parses a `--reserve-gap` value: a positive decimal integer no larger than
/// [`MAX_RESERVE_GAP`].
pub fn parse_reserve_gap(value: &str) -> Result<u64, &'static str> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("reserve gap must be a positive integer");
    }
    match value.parse::<u64>() {
        Ok(gap) if (1..=MAX_RESERVE_GAP).contains(&gap) => Ok(gap),
        _ => Err("reserve gap is out of range"),
    }
}

/// Adds `gap` to a little-endian 11-byte diversifier index (hex).
fn advance_index(index: &str, gap: u64) -> Result<String, &'static str> {
    let bytes = hex::decode(index).map_err(|_| "allocation index is invalid")?;
    if bytes.len() != 11 {
        return Err("allocation index is invalid");
    }
    let mut value = [0_u8; 16];
    value[..11].copy_from_slice(&bytes);
    let advanced = u128::from_le_bytes(value)
        .checked_add(u128::from(gap))
        .filter(|advanced| *advanced < (1_u128 << 88))
        .ok_or("allocation index exhausted")?;
    Ok(hex::encode(&advanced.to_le_bytes()[..11]))
}

/// Operator acknowledgement of a restored scanner state (`restore-ack
/// --new-epoch --reserve-gap N`). It never imports a key: the restored wallet
/// must already hold the configured view-only account.
///
/// Receivers the original scanner handed out after the backup are recorded
/// nowhere in the restored state, so the reserved high-water mark is advanced
/// by the operator's `reserve_gap` past the restored mark (never lowered):
/// those indices are burned and never reissued.
pub fn acknowledge_restore(config_path: &Path, reserve_gap: u64) -> Result<(), &'static str> {
    if !(1..=MAX_RESERVE_GAP).contains(&reserve_gap) {
        return Err("reserve gap is out of range");
    }
    let _writer_lease = acquire_config_writer_lease(config_path)?;
    let runtime = open_runtime_paths(config_path)?;
    runtime
        .state
        .file_identity(APPLICATION_DB_FILE)
        .map_err(|_| "restored scanner application state is missing")?;
    runtime
        .state
        .file_identity(WALLET_DB_FILE)
        .map_err(|_| "restored scanner wallet state is missing")?;
    let mut connection = application_connection(&runtime.state)?;
    if classify(&runtime.state, &connection)? != Binding::Restored {
        return Err("scanner state has no restore to acknowledge");
    }
    let ufvk = decode_orchard_ufvk(&runtime.params, &runtime.chain.network, &runtime.ufvk)?;
    persist_or_verify_restored_birthday_attestation(&runtime.state, &runtime.birthday_attestation)?;
    let wallet = open_persistent_wallet_db(&runtime.wallet_path, runtime.params)?;
    let account = find_view_only_account(&wallet, &ufvk, &runtime.birthday)?
        .ok_or("restored wallet does not hold the configured view-only account")?;
    let account_id = account.id().expose_uuid().to_string();
    let foreign: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM allocation_watermarks WHERE account_id <> ?1",
            [&account_id],
            |row| row.get(0),
        )
        .map_err(|_| "restored allocation state is unavailable")?;
    if foreign != 0 {
        return Err("restored allocation state belongs to another account");
    }
    let allocations = AllocationJournal::open(&runtime.application_db_path)?;
    // Only ever raises the reserved high-water mark.
    seed_allocation_watermark(&wallet, account.id(), &account_id, &allocations)?;
    let restored_mark = allocations
        .high_water_mark(&account_id)?
        .ok_or("restored scanner has no reserved allocations")?;
    allocations.seed_high_water_mark(&account_id, advance_index(&restored_mark, reserve_gap)?)?;
    drop(allocations);
    let snapshots = SnapshotStore::open(
        &runtime.application_db_path,
        &runtime.source_id,
        runtime.chain.clone(),
        &account_id,
    )?;
    let now = now_seconds();
    record_new_epoch(&mut connection, now)?;
    // Freshness reset: restored evidence is revoked under the new epoch; only
    // a later coherent scan pass can publish a release-eligible generation.
    if let Ok(current) = snapshots.current() {
        snapshots.invalidate(current.tip.height, current.tip.hash, now)?;
    }
    drop(snapshots);
    write_binding(&runtime.state, &connection, &account_id)
}

/// Non-secret facts a coordinated backup manifest needs. No UFVK, receiver,
/// address, or payment URI is ever read into this structure.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub account_id: String,
    pub source_id: String,
    pub network: String,
    /// Highest burned diversifier index (little-endian 88-bit) as decimal.
    pub reserved_high_water: String,
    pub allocation_count: u64,
}

/// Reads backup facts from `scanner.sqlite` only, without creating state.
pub fn backup_info(config_path: &Path) -> Result<BackupInfo, &'static str> {
    let opened = open_private_config(config_path)?;
    let runtime = opened
        .config
        .runtime
        .as_ref()
        .ok_or("scanner runtime configuration is missing")?;
    runtime.chain.validate()?;
    let state = opened
        .parent
        .open_child(&format!(".{}.live-state", opened.name))
        .map_err(|_| "scanner runtime state is unavailable")?;
    state
        .file_identity(APPLICATION_DB_FILE)
        .map_err(|_| "scanner application state is unavailable")?;
    let path = state
        .proc_path(APPLICATION_DB_FILE)
        .map_err(|_| "scanner application path is invalid")?;
    let connection = Connection::open(path).map_err(|_| "scanner application state cannot open")?;
    let bound: Option<String> = connection
        .query_row(
            "SELECT account_id FROM state_binding WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "scanner state binding is unavailable")?;
    let Some(bound) = bound else {
        return Err(UNBOUND_BACKUP);
    };
    let watermarks: Vec<(String, String)> = connection
        .prepare("SELECT account_id, burned_index FROM allocation_watermarks")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .map_err(|_| "scanner allocation state is unavailable")?;
    if !watermarks.iter().all(|(account, _)| *account == bound) {
        return Err("scanner account identity is unavailable");
    }
    let account_id = bound;
    let reserved_high_water = match watermarks.first() {
        Some((_, index)) => le_index_decimal(index)?,
        None => return Err("scanner has no reserved allocations"),
    };
    let allocation_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM allocations", [], |row| row.get(0))
        .map_err(|_| "scanner allocation state is unavailable")?;
    Ok(BackupInfo {
        account_id,
        source_id: runtime.source_id.clone(),
        network: runtime.chain.network.clone(),
        reserved_high_water,
        allocation_count: u64::try_from(allocation_count)
            .map_err(|_| "scanner allocation state is invalid")?,
    })
}

fn le_index_decimal(index: &str) -> Result<String, &'static str> {
    let bytes = hex::decode(index).map_err(|_| "allocation index is invalid")?;
    if bytes.len() != 11 {
        return Err("allocation index is invalid");
    }
    let mut value = [0_u8; 16];
    value[..11].copy_from_slice(&bytes);
    Ok(u128::from_le_bytes(value).to_string())
}

#[cfg(test)]
mod tests {
    use super::{MAX_RESERVE_GAP, advance_index, le_index_decimal, parse_reserve_gap};

    #[test]
    fn reserve_gap_is_positive_and_bounded() {
        assert_eq!(parse_reserve_gap("1"), Ok(1));
        assert_eq!(parse_reserve_gap("1000"), Ok(1000));
        assert_eq!(
            parse_reserve_gap(&MAX_RESERVE_GAP.to_string()),
            Ok(MAX_RESERVE_GAP)
        );
        for bad in [
            "",
            "0",
            "-1",
            "+5",
            "1e3",
            " 5",
            "1000001",
            "99999999999999999999",
        ] {
            assert!(parse_reserve_gap(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn advance_index_adds_little_endian_and_refuses_exhaustion() {
        let start = "ff".to_owned() + &"00".repeat(10);
        assert_eq!(
            le_index_decimal(&advance_index(&start, 2).unwrap()),
            Ok("257".to_owned())
        );
        assert!(advance_index(&"ff".repeat(11), 1).is_err());
    }

    #[test]
    fn diversifier_index_is_little_endian_decimal() {
        assert_eq!(le_index_decimal(&"00".repeat(11)), Ok("0".to_owned()));
        assert_eq!(
            le_index_decimal(&("0201".to_owned() + &"00".repeat(9))),
            Ok("258".to_owned())
        );
        assert!(le_index_decimal("00").is_err());
    }
}
