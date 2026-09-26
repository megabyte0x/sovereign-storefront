#![cfg(unix)]
//! Coordinated scanner restore semantics (Task 11 / R1.1).
//!
//! A provisioned view-only state is copied file-by-file (config, wallet DB,
//! application DB — exactly the frozen coordinated-backup roles) into a fresh
//! owner-private directory, then reopened. All chain access is absent: these
//! are deterministic fixtures, never live evidence.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, params};
use sovereign_storefront_scanner::{
    allocate::ChainIdentity, api::HttpRequest, config::ActivationHeights,
    consensus::consensus_fingerprint, daemon::PersistentScanner, scan::state_root_for,
};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork};
use zip32::{AccountId, DiversifierIndex};

static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
const BINARY: &str = env!("CARGO_BIN_EXE_sovereign-storefront-scanner");

fn regtest_parameters() -> LocalNetwork {
    let one = Some(BlockHeight::from_u32(1));
    LocalNetwork {
        overwinter: one,
        sapling: one,
        blossom: one,
        heartwood: one,
        canopy: one,
        nu5: one,
        nu6: one,
        nu6_1: one,
        nu6_2: one,
        nu6_3: one,
    }
}

fn private_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("scanner-restore-{label}-{nonce}-{id}"));
    fs::create_dir(&root).expect("create private root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("protect private root");
    root
}

fn chain() -> ChainIdentity {
    let activations: BTreeMap<String, Option<u32>> = ACTIVATIONS
        .into_iter()
        .map(|name| (name.to_owned(), Some(1)))
        .collect();
    ChainIdentity {
        consensus_fingerprint: consensus_fingerprint(
            "regtest",
            &ActivationHeights::from_config(&activations).expect("fixture schedule"),
        )
        .expect("fixture fingerprint"),
        ..ChainIdentity::fixture()
    }
}

const ACTIVATIONS: [&str; 10] = [
    "overwinter",
    "sapling",
    "blossom",
    "heartwood",
    "canopy",
    "nu5",
    "nu6",
    "nu6-1",
    "nu6-2",
    "nu6-3",
];

struct Provisioned {
    root: PathBuf,
    config: PathBuf,
    ufvk: UnifiedFullViewingKey,
}

fn provision(label: &str) -> Provisioned {
    let params = regtest_parameters();
    let mut seed = [0_u8; 32];
    getrandom::fill(&mut seed).expect("fixture seed");
    let ufvk = UnifiedSpendingKey::from_seed(&params, &seed, AccountId::ZERO)
        .expect("fixture key")
        .to_unified_full_viewing_key();
    seed.fill(0);
    let root = private_root(label);
    let config = root.join("scanner.json");
    let activations: BTreeMap<String, Option<u32>> = ACTIVATIONS
        .into_iter()
        .map(|name| (name.to_owned(), Some(1)))
        .collect();
    let body = serde_json::json!({
        "ufvk": ufvk.encode(&params),
        "birthday": 1,
        "birthdayTree": {
            "network": "regtest", "height": 0, "hash": "00".repeat(32), "time": 0,
            "saplingTree": "", "orchardTree": "", "ironwoodTree": ""
        },
        "runtime": {
            "sourceId": "restore-scanner",
            "chain": chain(),
            "lightwalletd": "http://127.0.0.1:9067",
            "activations": activations
        }
    });
    fs::write(&config, serde_json::to_vec(&body).expect("encode config")).expect("write config");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).expect("protect config");
    Provisioned { root, config, ufvk }
}

fn allocation_request(account_id: &str, allocation_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "allocationId": allocation_id,
        "chain": chain(),
        "accountId": account_id,
        "amountZat": "100000000",
        "expiresAt": 4_000_000_000_u64,
    }))
    .expect("encode allocation request")
}

fn allocate(scanner: &PersistentScanner, allocation_id: &str) -> serde_json::Value {
    let response = scanner
        .handle(HttpRequest::post(
            "/v1/allocations",
            allocation_request(scanner.account_id(), allocation_id),
        ))
        .expect("allocation handled");
    assert_eq!(response.status, 200, "allocation {allocation_id} failed");
    serde_json::from_slice(&response.body).expect("allocation json")
}

fn snapshot(scanner: &PersistentScanner) -> (u16, serde_json::Value) {
    let response = scanner
        .handle(HttpRequest::get("/v1/snapshot"))
        .expect("snapshot handled");
    let body = serde_json::from_slice(&response.body).unwrap_or(serde_json::Value::Null);
    (response.status, body)
}

/// Orchard receiver bytes the UFVK yields at a little-endian diversifier index.
fn receiver_at(ufvk: &UnifiedFullViewingKey, index: u64) -> Option<String> {
    let mut bytes = [0_u8; 11];
    bytes[..8].copy_from_slice(&index.to_le_bytes());
    ufvk.address(
        DiversifierIndex::from(bytes),
        UnifiedAddressRequest::ORCHARD,
    )
    .ok()
    .and_then(|address| {
        address
            .orchard()
            .map(|r| hex::encode(r.to_raw_address_bytes()))
    })
}

fn le_index(hex_index: &str) -> u64 {
    let bytes = hex::decode(hex_index).expect("index hex");
    assert_eq!(bytes.len(), 11);
    assert!(
        bytes[8..].iter().all(|byte| *byte == 0),
        "fixture index fits u64"
    );
    u64::from_le_bytes(bytes[..8].try_into().expect("u64"))
}

/// Seeds scanner-owned fixture state the socket cannot create without a chain:
/// one ready snapshot and one crashed (reserved, never finalized) allocation.
fn seed_application_fixtures(state: &Path, account_id: &str) -> u64 {
    let connection = Connection::open(state.join("scanner.sqlite")).expect("open app db");
    let body = serde_json::json!({
        "version": 1, "sourceId": "restore-scanner", "generation": "5",
        "chain": chain(), "accountId": account_id,
        "tip": {"height": 30, "hash": "d".repeat(64)},
        "scanned": {"height": 30, "hash": "d".repeat(64)},
        "checkedAt": 1_000, "caughtUp": true, "complete": true, "health": "ready",
        "receipts": []
    });
    connection
        .execute(
            "INSERT INTO snapshots (generation, body) VALUES (5, ?1)",
            [serde_json::to_vec(&body).expect("snapshot body")],
        )
        .expect("seed ready snapshot");
    let burned: String = connection
        .query_row(
            "SELECT burned_index FROM allocation_watermarks WHERE account_id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .expect("watermark exists");
    let crashed = le_index(&burned) + 1;
    let mut index = [0_u8; 11];
    index[..8].copy_from_slice(&crashed.to_le_bytes());
    let terms = String::from_utf8(allocation_request(account_id, "crashed-reservation"))
        .expect("terms utf8");
    connection
        .execute(
            "INSERT INTO allocations (allocation_id, terms, reserved_index, state, created_at)
             VALUES ('crashed-reservation', ?1, ?2, 'pending', 1)",
            params![terms, hex::encode(index)],
        )
        .expect("seed crashed reservation");
    connection
        .execute(
            "UPDATE allocation_watermarks SET burned_index = ?1 WHERE account_id = ?2",
            params![hex::encode(index), account_id],
        )
        .expect("burn crashed reservation");
    crashed
}

/// Copies exactly the three coordinated-backup roles into a fresh 0700 root.
fn restore_copy(original: &Provisioned, label: &str, with_attestation: bool) -> Provisioned {
    let state = state_root_for(&original.config).expect("state root");
    for name in ["wallet.sqlite", "scanner.sqlite"] {
        assert!(
            !state.join(format!("{name}-wal")).exists(),
            "{name} must be checkpointed before backup"
        );
    }
    let root = private_root(label);
    let config = root.join("scanner.json");
    fs::copy(&original.config, &config).expect("restore config");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).expect("config mode");
    let restored_state = state_root_for(&config).expect("restored state root");
    fs::create_dir(&restored_state).expect("fresh state dir");
    fs::set_permissions(&restored_state, fs::Permissions::from_mode(0o700)).expect("state mode");
    let mut names = vec!["wallet.sqlite", "scanner.sqlite"];
    if with_attestation {
        names.push("birthday-attestation.json");
    }
    for name in names {
        fs::copy(state.join(name), restored_state.join(name)).expect("restore file");
        fs::set_permissions(restored_state.join(name), fs::Permissions::from_mode(0o600))
            .expect("file mode");
    }
    Provisioned {
        root,
        config,
        ufvk: original.ufvk.clone(),
    }
}

fn run(args: &[&str], config: &Path) -> std::process::Output {
    let mut command = Command::new(BINARY);
    command.arg(args[0]).arg("--config").arg(config);
    command.args(&args[1..]);
    command.output().expect("run scanner cli")
}

fn backup_info(config: &Path) -> serde_json::Value {
    let output = run(&["backup-info"], config);
    assert!(output.status.success(), "backup-info failed");
    serde_json::from_slice(&output.stdout).expect("backup-info json")
}

struct Prior {
    account_id: String,
    finalized: Vec<(String, serde_json::Value)>,
    prior_receivers: BTreeSet<String>,
    high_water: u64,
}

fn provision_with_history(original: &Provisioned) -> Prior {
    let scanner = PersistentScanner::open(&original.config).expect("open original");
    let account_id = scanner.account_id().to_owned();
    let finalized: Vec<_> = ["invoice-a", "invoice-b"]
        .into_iter()
        .map(|id| (id.to_owned(), allocate(&scanner, id)))
        .collect();
    drop(scanner);
    let state = state_root_for(&original.config).expect("state root");
    let high_water = seed_application_fixtures(&state, &account_id);
    let prior_receivers = (0..=high_water)
        .filter_map(|index| receiver_at(&original.ufvk, index))
        .collect::<BTreeSet<_>>();
    for (_, allocation) in &finalized {
        assert!(prior_receivers.contains(allocation["receiver"]["receiverHex"].as_str().unwrap()));
    }
    Prior {
        account_id,
        finalized,
        prior_receivers,
        high_water,
    }
}

#[test]
fn restored_state_requires_explicit_new_epoch_then_preserves_allocations_and_resets_freshness() {
    let original = provision("original");
    let prior = provision_with_history(&original);
    let original_info = backup_info(&original.config);
    let restored = restore_copy(&original, "restored", false);

    // Without acknowledgement the restored state never serves any snapshot.
    assert!(PersistentScanner::open(&restored.config).is_err());
    assert!(!run(&["serve"], &restored.config).status.success());
    assert!(!run(&["restore-ack"], &restored.config).status.success());
    // The reserve gap is mandatory, positive and bounded.
    assert!(
        !run(&["restore-ack", "--new-epoch"], &restored.config)
            .status
            .success()
    );
    for bad in ["0", "-1", "abc", "1000001", "18446744073709551616", ""] {
        assert!(
            !run(
                &["restore-ack", "--new-epoch", "--reserve-gap", bad],
                &restored.config
            )
            .status
            .success(),
            "reserve gap {bad:?} must be rejected"
        );
    }
    assert!(
        PersistentScanner::open(&restored.config).is_err(),
        "a rejected acknowledgement leaves the restore unacknowledged"
    );

    let ack = run(
        &["restore-ack", "--new-epoch", "--reserve-gap", "1"],
        &restored.config,
    );
    assert!(ack.status.success(), "restore-ack failed");
    assert_eq!(ack.stdout, b"scanner_restore_acknowledged\n");
    // A second acknowledgement has nothing to acknowledge.
    assert!(
        !run(
            &["restore-ack", "--new-epoch", "--reserve-gap", "1"],
            &restored.config
        )
        .status
        .success()
    );

    let scanner = PersistentScanner::open(&restored.config).expect("reopen restored state");
    assert_eq!(scanner.account_id(), prior.account_id);
    for (id, allocation) in &prior.finalized {
        assert_eq!(
            &allocate(&scanner, id),
            allocation,
            "{id} replays byte-identically"
        );
    }
    let next = allocate(&scanner, "invoice-after-restore");
    let next_receiver = next["receiver"]["receiverHex"].as_str().expect("receiver");
    assert!(!prior.prior_receivers.contains(next_receiver));
    assert!(le_index(next["receiver"]["diversifierIndex"].as_str().unwrap()) > prior.high_water);

    let (status, current) = snapshot(&scanner);
    assert_eq!(status, 200);
    assert_eq!(current["complete"], false);
    assert_ne!(current["health"], "ready");
    assert_eq!(current["sourceId"], "restore-scanner");
    let generation: u64 = current["generation"].as_str().unwrap().parse().unwrap();
    assert!(
        generation > 5,
        "new epoch generation never reuses served generations"
    );
    drop(scanner);

    let restored_info = backup_info(&restored.config);
    assert_eq!(restored_info["accountId"], original_info["accountId"]);
    let hw = |info: &serde_json::Value| -> u128 {
        info["reservedHighWater"].as_str().unwrap().parse().unwrap()
    };
    assert!(hw(&restored_info) >= hw(&original_info));
    assert_eq!(hw(&original_info), u128::from(prior.high_water));
    for dir in [&original.root, &restored.root] {
        fs::remove_dir_all(dir).expect("cleanup");
    }
}

#[test]
fn restored_copy_with_attestation_is_detected_by_state_binding() {
    let original = provision("bound-original");
    provision_with_history(&original);
    let restored = restore_copy(&original, "bound-restored", true);

    assert!(PersistentScanner::open(&restored.config).is_err());
    assert!(
        run(
            &["restore-ack", "--new-epoch", "--reserve-gap", "1"],
            &restored.config
        )
        .status
        .success()
    );
    let scanner = PersistentScanner::open(&restored.config).expect("acknowledged reopen");
    let (status, current) = snapshot(&scanner);
    assert_eq!(status, 200);
    assert_eq!(current["complete"], false);
    drop(scanner);
    // The original, unmoved state keeps serving without any acknowledgement.
    PersistentScanner::open(&original.config).expect("original state is unaffected");
    assert!(
        !run(
            &["restore-ack", "--new-epoch", "--reserve-gap", "1"],
            &original.config
        )
        .status
        .success()
    );
    for dir in [&original.root, &restored.root] {
        fs::remove_dir_all(dir).expect("cleanup");
    }
}

#[test]
fn backup_info_prints_only_non_secret_identity_and_counts() {
    let original = provision("info");
    let prior = provision_with_history(&original);
    let output = run(&["backup-info"], &original.config);
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout.clone()).expect("utf8");
    let info: serde_json::Value = serde_json::from_str(&text).expect("json");
    let keys: BTreeSet<_> = info.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "accountId",
            "allocationCount",
            "network",
            "reservedHighWater",
            "sourceId"
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    assert_eq!(info["accountId"], prior.account_id);
    assert_eq!(info["sourceId"], "restore-scanner");
    assert_eq!(info["network"], "regtest");
    assert_eq!(info["allocationCount"], 3);
    assert_eq!(info["reservedHighWater"], prior.high_water.to_string());
    for forbidden in ["uview", "uivk", "uregtest", "zcash:"] {
        assert!(!text.contains(forbidden), "backup-info leaked {forbidden}");
    }
    for receiver in &prior.prior_receivers {
        assert!(
            !text.contains(receiver.as_str()),
            "backup-info leaked a receiver"
        );
    }
    assert!(output.stderr.is_empty());
    fs::remove_dir_all(&original.root).expect("cleanup");
}

#[test]
fn restore_ack_reserve_gap_skips_indices_the_original_may_have_issued_after_backup() {
    const GAP: u64 = 40;
    let original = provision("gap-original");
    let prior = provision_with_history(&original);
    let restored = restore_copy(&original, "gap-restored", false);

    let ack = run(
        &[
            "restore-ack",
            "--new-epoch",
            "--reserve-gap",
            &GAP.to_string(),
        ],
        &restored.config,
    );
    assert!(ack.status.success(), "restore-ack with a gap failed");
    let info = backup_info(&restored.config);
    assert_eq!(
        info["reservedHighWater"],
        (prior.high_water + GAP).to_string(),
        "the gap advances the reserved high-water mark by exactly N"
    );

    let scanner = PersistentScanner::open(&restored.config).expect("acknowledged reopen");
    // Prior allocations still replay byte-identically.
    for (id, allocation) in &prior.finalized {
        assert_eq!(&allocate(&scanner, id), allocation);
    }
    let next = allocate(&scanner, "invoice-after-gap");
    let index = le_index(next["receiver"]["diversifierIndex"].as_str().unwrap());
    assert!(index > prior.high_water + GAP - 1);
    assert_eq!(index, prior.high_water + GAP + 1);
    let reserved: BTreeSet<String> = (0..=prior.high_water + GAP)
        .filter_map(|i| receiver_at(&original.ufvk, i))
        .collect();
    assert!(!reserved.contains(next["receiver"]["receiverHex"].as_str().unwrap()));
    drop(scanner);
    // Reopening never lowers the advanced mark.
    let reopened = backup_info(&restored.config);
    assert!(
        reopened["reservedHighWater"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > prior.high_water + GAP
    );
    for dir in [&original.root, &restored.root] {
        fs::remove_dir_all(dir).expect("cleanup");
    }
}

#[test]
fn backup_info_refuses_state_that_was_never_bound() {
    let original = provision("unbound");
    provision_with_history(&original);
    let state = state_root_for(&original.config).expect("state root");
    // Simulate state last written by a scanner that predates state binding.
    Connection::open(state.join("scanner.sqlite"))
        .expect("open app db")
        .execute("DELETE FROM state_binding", [])
        .expect("drop binding row");
    fs::remove_file(state.join("state-binding")).expect("drop marker");

    let output = run(&["backup-info"], &original.config);
    assert!(
        !output.status.success(),
        "unbound state must not be backed up"
    );
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("utf8");
    assert!(
        stderr.contains("restart scanner once before backup"),
        "unexpected stderr: {stderr}"
    );
    for forbidden in ["uview", "uivk", "uregtest", "zcash:"] {
        assert!(!stderr.contains(forbidden));
    }
    fs::remove_dir_all(&original.root).expect("cleanup");
}

#[test]
fn restore_ack_fails_closed_when_allocation_state_cannot_be_read() {
    let original = provision("foreign-original");
    provision_with_history(&original);
    let restored = restore_copy(&original, "foreign-restored", false);
    let state = state_root_for(&restored.config).expect("state root");
    Connection::open(state.join("scanner.sqlite"))
        .expect("open app db")
        .execute("DROP TABLE allocation_watermarks", [])
        .expect("damage allocation state");

    assert!(
        !run(
            &["restore-ack", "--new-epoch", "--reserve-gap", "1"],
            &restored.config
        )
        .status
        .success(),
        "an unreadable foreign-account check must not fail open"
    );
    assert!(PersistentScanner::open(&restored.config).is_err());
    for dir in [&original.root, &restored.root] {
        fs::remove_dir_all(dir).expect("cleanup");
    }
}
