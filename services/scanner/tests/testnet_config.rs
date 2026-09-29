#![cfg(unix)]

use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    time::{SystemTime, UNIX_EPOCH},
};

use sovereign_storefront_scanner::{
    allocate::ChainIdentity,
    config::{ActivationHeights, ScannerParams, decode_orchard_ufvk, open_runtime_paths},
    consensus::consensus_fingerprint,
    wallet::allocate_orchard_only_address,
};
use zcash_keys::{
    address::Address,
    keys::{UnifiedFullViewingKey, UnifiedSpendingKey},
};
use zcash_protocol::{
    consensus::{Network, TEST_NETWORK},
    local_consensus::LocalNetwork,
};
use zip32::AccountId;

/// Public testnet activation heights from `zcash_protocol` 0.10.6 `TestNetwork`.
fn testnet_activations() -> BTreeMap<String, Option<u32>> {
    [
        ("overwinter", 207_500),
        ("sapling", 280_000),
        ("blossom", 584_000),
        ("heartwood", 903_800),
        ("canopy", 1_028_500),
        ("nu5", 1_842_420),
        ("nu6", 2_976_000),
        ("nu6-1", 3_536_500),
        ("nu6-2", 4_052_000),
        ("nu6-3", 4_134_000),
    ]
    .into_iter()
    .map(|(name, height)| (name.to_owned(), Some(height)))
    .collect()
}

fn regtest_parameters() -> LocalNetwork {
    let one = Some(zcash_protocol::consensus::BlockHeight::from_u32(1));
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

fn encoded_ufvk(params: &impl zcash_protocol::consensus::Parameters) -> String {
    let mut seed = [0_u8; 32];
    getrandom::fill(&mut seed).expect("OS entropy for disposable fixture");
    let encoded = UnifiedSpendingKey::from_seed(params, &seed, AccountId::ZERO)
        .expect("derive disposable viewing key")
        .to_unified_full_viewing_key()
        .encode(params);
    seed.fill(0);
    encoded
}

fn write_private_config(body: &serde_json::Value) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("scanner-testnet-config-{nonce}"));
    fs::create_dir(&root).expect("create disposable private config root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .expect("protect disposable private config root");
    let config = root.join("scanner.json");
    fs::write(&config, serde_json::to_vec(body).expect("encode fixture")).expect("write fixture");
    fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).expect("protect fixture");
    config
}

fn testnet_runtime(ufvk: &str, lightwalletd: &str) -> serde_json::Value {
    let activations = testnet_activations();
    let observed = ActivationHeights::from_config(&activations).expect("testnet schedule");
    let chain = ChainIdentity {
        network: "test".to_owned(),
        genesis_hash: "ab".repeat(32),
        consensus_fingerprint: consensus_fingerprint("test", &observed)
            .expect("testnet fingerprint"),
    };
    serde_json::json!({
        "ufvk": ufvk,
        "birthday": 1,
        "birthdayTree": {
            "network": "test",
            "height": 0,
            "hash": "00".repeat(32),
            "time": 0,
            "saplingTree": "",
            "orchardTree": "",
            "ironwoodTree": ""
        },
        "runtime": {
            "sourceId": "public-testnet",
            "chain": chain,
            "lightwalletd": lightwalletd,
            "activations": activations
        }
    })
}

#[test]
fn open_runtime_paths_accepts_testnet_https_and_rejects_plaintext_non_loopback() {
    let ufvk = encoded_ufvk(&Network::TestNetwork);
    let accepted = write_private_config(&testnet_runtime(&ufvk, "https://testnet.zec.rocks:443"));
    let opened = open_runtime_paths(&accepted).expect("testnet https runtime opens");
    assert!(matches!(
        opened.params,
        ScannerParams::Test(Network::TestNetwork)
    ));
    assert_eq!(opened.chain.network, "test");

    let rejected = write_private_config(&testnet_runtime(&ufvk, "http://testnet.zec.rocks:443"));
    match open_runtime_paths(&rejected) {
        Err(error) => assert_eq!(error, "plaintext lightwalletd endpoint is not loopback"),
        Ok(_) => panic!("plaintext non-loopback stays rejected"),
    }

    let mut mainnet = testnet_runtime(&ufvk, "https://testnet.zec.rocks:443");
    mainnet["runtime"]["chain"]["network"] = serde_json::json!("main");
    let mainnet_path = write_private_config(&mainnet);
    match open_runtime_paths(&mainnet_path) {
        Err(error) => assert_eq!(error, "scanner network is not permitted"),
        Ok(_) => panic!("mainnet stays rejected"),
    }
}

#[test]
fn orchard_ufvk_hrp_follows_the_params_network() {
    let test_key = encoded_ufvk(&Network::TestNetwork);
    let regtest_key = encoded_ufvk(&regtest_parameters());
    assert!(test_key.starts_with("uviewtest"));
    assert!(regtest_key.starts_with("uviewregtest"));

    let decoded = decode_orchard_ufvk(&Network::TestNetwork, "test", &test_key)
        .expect("uviewtest decodes under test params");
    assert!(decoded.orchard().is_some());
    assert!(matches!(
        decode_orchard_ufvk(&Network::TestNetwork, "test", &regtest_key),
        Err("viewing key cannot be decoded for this network")
    ));
    assert!(matches!(
        decode_orchard_ufvk(&regtest_parameters(), "regtest", &test_key),
        Err("viewing key cannot be decoded for this network")
    ));
    decode_orchard_ufvk(&regtest_parameters(), "regtest", &regtest_key)
        .expect("uviewregtest still decodes under regtest params");
    assert!(matches!(
        decode_orchard_ufvk(&TEST_NETWORK, "main", &test_key),
        Err("scanner network is not permitted")
    ));
}

#[test]
fn testnet_consensus_fingerprint_is_stable_and_distinct_from_regtest() {
    let heights = ActivationHeights::from_config(&testnet_activations()).expect("schedule");
    let first = consensus_fingerprint("test", &heights).expect("fingerprint");
    let second = consensus_fingerprint("test", &heights).expect("fingerprint");
    let regtest = consensus_fingerprint("regtest", &heights).expect("regtest fingerprint");
    assert_eq!(first, second);
    assert_ne!(first, regtest);
    assert_eq!(first.len(), 64);
    assert!(consensus_fingerprint("main", &heights).is_err());
}

#[test]
fn allocate_produces_an_orchard_only_utest1_address() {
    let params = Network::TestNetwork;
    let encoded = encoded_ufvk(&params);
    let ufvk = UnifiedFullViewingKey::decode(&params, &encoded).expect("decode fixture key");
    let wallet = std::env::temp_dir().join(format!(
        "scanner-testnet-allocate-{}.sqlite",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let address = allocate_orchard_only_address(&params, &ufvk, &wallet)
        .expect("allocate orchard-only receiver");
    assert!(
        address.starts_with("utest1"),
        "testnet allocation must use the utest1 HRP"
    );
    let Address::Unified(unified) = Address::decode(&params, &address).expect("decode allocation")
    else {
        panic!("allocation is not a unified address");
    };
    assert!(unified.orchard().is_some());
    assert!(unified.transparent().is_none());
    assert!(unified.sapling().is_none());
    let _ = fs::remove_file(&wallet);
}
