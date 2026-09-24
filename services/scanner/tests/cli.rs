#![cfg(unix)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    fs::OpenOptions,
    os::{fd::AsRawFd, unix::fs::PermissionsExt},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sovereign_storefront_scanner::{
    allocate::ChainIdentity, config::ActivationHeights, consensus::consensus_fingerprint,
    daemon::PersistentScanner, scan::state_root_for,
};
use zcash_client_backend::{data_api::AccountBirthday, proto::service::TreeState};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_protocol::{
    consensus::{BlockHeight, TEST_NETWORK},
    local_consensus::LocalNetwork,
};
use zip32::AccountId;

static PRIVATE_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

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

fn private_complete_runtime_config_with_ufvk(ufvk: String) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let fixture_id = PRIVATE_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("scanner-cli-private-{nonce}-{fixture_id}"));
    fs::create_dir(&root).expect("create disposable private config root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .expect("protect disposable private config root");

    let config = root.join("scanner.json");
    let activations: BTreeMap<String, Option<u32>> = [
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
    ]
    .into_iter()
    .map(|name| (name.to_owned(), Some(1)))
    .collect();
    let chain = ChainIdentity {
        consensus_fingerprint: consensus_fingerprint(
            "regtest",
            &ActivationHeights::from_config(&activations).expect("fixture schedule is valid"),
        )
        .expect("derive fixture consensus fingerprint"),
        ..ChainIdentity::fixture()
    };
    let body = serde_json::json!({
        "ufvk": ufvk,
        "birthday": 1,
        "birthdayTree": {
            "network": "regtest",
            "height": 0,
            "hash": "00".repeat(32),
            "time": 0,
            "saplingTree": "",
            "orchardTree": "",
            "ironwoodTree": ""
        },
        "runtime": {
            "sourceId": "disposable-scanner",
            "chain": chain,
            "lightwalletd": "http://127.0.0.1:9067",
            "activations": activations
        }
    });
    fs::write(
        &config,
        serde_json::to_vec(&body).expect("encode private fixture config"),
    )
    .expect("write private fixture config");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600))
        .expect("protect private fixture config");
    config
}

fn private_complete_runtime_config() -> std::path::PathBuf {
    let params = regtest_parameters();
    let mut seed = [0_u8; 32];
    getrandom::fill(&mut seed).expect("generate disposable fixture seed");
    let ufvk = UnifiedSpendingKey::from_seed(&params, &seed, AccountId::ZERO)
        .expect("derive disposable fixture UFVK")
        .to_unified_full_viewing_key()
        .encode(&params);
    seed.fill(0);
    private_complete_runtime_config_with_ufvk(ufvk)
}

fn write_private_config(config: &std::path::Path, body: &serde_json::Value) {
    fs::write(
        config,
        serde_json::to_vec(body).expect("encode altered private fixture config"),
    )
    .expect("replace altered private fixture config");
    fs::set_permissions(config, fs::Permissions::from_mode(0o600))
        .expect("preserve private fixture config permissions");
}

fn replace_attested_hash(body: &mut serde_json::Value) {
    body["birthdayTree"]["hash"] = serde_json::Value::String("11".repeat(32));
}

fn replace_attested_orchard_frontier(body: &mut serde_json::Value) {
    // This is the zcashd RPC encoding of a one-leaf Orchard commitment tree
    // whose canonical pallas field element is one; it differs from the empty
    // frontier while still being accepted by AccountBirthday's pinned decoder.
    let frontier = format!("01{}0000", "01".to_owned() + &"00".repeat(31));
    assert!(
        AccountBirthday::from_treestate(
            TreeState {
                network: "regtest".to_owned(),
                height: 0,
                hash: "00".repeat(32),
                time: 0,
                sapling_tree: String::new(),
                orchard_tree: frontier.clone(),
                ironwood_tree: String::new(),
            },
            None,
        )
        .is_ok(),
        "fixture must contain a valid alternative Orchard frontier"
    );
    body["birthdayTree"]["orchardTree"] = serde_json::Value::String(frontier);
}

fn replace_attested_chain_identity(body: &mut serde_json::Value) {
    body["runtime"]["chain"]["genesisHash"] = serde_json::Value::String("b".repeat(64));
}

struct ChildGuard {
    child: Child,
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_for_socket(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("serve lifecycle did not bind its private socket");
}

fn scanner_state_files(path: &std::path::Path) -> BTreeMap<OsString, Vec<u8>> {
    fs::read_dir(path)
        .expect("read scanner state directory")
        .map(|entry| entry.expect("read scanner state entry"))
        .filter_map(|entry| {
            entry
                .file_type()
                .expect("inspect scanner state entry")
                .is_file()
                .then(|| {
                    (
                        entry.file_name(),
                        fs::read(entry.path()).expect("read scanner state file"),
                    )
                })
        })
        .collect()
}

fn qualify_mutator(binary: &str, config: &std::path::Path, stage: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .args([
            "qualify",
            "--stage",
            stage,
            "--config",
            config.to_str().expect("private config path"),
            "--lightwalletd",
            "http://127.0.0.1:1",
            "--overwinter",
            "1",
            "--sapling",
            "1",
            "--blossom",
            "1",
            "--heartwood",
            "1",
            "--canopy",
            "1",
            "--nu5",
            "1",
            "--nu6",
            "1",
            "--nu6-1",
            "1",
            "--nu6-2",
            "1",
            "--nu6-3",
            "1",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[test]
fn qualify_requires_an_explicit_lightwalletd_endpoint() {
    let result = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
        .arg("qualify")
        .output()
        .expect("run scanner CLI");

    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
}

#[test]
fn qualify_reaches_the_private_config_gate_only_with_a_complete_runtime_schedule() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let config = std::env::temp_dir().join(format!("scanner-cli-{nonce}.json"));
    fs::write(&config, b"{}").expect("write non-secret invalid config");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).expect("make config private");

    let result = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
        .args([
            "qualify",
            "--stage",
            "prepare",
            "--config",
            config.to_str().expect("valid config path"),
            "--lightwalletd",
            "local",
            "--overwinter",
            "1",
            "--sapling",
            "1",
            "--blossom",
            "1",
            "--heartwood",
            "1",
            "--canopy",
            "1",
            "--nu5",
            "1",
            "--nu6",
            "1",
            "--nu6-1",
            "none",
            "--nu6-2",
            "none",
            "--nu6-3",
            "none",
        ])
        .output()
        .expect("run scanner CLI");

    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
    fs::remove_file(config).expect("remove config");
}

#[test]
fn init_view_fails_closed_without_a_private_complete_runtime_config() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let config = std::env::temp_dir().join(format!("scanner-init-view-{nonce}.json"));
    fs::write(&config, b"{}").expect("write non-secret invalid config");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).expect("make config private");

    let result = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
        .args([
            "init-view",
            "--config",
            config.to_str().expect("valid config path"),
        ])
        .output()
        .expect("run scanner CLI");

    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert_eq!(result.stderr, b"scanner runtime initialization failed\n");
    fs::remove_file(config).expect("remove config");
}

#[test]
fn init_view_rejects_plaintext_non_loopback_lightwalletd_before_creating_state() {
    let config = private_complete_runtime_config();
    let state = state_root_for(&config).expect("derive runtime state path");
    let mut body: serde_json::Value =
        serde_json::from_slice(&fs::read(&config).expect("read private fixture config"))
            .expect("decode private fixture config");
    body["runtime"]["lightwalletd"] =
        serde_json::Value::String("http://lightwalletd.example:9067".to_owned());
    write_private_config(&config, &body);

    let result = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
        .args([
            "init-view",
            "--config",
            config.to_str().expect("private config path"),
        ])
        .output()
        .expect("run scanner init lifecycle");

    assert!(!result.status.success());
    assert_eq!(result.stdout, b"");
    assert_eq!(result.stderr, b"scanner runtime initialization failed\n");
    assert!(
        !state.exists(),
        "rejected transport must not create scanner runtime state"
    );
    fs::remove_dir_all(config.parent().expect("private root")).expect("remove private fixture");
}

#[test]
fn init_view_rejects_unbound_or_altered_consensus_fingerprints_before_creating_state() {
    let alterations: [fn(&mut serde_json::Value); 3] = [
        // An arbitrary well-formed digest is not derived from the schedule.
        |body| body["runtime"]["chain"]["consensusFingerprint"] = "c".repeat(64).into(),
        // A changed schedule no longer matches its previously derived digest.
        |body| body["runtime"]["activations"]["nu6-3"] = serde_json::Value::Null,
        // Missing required upgrades are not silently treated as unactivated.
        |body| {
            body["runtime"]["activations"]
                .as_object_mut()
                .expect("activation map")
                .remove("nu5");
        },
    ];
    for alter in alterations {
        let config = private_complete_runtime_config();
        let state = state_root_for(&config).expect("derive runtime state path");
        let mut body: serde_json::Value =
            serde_json::from_slice(&fs::read(&config).expect("read private fixture config"))
                .expect("decode private fixture config");
        alter(&mut body);
        write_private_config(&config, &body);

        let result = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
            .args([
                "init-view",
                "--config",
                config.to_str().expect("private config path"),
            ])
            .output()
            .expect("run scanner init lifecycle");

        assert!(!result.status.success());
        assert_eq!(result.stdout, b"");
        assert_eq!(result.stderr, b"scanner runtime initialization failed\n");
        assert!(
            !state.exists(),
            "an unbound chain identity must not create scanner runtime state"
        );
        fs::remove_dir_all(config.parent().expect("private root")).expect("remove private fixture");
    }
}

#[test]
fn init_view_imports_a_clean_private_ufvk_idempotently_and_serve_can_reopen_it() {
    let config = private_complete_runtime_config();
    let binary = env!("CARGO_BIN_EXE_sovereign-storefront-scanner");

    for _ in 0..2 {
        let result = Command::new(binary)
            .args([
                "init-view",
                "--config",
                config.to_str().expect("valid private config path"),
            ])
            .output()
            .expect("run private init-view fixture");
        assert!(
            result.status.success(),
            "init-view stderr: {:?}",
            result.stderr
        );
        assert_eq!(result.stdout, b"scanner_view_initialized\n");
        assert!(result.stderr.is_empty());
    }

    // `serve` uses this same constructor before it accepts the socket. Reopening
    // here proves the account persisted by the private init surface is discoverable
    // without starting any chain or long-lived daemon fixture.
    PersistentScanner::open(&config).expect("serve can reopen the configured view-only account");
    fs::remove_dir_all(config.parent().expect("private root")).expect("remove private fixture");
}

#[test]
fn init_view_rejects_a_second_process_before_wallet_or_application_state_mutation() {
    let config = private_complete_runtime_config();
    let root = config.parent().expect("private root");
    let lease_path = root.join(".scanner.json.writer.lock");
    let lease_file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&lease_path)
        .expect("create private descriptor-rooted lease file");
    fs::set_permissions(&lease_path, fs::Permissions::from_mode(0o600))
        .expect("protect private descriptor-rooted lease file");
    // An independent raw kernel flock exercises the lifecycle boundary without
    // importing the scanner's crate-private lease capability into this test.
    let lock_result = unsafe {
        nix::libc::flock(
            lease_file.as_raw_fd(),
            nix::libc::LOCK_EX | nix::libc::LOCK_NB,
        )
    };
    assert_eq!(lock_result, 0, "first lifecycle owns the raw writer flock");

    let result = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
        .args([
            "init-view",
            "--config",
            config.to_str().expect("valid private config path"),
        ])
        .output()
        .expect("run competing init-view process");
    assert!(!result.status.success());
    assert_eq!(result.stdout, b"");
    assert_eq!(result.stderr, b"scanner runtime initialization failed\n");
    assert!(
        !root.join(".scanner.json.live-state").exists(),
        "a rejected writer must not initialize wallet or application state"
    );

    drop(lease_file);
    fs::remove_dir_all(root).expect("remove private fixture");
}

#[test]
fn init_view_and_serve_reject_invalid_ufvks_before_creating_runtime_state() {
    let regtest = regtest_parameters();
    let mut seed = [0_u8; 32];
    getrandom::fill(&mut seed).expect("generate disposable fixture seed");
    let full = UnifiedSpendingKey::from_seed(&regtest, &seed, AccountId::ZERO)
        .expect("derive disposable fixture UFVK")
        .to_unified_full_viewing_key();
    let wrong_network = UnifiedSpendingKey::from_seed(&TEST_NETWORK, &seed, AccountId::ZERO)
        .expect("derive disposable test-network UFVK")
        .to_unified_full_viewing_key()
        .encode(&TEST_NETWORK);
    seed.fill(0);
    let orchard_less = UnifiedFullViewingKey::new(full.sapling().cloned(), None)
        .expect("construct valid Orchard-less fixture UFVK")
        .encode(&regtest);

    for encoded in [wrong_network, orchard_less] {
        let config = private_complete_runtime_config_with_ufvk(encoded);
        let state = state_root_for(&config).expect("derive runtime state path");
        for command in ["init-view", "serve"] {
            let result = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
                .args([
                    command,
                    "--config",
                    config.to_str().expect("private config path"),
                ])
                .output()
                .expect("run invalid private scanner lifecycle");
            assert!(
                !result.status.success(),
                "{command} accepted an invalid private UFVK"
            );
            assert_eq!(result.stdout, b"");
            assert!(
                !state.exists(),
                "{command} created runtime state before rejecting the configured UFVK"
            );
        }
        fs::remove_dir_all(config.parent().expect("private root"))
            .expect("remove private fixture root");
    }
}

#[test]
fn init_view_and_serve_reject_changed_operator_attested_birthday_state() {
    for (label, mutate) in [
        (
            "same-height different block hash",
            replace_attested_hash as fn(&mut serde_json::Value),
        ),
        (
            "different Orchard frontier",
            replace_attested_orchard_frontier,
        ),
        (
            "changed configured chain identity",
            replace_attested_chain_identity,
        ),
    ] {
        let config = private_complete_runtime_config();
        let state = state_root_for(&config).expect("derive runtime state path");
        let initialized = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
            .args([
                "init-view",
                "--config",
                config.to_str().expect("private config path"),
            ])
            .output()
            .expect("initialize operator-attested private scanner");
        assert!(
            initialized.status.success(),
            "initialization failed: {label}"
        );

        let attestation_path = state.join("birthday-attestation.json");
        let original_attestation = fs::read(&attestation_path)
            .expect("first import persists the scanner-owned birthday attestation");
        let fingerprint: serde_json::Value =
            serde_json::from_slice(&original_attestation).expect("attestation is structured data");
        assert_eq!(fingerprint["chain"]["network"], "regtest");
        assert_eq!(fingerprint["treeState"]["height"], 0);
        assert!(fingerprint.get("ufvk").is_none());

        let mut altered: serde_json::Value =
            serde_json::from_slice(&fs::read(&config).expect("read private fixture config"))
                .expect("decode private fixture config");
        mutate(&mut altered);
        write_private_config(&config, &altered);

        for command in ["init-view", "serve"] {
            let repeated = Command::new(env!("CARGO_BIN_EXE_sovereign-storefront-scanner"))
                .args([
                    command,
                    "--config",
                    config.to_str().expect("private config path"),
                ])
                .output()
                .expect("rerun private lifecycle with altered trust state");
            assert!(
                !repeated.status.success(),
                "{command} accepted {label} after the first trusted import"
            );
            assert_eq!(repeated.stdout, b"");
        }
        assert_eq!(
            fs::read(&attestation_path).expect("persisted attestation remains readable"),
            original_attestation,
            "rejected config changes must never rewrite the operator attestation"
        );
        fs::remove_dir_all(config.parent().expect("private root"))
            .expect("remove private fixture root");
    }
}

#[test]
fn altered_scanner_owned_birthday_attestation_blocks_repeat_lifecycles() {
    let config = private_complete_runtime_config();
    let binary = env!("CARGO_BIN_EXE_sovereign-storefront-scanner");
    let initialized = Command::new(binary)
        .args([
            "init-view",
            "--config",
            config.to_str().expect("private config path"),
        ])
        .output()
        .expect("initialize scanner trust state");
    assert!(initialized.status.success());

    let state = state_root_for(&config).expect("derive runtime state path");
    let attestation_path = state.join("birthday-attestation.json");
    let mut altered: serde_json::Value =
        serde_json::from_slice(&fs::read(&attestation_path).expect("read scanner attestation"))
            .expect("decode scanner attestation");
    altered["treeState"]["hash"] = serde_json::Value::String("22".repeat(32));
    let altered_bytes = serde_json::to_vec(&altered).expect("encode tampered attestation");
    fs::write(&attestation_path, &altered_bytes).expect("tamper scanner attestation");
    fs::set_permissions(&attestation_path, fs::Permissions::from_mode(0o600))
        .expect("preserve scanner attestation permissions");

    for command in ["init-view", "serve"] {
        let repeated = Command::new(binary)
            .args([
                command,
                "--config",
                config.to_str().expect("private config path"),
            ])
            .output()
            .expect("rerun lifecycle after state tampering");
        assert!(
            !repeated.status.success(),
            "{command} accepted an altered scanner-owned birthday attestation"
        );
        assert_eq!(repeated.stdout, b"");
    }
    assert_eq!(
        fs::read(&attestation_path).expect("read rejected attestation"),
        altered_bytes,
        "a rejected lifecycle must never rewrite scanner-owned trust state"
    );
    fs::remove_dir_all(config.parent().expect("private root")).expect("remove private fixture");
}

#[test]
fn active_serve_lifecycle_blocks_init_view_and_every_retained_qualify_mutator() {
    let config = private_complete_runtime_config();
    let binary = env!("CARGO_BIN_EXE_sovereign-storefront-scanner");
    let initialized = Command::new(binary)
        .args([
            "init-view",
            "--config",
            config.to_str().expect("private config path"),
        ])
        .output()
        .expect("initialize private scanner before serve");
    assert!(initialized.status.success());

    let state = state_root_for(&config).expect("derive runtime state path");
    let socket = state.join("scanner.sock");
    let holder = ChildGuard {
        child: Command::new(binary)
            .args([
                "serve",
                "--config",
                config.to_str().expect("private config path"),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start actual serve lifecycle"),
    };
    wait_for_socket(&socket);
    let before = scanner_state_files(&state);

    let competing_init = Command::new(binary)
        .args([
            "init-view",
            "--config",
            config.to_str().expect("private config path"),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .expect("attempt competing init-view lifecycle");
    assert!(!competing_init.status.success());
    assert_eq!(
        scanner_state_files(&state),
        before,
        "competing init-view must fail before mutating scanner state"
    );

    for stage in ["prepare", "before-ten", "at-ten", "verify-restart"] {
        let result = qualify_mutator(binary, &config, stage)
            .output()
            .expect("attempt retained qualify mutator");
        assert!(
            !result.status.success(),
            "qualify {stage} acquired a writer lease while serve was active"
        );
        assert_eq!(
            scanner_state_files(&state),
            before,
            "qualify {stage} must fail before opening or mutating scanner state"
        );
    }
    drop(holder);
    fs::remove_dir_all(config.parent().expect("private root")).expect("remove private fixture");
}
