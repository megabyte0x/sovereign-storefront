//! Exact-version-coupled, read-only projection of the pinned Zakura wallet.
//!
//! This is the sole runtime module allowed to inspect wallet-owned SQLite
//! objects. It opens the wallet read-only, validates the rc5 schema and
//! migrations, and returns only normalized scanner model values.

use std::{fmt, path::Path};

use rusqlite::{Connection, OpenFlags};
use zcash_keys::address::Address;
use zcash_protocol::local_consensus::LocalNetwork;

const EXTERNAL_SCOPE: i64 = 0;
const INTERNAL_SCOPE: i64 = 1;

// `receiving_key_scopes`, `full_account_ids`, and `orchard_received_notes`
// from the Cargo-resolved zakura-client-sqlite 0.1.0-rc5 migration graph.
const REQUIRED_MIGRATIONS: [[u8; 16]; 3] = [
    [
        0xee, 0x89, 0xed, 0x2b, 0xc1, 0xc2, 0x42, 0x1e, 0x9e, 0x98, 0xc1, 0xe3, 0xe5, 0x4a, 0x7f,
        0xc2,
    ],
    [
        0x6d, 0x02, 0xec, 0x76, 0x87, 0x20, 0x4c, 0xc6, 0xb6, 0x46, 0xc4, 0xe2, 0xce, 0x69, 0x22,
        0x1c,
    ],
    [
        0x51, 0xd7, 0xa2, 0x73, 0xaa, 0x19, 0x41, 0x09, 0x93, 0x25, 0x80, 0xe4, 0xa5, 0x54, 0x50,
        0x48,
    ],
];

const REQUIRED_OBJECTS: &[(&str, &str, &[&str])] = &[
    (
        "v_received_outputs",
        "view",
        &[
            "id_within_pool_table",
            "transaction_id",
            "pool",
            "output_index",
            "account_id",
            "value",
            "address_id",
        ],
    ),
    (
        "transactions",
        "table",
        &[
            "id_tx",
            "txid",
            "block",
            "mined_height",
            "min_observed_height",
        ],
    ),
    ("accounts", "table", &["id", "uuid"]),
    (
        "orchard_received_notes",
        "table",
        &[
            "id",
            "transaction_id",
            "action_index",
            "account_id",
            "recipient_key_scope",
            "address_id",
        ],
    ),
    (
        "addresses",
        "table",
        &["id", "account_id", "key_scope", "address"],
    ),
    ("blocks", "table", &["height", "hash"]),
    (
        "orchard_received_note_spends",
        "table",
        &["orchard_received_note_id", "transaction_id"],
    ),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectionOrigin {
    Received,
    Sent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectedOutput {
    pub output_id: String,
    pub txid: String,
    pub pool: String,
    pub output_index: u32,
    pub account_id: String,
    pub scope: String,
    pub receiver_hex: String,
    pub amount_zat: String,
    pub mined: Option<(u32, String)>,
    /// Scanner-owned publication assigns and persists this field. Wallet rows
    /// have no scanner-observation timestamp.
    pub first_seen_at: u64,
    pub origin: ProjectionOrigin,
    pub spent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletHistory {
    pub outputs: Vec<ProjectedOutput>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionError {
    Unavailable,
    UnresolvedCandidate,
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "wallet history projection is unavailable",
            Self::UnresolvedCandidate => "wallet history contains an unresolved external candidate",
        })
    }
}

impl std::error::Error for ProjectionError {}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinedReceipt {
    pub height: u32,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub output_id: String,
    pub txid: String,
    pub pool: String,
    pub output_index: u32,
    pub account_id: String,
    pub scope: String,
    pub receiver_hex: String,
    pub amount_zat: String,
    pub first_seen_at: u64,
    pub mined: Option<MinedReceipt>,
    pub canonical: bool,
}

/// Reads all selected-account Orchard received rows, including spent and
/// unmined rows, from a library-migrated wallet. No partial projection is
/// returned: malformed/missing ownership data is an unavailable snapshot.
pub fn read_wallet_history(
    wallet_path: &Path,
    params: &LocalNetwork,
    account_id: &str,
) -> Result<WalletHistory, ProjectionError> {
    let account_uuid = decode_account_uuid(account_id)?;
    let connection = Connection::open_with_flags(wallet_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| ProjectionError::Unavailable)?;
    // This is connection-local enforcement in addition to read-only open flags.
    connection
        .execute_batch("PRAGMA query_only = ON")
        .map_err(|_| ProjectionError::Unavailable)?;
    validate_schema(&connection)?;

    let selected_account: i64 = connection
        .query_row(
            "SELECT id FROM accounts WHERE uuid = ?1",
            [account_uuid],
            |row| row.get(0),
        )
        .map_err(|_| ProjectionError::Unavailable)?;

    let mut statement = connection
        .prepare(
            "SELECT t.txid, ro.output_index, ro.value,
                    n.recipient_key_scope, ad.key_scope, ad.account_id, ad.address,
                    t.block, t.mined_height, b.hash,
                    EXISTS(
                        SELECT 1 FROM orchard_received_note_spends AS spend
                        WHERE spend.orchard_received_note_id = n.id
                    ) AS spent
             FROM v_received_outputs AS ro
             JOIN transactions AS t ON t.id_tx = ro.transaction_id
             JOIN accounts AS a ON a.id = ro.account_id
             LEFT JOIN orchard_received_notes AS n
               ON n.id = ro.id_within_pool_table
              AND n.transaction_id = ro.transaction_id
              AND n.action_index = ro.output_index
              AND n.account_id = ro.account_id
             LEFT JOIN addresses AS ad ON ad.id = ro.address_id
             LEFT JOIN blocks AS b ON b.height = t.block
             WHERE ro.account_id = ?1 AND ro.pool = 3
             ORDER BY t.txid, ro.output_index",
        )
        .map_err(|_| ProjectionError::Unavailable)?;
    let rows = statement
        .query_map([selected_account], |row| {
            Ok(WalletRow {
                txid: row.get(0)?,
                output_index: row.get(1)?,
                value: row.get(2)?,
                note_scope: row.get(3)?,
                address_scope: row.get(4)?,
                address_account_id: row.get(5)?,
                address: row.get(6)?,
                scanned_block_height: row.get(7)?,
                mined_height: row.get(8)?,
                scanned_block_hash: row.get(9)?,
                spent: row.get::<_, i64>(10)? != 0,
            })
        })
        .map_err(|_| ProjectionError::Unavailable)?;

    let mut outputs = Vec::new();
    for row in rows {
        let row = row.map_err(|_| ProjectionError::Unavailable)?;
        if row.note_scope == Some(INTERNAL_SCOPE) {
            // Internal notes do not require an address row and cannot become
            // receiver-attributable receipts.
            continue;
        }
        let (Some(EXTERNAL_SCOPE), Some(EXTERNAL_SCOPE), Some(address_account_id), Some(address)) = (
            row.note_scope,
            row.address_scope,
            row.address_account_id,
            row.address.as_deref(),
        ) else {
            return Err(ProjectionError::UnresolvedCandidate);
        };
        if address_account_id != selected_account {
            return Err(ProjectionError::UnresolvedCandidate);
        }
        let receiver_hex = external_orchard_receiver(params, address)
            .ok_or(ProjectionError::UnresolvedCandidate)?;
        let txid: [u8; 32] = row
            .txid
            .as_slice()
            .try_into()
            .map_err(|_| ProjectionError::Unavailable)?;
        let output_index =
            u32::try_from(row.output_index).map_err(|_| ProjectionError::Unavailable)?;
        let amount = u64::try_from(row.value)
            .ok()
            .filter(|amount| *amount > 0)
            .ok_or(ProjectionError::Unavailable)?;
        let mined = match (
            row.scanned_block_height,
            row.mined_height,
            row.scanned_block_hash,
        ) {
            (Some(block), Some(mined), Some(hash)) if block == mined => Some((
                u32::try_from(block).map_err(|_| ProjectionError::Unavailable)?,
                block_hash_hex(hash)?,
            )),
            // A retrieved `mined_height` without a scanned block link is not
            // canonical mining evidence. Keep the incoming identity/history.
            (None, _, None) | (None, _, Some(_)) | (Some(_), None, _) => None,
            _ => return Err(ProjectionError::Unavailable),
        };
        let txid = hex::encode(txid);
        outputs.push(ProjectedOutput {
            output_id: format!("{txid}:orchard:{output_index}"),
            txid,
            pool: "orchard".to_owned(),
            output_index,
            account_id: account_id.to_owned(),
            scope: "external".to_owned(),
            receiver_hex,
            amount_zat: amount.to_string(),
            mined,
            first_seen_at: 0,
            origin: ProjectionOrigin::Received,
            spent: row.spent,
        });
    }
    Ok(WalletHistory { outputs })
}

struct WalletRow {
    txid: Vec<u8>,
    output_index: i64,
    value: i64,
    note_scope: Option<i64>,
    address_scope: Option<i64>,
    address_account_id: Option<i64>,
    address: Option<String>,
    scanned_block_height: Option<i64>,
    mined_height: Option<i64>,
    scanned_block_hash: Option<Vec<u8>>,
    spent: bool,
}

fn validate_schema(connection: &Connection) -> Result<(), ProjectionError> {
    for migration in REQUIRED_MIGRATIONS {
        let present: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM schemer_migrations WHERE id = ?1",
                [migration.as_slice()],
                |row| row.get(0),
            )
            .ok();
        if present != Some(1) {
            return Err(ProjectionError::Unavailable);
        }
    }
    for (object, expected_kind, required_columns) in REQUIRED_OBJECTS {
        let found_kind: Option<String> = connection
            .query_row(
                "SELECT type FROM sqlite_master WHERE name = ?1",
                [object],
                |row| row.get(0),
            )
            .ok();
        if found_kind.as_deref() != Some(*expected_kind)
            || !has_columns(connection, object, required_columns)?
        {
            return Err(ProjectionError::Unavailable);
        }
    }
    Ok(())
}

fn has_columns(
    connection: &Connection,
    object: &str,
    required_columns: &[&str],
) -> Result<bool, ProjectionError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({object})"))
        .map_err(|_| ProjectionError::Unavailable)?;
    let found = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| ProjectionError::Unavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ProjectionError::Unavailable)?;
    Ok(required_columns
        .iter()
        .all(|required| found.iter().any(|column| column == required)))
}

fn decode_account_uuid(account_id: &str) -> Result<Vec<u8>, ProjectionError> {
    let compact = account_id.replace('-', "");
    if account_id.len() != 36
        || [8, 13, 18, 23]
            .iter()
            .any(|offset| account_id.as_bytes()[*offset] != b'-')
        || compact.len() != 32
        || !compact.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ProjectionError::Unavailable);
    }
    hex::decode(compact).map_err(|_| ProjectionError::Unavailable)
}

fn external_orchard_receiver(params: &LocalNetwork, address: &str) -> Option<String> {
    let Address::Unified(address) = Address::decode(params, address)? else {
        return None;
    };
    address
        .orchard()
        .map(|receiver| hex::encode(receiver.to_raw_address_bytes()))
}

fn block_hash_hex(hash: Vec<u8>) -> Result<String, ProjectionError> {
    if hash.len() != 32 {
        return Err(ProjectionError::Unavailable);
    }
    Ok(hex::encode(hash))
}

/// Converts a validated projected output into the versioned public receipt.
pub fn receipt_from_output(output: ProjectedOutput, account_id: &str) -> Option<Receipt> {
    if output.origin != ProjectionOrigin::Received
        || output.account_id != account_id
        || output.scope != "external"
        || output.pool != "orchard"
        || output.output_id.is_empty()
        || output.output_id.len() > 256
        || !is_lower_hex(&output.txid, 32)
        || output.output_index == u32::MAX
        || !is_lower_hex(&output.receiver_hex, 43)
        || output.amount_zat.is_empty()
        || output.amount_zat.starts_with('0')
        || !matches!(
            output.amount_zat.parse::<u64>(),
            Ok(1..=2_100_000_000_000_000)
        )
    {
        return None;
    }
    let mined = match output.mined {
        Some((height, hash)) => {
            if !is_lower_hex(&hash, 32) {
                return None;
            }
            Some(MinedReceipt { height, hash })
        }
        None => None,
    };
    Some(Receipt {
        output_id: output.output_id,
        txid: output.txid,
        pool: output.pool,
        output_index: output.output_index,
        account_id: output.account_id,
        scope: output.scope,
        receiver_hex: output.receiver_hex,
        amount_zat: output.amount_zat,
        first_seen_at: output.first_seen_at,
        canonical: mined.is_some(),
        mined,
    })
}

fn is_lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
