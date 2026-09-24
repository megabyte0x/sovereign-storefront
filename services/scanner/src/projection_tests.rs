//! Deterministic fixtures in this file are disposable wallet databases migrated
//! by the pinned wallet library. They are not live-chain evidence.

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{ProjectionError, read_wallet_history};
use crate::{
    allocate::ChainIdentity,
    snapshot::SnapshotStore,
    wallet::{
        allocate_next_external_orchard_address, external_orchard_receiver_hex,
        import_view_only_account, open_persistent_wallet_db,
    },
};
use rusqlite::{Connection, params};
use zcash_client_backend::{
    data_api::{Account as _, AccountBirthday, WalletWrite},
    proto::service::TreeState,
};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork};
use zip32::AccountId;

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

fn private_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("ssf-projection-{label}-{nonce}"));
    fs::create_dir(&root).expect("create isolated fixture root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .expect("make fixture root private");
    root
}

struct Fixture {
    root: PathBuf,
    wallet_path: PathBuf,
    params: LocalNetwork,
    account_id: String,
    account_row_id: i64,
    foreign_account_row_id: i64,
    receiver_hexes: Vec<String>,
    address_ids: Vec<i64>,
}

impl Fixture {
    fn new() -> Self {
        let root = private_root("history");
        let wallet_path = root.join("wallet.sqlite");
        let params = regtest_parameters();
        let mut seed = [0_u8; 32];
        getrandom::fill(&mut seed).expect("OS entropy for ephemeral fixture");
        let spending_key = UnifiedSpendingKey::from_seed(&params, &seed, AccountId::ZERO)
            .expect("derive ephemeral fixture key");
        seed.fill(0);
        let ufvk = spending_key.to_unified_full_viewing_key();
        let mut wallet = open_persistent_wallet_db(&wallet_path, params.clone())
            .expect("library migrates disposable wallet fixture");
        let account = import_view_only_account(&mut wallet, "fixture", &ufvk, &birthday())
            .expect("library imports disposable view-only fixture");
        let account_id = account.id().expose_uuid().to_string();
        let mut foreign_seed = [0_u8; 32];
        getrandom::fill(&mut foreign_seed).expect("OS entropy for foreign fixture account");
        let foreign_spending_key =
            UnifiedSpendingKey::from_seed(&params, &foreign_seed, AccountId::ZERO)
                .expect("derive foreign fixture key");
        foreign_seed.fill(0);
        let foreign_ufvk = foreign_spending_key.to_unified_full_viewing_key();
        let foreign_account =
            import_view_only_account(&mut wallet, "foreign", &foreign_ufvk, &birthday())
                .expect("library imports foreign view-only fixture account");
        let addresses = (0..2)
            .map(|_| {
                allocate_next_external_orchard_address(&mut wallet, account.id())
                    .expect("library persists external Orchard receiver")
                    .expect("fixture has an external Orchard receiver")
            })
            .collect::<Vec<_>>();
        let receiver_hexes = addresses
            .iter()
            .map(|address| {
                external_orchard_receiver_hex(address)
                    .expect("external Orchard allocation has receiver bytes")
            })
            .collect::<Vec<_>>();
        let address_strings = addresses
            .iter()
            .map(|address| address.encode(&params))
            .collect::<Vec<_>>();
        drop(wallet);

        let connection = Connection::open(&wallet_path).expect("open disposable migrated wallet");
        // A retained pre-receipt block gives the pinned wallet library a valid
        // rewind target in this deterministic fixture; it is never a runtime
        // scanner write path.
        connection
            .execute(
                "INSERT INTO blocks (height, hash, time, sapling_tree) VALUES (100, ?1, 0, X'00')",
                [vec![0_u8; 32]],
            )
            .expect("insert deterministic retained fixture block");
        let account_row_id = connection
            .query_row(
                "SELECT id FROM accounts WHERE uuid = ?1",
                [account.id().expose_uuid().as_bytes().as_slice()],
                |row| row.get(0),
            )
            .expect("imported account row exists");
        let foreign_account_row_id = connection
            .query_row(
                "SELECT id FROM accounts WHERE uuid = ?1",
                [foreign_account.id().expose_uuid().as_bytes().as_slice()],
                |row| row.get(0),
            )
            .expect("foreign imported account row exists");
        let address_ids = address_strings
            .iter()
            .map(|address| {
                connection
                    .query_row(
                        "SELECT id FROM addresses WHERE address = ?1",
                        [address],
                        |row| row.get(0),
                    )
                    .expect("library-derived address row exists")
            })
            .collect();
        drop(connection);

        Self {
            root,
            wallet_path,
            params,
            account_id,
            account_row_id,
            foreign_account_row_id,
            receiver_hexes,
            address_ids,
        }
    }

    /// Insert deterministic note data only into this disposable library-migrated
    /// fixture. Runtime wallet tables are never written by scanner code.
    fn insert_received(&self, id: i64, address: usize, spent: bool) {
        let connection = Connection::open(&self.wallet_path).expect("open disposable fixture");
        let txid = vec![id as u8; 32];
        connection
            .execute(
                "INSERT INTO blocks (height, hash, time, sapling_tree) VALUES (?1, ?2, 0, X'00')",
                params![100 + id, vec![id as u8; 32]],
            )
            .expect("insert scanned block into disposable fixture");
        connection
            .execute(
                "INSERT INTO transactions (id_tx, txid, block, mined_height, min_observed_height)
                 VALUES (?1, ?2, ?3, ?3, ?3)",
                params![id, txid, 100 + id],
            )
            .expect("insert mined transaction into disposable fixture");
        connection
            .execute(
                "INSERT INTO orchard_received_notes
                 (id, transaction_id, action_index, account_id, diversifier, value, rho, rseed,
                  is_change, recipient_key_scope, address_id)
                 VALUES (?1, ?1, ?1, ?2, X'00', ?3, X'00', X'00', 0, 0, ?4)",
                params![
                    id,
                    self.account_row_id,
                    100_000_000_i64 + id,
                    self.address_ids[address]
                ],
            )
            .expect("insert external Orchard note into disposable fixture");
        if spent {
            let spend_tx = 1_000 + id;
            connection
                .execute(
                    "INSERT INTO transactions (id_tx, txid, min_observed_height)
                     VALUES (?1, ?2, ?3)",
                    params![spend_tx, vec![spend_tx as u8; 32], 200_i64],
                )
                .expect("insert fixture spending transaction");
            connection
                .execute(
                    "INSERT INTO orchard_received_note_spends (orchard_received_note_id, transaction_id)
                     VALUES (?1, ?2)",
                    params![id, spend_tx],
                )
                .expect("mark deterministic fixture note spent through migrated wallet relation");
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn spent_receipt_survives_restart() {
    let fixture = Fixture::new();
    fixture.insert_received(1, 0, true);
    fixture.insert_received(2, 1, false);

    let application_path = fixture.root.join("scanner-owned.sqlite");
    let store = SnapshotStore::open(
        &application_path,
        "scanner-a",
        ChainIdentity::fixture(),
        &fixture.account_id,
    )
    .expect("open scanner-owned history store");
    let first = read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
        .expect("read full received history from read-only migrated wallet");
    let first = store
        .publish(102, "02".repeat(32), first.outputs, true, true, 1_000)
        .expect("publish projected receipt history");
    assert_eq!(first.receipts.len(), 2);
    assert!(
        first
            .receipts
            .iter()
            .any(|receipt| receipt.receiver_hex == fixture.receiver_hexes[0])
    );
    let first_seen = first
        .receipts
        .iter()
        .map(|receipt| (receipt.output_id.clone(), receipt.first_seen_at))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert!(first_seen.values().all(|seen| *seen == 1_000));
    drop(store);

    let reopened_store = SnapshotStore::open(
        &application_path,
        "scanner-a",
        ChainIdentity::fixture(),
        &fixture.account_id,
    )
    .expect("reopen scanner-owned history store");
    let reopened = read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
        .expect("reopen read-only wallet projection");
    let reopened = reopened_store
        .publish(102, "02".repeat(32), reopened.outputs, true, true, 1_001)
        .expect("republish complete history after scanner restart");
    assert_eq!(reopened.receipts.len(), 2);
    assert_eq!(
        reopened
            .receipts
            .iter()
            .map(|receipt| (receipt.output_id.clone(), receipt.first_seen_at))
            .collect::<std::collections::BTreeMap<_, _>>(),
        first_seen
    );
}

#[test]
fn received_ownership_and_scope_exclude_internal_foreign_and_nonreceived_rows() {
    let fixture = Fixture::new();
    fixture.insert_received(1, 0, false);
    // All rows below are deterministic disposable-fixture state; the production
    // reader remains read-only and selects only the imported account's output view.
    let connection = Connection::open(&fixture.wallet_path).expect("open disposable fixture");
    for (id, account_id, scope, address_id) in [
        (2_i64, fixture.account_row_id, 1_i64, None),
        (
            3_i64,
            fixture.foreign_account_row_id,
            0_i64,
            Some(fixture.address_ids[1]),
        ),
    ] {
        connection
            .execute(
                "INSERT INTO blocks (height, hash, time, sapling_tree) VALUES (?1, ?2, 0, X'00')",
                params![100 + id, vec![id as u8; 32]],
            )
            .expect("insert deterministic fixture block");
        connection
            .execute(
                "INSERT INTO transactions (id_tx, txid, block, mined_height, min_observed_height)
                 VALUES (?1, ?2, ?3, ?3, ?3)",
                params![id, vec![id as u8; 32], 100 + id],
            )
            .expect("insert deterministic fixture transaction");
        connection
            .execute(
                "INSERT INTO orchard_received_notes
                 (id, transaction_id, action_index, account_id, diversifier, value, rho, rseed,
                  is_change, recipient_key_scope, address_id)
                 VALUES (?1, ?1, ?1, ?2, X'00', ?3, X'00', X'00', 0, ?4, ?5)",
                params![id, account_id, 100_000_000_i64 + id, scope, address_id],
            )
            .expect("insert deterministic internal or foreign fixture note");
    }
    // This transaction has no received-output row and therefore represents a
    // sent-only/nonreceived event as far as the received-history projection is concerned.
    connection
        .execute(
            "INSERT INTO transactions (id_tx, txid, min_observed_height) VALUES (4, ?1, 104)",
            [vec![4_u8; 32]],
        )
        .expect("insert deterministic nonreceived transaction");

    let history = read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
        .expect("project selected external received history");
    assert_eq!(history.outputs.len(), 1);
    assert_eq!(
        history.outputs[0].output_id,
        format!("{}:orchard:1", "01".repeat(32))
    );
    assert_eq!(history.outputs[0].scope, "external");
}

#[test]
fn projection_fails_closed_when_an_external_note_cannot_be_reconciled_to_an_external_address() {
    let fixture = Fixture::new();
    fixture.insert_received(1, 0, false);
    // This is an isolated, library-migrated fixture only. Runtime scanner code
    // never mutates wallet-owned tables.
    let connection = Connection::open(&fixture.wallet_path).expect("open disposable fixture");
    connection
        .execute(
            "UPDATE addresses SET key_scope = 1 WHERE id = ?1",
            [fixture.address_ids[0]],
        )
        .expect("make fixture candidate internally scoped");

    assert!(
        read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id).is_err()
    );
}

#[test]
fn retrieved_unscanned_output_is_retained_without_canonical_mining_evidence() {
    let fixture = Fixture::new();
    fixture.insert_received(1, 0, false);
    // A retrieved transaction can carry a height before its scanned block hash
    // is linked. It must not become a canonical confirmed receipt.
    let connection = Connection::open(&fixture.wallet_path).expect("open disposable fixture");
    connection
        .execute("UPDATE transactions SET block = NULL WHERE id_tx = 1", [])
        .expect("remove only the fixture scanned-block link");

    let history = read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
        .expect("retain retrieved external history");
    assert_eq!(history.outputs.len(), 1);
    assert_eq!(history.outputs[0].mined, None);
}

#[test]
fn wallet_library_rewind_retains_output_identity_but_revokes_canonical_receipt() {
    let fixture = Fixture::new();
    fixture.insert_received(1, 0, false);
    let store_path = fixture.root.join("scanner-owned.sqlite");
    let store = SnapshotStore::open(
        &store_path,
        "scanner-a",
        ChainIdentity::fixture(),
        &fixture.account_id,
    )
    .expect("open scanner-owned history store");
    let observed = store
        .publish(
            101,
            "01".repeat(32),
            read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
                .expect("project mined fixture before rewind")
                .outputs,
            true,
            true,
            1_000,
        )
        .expect("publish mined receipt");
    let original = observed.receipts[0].clone();

    let mut wallet = open_persistent_wallet_db(&fixture.wallet_path, fixture.params.clone())
        .expect("open migrated fixture through pinned library");
    wallet
        .truncate_to_height(BlockHeight::from_u32(100))
        .expect("rewind fixture below observed Orchard receipt through wallet library");
    drop(wallet);

    let rewound = store
        .publish(
            99,
            "09".repeat(32),
            read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
                .expect("project retained fixture history after library rewind")
                .outputs,
            true,
            true,
            1_001,
        )
        .expect("publish revoked receipt history");
    assert!(rewound.generation > observed.generation);
    let receipt = rewound
        .receipts
        .iter()
        .find(|receipt| receipt.output_id == original.output_id)
        .expect("rewind preserves output identity in scanner history");
    assert_eq!(receipt.first_seen_at, original.first_seen_at);
    assert!(!receipt.canonical);
    assert_eq!(receipt.mined, None);

    // Construct a same-height fork only in the disposable fixture, reconcile it,
    // then use the library rewind path again. A stale hash must not re-enable
    // canonicality after the second invalidation.
    let connection = Connection::open(&fixture.wallet_path).expect("open disposable fork fixture");
    connection
        .execute(
            "INSERT INTO blocks (height, hash, time, sapling_tree) VALUES (101, ?1, 0, X'00')",
            [vec![3_u8; 32]],
        )
        .expect("insert deterministic same-height fork block");
    connection
        .execute(
            "UPDATE transactions SET block = 101, mined_height = 101 WHERE id_tx = 1",
            [],
        )
        .expect("link retained fixture output to same-height fork");
    let rescanned = store
        .publish(
            101,
            "03".repeat(32),
            read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
                .expect("project deterministic same-height fork")
                .outputs,
            true,
            true,
            1_002,
        )
        .expect("publish deterministic same-height fork");
    assert!(rescanned.receipts[0].canonical);

    let mut wallet = open_persistent_wallet_db(&fixture.wallet_path, fixture.params.clone())
        .expect("reopen migrated fixture through pinned library");
    wallet
        .truncate_to_height(BlockHeight::from_u32(100))
        .expect("rewind deterministic same-height fork through wallet library");
    drop(wallet);
    let revoked_again = store
        .publish(
            100,
            "00".repeat(32),
            read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id)
                .expect("project retained history after second library rewind")
                .outputs,
            true,
            true,
            1_003,
        )
        .expect("publish second revoked receipt history");
    assert!(revoked_again.generation > rescanned.generation);
    let receipt = revoked_again
        .receipts
        .iter()
        .find(|receipt| receipt.output_id == original.output_id)
        .expect("second rewind retains original output identity");
    assert_eq!(receipt.first_seen_at, original.first_seen_at);
    assert!(!receipt.canonical);
    assert_eq!(receipt.mined, None);
}

#[test]
fn library_migrated_fixture_has_the_pinned_required_object_kinds() {
    let fixture = Fixture::new();
    let connection =
        Connection::open(&fixture.wallet_path).expect("open disposable migrated fixture");

    for (object, expected_kind) in [
        ("v_received_outputs", "view"),
        ("transactions", "table"),
        ("accounts", "table"),
        ("orchard_received_notes", "table"),
        ("addresses", "table"),
        ("blocks", "table"),
        ("orchard_received_note_spends", "table"),
    ] {
        let actual_kind: String = connection
            .query_row(
                "SELECT type FROM sqlite_master WHERE name = ?1",
                [object],
                |row| row.get(0),
            )
            .expect("required object exists in locked library-migrated fixture");
        assert_eq!(
            actual_kind, expected_kind,
            "locked library migrated {object} as the expected SQLite kind"
        );
    }
}

#[test]
fn schema_drift_is_unavailable_instead_of_falling_back_to_lookalike_sql() {
    let fixture = Fixture::new();
    let connection =
        Connection::open(&fixture.wallet_path).expect("open disposable migrated fixture");
    connection
        .execute_batch("DROP VIEW v_received_outputs")
        .expect("remove required view only in disposable fixture");

    assert_eq!(
        read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id),
        Err(ProjectionError::Unavailable)
    );
}

#[test]
fn selected_received_note_joined_to_a_foreign_address_account_fails_closed() {
    let fixture = Fixture::new();
    fixture.insert_received(1, 0, false);
    let connection =
        Connection::open(&fixture.wallet_path).expect("open disposable migrated fixture");
    connection
        .execute(
            "UPDATE addresses SET account_id = ?1 WHERE id = ?2",
            params![fixture.foreign_account_row_id, fixture.address_ids[0]],
        )
        .expect("make selected received note reference foreign address account");

    assert_eq!(
        read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id),
        Err(ProjectionError::UnresolvedCandidate)
    );
}

#[test]
fn a_lookalike_table_with_projection_columns_is_schema_drift_not_empty_history() {
    let fixture = Fixture::new();
    let connection =
        Connection::open(&fixture.wallet_path).expect("open disposable migrated fixture");
    connection
        .execute_batch(
            "DROP VIEW v_received_outputs;
             CREATE TABLE v_received_outputs (
                id_within_pool_table INTEGER, transaction_id INTEGER, pool INTEGER,
                output_index INTEGER, account_id INTEGER, value INTEGER, address_id INTEGER
             )",
        )
        .expect("replace required view only in disposable fixture");

    assert_eq!(
        read_wallet_history(&fixture.wallet_path, &fixture.params, &fixture.account_id),
        Err(ProjectionError::Unavailable)
    );
}
