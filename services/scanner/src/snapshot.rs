use std::{path::Path, sync::Mutex};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::{
    allocate::ChainIdentity,
    projection::{Receipt, receipt_from_output},
};

const MAX_V1_RECEIPTS: usize = 10_000;
const MAX_V1_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Revision {
    pub height: u32,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub version: u8,
    pub source_id: String,
    pub generation: String,
    pub chain: ChainIdentity,
    pub account_id: String,
    pub tip: Revision,
    pub scanned: Revision,
    pub checked_at: u64,
    pub caught_up: bool,
    pub complete: bool,
    pub health: String,
    pub receipts: Vec<Receipt>,
}

#[allow(dead_code)]
pub(crate) struct SnapshotStore {
    connection: Mutex<Connection>,
    source_id: String,
    chain: ChainIdentity,
    account_id: String,
}

#[allow(dead_code)]
impl SnapshotStore {
    pub(crate) fn open(
        path: &Path,
        source_id: &str,
        chain: ChainIdentity,
        account_id: &str,
    ) -> Result<Self, &'static str> {
        chain.validate()?;
        if source_id.is_empty() || account_id.is_empty() {
            return Err("scanner source identity is invalid");
        }
        let connection =
            Connection::open(path).map_err(|_| "scanner snapshot store cannot open")?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshots (generation INTEGER PRIMARY KEY NOT NULL, body BLOB NOT NULL);").map_err(|_| "scanner snapshot store cannot initialize")?;
        crate::restore::ensure_schema(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            source_id: source_id.to_owned(),
            chain,
            account_id: account_id.to_owned(),
        })
    }

    pub(crate) fn publish(
        &self,
        height: u32,
        hash: String,
        outputs: Vec<crate::projection::ProjectedOutput>,
        caught_up: bool,
        enhancement_complete: bool,
        checked_at: u64,
    ) -> Result<Snapshot, &'static str> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "scanner snapshot mutex poisoned")?;
        let prior = latest(&connection)?;
        let first_seen = prior
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .receipts
                    .iter()
                    .map(|receipt| (receipt.output_id.clone(), receipt.first_seen_at))
                    .collect::<std::collections::BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        let mut receipts = Vec::new();
        for mut output in outputs {
            if let Some(seen) = first_seen.get(&output.output_id) {
                output.first_seen_at = *seen;
            } else if output.first_seen_at == 0 {
                // The wallet has no scanner-observation clock. Assign it only
                // in scanner-owned durable state, after a coherent projection.
                output.first_seen_at = checked_at;
            }
            let candidate = is_receipt_candidate(&output, &self.account_id);
            match receipt_from_output(output, &self.account_id) {
                Some(receipt) => {
                    if receipts.len() < MAX_V1_RECEIPTS {
                        receipts.push(receipt);
                    } else {
                        return self.publish_unavailable(
                            &mut connection,
                            prior.as_ref(),
                            height,
                            hash,
                            checked_at,
                        );
                    }
                }
                None if candidate => {
                    return self.publish_unavailable(
                        &mut connection,
                        prior.as_ref(),
                        height,
                        hash,
                        checked_at,
                    );
                }
                None => {}
            }
        }
        receipts.sort_by(|a, b| a.output_id.cmp(&b.output_id));
        let generation = next_generation(&connection, prior.as_ref())?;
        let complete = caught_up && enhancement_complete;
        let snapshot = Snapshot {
            version: 1,
            source_id: self.source_id.clone(),
            generation: generation.to_string(),
            chain: self.chain.clone(),
            account_id: self.account_id.clone(),
            tip: Revision {
                height,
                hash: hash.clone(),
            },
            scanned: Revision { height, hash },
            checked_at,
            caught_up,
            complete,
            health: if complete {
                "ready".to_owned()
            } else {
                "syncing".to_owned()
            },
            receipts,
        };
        if snapshot_body(&snapshot).is_err() {
            return self.publish_unavailable(
                &mut connection,
                prior.as_ref(),
                height,
                snapshot.tip.hash.clone(),
                checked_at,
            );
        }
        persist(&mut connection, &snapshot)?;
        Ok(snapshot)
    }

    fn publish_unavailable(
        &self,
        connection: &mut Connection,
        prior: Option<&Snapshot>,
        height: u32,
        hash: String,
        checked_at: u64,
    ) -> Result<Snapshot, &'static str> {
        let generation = next_generation(connection, prior)?;
        let previous_receipts = prior
            .map(|snapshot| snapshot.receipts.clone())
            .unwrap_or_default();
        let mut snapshot = Snapshot {
            version: 1,
            source_id: self.source_id.clone(),
            generation: generation.to_string(),
            chain: self.chain.clone(),
            account_id: self.account_id.clone(),
            tip: Revision {
                height,
                hash: hash.clone(),
            },
            scanned: Revision { height, hash },
            checked_at,
            caught_up: false,
            complete: false,
            health: "unavailable".to_owned(),
            receipts: previous_receipts,
        };
        if snapshot_body(&snapshot).is_err() {
            // Leave the previous canonical evidence in its prior generation,
            // while making the active generation explicitly unavailable.
            snapshot.receipts.clear();
        }
        persist(connection, &snapshot)?;
        Ok(snapshot)
    }

    pub(crate) fn invalidate(
        &self,
        height: u32,
        hash: String,
        checked_at: u64,
    ) -> Result<Snapshot, &'static str> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "scanner snapshot mutex poisoned")?;
        let previous = latest(&connection)?;
        let generation = next_generation(&connection, previous.as_ref())?;
        let mut receipts = previous
            .map(|previous| previous.receipts)
            .unwrap_or_default();
        for receipt in &mut receipts {
            receipt.canonical = false;
        }
        let snapshot = Snapshot {
            version: 1,
            source_id: self.source_id.clone(),
            generation: generation.to_string(),
            chain: self.chain.clone(),
            account_id: self.account_id.clone(),
            tip: Revision {
                height,
                hash: hash.clone(),
            },
            scanned: Revision { height, hash },
            checked_at,
            caught_up: false,
            complete: false,
            health: "syncing".to_owned(),
            receipts,
        };
        persist(&mut connection, &snapshot)?;
        Ok(snapshot)
    }

    pub(crate) fn current(&self) -> Result<Snapshot, &'static str> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner snapshot mutex poisoned")?;
        latest(&connection)?.ok_or("scanner snapshot is unavailable")
    }
    pub(crate) fn read_generation(&self, generation: String) -> Result<Snapshot, &'static str> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner snapshot mutex poisoned")?;
        connection
            .query_row(
                "SELECT body FROM snapshots WHERE generation = ?1",
                [generation],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .map_err(|_| "snapshot generation is unavailable")
            .and_then(|body| decode_snapshot(&body))
    }
}

/// Next durable generation: strictly after the latest persisted one and never
/// below the current source epoch's floor recorded by an acknowledged restore.
fn next_generation(connection: &Connection, prior: Option<&Snapshot>) -> Result<u64, &'static str> {
    let after_prior = prior
        .map(|snapshot| {
            snapshot
                .generation
                .parse::<u64>()
                .map_err(|_| "snapshot generation is invalid")
        })
        .transpose()?
        .unwrap_or(0)
        .checked_add(1)
        .ok_or("snapshot generation overflow")?;
    Ok(after_prior.max(crate::restore::generation_floor(connection)?))
}

fn latest(connection: &Connection) -> Result<Option<Snapshot>, &'static str> {
    let body = connection
        .query_row(
            "SELECT body FROM snapshots ORDER BY generation DESC LIMIT 1",
            [],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .ok();
    body.map(|body| decode_snapshot(&body)).transpose()
}

fn is_receipt_candidate(output: &crate::projection::ProjectedOutput, account_id: &str) -> bool {
    output.origin == crate::projection::ProjectionOrigin::Received
        && output.account_id == account_id
        && output.scope != "internal"
}

fn snapshot_body(snapshot: &Snapshot) -> Result<Vec<u8>, &'static str> {
    if snapshot.receipts.len() > MAX_V1_RECEIPTS {
        return Err("snapshot receipt count exceeds version 1 limit");
    }
    let body = serde_json::to_vec(snapshot).map_err(|_| "snapshot cannot encode")?;
    if body.len() > MAX_V1_SNAPSHOT_BYTES {
        return Err("snapshot exceeds version 1 byte limit");
    }
    Ok(body)
}

fn decode_snapshot(body: &[u8]) -> Result<Snapshot, &'static str> {
    if body.len() > MAX_V1_SNAPSHOT_BYTES {
        return Err("stored snapshot exceeds version 1 byte limit");
    }
    let snapshot: Snapshot =
        serde_json::from_slice(body).map_err(|_| "stored snapshot is invalid")?;
    snapshot_body(&snapshot).map_err(|_| "stored snapshot exceeds version 1 limits")?;
    Ok(snapshot)
}

fn persist(connection: &mut Connection, snapshot: &Snapshot) -> Result<(), &'static str> {
    let body = snapshot_body(snapshot)?;
    let generation = snapshot
        .generation
        .parse::<u64>()
        .map_err(|_| "snapshot generation is invalid")?;
    connection
        .execute(
            "INSERT INTO snapshots (generation, body) VALUES (?1, ?2)",
            params![generation, body],
        )
        .map_err(|_| "snapshot cannot persist")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::SnapshotStore;
    use crate::{
        allocate::ChainIdentity,
        projection::{ProjectedOutput, ProjectionOrigin},
    };

    fn private_db(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ssf-task3-snapshot-{label}-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    fn output(id: &str) -> ProjectedOutput {
        ProjectedOutput {
            output_id: id.to_owned(),
            txid: "e".repeat(64),
            pool: "orchard".to_owned(),
            output_index: 7,
            account_id: "seller-account-0".to_owned(),
            scope: "external".to_owned(),
            receiver_hex: "02".repeat(43),
            amount_zat: "100000000".to_owned(),
            mined: Some((20, "d".repeat(64))),
            first_seen_at: 1_000,
            origin: ProjectionOrigin::Received,
            spent: false,
        }
    }

    #[test]
    fn spent_received_receipt_remains_in_complete_history_and_nonreceipt_rows_are_excluded() {
        let path = private_db("spent-receipt");
        let store = SnapshotStore::open(
            &path,
            "scanner-a",
            ChainIdentity::fixture(),
            "seller-account-0",
        )
        .expect("store");
        let mut spent = output("spent-output");
        spent.spent = true;
        let mut internal = output("internal-output");
        internal.scope = "internal".to_owned();
        let mut foreign = output("foreign-output");
        foreign.account_id = "other-account".to_owned();
        let mut sent = output("sent-output");
        sent.origin = ProjectionOrigin::Sent;

        let snapshot = store
            .publish(
                20,
                "d".repeat(64),
                vec![spent, internal, foreign, sent],
                true,
                true,
                1_000,
            )
            .expect("publish");
        assert_eq!(snapshot.receipts.len(), 1);
        assert_eq!(snapshot.receipts[0].output_id, "spent-output");
        assert!(snapshot.complete);
        assert_eq!(snapshot.health, "ready");
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reorg_preserves_historical_output_identity_but_revokes_canonicality_before_ready_reopens() {
        let path = private_db("reorg");
        let store = SnapshotStore::open(
            &path,
            "scanner-a",
            ChainIdentity::fixture(),
            "seller-account-0",
        )
        .expect("store");
        let first = store
            .publish(
                20,
                "d".repeat(64),
                vec![output("receipt-a")],
                true,
                true,
                1_000,
            )
            .expect("first");
        let revoked = store.invalidate(20, "b".repeat(64), 1_001).expect("revoke");

        assert!(revoked.generation > first.generation);
        assert!(!revoked.complete);
        assert_eq!(revoked.health, "syncing");
        assert_eq!(revoked.receipts[0].output_id, "receipt-a");
        assert!(!revoked.receipts[0].canonical);
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn incomplete_enhancement_never_publishes_ready_and_replayed_generation_is_byte_equivalent() {
        let path = private_db("incomplete-enhancement");
        let store = SnapshotStore::open(
            &path,
            "scanner-a",
            ChainIdentity::fixture(),
            "seller-account-0",
        )
        .expect("store");
        let snapshot = store
            .publish(
                20,
                "d".repeat(64),
                vec![output("receipt-a")],
                true,
                false,
                1_000,
            )
            .expect("publish");
        assert!(!snapshot.complete);
        assert_ne!(snapshot.health, "ready");
        assert_eq!(
            store
                .read_generation(snapshot.generation.clone())
                .expect("replay"),
            snapshot
        );
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn malformed_receipt_candidate_publishes_unavailable_without_dropping_prior_evidence() {
        let path = private_db("malformed-candidate");
        let store = SnapshotStore::open(
            &path,
            "scanner-a",
            ChainIdentity::fixture(),
            "seller-account-0",
        )
        .expect("store");
        let prior = store
            .publish(
                20,
                "d".repeat(64),
                vec![output("receipt-a")],
                true,
                true,
                1_000,
            )
            .expect("prior ready snapshot");
        let mut unresolved = output("receipt-unresolved");
        unresolved.receiver_hex.clear();

        let unavailable = store
            .publish(
                20,
                "d".repeat(64),
                vec![output("receipt-a"), unresolved],
                true,
                true,
                1_001,
            )
            .expect("unresolved candidate is recorded as unavailable");

        assert!(!unavailable.complete);
        assert_eq!(unavailable.health, "unavailable");
        assert_eq!(unavailable.receipts, prior.receipts);
        assert_eq!(store.current().expect("current"), unavailable);
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn out_of_range_amount_candidate_publishes_an_unavailable_generation() {
        let path = private_db("out-of-range-amount");
        let store = SnapshotStore::open(
            &path,
            "scanner-a",
            ChainIdentity::fixture(),
            "seller-account-0",
        )
        .expect("store");
        let mut candidate = output("receipt-out-of-range");
        candidate.amount_zat = "2100000000000001".to_owned();

        let unavailable = store
            .publish(20, "d".repeat(64), vec![candidate], true, true, 1_000)
            .expect("out-of-range amount is recorded as unavailable");

        assert!(!unavailable.complete);
        assert_eq!(unavailable.health, "unavailable");
        assert!(unavailable.receipts.is_empty());
        assert_eq!(store.current().expect("current"), unavailable);
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn receipt_count_overflow_publishes_an_unavailable_generation() {
        let path = private_db("receipt-count-overflow");
        let store = SnapshotStore::open(
            &path,
            "scanner-a",
            ChainIdentity::fixture(),
            "seller-account-0",
        )
        .expect("store");
        let outputs = (0..=10_000)
            .map(|index| {
                let mut candidate = output(&format!("receipt-{index}"));
                candidate.output_index = index;
                candidate
            })
            .collect();

        let unavailable = store
            .publish(20, "d".repeat(64), outputs, true, true, 1_000)
            .expect("receipt count overflow is recorded as unavailable");

        assert!(!unavailable.complete);
        assert_eq!(unavailable.health, "unavailable");
        assert!(unavailable.receipts.is_empty());
        assert_eq!(store.current().expect("current"), unavailable);
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn serialized_body_overflow_publishes_an_unavailable_generation() {
        let path = private_db("serialized-body-overflow");
        let store = SnapshotStore::open(
            &path,
            "scanner-a",
            ChainIdentity::fixture(),
            "seller-account-0",
        )
        .expect("store");
        let mut candidate = output("receipt-too-large");
        candidate.amount_zat = "1".repeat(16 * 1024 * 1024);

        let unavailable = store
            .publish(20, "d".repeat(64), vec![candidate], true, true, 1_000)
            .expect("serialized body overflow is recorded as unavailable");

        assert!(!unavailable.complete);
        assert_eq!(unavailable.health, "unavailable");
        assert!(unavailable.receipts.is_empty());
        assert_eq!(store.current().expect("current"), unavailable);
        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn durable_generation_advances_on_checked_at_refresh_and_survives_restart() {
        let path = private_db("restore");
        let chain = ChainIdentity::fixture();
        let store = SnapshotStore::open(&path, "scanner-a", chain.clone(), "seller-account-0")
            .expect("open");
        let receipt = ProjectedOutput {
            output_id: "receipt-a".to_owned(),
            txid: "e".repeat(64),
            pool: "orchard".to_owned(),
            output_index: 3,
            account_id: "seller-account-0".to_owned(),
            scope: "external".to_owned(),
            receiver_hex: "02".repeat(43),
            amount_zat: "100000000".to_owned(),
            mined: Some((20, "d".repeat(64))),
            first_seen_at: 99,
            origin: ProjectionOrigin::Received,
            spent: false,
        };
        let first = store
            .publish(20, "d".repeat(64), vec![receipt.clone()], true, true, 1_000)
            .expect("first");
        let refreshed = store
            .publish(20, "d".repeat(64), vec![receipt], true, true, 1_001)
            .expect("refreshed");
        assert!(refreshed.generation > first.generation);
        drop(store);

        let restored =
            SnapshotStore::open(&path, "scanner-a", chain, "seller-account-0").expect("reopen");
        assert_eq!(restored.current().expect("current"), refreshed);
        drop(restored);
        let _ = fs::remove_file(path);
    }
}
