#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    time::{SystemTime, UNIX_EPOCH},
};

use sovereign_storefront_scanner::config::{read_private_config, validate_lightwalletd_endpoint};

#[test]
fn lightwalletd_transport_rejects_plaintext_non_loopback_endpoints() {
    for endpoint in [
        "https://lightwalletd.example:9067",
        "http://127.0.0.1:9067",
        "http://localhost:9067",
        "http://[::1]:9067",
    ] {
        assert!(
            validate_lightwalletd_endpoint(endpoint).is_ok(),
            "{endpoint} should be allowed"
        );
    }

    for endpoint in [
        "",
        "lightwalletd.example:9067",
        "grpc://lightwalletd.example:9067",
        "http://lightwalletd.example:9067",
        "http://10.0.0.1:9067",
        "http://127.0.0.1@lightwalletd.example:9067",
    ] {
        assert!(
            validate_lightwalletd_endpoint(endpoint).is_err(),
            "{endpoint} must be rejected"
        );
    }
}

#[test]
fn protected_config_rejects_non_private_permissions_before_parsing() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("scanner-config-{nonce}"));
    fs::write(&path, b"{}").expect("write non-secret invalid fixture");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("make fixture unsafe");

    assert!(read_private_config(&path).is_err());

    fs::remove_file(path).expect("remove fixture");
}

#[test]
fn protected_config_rejects_a_missing_required_field_without_exposing_content() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("scanner-config-missing-{nonce}"));
    fs::write(&path, b"{}").expect("write non-secret invalid fixture");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("make fixture private");

    assert!(read_private_config(&path).is_err());

    fs::remove_file(path).expect("remove fixture");
}

#[test]
fn protected_config_rejects_shared_or_symlinked_parent_before_reading() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("scanner-config-parent-{nonce}"));
    fs::create_dir(&root).expect("create fixture root");
    let shared = root.join("shared");
    fs::create_dir(&shared).expect("create shared fixture parent");
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).expect("make parent shared");
    let shared_config = shared.join("scanner.json");
    fs::write(&shared_config, b"{\"ufvk\":\"fixture\",\"birthday\":0}")
        .expect("write non-secret fixture");
    fs::set_permissions(&shared_config, fs::Permissions::from_mode(0o600))
        .expect("make fixture private");
    assert!(read_private_config(&shared_config).is_err());

    let private = root.join("private");
    fs::create_dir(&private).expect("create private fixture parent");
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).expect("make parent private");
    let target_config = private.join("scanner.json");
    fs::write(&target_config, b"{\"ufvk\":\"fixture\",\"birthday\":0}")
        .expect("write non-secret fixture");
    fs::set_permissions(&target_config, fs::Permissions::from_mode(0o600))
        .expect("make fixture private");
    let redirected_parent = root.join("redirected");
    std::os::unix::fs::symlink(&private, &redirected_parent).expect("create parent symlink");
    assert!(read_private_config(&redirected_parent.join("scanner.json")).is_err());

    fs::remove_dir_all(root).expect("remove generated fixture root");
}
