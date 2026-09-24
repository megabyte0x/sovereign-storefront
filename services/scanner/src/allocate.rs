use std::{path::Path, sync::Mutex};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainIdentity {
    pub network: String,
    pub genesis_hash: String,
    pub consensus_fingerprint: String,
}

impl ChainIdentity {
    pub fn fixture() -> Self {
        Self {
            network: "regtest".to_owned(),
            genesis_hash: "a".repeat(64),
            consensus_fingerprint: "c".repeat(64),
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.network != "regtest" && self.network != "test" {
            return Err("scanner network is not permitted");
        }
        if !is_lower_hex(&self.genesis_hash, 32) || !is_lower_hex(&self.consensus_fingerprint, 32) {
            return Err("scanner chain identity is invalid");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationRequest {
    pub allocation_id: String,
    pub chain: ChainIdentity,
    pub account_id: String,
    pub amount_zat: String,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReservedAllocation {
    pub request: AllocationRequest,
    /// Exact ZIP-32 diversifier index as 11 raw bytes encoded as lowercase hex.
    pub index: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReceiverDerivation {
    pub destination: String,
    pub diversifier_index: String,
    pub receiver_hex: String,
    pub payment_uri: String,
}

impl ReceiverDerivation {
    /// Deterministic test derivation; production finalization must use the wallet binding.
    #[cfg(test)]
    pub fn for_index(index: &str) -> Self {
        let diversifier_index = if is_lower_hex(index, 11) {
            index.to_owned()
        } else {
            "00".repeat(11)
        };
        Self {
            destination: format!("uregtest1reserved{diversifier_index}"),
            diversifier_index: diversifier_index.clone(),
            receiver_hex: format!("{diversifier_index:0>86}"),
            payment_uri: format!("zcash:uregtest1reserved{diversifier_index}?amount=1"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverRef {
    pub account_id: String,
    pub scope: String,
    pub pool: String,
    pub diversifier_index: String,
    pub receiver_hex: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverAllocation {
    #[serde(flatten)]
    pub request: AllocationRequest,
    pub destination: String,
    pub receiver: ReceiverRef,
    pub payment_uri: String,
}

pub(crate) trait AllocationDeriver: Send + Sync {
    /// Derives exactly the journal-reserved index through the pinned wallet API.
    fn derive(&self, reserved: &ReservedAllocation) -> Result<ReceiverDerivation, &'static str>;
}

pub(crate) struct AllocationJournal {
    connection: Mutex<Connection>,
}

impl AllocationJournal {
    pub(crate) fn open(path: &Path) -> Result<Self, &'static str> {
        let connection =
            Connection::open(path).map_err(|_| "scanner allocation journal cannot open")?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=FULL;
                 CREATE TABLE IF NOT EXISTS allocations (
                   allocation_id TEXT PRIMARY KEY NOT NULL,
                   terms TEXT NOT NULL,
                   reserved_index TEXT NOT NULL UNIQUE,
                   state TEXT NOT NULL,
                   result TEXT,
                   created_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS allocation_watermarks (
                   account_id TEXT PRIMARY KEY NOT NULL,
                   burned_index TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS allocation_intents (
                   allocation_id TEXT PRIMARY KEY NOT NULL,
                   terms TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );",
            )
            .map_err(|_| "scanner allocation journal cannot initialize")?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    #[cfg(test)]
    pub(crate) fn record_intent(&self, request: AllocationRequest) -> Result<(), &'static str> {
        validate_request(&request)?;
        let terms =
            serde_json::to_string(&request).map_err(|_| "allocation terms cannot encode")?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT terms FROM allocation_intents WHERE allocation_id = ?1",
                [&request.allocation_id],
                |row| row.get(0),
            )
            .ok();
        match existing {
            Some(existing) if existing == terms => Ok(()),
            Some(_) => Err("allocation terms changed"),
            None => connection
                .execute(
                    "INSERT INTO allocation_intents (allocation_id, terms, created_at) VALUES (?1, ?2, unixepoch())",
                    params![request.allocation_id, terms],
                )
                .map(|_| ())
                .map_err(|_| "allocation intent cannot persist"),
        }
    }

    #[cfg(test)]
    pub(crate) fn pending_intent(
        &self,
        allocation_id: &str,
    ) -> Result<Option<AllocationRequest>, &'static str> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        let encoded: Option<String> = connection
            .query_row(
                "SELECT terms FROM allocation_intents WHERE allocation_id = ?1",
                [allocation_id],
                |row| row.get(0),
            )
            .ok();
        encoded
            .map(|terms| serde_json::from_str(&terms).map_err(|_| "stored allocation is invalid"))
            .transpose()
    }

    /// Atomically persists request terms and an unexposed candidate index before
    /// any wallet mutation, so retries always derive the same index.
    pub(crate) fn reserve(
        &self,
        request: AllocationRequest,
    ) -> Result<ReservedAllocation, &'static str> {
        validate_request(&request)?;
        let terms =
            serde_json::to_string(&request).map_err(|_| "allocation terms cannot encode")?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        let transaction = connection
            .transaction()
            .map_err(|_| "allocation reservation cannot persist")?;
        let prior: Option<(String, String)> = transaction
            .query_row(
                "SELECT terms, reserved_index FROM allocations WHERE allocation_id = ?1",
                [&request.allocation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if let Some((prior_terms, index)) = prior {
            return if prior_terms == terms {
                Ok(ReservedAllocation { request, index })
            } else {
                Err("allocation terms changed")
            };
        }
        let prior_watermark: Option<String> = transaction
            .query_row(
                "SELECT burned_index FROM allocation_watermarks WHERE account_id = ?1",
                [&request.account_id],
                |row| row.get(0),
            )
            .ok();
        let mut candidate = prior_watermark
            .as_deref()
            .map(parse_diversifier_index)
            .transpose()?
            .unwrap_or([0_u8; 11]);
        if prior_watermark.is_some() {
            increment_diversifier_index(&mut candidate)?;
        }
        let index = hex::encode(candidate);
        transaction
            .execute(
                "INSERT INTO allocation_watermarks (account_id, burned_index) VALUES (?1, ?2)
                 ON CONFLICT(account_id) DO UPDATE SET burned_index = excluded.burned_index",
                params![request.account_id, index],
            )
            .map_err(|_| "allocation reservation cannot persist")?;
        transaction
            .execute(
                "INSERT INTO allocations (allocation_id, terms, reserved_index, state, created_at) VALUES (?1, ?2, ?3, 'pending', unixepoch())",
                params![request.allocation_id, terms, index],
            )
            .map_err(|_| "allocation reservation cannot persist")?;
        transaction
            .commit()
            .map_err(|_| "allocation reservation cannot persist")?;
        Ok(ReservedAllocation { request, index })
    }

    /// Advances a pending allocation only after the wallet explicitly reported
    /// that the durable candidate could not produce the requested receiver.
    /// The replacement is journaled and burned before the next wallet call.
    pub(crate) fn advance_candidate(
        &self,
        reserved: &ReservedAllocation,
    ) -> Result<ReservedAllocation, &'static str> {
        let terms = serde_json::to_string(&reserved.request)
            .map_err(|_| "allocation terms cannot encode")?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        let transaction = connection
            .transaction()
            .map_err(|_| "allocation reservation cannot persist")?;
        let current: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT terms, reserved_index, state FROM allocations WHERE allocation_id = ?1",
                [&reserved.request.allocation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();
        let Some((stored_terms, stored_index, state)) = current else {
            return Err("allocation reservation is unavailable");
        };
        if stored_terms != terms {
            return Err("allocation terms changed");
        }
        if stored_index != reserved.index || state != "pending" {
            return Err("allocation reservation is unavailable");
        }
        let watermark: String = transaction
            .query_row(
                "SELECT burned_index FROM allocation_watermarks WHERE account_id = ?1",
                [&reserved.request.account_id],
                |row| row.get(0),
            )
            .map_err(|_| "allocation reservation is unavailable")?;
        let mut candidate = parse_diversifier_index(&watermark)?;
        increment_diversifier_index(&mut candidate)?;
        let index = hex::encode(candidate);
        transaction
            .execute(
                "UPDATE allocation_watermarks SET burned_index = ?1 WHERE account_id = ?2",
                params![index, reserved.request.account_id],
            )
            .map_err(|_| "allocation reservation cannot persist")?;
        let changed = transaction
            .execute(
                "UPDATE allocations SET reserved_index = ?1 WHERE allocation_id = ?2 AND reserved_index = ?3 AND state = 'pending'",
                params![index, reserved.request.allocation_id, reserved.index],
            )
            .map_err(|_| "allocation reservation cannot persist")?;
        if changed != 1 {
            return Err("allocation reservation is unavailable");
        }
        transaction
            .commit()
            .map_err(|_| "allocation reservation cannot persist")?;
        Ok(ReservedAllocation {
            request: reserved.request.clone(),
            index,
        })
    }

    /// Burns wallet-exposed derived indices discovered during startup. The
    /// scanner never assigns a historical wallet-only exposure to an unknown
    /// allocation id.
    pub(crate) fn seed_high_water_mark(
        &self,
        account_id: &str,
        exposed_index: String,
    ) -> Result<(), &'static str> {
        let exposed = parse_diversifier_index(&exposed_index)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT burned_index FROM allocation_watermarks WHERE account_id = ?1",
                [account_id],
                |row| row.get(0),
            )
            .ok();
        if existing
            .as_deref()
            .map(parse_diversifier_index)
            .transpose()?
            .is_none_or(|current| exposed.iter().rev().cmp(current.iter().rev()).is_gt())
        {
            connection
                .execute(
                    "INSERT INTO allocation_watermarks (account_id, burned_index) VALUES (?1, ?2)
                     ON CONFLICT(account_id) DO UPDATE SET burned_index = excluded.burned_index",
                    params![account_id, exposed_index],
                )
                .map_err(|_| "allocation watermark cannot persist")?;
        }
        Ok(())
    }

    pub(crate) fn finalized(
        &self,
        request: &AllocationRequest,
    ) -> Result<Option<ReceiverAllocation>, &'static str> {
        validate_request(request)?;
        let terms = serde_json::to_string(request).map_err(|_| "allocation terms cannot encode")?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        let row: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT terms, result FROM allocations WHERE allocation_id = ?1",
                [&request.allocation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        match row {
            Some((stored_terms, _)) if stored_terms != terms => Err("allocation terms changed"),
            Some((_, Some(result))) => serde_json::from_str(&result)
                .map(Some)
                .map_err(|_| "stored allocation is invalid"),
            _ => Ok(None),
        }
    }

    pub(crate) fn finalize(
        &self,
        reserved: &ReservedAllocation,
        derived: ReceiverDerivation,
    ) -> Result<ReceiverAllocation, &'static str> {
        validate_derivation(&derived)?;
        if reserved.index != derived.diversifier_index {
            return Err("wallet-derived allocation index does not match reservation");
        }
        let allocation = ReceiverAllocation {
            request: reserved.request.clone(),
            destination: derived.destination,
            receiver: ReceiverRef {
                account_id: reserved.request.account_id.clone(),
                scope: "external".to_owned(),
                pool: "orchard".to_owned(),
                diversifier_index: derived.diversifier_index,
                receiver_hex: derived.receiver_hex,
            },
            payment_uri: derived.payment_uri,
        };
        let encoded =
            serde_json::to_string(&allocation).map_err(|_| "allocation result cannot encode")?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        let prior: Option<String> = connection
            .query_row(
                "SELECT result FROM allocations WHERE allocation_id = ?1",
                [&reserved.request.allocation_id],
                |row| row.get(0),
            )
            .ok();
        if let Some(existing) = prior {
            return serde_json::from_str(&existing).map_err(|_| "stored allocation is invalid");
        }
        let changed = connection
            .execute(
                "UPDATE allocations SET state = 'finalized', result = ?1 WHERE allocation_id = ?2 AND reserved_index = ?3 AND state = 'pending'",
                params![encoded, reserved.request.allocation_id, reserved.index],
            )
            .map_err(|_| "allocation finalization cannot persist")?;
        if changed != 1 {
            return Err("allocation reservation is unavailable");
        }
        Ok(allocation)
    }

    #[cfg(test)]
    pub(crate) fn high_water_mark(&self, account_id: &str) -> Result<Option<String>, &'static str> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "scanner allocation mutex poisoned")?;
        Ok(connection
            .query_row(
                "SELECT burned_index FROM allocation_watermarks WHERE account_id = ?1",
                [account_id],
                |row| row.get(0),
            )
            .ok())
    }
}

fn parse_diversifier_index(value: &str) -> Result<[u8; 11], &'static str> {
    let bytes = hex::decode(value).map_err(|_| "allocation index is invalid")?;
    bytes.try_into().map_err(|_| "allocation index is invalid")
}

fn increment_diversifier_index(index: &mut [u8; 11]) -> Result<(), &'static str> {
    for byte in index {
        *byte = byte.wrapping_add(1);
        if *byte != 0 {
            return Ok(());
        }
    }
    Err("allocation index exhausted")
}

fn validate_request(request: &AllocationRequest) -> Result<(), &'static str> {
    request.chain.validate()?;
    if request.allocation_id.is_empty()
        || request.account_id.is_empty()
        || request.amount_zat.is_empty()
        || !request.amount_zat.bytes().all(|byte| byte.is_ascii_digit())
        || request.amount_zat.starts_with('0')
    {
        return Err("allocation request is invalid");
    }
    Ok(())
}

fn validate_derivation(derived: &ReceiverDerivation) -> Result<(), &'static str> {
    if derived.destination.is_empty()
        || !derived.payment_uri.starts_with("zcash:")
        || !is_lower_hex(&derived.diversifier_index, 11)
        || !is_lower_hex(&derived.receiver_hex, 43)
    {
        return Err("wallet-derived allocation is invalid");
    }
    Ok(())
}

fn is_lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{AllocationJournal, AllocationRequest, ChainIdentity, ReceiverDerivation};

    fn private_db(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ssf-task3-{name}-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    fn request() -> AllocationRequest {
        AllocationRequest {
            allocation_id: "allocation-a".to_owned(),
            chain: ChainIdentity::fixture(),
            account_id: "seller-account-0".to_owned(),
            amount_zat: "100000000".to_owned(),
            expires_at: 2_000_000,
        }
    }

    #[test]
    fn persisted_index_reservation_is_reused_after_crash_before_finalization() {
        let path = private_db("allocation-crash");
        let first = AllocationJournal::open(&path).expect("open journal");
        let reserved = first.reserve(request()).expect("reserve index");
        assert_eq!(reserved.index, "00".repeat(11));
        drop(first);

        let restarted = AllocationJournal::open(&path).expect("reopen journal");
        let replay = restarted.reserve(request()).expect("replay reserve");
        assert_eq!(replay.index, reserved.index);
        let allocation = restarted
            .finalize(&replay, ReceiverDerivation::for_index(&replay.index))
            .expect("finalize reserved index");
        assert_eq!(
            allocation.receiver.diversifier_index,
            "0000000000000000000000"
        );
        assert_eq!(
            restarted
                .high_water_mark(&request().account_id)
                .expect("high water"),
            Some("00".repeat(11))
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn changed_allocation_terms_fail_instead_of_reusing_a_receiver() {
        let path = private_db("allocation-terms");
        let journal = AllocationJournal::open(&path).expect("open journal");
        journal.reserve(request()).expect("reserve");

        let changed = AllocationRequest {
            amount_zat: "1".to_owned(),
            ..request()
        };
        assert_eq!(journal.reserve(changed), Err("allocation terms changed"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn finalization_rejects_a_valid_derivation_for_a_different_index() {
        let path = private_db("allocation-index-mismatch");
        let journal = AllocationJournal::open(&path).expect("open journal");
        let reserved = journal.reserve(request()).expect("reserve exact index");
        let different_index = "01".to_owned() + &"00".repeat(10);
        assert_eq!(
            journal.finalize(&reserved, ReceiverDerivation::for_index(&different_index)),
            Err("wallet-derived allocation index does not match reservation")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn pending_intent_survives_crash_before_wallet_address_reservation() {
        let path = private_db("allocation-intent");
        let first = AllocationJournal::open(&path).expect("open journal");
        first
            .record_intent(request())
            .expect("persist intent before wallet mutation");
        drop(first);

        let restarted = AllocationJournal::open(&path).expect("reopen scanner-owned journal");
        assert_eq!(
            restarted
                .pending_intent("allocation-a")
                .expect("read durable intent"),
            Some(request())
        );
        assert_eq!(
            restarted.record_intent(AllocationRequest {
                amount_zat: "1".to_owned(),
                ..request()
            }),
            Err("allocation terms changed")
        );
        let _ = fs::remove_file(path);
    }
}
