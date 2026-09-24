use std::{fmt, path::Path};

use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error::Error as ChainError},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

use crate::private_fs::{PrivateDir, private_parent};

#[derive(Debug)]
pub enum CacheError {
    Decode,
    InvalidBlockHeight,
    Io,
    MissingBlock,
    UnsafeRoot,
}

impl fmt::Display for CacheError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Decode => "compact block cache contains invalid data",
            Self::InvalidBlockHeight => "compact block cache received an invalid height",
            Self::Io => "compact block cache I/O failed",
            Self::MissingBlock => "compact block cache is missing a block",
            Self::UnsafeRoot => "compact block cache root is unsafe",
        })
    }
}

impl std::error::Error for CacheError {}

/// A cache held beneath an owner-private directory descriptor. Every block file
/// operation is resolved relative to that descriptor with `O_NOFOLLOW`.
pub struct PersistentBlockCache {
    blocks: PrivateDir,
}

impl PersistentBlockCache {
    /// Opens a cache rooted at a direct child of an existing private parent.
    pub fn open(root: &Path) -> Result<Self, CacheError> {
        let (parent, name) = private_parent(root).map_err(|_| CacheError::UnsafeRoot)?;
        let name = name.to_str().ok_or(CacheError::UnsafeRoot)?;
        Self::open_in(&parent, name)
    }

    /// Opens or creates a cache inside an already-held scanner state boundary.
    pub fn open_in(parent: &PrivateDir, name: &str) -> Result<Self, CacheError> {
        let root = parent
            .open_or_create_child(name)
            .map_err(|_| CacheError::UnsafeRoot)?;
        let blocks = root
            .open_or_create_child("blocks")
            .map_err(|_| CacheError::UnsafeRoot)?;
        Ok(Self { blocks })
    }

    fn block_height(block: &CompactBlock) -> Result<BlockHeight, CacheError> {
        u32::try_from(block.height)
            .map(BlockHeight::from_u32)
            .map_err(|_| CacheError::InvalidBlockHeight)
    }

    fn block_name(height: BlockHeight) -> String {
        format!("{:010}.compactblock", u32::from(height))
    }

    fn decode(&self, height: BlockHeight) -> Result<CompactBlock, CacheError> {
        let bytes = self
            .blocks
            .read_file(&Self::block_name(height))
            .map_err(|_| CacheError::MissingBlock)?;
        prost::Message::decode(bytes.as_slice()).map_err(|_| CacheError::Decode)
    }

    fn heights(&self) -> Result<Vec<BlockHeight>, CacheError> {
        let mut heights = self
            .blocks
            .file_names()
            .map_err(|_| CacheError::Io)?
            .into_iter()
            .filter_map(|name| name.into_string().ok())
            .filter_map(|name| {
                name.strip_suffix(".compactblock")?
                    .parse::<u32>()
                    .ok()
                    .map(BlockHeight::from_u32)
            })
            .collect::<Vec<_>>();
        heights.sort_unstable();
        heights.dedup();
        Ok(heights)
    }

    fn write_block(&self, block: &CompactBlock) -> Result<(), CacheError> {
        let height = Self::block_height(block)?;
        let bytes = prost::Message::encode_to_vec(block);
        self.blocks
            .write_file_atomic(&Self::block_name(height), &bytes)
            .map_err(|_| CacheError::Io)
    }
}

impl BlockSource for PersistentBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let start = from_height.unwrap_or_else(|| BlockHeight::from_u32(0));
        for height in self
            .heights()
            .map_err(ChainError::BlockSource)?
            .into_iter()
            .filter(|height| *height >= start)
            .take(limit.unwrap_or(usize::MAX))
        {
            with_block(self.decode(height).map_err(ChainError::BlockSource)?)?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl BlockCache for PersistentBlockCache {
    fn get_tip_height(
        &self,
        range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        let mut heights = self.heights()?;
        if let Some(range) = range {
            heights.retain(|height| range.block_range().contains(height));
        }
        Ok(heights.into_iter().max())
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let mut blocks = Vec::new();
        for height in u32::from(range.block_range().start)..u32::from(range.block_range().end) {
            blocks.push(self.decode(BlockHeight::from_u32(height))?);
        }
        Ok(blocks)
    }

    async fn insert(&self, blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        for block in blocks {
            self.write_block(&block)?;
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let names = self.blocks.file_names().map_err(|_| CacheError::Io)?;
        for height in u32::from(range.block_range().start)..u32::from(range.block_range().end) {
            let name = Self::block_name(BlockHeight::from_u32(height));
            if names
                .iter()
                .any(|candidate| candidate.as_os_str() == std::ffi::OsStr::new(&name))
            {
                self.blocks.remove_file(&name).map_err(|_| CacheError::Io)?;
            }
        }
        Ok(())
    }
}
