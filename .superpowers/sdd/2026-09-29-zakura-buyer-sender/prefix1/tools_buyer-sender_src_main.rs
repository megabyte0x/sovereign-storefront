//! Public-testnet buyer wallet sender (`ssf-buyer-sender`).
//!
//! Prints exactly one JSON object on stdout and exits with the frozen code
//! contract: 0 ok, 2 refused (nothing broadcast), 3 broadcast outcome
//! unknown, 4 attempt already exists.

mod chain;
mod pay;
mod state;

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::ExitCode,
};

use secrecy::{ExposeSecret, SecretVec};
use serde_json::{Value, json};
use sovereign_storefront_scanner::config::ScannerParams;
use zcash_client_backend::data_api::{
    Account as _, WalletRead, WalletWrite, wallet::ConfirmationsPolicy,
};
use zcash_client_sqlite::AccountUuid;
use zcash_keys::keys::UnifiedSpendingKey;

use crate::state::{Db, StateDir};

const DEFAULT_LIGHTWALLETD: &str = "https://testnet.zec.rocks:443";
const DEFAULT_EXPIRY_DELTA: u32 = 20;
const MIN_EXPIRY_DELTA: u32 = 10;
const MAX_EXPIRY_DELTA: u32 = 40;

/// Success carries the JSON to print and its exit code (0, or 3/4 for a
/// recorded pay attempt); failure carries an exit code and a fixed error.
type CommandResult = Result<(Value, u8), (u8, &'static str)>;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Globals {
    state_dir: Option<PathBuf>,
    lightwalletd: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Import {
        mnemonic_file: PathBuf,
        birthday: u32,
    },
    Status,
    Pay {
        uri_file: PathBuf,
        attempt_id: String,
        expiry_delta: u32,
    },
    TxStatus {
        attempt_id: String,
    },
    Rebroadcast {
        attempt_id: String,
    },
}

/// Pure `--expiry-delta` parser: default 20, allowed `10..=40`.
pub fn parse_expiry_delta(value: Option<&str>) -> Result<u32, &'static str> {
    let Some(value) = value else {
        return Ok(DEFAULT_EXPIRY_DELTA);
    };
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("expiry delta is invalid");
    }
    let delta: u32 = value.parse().map_err(|_| "expiry delta is invalid")?;
    if (MIN_EXPIRY_DELTA..=MAX_EXPIRY_DELTA).contains(&delta) {
        Ok(delta)
    } else {
        Err("expiry delta is invalid")
    }
}

/// Collects `--flag value` pairs for one subcommand; every flag must be in
/// `allowed`, appear once and carry a value.
fn flag_values<'a>(rest: &'a [String], allowed: &[&str]) -> Option<Vec<(&'a str, &'a str)>> {
    let mut seen: Vec<(&str, &str)> = Vec::new();
    let mut index = 0;
    while index < rest.len() {
        let flag = rest[index].as_str();
        if !allowed.contains(&flag) || seen.iter().any(|(name, _)| *name == flag) {
            return None;
        }
        let value = rest.get(index + 1)?.as_str();
        seen.push((flag, value));
        index += 2;
    }
    Some(seen)
}

fn lookup<'a>(values: &[(&str, &'a str)], flag: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|(name, _)| *name == flag)
        .map(|(_, value)| *value)
}

/// Global flags may appear before the command (frozen contract) or among the
/// command's own flags; each at most once.
const GLOBAL_FLAGS: [&str; 2] = ["--state-dir", "--lightwalletd"];

fn parse_arguments(arguments: &[String]) -> Result<(Globals, Command), &'static str> {
    const INVALID: &str = "invalid arguments";
    let mut index = 0;
    let mut leading: Vec<(&str, &str)> = Vec::new();
    let command = loop {
        let token = arguments.get(index).ok_or(INVALID)?.as_str();
        match token {
            "import" | "status" | "pay" | "tx-status" | "rebroadcast" => break token,
            flag if GLOBAL_FLAGS.contains(&flag) && lookup(&leading, flag).is_none() => {
                leading.push((flag, arguments.get(index + 1).ok_or(INVALID)?.as_str()));
                index += 2;
            }
            _ => return Err(INVALID),
        }
    };
    let rest = &arguments[index + 1..];
    let own: &[&str] = match command {
        "import" => &["--mnemonic-file", "--birthday"],
        "status" => &[],
        "pay" => &["--uri-file", "--attempt-id", "--expiry-delta"],
        _ => &["--attempt-id"],
    };
    let allowed: Vec<&str> = own
        .iter()
        .copied()
        .chain(
            GLOBAL_FLAGS
                .iter()
                .copied()
                .filter(|flag| lookup(&leading, flag).is_none()),
        )
        .collect();
    let values = flag_values(rest, &allowed).ok_or(INVALID)?;
    let global = |flag: &str| lookup(&leading, flag).or_else(|| lookup(&values, flag));
    let parsed = match command {
        "import" => {
            let mnemonic_file = lookup(&values, "--mnemonic-file").ok_or(INVALID)?;
            let birthday = lookup(&values, "--birthday").ok_or(INVALID)?;
            if birthday.is_empty() || !birthday.bytes().all(|b| b.is_ascii_digit()) {
                return Err(INVALID);
            }
            Command::Import {
                mnemonic_file: PathBuf::from(mnemonic_file),
                birthday: birthday.parse().map_err(|_| INVALID)?,
            }
        }
        "status" => Command::Status,
        "pay" => Command::Pay {
            uri_file: PathBuf::from(lookup(&values, "--uri-file").ok_or(INVALID)?),
            attempt_id: lookup(&values, "--attempt-id").ok_or(INVALID)?.to_owned(),
            expiry_delta: parse_expiry_delta(lookup(&values, "--expiry-delta"))
                .map_err(|_| INVALID)?,
        },
        "tx-status" => Command::TxStatus {
            attempt_id: lookup(&values, "--attempt-id").ok_or(INVALID)?.to_owned(),
        },
        "rebroadcast" => Command::Rebroadcast {
            attempt_id: lookup(&values, "--attempt-id").ok_or(INVALID)?.to_owned(),
        },
        _ => return Err(INVALID),
    };
    Ok((
        Globals {
            state_dir: global("--state-dir").map(PathBuf::from),
            lightwalletd: global("--lightwalletd")
                .unwrap_or(DEFAULT_LIGHTWALLETD)
                .to_owned(),
        },
        parsed,
    ))
}

/// Source of lightwalletd clients. Command handlers never call
/// `chain::connect` directly, so tests can inject a factory (for example one
/// that panics) to prove a command refuses before touching the network.
pub trait ChainFactory {
    fn connect(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<chain::Client, &'static str>> + Send + '_>>;
}

/// Production factory: validates and connects to the `--lightwalletd`
/// endpoint.
pub struct LiveChain {
    endpoint: String,
}

impl LiveChain {
    pub fn new(endpoint: String) -> Self {
        Self { endpoint }
    }
}

impl ChainFactory for LiveChain {
    fn connect(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<chain::Client, &'static str>> + Send + '_>> {
        Box::pin(chain::connect(&self.endpoint))
    }
}

const WALLET_ACCOUNT_NAME: &str = "ssf-buyer";

/// Finds the wallet account whose UFVK derives from `seed` at ZIP-32
/// account 0.
pub fn account_for_seed(db: &Db, seed: &SecretVec<u8>) -> Result<AccountUuid, &'static str> {
    let params = ScannerParams::test_network();
    let usk = UnifiedSpendingKey::from_seed(&params, seed.expose_secret(), zip32::AccountId::ZERO)
        .map_err(|_| "spending key cannot be derived")?;
    db.get_account_for_ufvk(&usk.to_unified_full_viewing_key())
        .map_err(|_| "wallet account cannot be read")?
        .map(|account| account.id())
        .ok_or("wallet account does not match the stored seed")
}

pub(crate) fn refuse(error: &'static str) -> (u8, &'static str) {
    (2, error)
}

async fn import(
    state: &StateDir,
    chain: &dyn ChainFactory,
    mnemonic_file: &Path,
    birthday: u32,
) -> CommandResult {
    // Refuse before touching the stored seed when an account already exists.
    {
        // A stored seed from an earlier run lets seed-dependent migrations run.
        let existing = if state.has_seed().map_err(refuse)? {
            Some(state.read_seed().map_err(refuse)?)
        } else {
            None
        };
        let db = state.open_wallet(existing.as_ref()).map_err(refuse)?;
        let accounts = db
            .get_account_ids()
            .map_err(|_| refuse("wallet accounts cannot be read"))?;
        if !accounts.is_empty() {
            return Err(refuse("wallet already imported"));
        }
    }
    state.write_seed(mnemonic_file).map_err(refuse)?;
    let seed = state.read_seed().map_err(refuse)?;
    let mut db = state.open_wallet(Some(&seed)).map_err(refuse)?;
    let cache = state.block_cache().map_err(refuse)?;
    let mut client = chain.connect().await.map_err(refuse)?;
    let account_birthday = chain::birthday_at(&mut client, birthday)
        .await
        .map_err(refuse)?;
    db.import_account_hd(
        WALLET_ACCOUNT_NAME,
        &seed,
        zip32::AccountId::ZERO,
        &account_birthday,
        None,
    )
    .map_err(|_| refuse("wallet account cannot be imported"))?;
    chain::sync(&mut client, &mut db, &cache, chain::IMPORT_SYNC_DEADLINE)
        .await
        .map_err(refuse)?;
    let tip = chain::tip(&mut client).await.map_err(refuse)?;
    Ok((
        json!({ "ok": true, "birthday": birthday, "tip": u32::from(tip) }),
        0,
    ))
}

async fn status(state: &StateDir, chain: &dyn ChainFactory) -> CommandResult {
    if !state.has_seed().map_err(refuse)? {
        return Err(refuse("wallet is not imported"));
    }
    let seed = state.read_seed().map_err(refuse)?;
    let mut db = state.open_wallet(Some(&seed)).map_err(refuse)?;
    let account = account_for_seed(&db, &seed).map_err(refuse)?;
    drop(seed);
    let cache = state.block_cache().map_err(refuse)?;
    let mut client = chain.connect().await.map_err(refuse)?;
    chain::sync(&mut client, &mut db, &cache, chain::SYNC_BUDGET)
        .await
        .map_err(refuse)?;
    let tip = chain::tip(&mut client).await.map_err(refuse)?;
    let summary = db
        .get_wallet_summary(ConfirmationsPolicy::default())
        .map_err(|_| refuse("wallet summary cannot be read"))?
        .ok_or(refuse("wallet is not synchronized"))?;
    let balance = summary
        .account_balances()
        .get(&account)
        .ok_or(refuse("wallet is not synchronized"))?;
    Ok((
        json!({
            "network": "test",
            "tip": u32::from(tip),
            "spendableZat": balance.spendable_value().into_u64().to_string(),
            "orchardZat": balance.orchard_balance().spendable_value().into_u64().to_string(),
            "ironwoodZat": balance.ironwood_balance().spendable_value().into_u64().to_string(),
        }),
        0,
    ))
}

async fn pay(
    state: &StateDir,
    _globals: &Globals,
    chain: &dyn ChainFactory,
    uri_file: &Path,
    attempt_id: &str,
    expiry_delta: u32,
) -> CommandResult {
    pay::pay(state, chain, uri_file, attempt_id, expiry_delta).await
}

async fn tx_status(
    state: &StateDir,
    _globals: &Globals,
    chain: &dyn ChainFactory,
    attempt_id: &str,
) -> CommandResult {
    pay::tx_status(state, chain, attempt_id).await
}

async fn rebroadcast(
    state: &StateDir,
    _globals: &Globals,
    chain: &dyn ChainFactory,
    attempt_id: &str,
) -> CommandResult {
    pay::rebroadcast(state, chain, attempt_id).await
}

async fn dispatch(globals: Globals, command: Command) -> CommandResult {
    let live = LiveChain::new(globals.lightwalletd.clone());
    dispatch_with(globals, command, &live).await
}

/// Runs one command against an injected chain factory.
async fn dispatch_with(
    globals: Globals,
    command: Command,
    chain: &dyn ChainFactory,
) -> CommandResult {
    // Every command runs under the private state boundary and exclusive
    // wallet lock, held until this function returns.
    let state = StateDir::open_or_create(globals.state_dir.clone()).map_err(|error| (2, error))?;
    let state = &state;
    match &command {
        Command::Import {
            mnemonic_file,
            birthday,
        } => import(state, chain, mnemonic_file, *birthday).await,
        Command::Status => status(state, chain).await,
        Command::Pay {
            uri_file,
            attempt_id,
            expiry_delta,
        } => pay(state, &globals, chain, uri_file, attempt_id, *expiry_delta).await,
        Command::TxStatus { attempt_id } => tx_status(state, &globals, chain, attempt_id).await,
        Command::Rebroadcast { attempt_id } => {
            rebroadcast(state, &globals, chain, attempt_id).await
        }
    }
}

fn emit(value: &Value) {
    println!("{value}");
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let (globals, command) = match parse_arguments(&arguments) {
        Ok(parsed) => parsed,
        Err(error) => {
            emit(&json!({ "error": error }));
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            emit(&json!({ "error": "async runtime cannot be started" }));
            return ExitCode::from(2);
        }
    };
    match runtime.block_on(dispatch(globals, command)) {
        Ok((value, code)) => {
            emit(&value);
            ExitCode::from(code)
        }
        Err((code, error)) => {
            emit(&json!({ "error": error }));
            ExitCode::from(code)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::{
        chain::{Broadcast, TxState},
        pay::attempt_output,
        state::tests::{TempRoot, attempt_fixture},
    };

    /// A factory that must never be used: calling it fails the test.
    struct PanicChain {
        calls: AtomicUsize,
    }

    impl PanicChain {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl ChainFactory for PanicChain {
        fn connect(
            &self,
        ) -> Pin<Box<dyn Future<Output = Result<chain::Client, &'static str>> + Send + '_>>
        {
            self.calls.fetch_add(1, Ordering::SeqCst);
            panic!("chain factory must not be used");
        }
    }

    fn globals(temp: &TempRoot) -> Globals {
        Globals {
            state_dir: Some(temp.state_path()),
            lightwalletd: DEFAULT_LIGHTWALLETD.to_owned(),
        }
    }

    fn pay_command(uri_file: &Path, attempt_id: &str) -> Command {
        Command::Pay {
            uri_file: uri_file.to_path_buf(),
            attempt_id: attempt_id.to_owned(),
            expiry_delta: 20,
        }
    }

    #[test]
    fn expiry_delta_parsing() {
        assert_eq!(parse_expiry_delta(None), Ok(20));
        assert_eq!(parse_expiry_delta(Some("10")), Ok(10));
        assert_eq!(parse_expiry_delta(Some("40")), Ok(40));
        for bad in [
            "9",
            "41",
            "0",
            "",
            "abc",
            "-10",
            "+20",
            " 20",
            "20 ",
            "1e1",
            "99999999999",
        ] {
            assert!(parse_expiry_delta(Some(bad)).is_err(), "{bad:?}");
        }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn argument_parsing_follows_frozen_contract() {
        let id = "ab".repeat(32);
        let (g, c) = parse_arguments(&args(&[
            "--state-dir",
            "/s",
            "pay",
            "--uri-file",
            "/u",
            "--attempt-id",
            &id,
        ]))
        .unwrap();
        assert_eq!(g.state_dir, Some(PathBuf::from("/s")));
        assert_eq!(g.lightwalletd, DEFAULT_LIGHTWALLETD);
        assert_eq!(c, pay_command(Path::new("/u"), &id));
        assert!(parse_arguments(&args(&["status"])).is_ok());
        for bad in [
            args(&[]),
            args(&["bogus"]),
            args(&["status", "--extra", "x"]),
            args(&["pay", "--uri-file", "/u"]),
            args(&[
                "pay",
                "--uri-file",
                "/u",
                "--attempt-id",
                &id,
                "--expiry-delta",
                "41",
            ]),
            args(&["import", "--mnemonic-file", "/m", "--birthday", "-1"]),
            args(&["--state-dir", "/a", "--state-dir", "/b", "status"]),
            args(&["tx-status", "--attempt-id"]),
        ] {
            assert!(parse_arguments(&bad).is_err(), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn pay_with_existing_attempt_exits_4_without_chain() {
        let temp = TempRoot::new("guard");
        let id = "ab".repeat(32);
        let attempt = attempt_fixture(&id);
        {
            let state = temp.open();
            state.write_attempt(&attempt).unwrap();
        }
        let chain = PanicChain::new();
        // The URI file does not exist: the guard must answer first.
        let missing = temp.root.join("missing.uri");
        let (value, code) = dispatch_with(globals(&temp), pay_command(&missing, &id), &chain)
            .await
            .expect("guard reports the recorded attempt");
        assert_eq!(code, 4);
        assert_eq!(value, attempt_output(&attempt, Broadcast::Unknown));
        assert_eq!(chain.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn pay_refusals_before_chain_exit_2() {
        let temp = TempRoot::new("payrefuse");
        let chain = PanicChain::new();
        let (uri, id) = crate::pay::tests::valid_invoice();
        let uri_file = temp.write_private("invoice.uri", uri.as_bytes());

        // Invalid attempt id.
        let bad = dispatch_with(globals(&temp), pay_command(&uri_file, "ABC"), &chain).await;
        assert_eq!(bad, Err((2, "attempt id is invalid")));
        // Attempt id that does not match the invoice bytes.
        let other = "cd".repeat(32);
        let mismatch = dispatch_with(globals(&temp), pay_command(&uri_file, &other), &chain).await;
        assert_eq!(mismatch, Err((2, "attempt id does not match the invoice")));
        // Valid invoice, but no imported wallet.
        let fresh = dispatch_with(globals(&temp), pay_command(&uri_file, &id), &chain).await;
        assert_eq!(fresh, Err((2, "wallet is not imported")));
        assert_eq!(chain.calls.load(Ordering::SeqCst), 0);
        // No attempt file was created by any refusal.
        let state = temp.open();
        assert_eq!(state.read_attempt(&id).unwrap(), None);
        assert_eq!(state.read_attempt(&other).unwrap(), None);
    }

    #[tokio::test]
    async fn tx_status_and_rebroadcast_without_attempt_exit_2_without_chain() {
        let temp = TempRoot::new("missing");
        let chain = PanicChain::new();
        let id = "ef".repeat(32);
        for command in [
            Command::TxStatus {
                attempt_id: id.clone(),
            },
            Command::Rebroadcast {
                attempt_id: id.clone(),
            },
        ] {
            let result = dispatch_with(globals(&temp), command, &chain).await;
            assert_eq!(result, Err((2, "no attempt recorded")));
        }
        let invalid = dispatch_with(
            globals(&temp),
            Command::TxStatus {
                attempt_id: "XYZ".to_owned(),
            },
            &chain,
        )
        .await;
        assert_eq!(invalid, Err((2, "attempt id is invalid")));
        assert_eq!(chain.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn status_without_seed_exits_2_without_chain() {
        let temp = TempRoot::new("status");
        let chain = PanicChain::new();
        let result = dispatch_with(globals(&temp), Command::Status, &chain).await;
        assert_eq!(result, Err((2, "wallet is not imported")));
        assert_eq!(chain.calls.load(Ordering::SeqCst), 0);
    }

    /// True when `text` contains a run of 65 or more hex digits.
    fn has_long_hex_run(text: &str) -> bool {
        let mut run = 0;
        for c in text.chars() {
            if c.is_ascii_hexdigit() {
                run += 1;
                if run >= 65 {
                    return true;
                }
            } else {
                run = 0;
            }
        }
        false
    }

    fn assert_clean(text: &str) {
        for forbidden in ["utest1", "uviewtest", "zcash:"] {
            assert!(!text.contains(forbidden), "{forbidden} in {text}");
        }
        assert!(!has_long_hex_run(text), "long hex run in {text}");
    }

    #[test]
    fn output_shapes_are_clean() {
        let (uri, id) = crate::pay::tests::valid_invoice();
        // The fixture is dirty on purpose; the outputs must not be.
        assert!(uri.contains("utest1") && uri.starts_with("zcash:"));
        assert!(has_long_hex_run(&"a".repeat(65)));
        assert!(!has_long_hex_run(&"a".repeat(64)));

        let (txid, _) = crate::chain::tests::tx_fixture(3_000_020);
        let mut attempt = attempt_fixture(&id);
        attempt.txid = chain::txid_display(&txid);
        // `raw_hex` keeps the fixture's 800-hex-digit payload as a canary.

        let mut outputs = vec![
            json!({ "ok": true, "birthday": 3_000_000u32, "tip": 3_000_100u32 }),
            json!({
                "network": "test",
                "tip": 3_000_100u32,
                "spendableZat": "1200000",
                "orchardZat": "1200000",
                "ironwoodZat": "0",
            }),
        ];
        for outcome in [Broadcast::Accepted, Broadcast::Rejected, Broadcast::Unknown] {
            outputs.push(attempt_output(&attempt, outcome));
        }
        for state in [
            TxState::Mined(3_000_005),
            TxState::Mempool,
            TxState::NotFound,
            TxState::Expired,
            TxState::Forked,
        ] {
            outputs.push(json!({
                "attemptId": attempt.attempt_id,
                "txid": attempt.txid,
                "state": state.as_str(),
                "minedHeight": state.mined_height(),
                "tip": 3_000_010u32,
                "expiryHeight": attempt.expiry_height,
            }));
        }
        for error in [
            "invalid arguments",
            "attempt id is invalid",
            "attempt id does not match the invoice",
            "no attempt recorded",
            "status payload is malformed",
            "transaction status unavailable",
        ] {
            outputs.push(json!({ "error": error }));
        }
        for value in &outputs {
            assert!(value.is_object());
            assert_clean(&value.to_string());
        }
        // The raw payload is a long hex run, so leaking it would have been caught.
        assert!(has_long_hex_run(&attempt.raw_hex));
    }
}
