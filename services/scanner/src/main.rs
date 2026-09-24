//! Bounded receiver-side Task 1 scanner qualification CLI.

use std::{collections::BTreeMap, env, path::PathBuf, process::ExitCode};

use sovereign_storefront_scanner::{
    config::{ActivationHeights, validate_lightwalletd_endpoint},
    consensus::verify_lightd_consensus,
    daemon::PersistentScanner,
    scan::{GRPC_CONNECT_DEADLINE, GRPC_RPC_DEADLINE, Stage, run, within_deadline},
};
use zcash_client_backend::proto::service::{
    BlockId, Empty, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_protocol::local_consensus::LocalNetwork;

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

struct Arguments {
    config: PathBuf,
    endpoint: String,
    params: LocalNetwork,
    stage: Stage,
}

struct InspectionArguments {
    endpoint: String,
    birthday: u32,
    params: LocalNetwork,
}

fn parse_height(value: Option<String>) -> Option<Option<u32>> {
    match value?.as_str() {
        "none" => Some(None),
        value => value.parse().ok().map(Some),
    }
}

fn parse_stage(value: Option<String>) -> Option<Stage> {
    match value?.as_str() {
        "prepare" => Some(Stage::Prepare),
        "before-ten" => Some(Stage::BeforeTen),
        "at-ten" => Some(Stage::AtTen),
        "verify-restart" => Some(Stage::VerifyRestart),
        _ => None,
    }
}

fn parse_arguments() -> Option<Arguments> {
    let mut values = env::args().skip(1);
    if values.next()?.as_str() != "qualify" {
        return None;
    }
    let mut config = None;
    let mut endpoint = None;
    let mut stage = None;
    let mut heights = BTreeMap::new();
    while let Some(flag) = values.next() {
        match flag.as_str() {
            "--config" if config.is_none() => config = values.next().map(PathBuf::from),
            "--lightwalletd" if endpoint.is_none() => endpoint = values.next(),
            "--stage" if stage.is_none() => stage = parse_stage(values.next()),
            flag if flag.starts_with("--") => {
                let name = flag.strip_prefix("--")?;
                if !ACTIVATIONS.contains(&name) || heights.contains_key(name) {
                    return None;
                }
                heights.insert(name.to_owned(), parse_height(values.next())?);
            }
            _ => return None,
        }
    }
    let config = config?;
    let endpoint = endpoint?;
    if endpoint.is_empty() || !config.is_file() {
        return None;
    }
    let observed = ActivationHeights::from_runtime_values([
        ("overwinter", *heights.get("overwinter")?),
        ("sapling", *heights.get("sapling")?),
        ("blossom", *heights.get("blossom")?),
        ("heartwood", *heights.get("heartwood")?),
        ("canopy", *heights.get("canopy")?),
        ("nu5", *heights.get("nu5")?),
        ("nu6", *heights.get("nu6")?),
        ("nu6-1", *heights.get("nu6-1")?),
        ("nu6-2", *heights.get("nu6-2")?),
        ("nu6-3", *heights.get("nu6-3")?),
    ])
    .ok()?;
    Some(Arguments {
        config,
        endpoint,
        stage: stage?,
        params: observed.local_network(),
    })
}

fn parse_inspection_arguments() -> Option<InspectionArguments> {
    let mut values = env::args().skip(2);
    let mut endpoint = None;
    let mut birthday = None;
    let mut heights = BTreeMap::new();
    while let Some(flag) = values.next() {
        match flag.as_str() {
            "--lightwalletd" if endpoint.is_none() => endpoint = values.next(),
            "--birthday" if birthday.is_none() => birthday = values.next()?.parse::<u32>().ok(),
            flag if flag.starts_with("--") => {
                let name = flag.strip_prefix("--")?;
                if !ACTIVATIONS.contains(&name) || heights.contains_key(name) {
                    return None;
                }
                heights.insert(name.to_owned(), parse_height(values.next())?);
            }
            _ => return None,
        }
    }
    let endpoint = endpoint?;
    let birthday = birthday?;
    if endpoint.is_empty() || birthday == 0 || validate_lightwalletd_endpoint(&endpoint).is_err() {
        return None;
    }
    let observed = ActivationHeights::from_runtime_values([
        ("overwinter", *heights.get("overwinter")?),
        ("sapling", *heights.get("sapling")?),
        ("blossom", *heights.get("blossom")?),
        ("heartwood", *heights.get("heartwood")?),
        ("canopy", *heights.get("canopy")?),
        ("nu5", *heights.get("nu5")?),
        ("nu6", *heights.get("nu6")?),
        ("nu6-1", *heights.get("nu6-1")?),
        ("nu6-2", *heights.get("nu6-2")?),
        ("nu6-3", *heights.get("nu6-3")?),
    ])
    .ok()?;
    Some(InspectionArguments {
        endpoint,
        birthday,
        params: observed.local_network(),
    })
}

async fn inspect_lightwalletd(arguments: InspectionArguments) -> Result<serde_json::Value, ()> {
    let mut client = within_deadline(
        GRPC_CONNECT_DEADLINE,
        CompactTxStreamerClient::connect(arguments.endpoint),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    let info = within_deadline(GRPC_RPC_DEADLINE, client.get_lightd_info(Empty {}))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?
        .into_inner();
    verify_lightd_consensus(
        &arguments.params,
        info.sapling_activation_height,
        &info.consensus_branch_id,
        info.block_height,
    )
    .map_err(|_| ())?;
    let tree = within_deadline(
        GRPC_RPC_DEADLINE,
        client.get_tree_state(BlockId {
            height: u64::from(arguments.birthday - 1),
            hash: Vec::new(),
        }),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?
    .into_inner();
    Ok(serde_json::json!({
        "network": tree.network,
        "height": tree.height,
        "hash": tree.hash,
        "time": tree.time,
        "saplingTree": tree.sapling_tree,
        "orchardTree": tree.orchard_tree,
        "ironwoodTree": tree.ironwood_tree,
    }))
}

fn stage_label(stage: Stage) -> &'static str {
    match stage {
        Stage::Prepare => "prepare",
        Stage::BeforeTen => "before-ten",
        Stage::AtTen => "at-ten",
        Stage::VerifyRestart => "verify-restart",
    }
}

fn service_config() -> Option<PathBuf> {
    let mut values = env::args().skip(2);
    if values.next()?.as_str() != "--config" {
        return None;
    }
    let config = PathBuf::from(values.next()?);
    if values.next().is_some() || !config.is_file() {
        return None;
    }
    Some(config)
}

fn run_service(config: PathBuf, serve: bool) -> ExitCode {
    let scanner = match PersistentScanner::open(&config) {
        Ok(scanner) => scanner,
        Err(_) => {
            eprintln!("scanner runtime initialization failed");
            return ExitCode::FAILURE;
        }
    };
    if !serve {
        println!("scanner_view_initialized");
        return ExitCode::SUCCESS;
    }
    match scanner.serve() {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("scanner daemon failed");
            ExitCode::FAILURE
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match env::args().nth(1).as_deref() {
        Some("init-view") => {
            let Some(config) = service_config() else {
                return ExitCode::FAILURE;
            };
            return run_service(config, false);
        }
        Some("serve") => {
            let Some(config) = service_config() else {
                return ExitCode::FAILURE;
            };
            return run_service(config, true);
        }
        Some("inspect-lightwalletd") => {
            let Some(arguments) = parse_inspection_arguments() else {
                return ExitCode::FAILURE;
            };
            return match inspect_lightwalletd(arguments).await {
                Ok(tree) => match serde_json::to_string(&tree) {
                    Ok(encoded) => {
                        println!("{encoded}");
                        ExitCode::SUCCESS
                    }
                    Err(_) => ExitCode::FAILURE,
                },
                Err(_) => ExitCode::FAILURE,
            };
        }
        Some("qualify") => {}
        _ => return ExitCode::FAILURE,
    }
    let Some(arguments) = parse_arguments() else {
        return ExitCode::FAILURE;
    };
    let stage = arguments.stage;
    match run(
        &arguments.config,
        &arguments.endpoint,
        arguments.params,
        stage,
    )
    .await
    {
        Ok(()) => {
            println!("scanner_stage={}", stage_label(stage));
            ExitCode::SUCCESS
        }
        Err(_) => {
            eprintln!("scanner qualification failed");
            ExitCode::FAILURE
        }
    }
}
