//! Throwaway public-testnet scanner qualification spike.
//!
//! Never prints a seed, UFVK, or viewing key. Runtime data lives under `state/`
//! (gitignored via `spikes/**/state/`).

use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

use async_trait::async_trait;
use getrandom::SysRng;
use rand_core::UnwrapErr;
use rusqlite::Connection;
use zcash_client_backend::{
    data_api::{
        AccountBirthday, AccountPurpose, WalletRead, WalletWrite,
        chain::{BlockCache, BlockSource, error::Error as ChainError},
        scanning::ScanRange,
    },
    proto::{
        compact_formats::CompactBlock,
        service::{BlockId, Empty, compact_tx_streamer_client::CompactTxStreamerClient},
    },
    sync,
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};
use zip32::AccountId;

const ENDPOINT: &str = "https://testnet.zec.rocks:443";
const PARAMS: Network = Network::TestNetwork;
const SYNC_BLOCKS: u32 = 1_000;
const BATCH_SIZE: u32 = 100;

type Db = WalletDb<Connection, Network, SystemClock, UnwrapErr<SysRng>>;

struct MemCache {
    blocks: Mutex<BTreeMap<u32, CompactBlock>>,
}

impl MemCache {
    fn new() -> Self {
        Self {
            blocks: Mutex::new(BTreeMap::new()),
        }
    }
}

impl BlockSource for MemCache {
    type Error = std::io::Error;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let start = from_height.map(u32::from).unwrap_or(0);
        let blocks = self.blocks.lock().map_err(|_| {
            ChainError::BlockSource(std::io::Error::other("block cache mutex poisoned"))
        })?;
        for block in blocks
            .values()
            .filter(|block| u32::try_from(block.height).unwrap_or(u32::MAX) >= start)
            .take(limit.unwrap_or(usize::MAX))
        {
            with_block(block.clone())?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemCache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self
            .blocks
            .lock()
            .map_err(|_| std::io::Error::other("block cache mutex poisoned"))?;
        let tip = blocks
            .keys()
            .copied()
            .filter(|height| match range {
                Some(range) => range.block_range().contains(&BlockHeight::from_u32(*height)),
                None => true,
            })
            .max()
            .map(BlockHeight::from_u32);
        Ok(tip)
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let blocks = self
            .blocks
            .lock()
            .map_err(|_| std::io::Error::other("block cache mutex poisoned"))?;
        let mut out = Vec::new();
        for height in u32::from(range.block_range().start)..u32::from(range.block_range().end) {
            match blocks.get(&height) {
                Some(block) => out.push(block.clone()),
                None => break,
            }
        }
        Ok(out)
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut blocks = self
            .blocks
            .lock()
            .map_err(|_| std::io::Error::other("block cache mutex poisoned"))?;
        for block in compact_blocks {
            let height = u32::try_from(block.height)
                .map_err(|_| std::io::Error::other("compact block height is invalid"))?;
            blocks.insert(height, block);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut blocks = self
            .blocks
            .lock()
            .map_err(|_| std::io::Error::other("block cache mutex poisoned"))?;
        blocks.retain(|height, _| !range.block_range().contains(&BlockHeight::from_u32(*height)));
        Ok(())
    }
}

fn state_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("state")
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn throwaway_orchard_ufvk() -> zcash_keys::keys::UnifiedFullViewingKey {
    let mut seed = [0_u8; 32];
    getrandom::fill(&mut seed).expect("os entropy");
    let spending_key = UnifiedSpendingKey::from_seed(&PARAMS, &seed, AccountId::ZERO)
        .expect("derive throwaway testnet usk");
    seed.fill(0);
    let ufvk = spending_key.to_unified_full_viewing_key();
    assert!(
        ufvk.orchard().is_some(),
        "throwaway UFVK missing Orchard component"
    );
    let encoded = ufvk.encode(&PARAMS);
    let hrp_ok = encoded.starts_with("uviewtest1");
    println!("ufvk_hrp_ok={hrp_ok} ufvk_len={}", encoded.len());
    drop(encoded);
    ufvk
}

#[tokio::main]
async fn main() {
    let sapling = PARAMS
        .activation_height(NetworkUpgrade::Sapling)
        .map(u32::from);
    let nu5 = PARAMS.activation_height(NetworkUpgrade::Nu5).map(u32::from);
    println!("params=Network::TestNetwork sapling={sapling:?} nu5={nu5:?}");
    println!("endpoint={ENDPOINT}");

    let connect_start = Instant::now();
    let mut client = CompactTxStreamerClient::connect(ENDPOINT.to_owned())
        .await
        .unwrap_or_else(|error| panic!("tls connect failed: {error}"));
    println!("connect_ms={}", connect_start.elapsed().as_millis());

    let info = client
        .get_lightd_info(Empty {})
        .await
        .unwrap_or_else(|error| panic!("GetLightdInfo failed: {error}"))
        .into_inner();
    println!(
        "probe_lightd chain_name={} block_height={} consensus_branch_id={} sapling_activation_height={}",
        info.chain_name, info.block_height, info.consensus_branch_id, info.sapling_activation_height
    );

    let tip = u32::try_from(info.block_height).expect("tip fits u32");
    let birthday_height = tip.saturating_sub(SYNC_BLOCKS).max(1);
    let tree_height = u64::from(birthday_height.saturating_sub(1));
    let tree = client
        .get_tree_state(BlockId {
            height: tree_height,
            hash: Vec::new(),
        })
        .await
        .unwrap_or_else(|error| panic!("GetTreeState failed: {error}"))
        .into_inner();
    println!(
        "probe_treestate network={} height={} birthday={}",
        tree.network, tree.height, birthday_height
    );

    let birthday =
        AccountBirthday::from_treestate(tree, None).expect("birthday from GetTreeState");
    let ufvk = throwaway_orchard_ufvk();

    let root = state_dir();
    fs::create_dir_all(&root).expect("create spike state dir");
    let wallet_path = root.join("wallet.sqlite");
    let _ = fs::remove_file(&wallet_path);

    let mut db = WalletDb::for_path(&wallet_path, PARAMS, SystemClock, UnwrapErr(SysRng))
        .expect("open wallet db");
    init_wallet_db(&mut db, None).expect("init wallet db");
    db.import_account_ufvk(
        "spike-testnet",
        &ufvk,
        &birthday,
        AccountPurpose::ViewOnly,
        None,
    )
    .expect("import view-only ufvk");
    db.update_chain_tip(birthday.height())
        .expect("record birthday as chain tip");

    let cache = MemCache::new();
    let sync_start = Instant::now();
    match sync::run(&mut client, &PARAMS, &cache, &mut db, BATCH_SIZE).await {
        Ok(()) => println!("sync_ok=true"),
        Err(error) => {
            println!("sync_ok=false error={error}");
            std::process::exit(1);
        }
    }
    let sync_ms = sync_start.elapsed().as_millis();
    let cached = cache.blocks.lock().map(|blocks| blocks.len()).unwrap_or(0);
    let db_bytes = file_size(&wallet_path);
    println!("sync_wall_ms={sync_ms} cached_blocks={cached} wallet_db_bytes={db_bytes}");

    if let Ok(Some(summary)) = db.get_wallet_summary(Default::default()) {
        println!(
            "wallet_summary chain_tip={} fully_scanned={}",
            u32::from(summary.chain_tip_height()),
            u32::from(summary.fully_scanned_height())
        );
    }

    let rate = if sync_ms == 0 {
        f64::INFINITY
    } else {
        (SYNC_BLOCKS as f64) * 1000.0 / (sync_ms as f64)
    };
    println!("sync_blocks={SYNC_BLOCKS} blocks_per_sec={rate:.3}");
    println!(
        "seller_birthday_plan=GetLatestBlock estimated_full_sync_from_seller_birthday_s=0 extra_lag_blocks_use_this_rate"
    );
}
