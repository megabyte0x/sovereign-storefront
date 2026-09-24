#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const ACTIVATION_FLAGS: [&str; 20] = [
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
];

const LEGACY_ACTIVATION_FLAGS: [&str; 20] = [
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
];

fn private_runtime_dir(test_name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is after UNIX epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "payment-test-wallet-{test_name}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&directory).expect("create isolated runtime directory");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .expect("restrict runtime directory permissions");
    directory
}

#[test]
fn provisioning_accepts_runtime_evidence_that_future_upgrades_are_unactivated() {
    let runtime = private_runtime_dir("legacy-regtest");
    let config = runtime.join("scanner.json");
    let mut command = Command::new(env!("CARGO_BIN_EXE_payment-test-wallet"));
    command
        .arg("--config")
        .arg(&config)
        .arg("--birthday")
        .arg("42")
        .args(LEGACY_ACTIVATION_FLAGS);

    let result = command.output().expect("run provisioning helper");
    assert!(result.status.success());
    assert_eq!(result.stdout, b"provisioned\n");
    assert!(result.stderr.is_empty());
    assert_eq!(
        fs::metadata(&config)
            .expect("scanner config exists")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    fs::remove_dir_all(runtime).expect("remove generated test runtime directory");
}

#[test]
fn provisioning_keeps_cli_secret_free_and_config_private() {
    let runtime = private_runtime_dir("secret-free");
    let config = runtime.join("scanner.json");
    let mut command = Command::new(env!("CARGO_BIN_EXE_payment-test-wallet"));
    command
        .arg("--config")
        .arg(&config)
        .arg("--birthday")
        .arg("0")
        .args(ACTIVATION_FLAGS);

    let result = command.output().expect("run provisioning helper");
    assert!(
        result.status.success(),
        "helper must provision without outputting secrets"
    );
    assert_eq!(result.stdout, b"provisioned\n");
    assert!(result.stderr.is_empty());

    let config_metadata = fs::metadata(&config).expect("scanner config exists");
    assert_eq!(config_metadata.permissions().mode() & 0o777, 0o600);
    let runtime_metadata = fs::metadata(&runtime).expect("runtime directory exists");
    assert_eq!(runtime_metadata.permissions().mode() & 0o777, 0o700);
    assert_eq!(
        fs::read_dir(&runtime)
            .expect("read runtime names only")
            .count(),
        1
    );

    fs::remove_dir_all(runtime).expect("remove generated test runtime directory");
}

#[test]
fn provisioning_refuses_to_overwrite_an_existing_scanner_config() {
    let runtime = private_runtime_dir("no-overwrite");
    let config = runtime.join("scanner.json");
    fs::write(&config, b"{}").expect("create non-secret sentinel config");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600))
        .expect("restrict sentinel config permissions");

    let mut command = Command::new(env!("CARGO_BIN_EXE_payment-test-wallet"));
    command
        .arg("--config")
        .arg(&config)
        .arg("--birthday")
        .arg("0")
        .args(ACTIVATION_FLAGS);

    let result = command.output().expect("run provisioning helper");
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
    assert_eq!(fs::metadata(&config).expect("sentinel remains").len(), 2);

    fs::remove_dir_all(runtime).expect("remove generated test runtime directory");
}
