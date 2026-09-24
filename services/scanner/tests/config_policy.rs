#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    time::{SystemTime, UNIX_EPOCH},
};

use sovereign_storefront_scanner::{
    config::decode_regtest_orchard_ufvk,
    scan::{Stage, run, state_root_for},
};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_protocol::{
    consensus::{BlockHeight, TEST_NETWORK},
    local_consensus::LocalNetwork,
};
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

fn generated_ufvk<P: zcash_protocol::consensus::Parameters>(params: &P) -> UnifiedFullViewingKey {
    let mut seed = [0_u8; 32];
    getrandom::fill(&mut seed).expect("OS entropy for an ephemeral test fixture");
    let spending_key = UnifiedSpendingKey::from_seed(params, &seed, AccountId::ZERO)
        .expect("derive ephemeral test fixture");
    seed.fill(0);
    spending_key.to_unified_full_viewing_key()
}

fn private_config(encoded_ufvk: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is after epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("scanner-policy-{nonce}"));
    fs::create_dir(&root).expect("create private fixture root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .expect("make fixture root private");
    let config = root.join("scanner.json");
    fs::write(
        &config,
        serde_json::json!({ "ufvk": encoded_ufvk, "birthday": 1 }).to_string(),
    )
    .expect("write private fixture config");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600))
        .expect("make fixture config private");
    config
}

#[test]
fn production_decoder_has_no_modelled_network_authority() {
    assert!(
        !include_str!("../src/config.rs").contains("network_matches_regtest"),
        "network acceptance must remain in UnifiedFullViewingKey::decode"
    );
}

#[test]
fn encoded_wrong_network_ufvk_is_rejected_before_wallet_import() {
    let regtest = regtest_parameters();
    let encoded_test_network_ufvk = generated_ufvk(&TEST_NETWORK).encode(&TEST_NETWORK);

    assert!(matches!(
        decode_regtest_orchard_ufvk(&regtest, &encoded_test_network_ufvk),
        Err("viewing key cannot be decoded for this network")
    ));
}

#[test]
fn encoded_regtest_ufvk_without_orchard_is_rejected_before_wallet_import() {
    let regtest = regtest_parameters();
    let full = generated_ufvk(&regtest);
    let without_orchard = UnifiedFullViewingKey::new(full.sapling().cloned(), None)
        .expect("construct valid test-only Sapling UFVK")
        .encode(&regtest);

    assert!(matches!(
        decode_regtest_orchard_ufvk(&regtest, &without_orchard),
        Err("viewing key has no Orchard capability")
    ));
}

#[tokio::test]
async fn scanner_entrypoint_decodes_and_rejects_encoded_invalid_ufvks_before_transport() {
    let regtest = regtest_parameters();
    let encoded_test_network_ufvk = generated_ufvk(&TEST_NETWORK).encode(&TEST_NETWORK);
    let full = generated_ufvk(&regtest);
    let encoded_without_orchard = UnifiedFullViewingKey::new(full.sapling().cloned(), None)
        .expect("construct valid test-only Sapling UFVK")
        .encode(&regtest);

    for (encoded, expected) in [
        (
            encoded_test_network_ufvk,
            "viewing key cannot be decoded for this network",
        ),
        (
            encoded_without_orchard,
            "viewing key has no Orchard capability",
        ),
    ] {
        let config = private_config(&encoded);
        let state_root = state_root_for(&config).expect("derive state root");
        let result = run(
            &config,
            "http://127.0.0.1:1",
            regtest.clone(),
            Stage::Prepare,
        )
        .await;

        assert_eq!(result, Err(expected));
        assert!(
            !state_root.exists(),
            "invalid UFVKs must fail before scanner state or any transport is opened"
        );
        fs::remove_dir_all(config.parent().expect("fixture parent"))
            .expect("remove private fixture root");
    }
}
