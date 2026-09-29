//! Runtime-observed regtest and public-testnet activation handling.
//!
//! Regtest keeps the operator-supplied `LocalNetwork` schedule. Public testnet
//! uses `zcash_protocol::consensus::Network::TestNetwork` so a `uviewtest` UFVK
//! can import. `LocalNetwork::network_type` is always regtest, so copied heights
//! cannot stand in for testnet.

use std::{collections::BTreeMap, path::PathBuf};

use crate::{allocate::ChainIdentity, lease::WriterLease, private_fs::private_parent};

use zcash_client_backend::{data_api::AccountBirthday, proto::service::TreeState};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::{
    consensus::{BlockHeight, Network, NetworkType, NetworkUpgrade, Parameters},
    local_consensus::LocalNetwork,
};

const NAMES: [&str; 10] = [
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

const REQUIRED: [&str; 7] = [
    "overwinter",
    "sapling",
    "blossom",
    "heartwood",
    "canopy",
    "nu5",
    "nu6",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivationHeights(BTreeMap<&'static str, Option<u32>>);

impl ActivationHeights {
    /// The fixed protocol order used by the v1 consensus fingerprint.
    pub const CANONICAL_ORDER: [&'static str; 10] = NAMES;

    /// Accepts each activation reported by the live regtest node exactly once.
    pub fn from_runtime_values<const N: usize>(
        values: [(&str, Option<u32>); N],
    ) -> Result<Self, &'static str> {
        let mut parsed = BTreeMap::new();
        for (name, height) in values {
            let Some(canonical) = NAMES.iter().copied().find(|known| *known == name) else {
                return Err("unknown activation");
            };
            if parsed.insert(canonical, height).is_some() {
                return Err("duplicate activation");
            }
        }
        if REQUIRED.iter().any(|name| !parsed.contains_key(name)) {
            return Err("missing required activation");
        }
        for name in NAMES {
            parsed.entry(name).or_insert(None);
        }
        Self::validated(parsed)
    }

    /// Accepts a runtime configuration map. Required upgrades must be present
    /// with a height; an absent optional upgrade is the same as `null`.
    pub fn from_config(values: &BTreeMap<String, Option<u32>>) -> Result<Self, &'static str> {
        let mut parsed = BTreeMap::new();
        for (name, height) in values {
            let Some(canonical) = NAMES.iter().copied().find(|known| *known == name) else {
                return Err("unknown activation");
            };
            parsed.insert(canonical, *height);
        }
        if REQUIRED.iter().any(|name| !parsed.contains_key(name)) {
            return Err("missing required activation");
        }
        for name in NAMES {
            parsed.entry(name).or_insert(None);
        }
        Self::validated(parsed)
    }

    /// Required upgrades must be activated, and the schedule must follow
    /// protocol order: heights never decrease and no upgrade activates after
    /// an unactivated predecessor.
    fn validated(parsed: BTreeMap<&'static str, Option<u32>>) -> Result<Self, &'static str> {
        if REQUIRED.iter().any(|name| parsed[name].is_none()) {
            return Err("required activation is unactivated");
        }
        let mut previous = Some(0);
        for name in NAMES {
            match (previous, parsed[name]) {
                (None, Some(_)) => return Err("activation follows an unactivated upgrade"),
                (Some(before), Some(height)) if height < before => {
                    return Err("activation heights decrease");
                }
                _ => {}
            }
            previous = parsed[name];
        }
        Ok(Self(parsed))
    }

    /// Builds the pinned library's regtest parameters from this exact schedule.
    pub fn local_network(&self) -> LocalNetwork {
        let height = |name| {
            self.value(name)
                .flatten()
                .map(zcash_protocol::consensus::BlockHeight::from_u32)
        };
        LocalNetwork {
            overwinter: height("overwinter"),
            sapling: height("sapling"),
            blossom: height("blossom"),
            heartwood: height("heartwood"),
            canopy: height("canopy"),
            nu5: height("nu5"),
            nu6: height("nu6"),
            nu6_1: height("nu6-1"),
            nu6_2: height("nu6-2"),
            nu6_3: height("nu6-3"),
        }
    }

    /// Returns the observed activation, including `Some(None)` for an
    /// explicitly unactivated future network upgrade.
    pub fn value(&self, name: &str) -> Option<Option<u32>> {
        self.0.get(name).copied()
    }
}

const TESTNET_UPGRADES: [(&str, NetworkUpgrade); 10] = [
    ("overwinter", NetworkUpgrade::Overwinter),
    ("sapling", NetworkUpgrade::Sapling),
    ("blossom", NetworkUpgrade::Blossom),
    ("heartwood", NetworkUpgrade::Heartwood),
    ("canopy", NetworkUpgrade::Canopy),
    ("nu5", NetworkUpgrade::Nu5),
    ("nu6", NetworkUpgrade::Nu6),
    ("nu6-1", NetworkUpgrade::Nu6_1),
    ("nu6-2", NetworkUpgrade::Nu6_2),
    ("nu6-3", NetworkUpgrade::Nu6_3),
];

/// Consensus parameters for a scanner runtime.
///
/// Regtest carries the observed local schedule. Testnet is the built-in
/// `Network::TestNetwork` and never a `LocalNetwork` with copied heights.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScannerParams {
    Regtest(LocalNetwork),
    Test(Network),
}

impl Parameters for ScannerParams {
    fn network_type(&self) -> NetworkType {
        match self {
            Self::Regtest(params) => params.network_type(),
            Self::Test(params) => params.network_type(),
        }
    }

    fn activation_height(&self, upgrade: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            Self::Regtest(params) => params.activation_height(upgrade),
            Self::Test(params) => params.activation_height(upgrade),
        }
    }
}

impl ScannerParams {
    /// Public testnet parameters. Mainnet is not constructible here.
    pub fn test_network() -> Self {
        Self::Test(Network::TestNetwork)
    }

    pub fn network_name(&self) -> &'static str {
        match self.network_type() {
            NetworkType::Regtest => "regtest",
            NetworkType::Test => "test",
            NetworkType::Main => "main",
        }
    }
}

fn permitted_network(network: &str) -> Result<NetworkType, &'static str> {
    match network {
        "regtest" => Ok(NetworkType::Regtest),
        "test" => Ok(NetworkType::Test),
        _ => Err("scanner network is not permitted"),
    }
}

/// Public testnet heights are fixed by `Network::TestNetwork`. A config that
/// disagrees cannot be scanned with those parameters.
fn testnet_schedule_matches(observed: &ActivationHeights) -> bool {
    TESTNET_UPGRADES.into_iter().all(|(name, upgrade)| {
        let expected = Network::TestNetwork
            .activation_height(upgrade)
            .map(u32::from);
        observed.value(name) == Some(expected)
    })
}

/// Decodes a ZIP-316 UFVK against the named network's parameters and requires
/// its real Orchard component before any wallet import is attempted.
pub fn decode_orchard_ufvk(
    params: &impl Parameters,
    network: &str,
    encoded: &str,
) -> Result<UnifiedFullViewingKey, &'static str> {
    if params.network_type() != permitted_network(network)? {
        return Err("viewing key cannot be decoded for this network");
    }
    let key = UnifiedFullViewingKey::decode(params, encoded)
        .map_err(|_| "viewing key cannot be decoded for this network")?;
    key.orchard()
        .ok_or("viewing key has no Orchard capability")?;
    Ok(key)
}

/// Regtest specialization kept for existing callers outside this change.
pub fn decode_regtest_orchard_ufvk(
    params: &LocalNetwork,
    encoded: &str,
) -> Result<UnifiedFullViewingKey, &'static str> {
    decode_orchard_ufvk(params, "regtest", encoded)
}

/// Accepts TLS transport for any non-empty authority, and plaintext only when
/// it cannot leave the local host. Runtime configuration contains no transport
/// credentials, and authority decorations that could obscure the actual peer
/// are rejected rather than delegated to URI parsing quirks.
pub fn validate_lightwalletd_endpoint(endpoint: &str) -> Result<(), &'static str> {
    let (scheme, remainder) = endpoint
        .split_once("://")
        .ok_or("lightwalletd endpoint scheme is invalid")?;
    let authority = remainder
        .split('/')
        .next()
        .filter(|authority| !authority.is_empty())
        .ok_or("lightwalletd endpoint authority is invalid")?;
    if authority.contains(['@', '?', '#']) {
        return Err("lightwalletd endpoint authority is invalid");
    }
    match scheme {
        "https" => Ok(()),
        "http" if loopback_authority(authority) => Ok(()),
        "http" => Err("plaintext lightwalletd endpoint is not loopback"),
        _ => Err("lightwalletd endpoint scheme is invalid"),
    }
}

fn loopback_authority(authority: &str) -> bool {
    let host = authority
        .strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(host, _)| host))
        .unwrap_or_else(|| authority.split(':').next().unwrap_or_default());
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateScannerConfig {
    pub ufvk: String,
    pub birthday: u32,
    #[serde(default)]
    pub birthday_tree: Option<TrustedBirthdayTreeState>,
    #[serde(default)]
    pub runtime: Option<RuntimeServiceConfig>,
}

/// A complete, already-trusted lightwalletd tree state for the block before
/// `birthday`. It is an explicitly operator-attested trust root at first import;
/// C1 must later verify this exact state against lightwalletd before scanning.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedBirthdayTreeState {
    pub network: String,
    pub height: u64,
    pub hash: String,
    pub time: u32,
    pub sapling_tree: String,
    pub orchard_tree: String,
    pub ironwood_tree: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeServiceConfig {
    pub source_id: String,
    pub chain: ChainIdentity,
    pub lightwalletd: String,
    pub activations: BTreeMap<String, Option<u32>>,
}

/// Immutable scanner-owned record of the operator's initial trust decision.
/// It deliberately stores the exact lightwalletd encodings rather than a wallet
/// birthday height, because the pinned wallet API exposes only that height on
/// repeat import. C1 can read `tree_state` and compare it to lightwalletd before
/// it accepts this anchor for synchronization.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirthdayAttestation {
    pub version: u8,
    pub chain: ChainIdentity,
    pub tree_state: TrustedBirthdayTreeState,
}

impl BirthdayAttestation {
    pub fn tree_state(&self) -> TreeState {
        TreeState {
            network: self.tree_state.network.clone(),
            height: self.tree_state.height,
            hash: self.tree_state.hash.clone(),
            time: self.tree_state.time,
            sapling_tree: self.tree_state.sapling_tree.clone(),
            orchard_tree: self.tree_state.orchard_tree.clone(),
            ironwood_tree: self.tree_state.ironwood_tree.clone(),
        }
    }
}

const BIRTHDAY_ATTESTATION_FILE: &str = "birthday-attestation.json";

/// Descriptor-rooted, scanner-private paths for daemon state. The socket is
/// placed beneath the same owner-private state directory, never network-bound.
pub struct RuntimePaths {
    pub wallet_path: PathBuf,
    pub application_db_path: PathBuf,
    pub socket_path: PathBuf,
    pub ufvk: String,
    pub params: ScannerParams,
    pub birthday: AccountBirthday,
    pub birthday_attestation: BirthdayAttestation,
    pub source_id: String,
    pub chain: ChainIdentity,
    pub lightwalletd: String,
    pub(crate) state: crate::private_fs::PrivateDir,
}

/// The decoded private config plus its held owner-private parent boundary.
pub(crate) struct OpenPrivateScannerConfig {
    pub config: PrivateScannerConfig,
    pub parent: crate::private_fs::PrivateDir,
    pub name: String,
}

/// The lease is a direct, descriptor-relative sibling of the configuration,
/// which makes all scanner lifecycles for that state root contend on one inode.
pub(crate) fn writer_lease_name(config_name: &str) -> String {
    format!(".{config_name}.writer.lock")
}

/// Acquires the lifecycle lease before any caller creates or opens wallet or
/// scanner application state beneath this private configuration boundary.
pub(crate) fn acquire_config_writer_lease(
    path: &std::path::Path,
) -> Result<WriterLease, &'static str> {
    let opened = open_private_config(path)?;
    WriterLease::acquire(
        opened
            .parent
            .ensure_file(&writer_lease_name(&opened.name))
            .map_err(|_| "scanner writer lease is unavailable safely")?,
    )
}

pub(crate) fn open_private_config(
    path: &std::path::Path,
) -> Result<OpenPrivateScannerConfig, &'static str> {
    let (parent, name) = private_parent(path).map_err(|_| "scanner config boundary is unsafe")?;
    let name = name
        .into_string()
        .map_err(|_| "scanner config name is invalid")?;
    let bytes = parent
        .read_file(&name)
        .map_err(|_| "scanner config cannot be read safely")?;
    let config = serde_json::from_slice(&bytes).map_err(|_| "scanner config is invalid")?;
    Ok(OpenPrivateScannerConfig {
        config,
        parent,
        name,
    })
}

/// Records the initial operator-attested tree state before wallet import, or
/// verifies that a later lifecycle uses the exact same state and chain identity.
/// Callers hold `WriterLease` before entering this function.
pub(crate) fn persist_or_verify_birthday_attestation(
    state: &crate::private_fs::PrivateDir,
    expected: &BirthdayAttestation,
) -> Result<(), &'static str> {
    match state.read_file(BIRTHDAY_ATTESTATION_FILE) {
        Ok(bytes) => {
            let stored: BirthdayAttestation = serde_json::from_slice(&bytes)
                .map_err(|_| "scanner birthday attestation is invalid")?;
            if stored != *expected {
                return Err("scanner birthday attestation does not match configured trust root");
            }
            Ok(())
        }
        Err(_) if state.is_empty()? => {
            let encoded = serde_json::to_vec(expected)
                .map_err(|_| "scanner birthday attestation cannot encode")?;
            state
                .write_file_atomic(BIRTHDAY_ATTESTATION_FILE, &encoded)
                .map_err(|_| "scanner birthday attestation cannot persist")
        }
        Err(_) => Err("scanner birthday attestation is missing for existing state"),
    }
}

/// Restore-only variant: a coordinated backup may omit the scanner-owned
/// attestation, so an explicitly acknowledged restore re-derives it from the
/// restored configuration. An attestation that is present must still match.
pub(crate) fn persist_or_verify_restored_birthday_attestation(
    state: &crate::private_fs::PrivateDir,
    expected: &BirthdayAttestation,
) -> Result<(), &'static str> {
    match state.read_file(BIRTHDAY_ATTESTATION_FILE) {
        Ok(_) => persist_or_verify_birthday_attestation(state, expected),
        Err(_) => {
            let encoded = serde_json::to_vec(expected)
                .map_err(|_| "scanner birthday attestation cannot encode")?;
            state
                .write_file_atomic(BIRTHDAY_ATTESTATION_FILE, &encoded)
                .map_err(|_| "scanner birthday attestation cannot persist")
        }
    }
}

/// Opens only a fully specified, owner-private daemon configuration. Missing or
/// unknown activation data makes runtime startup unavailable rather than falling
/// back to guessed network parameters.
pub fn open_runtime_paths(path: &std::path::Path) -> Result<RuntimePaths, &'static str> {
    let opened = open_private_config(path)?;
    let runtime = opened
        .config
        .runtime
        .as_ref()
        .ok_or("scanner runtime configuration is missing")?;
    let observed = ActivationHeights::from_config(&runtime.activations)?;
    runtime.chain.validate()?;
    if !matches!(runtime.chain.network.as_str(), "regtest" | "test") || runtime.source_id.is_empty()
    {
        return Err("scanner runtime configuration is unsupported");
    }
    // The fingerprint is derived, never trusted: a value that does not bind
    // exactly these activation parameters fails before any state is created.
    if crate::consensus::consensus_fingerprint(&runtime.chain.network, &observed)?
        != runtime.chain.consensus_fingerprint
    {
        return Err("scanner consensus fingerprint does not match activation parameters");
    }
    validate_lightwalletd_endpoint(&runtime.lightwalletd)?;
    let params = match runtime.chain.network.as_str() {
        "regtest" => ScannerParams::Regtest(observed.local_network()),
        "test" if testnet_schedule_matches(&observed) => ScannerParams::test_network(),
        "test" => return Err("scanner testnet activation heights do not match TestNetwork"),
        _ => return Err("scanner runtime configuration is unsupported"),
    };
    let (birthday, birthday_attestation) = validated_birthday(&opened.config, &runtime.chain)?;
    let source_id = runtime.source_id.clone();
    let chain = runtime.chain.clone();
    let lightwalletd = runtime.lightwalletd.clone();
    let ufvk = opened.config.ufvk.clone();
    // Reject an encoded key for another network, or a UFVK without Orchard,
    // before creating the scanner runtime directory or either database file.
    decode_orchard_ufvk(&params, &runtime.chain.network, &ufvk)?;
    let state = opened
        .parent
        .open_or_create_child(&format!(".{}.live-state", opened.name))
        .map_err(|_| "scanner runtime state is unavailable safely")?;
    let wallet_path = state
        .proc_path("wallet.sqlite")
        .map_err(|_| "scanner wallet path is invalid")?;
    let application_db_path = state
        .proc_path("scanner.sqlite")
        .map_err(|_| "scanner application path is invalid")?;
    let socket_path = state
        .proc_path("scanner.sock")
        .map_err(|_| "scanner socket path is invalid")?;
    Ok(RuntimePaths {
        wallet_path,
        application_db_path,
        socket_path,
        ufvk,
        params,
        birthday,
        birthday_attestation,
        source_id,
        chain,
        lightwalletd,
        state,
    })
}

fn validated_birthday(
    config: &PrivateScannerConfig,
    chain: &ChainIdentity,
) -> Result<(AccountBirthday, BirthdayAttestation), &'static str> {
    let tree = config
        .birthday_tree
        .as_ref()
        .ok_or("scanner birthday tree state is missing")?;
    if tree.network != chain.network
        || permitted_network(&tree.network).is_err()
        || tree.height.checked_add(1) != Some(u64::from(config.birthday))
        || !is_lower_hex(&tree.hash, 32)
    {
        return Err("scanner birthday tree state is invalid");
    }
    let attestation = BirthdayAttestation {
        version: 1,
        chain: chain.clone(),
        tree_state: tree.clone(),
    };
    let birthday = AccountBirthday::from_treestate(attestation.tree_state(), None)
        .map_err(|_| "scanner birthday tree state is invalid")?;
    Ok((birthday, attestation))
}

fn is_lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn read_private_config(path: &std::path::Path) -> Result<PrivateScannerConfig, &'static str> {
    Ok(open_private_config(path)?.config)
}

/// A testnet config that still needs `GetTreeState(birthday-1)` over TLS.
/// Operator-attested configs, including regtest, are not pending.
pub(crate) struct PendingTestnetBirthday {
    pub endpoint: String,
    pub birthday: u32,
}

pub(crate) fn pending_testnet_birthday(
    path: &std::path::Path,
) -> Result<Option<PendingTestnetBirthday>, &'static str> {
    let opened = match open_private_config(path) {
        Ok(opened) => opened,
        Err(_) => return Ok(None),
    };
    let Some(runtime) = opened.config.runtime.as_ref() else {
        return Ok(None);
    };
    if runtime.chain.network != "test" || opened.config.birthday_tree.is_some() {
        return Ok(None);
    }
    validate_lightwalletd_endpoint(&runtime.lightwalletd)?;
    if !runtime.lightwalletd.starts_with("https://") {
        return Err("scanner birthday tree state must be fetched over TLS");
    }
    if opened.config.birthday == 0 {
        return Err("scanner birthday cannot be genesis");
    }
    Ok(Some(PendingTestnetBirthday {
        endpoint: runtime.lightwalletd.clone(),
        birthday: opened.config.birthday,
    }))
}

/// Accepts a lightwalletd `TreeState` only when it is the block before `birthday`
/// on the named network. The block hash is stored lowercase.
pub fn trusted_birthday_from_tree_state(
    tree: &TreeState,
    network: &str,
    birthday: u32,
) -> Result<TrustedBirthdayTreeState, &'static str> {
    permitted_network(network)?;
    let hash = tree.hash.to_ascii_lowercase();
    if tree.network != network
        || tree.height.checked_add(1) != Some(u64::from(birthday))
        || !is_lower_hex(&hash, 32)
    {
        return Err("scanner birthday tree state is invalid");
    }
    Ok(TrustedBirthdayTreeState {
        network: network.to_owned(),
        height: tree.height,
        hash,
        time: tree.time,
        sapling_tree: tree.sapling_tree.clone(),
        orchard_tree: tree.orchard_tree.clone(),
        ironwood_tree: tree.ironwood_tree.clone(),
    })
}

/// Writes the fetched tree into the private config so later opens use the
/// operator-attested path. An existing tree is not overwritten.
pub(crate) fn write_fetched_birthday_tree(
    path: &std::path::Path,
    tree: &TrustedBirthdayTreeState,
) -> Result<(), &'static str> {
    let (parent, name) = private_parent(path).map_err(|_| "scanner config boundary is unsafe")?;
    let name = name
        .into_string()
        .map_err(|_| "scanner config name is invalid")?;
    let bytes = parent
        .read_file(&name)
        .map_err(|_| "scanner config cannot be read safely")?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "scanner config is invalid")?;
    let object = value.as_object_mut().ok_or("scanner config is invalid")?;
    if object
        .get("birthdayTree")
        .is_some_and(|existing| !existing.is_null())
    {
        return Err("scanner birthday tree state is already attested");
    }
    object.insert(
        "birthdayTree".to_owned(),
        serde_json::to_value(tree).map_err(|_| "scanner birthday tree state is invalid")?,
    );
    let mut encoded =
        serde_json::to_vec(&value).map_err(|_| "scanner birthday tree state is invalid")?;
    encoded.push(b'\n');
    parent
        .write_file_atomic(&name, &encoded)
        .map_err(|_| "scanner birthday tree state cannot persist")
}

/// `init-view --network test --lightwalletd URL --birthday H --config FILE`.
/// Flags may appear in any order. Mainnet is rejected.
pub fn parse_testnet_init_view_args(
    args: &[String],
) -> Result<(std::path::PathBuf, String, u32), &'static str> {
    let mut network = None;
    let mut lightwalletd = None;
    let mut birthday = None;
    let mut config = None;
    let mut values = args.iter();
    while let Some(flag) = values.next() {
        match flag.as_str() {
            "--network" if network.is_none() => network = Some(values.next().map(String::as_str)),
            "--lightwalletd" if lightwalletd.is_none() => {
                lightwalletd = Some(values.next().map(String::as_str));
            }
            "--birthday" if birthday.is_none() => {
                birthday = Some(values.next().map(String::as_str))
            }
            "--config" if config.is_none() => config = Some(values.next().map(String::as_str)),
            _ => return Err("scanner runtime initialization failed"),
        }
    }
    if network != Some(Some("test")) {
        return Err("scanner network is not permitted");
    }
    let lightwalletd = lightwalletd
        .flatten()
        .filter(|endpoint| !endpoint.is_empty())
        .ok_or("lightwalletd endpoint scheme is invalid")?;
    validate_lightwalletd_endpoint(lightwalletd)?;
    if !lightwalletd.starts_with("https://") {
        return Err("scanner birthday tree state must be fetched over TLS");
    }
    let birthday = birthday
        .flatten()
        .ok_or("scanner birthday tree state is invalid")?
        .parse::<u32>()
        .map_err(|_| "scanner birthday tree state is invalid")?;
    if birthday == 0 {
        return Err("scanner birthday cannot be genesis");
    }
    let config = std::path::PathBuf::from(
        config
            .flatten()
            .filter(|path| !path.is_empty())
            .ok_or("scanner config boundary is unsafe")?,
    );
    if !config.is_file() {
        return Err("scanner config boundary is unsafe");
    }
    Ok((config, lightwalletd.to_owned(), birthday))
}

/// Applies the testnet init-view overrides and clears an attested tree so the
/// following open fetches `GetTreeState(birthday-1)` for the requested height.
pub fn apply_testnet_init_view(
    path: &std::path::Path,
    lightwalletd: &str,
    birthday: u32,
) -> Result<(), &'static str> {
    validate_lightwalletd_endpoint(lightwalletd)?;
    if !lightwalletd.starts_with("https://") || birthday == 0 {
        return Err("scanner birthday tree state must be fetched over TLS");
    }
    let (parent, name) = private_parent(path).map_err(|_| "scanner config boundary is unsafe")?;
    let name = name
        .into_string()
        .map_err(|_| "scanner config name is invalid")?;
    let bytes = parent
        .read_file(&name)
        .map_err(|_| "scanner config cannot be read safely")?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "scanner config is invalid")?;
    let object = value.as_object_mut().ok_or("scanner config is invalid")?;
    let runtime = object
        .get_mut("runtime")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("scanner runtime configuration is missing")?;
    let chain = runtime
        .get_mut("chain")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("scanner runtime configuration is missing")?;
    if chain.get("network").and_then(serde_json::Value::as_str) != Some("test") {
        return Err("scanner network is not permitted");
    }
    runtime.insert(
        "lightwalletd".to_owned(),
        serde_json::Value::String(lightwalletd.to_owned()),
    );
    object.insert("birthday".to_owned(), serde_json::Value::from(birthday));
    object.remove("birthdayTree");
    let mut encoded = serde_json::to_vec(&value).map_err(|_| "scanner config is invalid")?;
    encoded.push(b'\n');
    parent
        .write_file_atomic(&name, &encoded)
        .map_err(|_| "scanner birthday tree state cannot persist")
}
