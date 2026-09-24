#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    time::{SystemTime, UNIX_EPOCH},
};

use sovereign_storefront_scanner::cache::PersistentBlockCache;
use zcash_client_backend::{
    data_api::{
        chain::BlockCache,
        scanning::{ScanPriority, ScanRange},
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

fn private_parent(label: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time is after UNIX epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "scanner-cache-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("create owner-private fixture parent");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .expect("restrict fixture parent permissions");
    root
}

#[test]
fn persistent_block_cache_refuses_a_non_directory_root() {
    let parent = private_parent("file");
    let root = parent.join("cache");
    fs::write(&root, b"not a directory").expect("create non-directory root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o600)).expect("restrict fixture file");

    assert!(PersistentBlockCache::open(&root).is_err());

    fs::remove_dir_all(parent).expect("remove generated test parent");
}

#[test]
fn persistent_block_cache_rejects_a_shared_parent_before_creation() {
    let parent = private_parent("shared");
    let shared = parent.join("shared");
    fs::create_dir(&shared).expect("create shared fixture parent");
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).expect("make parent shared");

    assert!(PersistentBlockCache::open(&shared.join("cache")).is_err());

    fs::remove_dir_all(parent).expect("remove generated test parent");
}

#[test]
fn persistent_block_cache_creates_owner_private_storage_that_can_be_reopened() {
    let parent = private_parent("private");
    let root = parent.join("cache");
    let first = PersistentBlockCache::open(&root).expect("create cache");
    drop(first);
    let second = PersistentBlockCache::open(&root).expect("reopen cache");
    drop(second);

    assert_eq!(
        fs::metadata(&root)
            .expect("cache root exists")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    fs::remove_dir_all(parent).expect("remove generated test parent");
}

#[tokio::test]
async fn persistent_block_cache_round_trips_compact_blocks_through_its_blockcache_api() {
    let parent = private_parent("blocks");
    let root = parent.join("cache");
    let cache = PersistentBlockCache::open(&root).expect("create cache");
    let block = CompactBlock {
        height: 42,
        ..CompactBlock::default()
    };
    cache
        .insert(vec![block.clone()])
        .await
        .expect("persist block");

    let range = ScanRange::from_parts(
        BlockHeight::from_u32(42)..BlockHeight::from_u32(43),
        ScanPriority::Historic,
    );
    assert_eq!(cache.read(&range).await.expect("read block"), vec![block]);
    assert_eq!(
        cache.get_tip_height(None).expect("read cached tip"),
        Some(BlockHeight::from_u32(42))
    );

    fs::remove_dir_all(parent).expect("remove generated test parent");
}
