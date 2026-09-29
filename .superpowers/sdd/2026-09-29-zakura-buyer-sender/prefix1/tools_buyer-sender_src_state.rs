//! Owner-private buyer wallet state: seed, wallet database, block cache,
//! broadcast attempt records and the single-process wallet lock.
//!
//! Every file lives beneath one held `0700` directory descriptor. Nothing in
//! this module prints or returns seed material except as a zeroizing secret.

use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use bip39::{Language, Mnemonic};
use getrandom::SysRng;
use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg},
    unistd::geteuid,
};
use rand_core::UnwrapErr;
use rusqlite::Connection;
use secrecy::{ExposeSecret, SecretVec};
use serde::{Deserialize, Serialize};
use sovereign_storefront_scanner::{
    cache::PersistentBlockCache,
    config::ScannerParams,
    private_fs::{PrivateDir, private_parent},
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zeroize::{Zeroize, Zeroizing};

pub type Db = WalletDb<Connection, ScannerParams, SystemClock, UnwrapErr<SysRng>>;

const DEFAULT_STATE_SUFFIX: &str = ".local/state/ssf-buyer";
const LOCK_FILE: &str = "lock";
const SEED_FILE: &str = "seed.private";
const WALLET_FILE: &str = "wallet.sqlite";
const BLOCKS_DIRECTORY: &str = "blocks";
const ATTEMPTS_DIRECTORY: &str = "attempts";
const MAX_MNEMONIC_FILE_BYTES: u64 = 4096;

/// One broadcast attempt. Written once, before broadcast, and never replaced:
/// a rebroadcast re-sends exactly `raw_hex`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub attempt_id: String,
    pub txid: String,
    pub raw_hex: String,
    pub target_height: u32,
    pub expiry_height: u32,
    pub amount_zat: u64,
    pub created_at: u64,
}

/// The held private state directory plus the exclusive wallet lock. The lock
/// is released only when this value is dropped.
pub struct StateDir {
    root: PrivateDir,
    _lock: Flock<File>,
}

/// Pure attempt-id check: exactly 64 lowercase hex characters.
pub fn validate_attempt_id(id: &str) -> Result<(), &'static str> {
    if id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(())
    } else {
        Err("attempt id is invalid")
    }
}

fn default_state_path() -> Result<PathBuf, &'static str> {
    let home = std::env::var_os("HOME").ok_or("state directory is unavailable")?;
    if home.is_empty() {
        return Err("state directory is unavailable");
    }
    Ok(PathBuf::from(home).join(DEFAULT_STATE_SUFFIX))
}

fn open_root(path: &Path) -> Result<PrivateDir, &'static str> {
    // Preferred: the parent is itself a private boundary, so the final
    // component is created and opened through the parent's descriptor.
    if let Ok((parent, name)) = private_parent(path) {
        let name = name.to_str().ok_or("state directory path is invalid")?;
        return parent
            .open_or_create_child(name)
            .map_err(|_| "state directory cannot be opened safely");
    }
    // Default location (`~/.local/state`) is normally 0755: create only the
    // final component as 0700, then open it with O_NOFOLLOW and require the
    // current owner and exact 0700 mode.
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("state directory cannot be created"),
    }
    PrivateDir::open(path).map_err(|_| "state directory cannot be opened safely")
}

impl StateDir {
    /// Opens (creating when needed) the private state directory and takes an
    /// exclusive non-blocking `flock` on `lock` for this value's lifetime.
    pub fn open_or_create(path: Option<PathBuf>) -> Result<Self, &'static str> {
        let path = match path {
            Some(path) => path,
            None => default_state_path()?,
        };
        let root = open_root(&path)?;
        root.verify()
            .map_err(|_| "state directory permissions are unsafe")?;
        let file = root
            .ensure_file(LOCK_FILE)
            .map_err(|_| "wallet lock file is unsafe")?;
        let lock = match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => lock,
            Err((_, Errno::EWOULDBLOCK)) => {
                return Err("another sender process holds the wallet lock");
            }
            Err(_) => return Err("wallet lock cannot be taken"),
        };
        Ok(Self { root, _lock: lock })
    }

    pub fn has_seed(&self) -> Result<bool, &'static str> {
        let path = self
            .root
            .proc_path(SEED_FILE)
            .map_err(|_| "seed path is invalid")?;
        match std::fs::symlink_metadata(&path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("seed cannot be inspected"),
        }
    }

    /// Imports a BIP-39 English mnemonic from an owner-only `0600` file and
    /// stores its normalized phrase in `seed.private`. Never echoes it.
    pub fn write_seed(&self, mnemonic_file: &Path) -> Result<(), &'static str> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(mnemonic_file)
            .map_err(|_| "mnemonic file cannot be opened safely")?;
        let metadata = file
            .metadata()
            .map_err(|_| "mnemonic file cannot be inspected")?;
        if !metadata.is_file()
            || metadata.uid() != geteuid().as_raw()
            || metadata.mode() & 0o777 != 0o600
        {
            return Err("mnemonic file must be owned by this user with mode 0600");
        }
        if metadata.len() > MAX_MNEMONIC_FILE_BYTES {
            return Err("mnemonic is invalid");
        }
        let mut text = Zeroizing::new(String::new());
        file.read_to_string(&mut text)
            .map_err(|_| "mnemonic file cannot be read")?;
        let mnemonic = Mnemonic::parse_in(Language::English, text.as_str())
            .map_err(|_| "mnemonic is invalid")?;
        let normalized = Zeroizing::new(mnemonic.to_string());
        self.root
            .write_file_atomic(SEED_FILE, normalized.as_bytes())
            .map_err(|_| "seed cannot be stored safely")
    }

    /// Returns the BIP-39 seed (empty passphrase) as a zeroizing secret.
    pub fn read_seed(&self) -> Result<SecretVec<u8>, &'static str> {
        let bytes = Zeroizing::new(
            self.root
                .read_file(SEED_FILE)
                .map_err(|_| "seed cannot be read safely")?,
        );
        let text = std::str::from_utf8(&bytes).map_err(|_| "stored seed is invalid")?;
        let mnemonic =
            Mnemonic::parse_in(Language::English, text).map_err(|_| "stored seed is invalid")?;
        let mut seed = mnemonic.to_seed("");
        let secret = SecretVec::new(seed.to_vec());
        seed.zeroize();
        Ok(secret)
    }

    /// Opens and migrates `wallet.sqlite` for public testnet, mirroring the
    /// scanner's descriptor-backed open. A seed is required only for
    /// migrations that derive spending state.
    pub fn open_wallet(&self, seed: Option<&SecretVec<u8>>) -> Result<Db, &'static str> {
        drop(
            self.root
                .ensure_file(WALLET_FILE)
                .map_err(|_| "wallet database boundary is unsafe")?,
        );
        let path = self
            .root
            .proc_path(WALLET_FILE)
            .map_err(|_| "wallet database path is invalid")?;
        let mut db = WalletDb::for_path(
            &path,
            ScannerParams::test_network(),
            SystemClock,
            UnwrapErr(SysRng),
        )
        .map_err(|_| "wallet database cannot be opened")?;
        let seed = seed.map(|seed| SecretVec::new(seed.expose_secret().clone()));
        init_wallet_db(&mut db, seed).map_err(|_| "wallet database cannot be initialized")?;
        drop(
            self.root
                .ensure_file(WALLET_FILE)
                .map_err(|_| "wallet database permissions are unsafe")?,
        );
        Ok(db)
    }

    pub fn block_cache(&self) -> Result<PersistentBlockCache, &'static str> {
        PersistentBlockCache::open_in(&self.root, BLOCKS_DIRECTORY)
            .map_err(|_| "block cache cannot be opened safely")
    }

    fn attempts(&self) -> Result<PrivateDir, &'static str> {
        self.root
            .open_or_create_child(ATTEMPTS_DIRECTORY)
            .map_err(|_| "attempt directory cannot be opened safely")
    }

    /// Writes an attempt with create-new semantics (mode 0600). An existing
    /// file is never replaced.
    pub fn write_attempt(&self, attempt: &Attempt) -> Result<(), &'static str> {
        validate_attempt_id(&attempt.attempt_id)?;
        let mut encoded = serde_json::to_vec(attempt).map_err(|_| "attempt cannot be encoded")?;
        encoded.push(b'\n');
        let dir = self.attempts()?;
        let name = format!("{}.json", attempt.attempt_id);
        let path = dir
            .proc_path(&name)
            .map_err(|_| "attempt path is invalid")?;
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err("attempt already exists");
            }
            Err(_) => return Err("attempt cannot be created"),
        };
        let metadata = file.metadata().map_err(|_| "attempt cannot be inspected")?;
        if metadata.uid() != geteuid().as_raw() || metadata.mode() & 0o777 != 0o600 {
            drop(file);
            let _ = dir.remove_file(&name);
            return Err("attempt file boundary is unsafe");
        }
        if file.write_all(&encoded).is_err() || file.sync_all().is_err() {
            drop(file);
            let _ = dir.remove_file(&name);
            return Err("attempt cannot be written");
        }
        Ok(())
    }

    /// Reads an attempt by id. A missing attempt is `Ok(None)`.
    pub fn read_attempt(&self, id: &str) -> Result<Option<Attempt>, &'static str> {
        validate_attempt_id(id)?;
        let dir = self.attempts()?;
        let name = format!("{id}.json");
        let path = dir
            .proc_path(&name)
            .map_err(|_| "attempt path is invalid")?;
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("attempt cannot be inspected"),
        }
        let bytes = dir
            .read_file(&name)
            .map_err(|_| "attempt cannot be read safely")?;
        let attempt: Attempt =
            serde_json::from_slice(&bytes).map_err(|_| "attempt file is invalid")?;
        if attempt.attempt_id != id {
            return Err("attempt file is invalid");
        }
        Ok(Some(attempt))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{
        fs::{DirBuilder, Permissions},
        os::unix::fs::{DirBuilderExt, PermissionsExt},
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    /// A `0700` temp root under `std::env::temp_dir()`, removed on drop. The
    /// state directory is `<root>/state`, so its parent is a private boundary.
    pub(crate) struct TempRoot {
        pub(crate) root: PathBuf,
    }

    impl TempRoot {
        pub(crate) fn new(tag: &str) -> Self {
            let n = NEXT.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir()
                .join(format!("ssf-buyer-6-1-{tag}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            DirBuilder::new().mode(0o700).create(&root).unwrap();
            std::fs::set_permissions(&root, Permissions::from_mode(0o700)).unwrap();
            Self { root }
        }

        pub(crate) fn state_path(&self) -> PathBuf {
            self.root.join("state")
        }

        pub(crate) fn open(&self) -> StateDir {
            StateDir::open_or_create(Some(self.state_path())).unwrap()
        }

        pub(crate) fn write_private(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(name);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .unwrap();
            file.write_all(bytes).unwrap();
            std::fs::set_permissions(&path, Permissions::from_mode(0o600)).unwrap();
            path
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    pub(crate) fn attempt_fixture(id: &str) -> Attempt {
        Attempt {
            attempt_id: id.to_owned(),
            txid: "0123456789abcdef".repeat(4),
            raw_hex: "05".repeat(400),
            target_height: 3_000_000,
            expiry_height: 3_000_020,
            amount_zat: 50_000,
            created_at: 1_790_000_000,
        }
    }

    #[test]
    fn validate_attempt_id_accepts_only_64_lowercase_hex() {
        assert!(validate_attempt_id(&"a1".repeat(32)).is_ok());
        assert!(validate_attempt_id(&"A1".repeat(32)).is_err());
        assert!(validate_attempt_id(&"a1".repeat(31)).is_err());
        assert!(validate_attempt_id(&"a1".repeat(33)).is_err());
        assert!(validate_attempt_id(&"g1".repeat(32)).is_err());
        assert!(validate_attempt_id("").is_err());
        assert!(validate_attempt_id(&format!("../{}", "a".repeat(61))).is_err());
    }

    #[test]
    fn write_attempt_is_create_new_with_mode_0600() {
        let temp = TempRoot::new("attempt");
        let state = temp.open();
        let id = "cd".repeat(32);
        let attempt = attempt_fixture(&id);
        state.write_attempt(&attempt).unwrap();

        let path = temp
            .state_path()
            .join("attempts")
            .join(format!("{id}.json"));
        let meta = std::fs::symlink_metadata(&path).unwrap();
        assert!(meta.file_type().is_file());
        assert_eq!(meta.mode() & 0o7777, 0o600);
        assert_eq!(meta.uid(), geteuid().as_raw());

        // A second write with different content must not replace the file.
        let mut other = attempt.clone();
        other.raw_hex = "06".repeat(10);
        assert_eq!(state.write_attempt(&other), Err("attempt already exists"));
        assert_eq!(state.read_attempt(&id).unwrap(), Some(attempt));
    }

    #[test]
    fn read_attempt_missing_is_none_and_bad_ids_are_rejected() {
        let temp = TempRoot::new("read");
        let state = temp.open();
        assert_eq!(state.read_attempt(&"ef".repeat(32)).unwrap(), None);
        for bad in [
            "EF".repeat(32),
            "ef".repeat(31),
            "zz".repeat(32),
            String::new(),
        ] {
            assert_eq!(state.read_attempt(&bad), Err("attempt id is invalid"));
        }
        let mut bad = attempt_fixture(&"ab".repeat(32));
        bad.attempt_id = "AB".repeat(32);
        assert_eq!(state.write_attempt(&bad), Err("attempt id is invalid"));
    }

    #[test]
    fn second_state_open_is_refused_by_lock() {
        let temp = TempRoot::new("lock");
        let _held = temp.open();
        match StateDir::open_or_create(Some(temp.state_path())) {
            Ok(_) => panic!("second open must be refused"),
            Err(error) => assert_eq!(error, "another sender process holds the wallet lock"),
        }
    }
}
