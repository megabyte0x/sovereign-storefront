//! Descriptor-rooted, process-wide exclusion for scanner state writers.

use std::fs::File;

use nix::fcntl::{Flock, FlockArg};

/// An exclusive non-blocking OS lease held across an entire mutating scanner
/// lifecycle. The owned descriptor releases its lock on drop and process exit.
pub(crate) struct WriterLease {
    _lock: Flock<File>,
}

impl WriterLease {
    /// Acquires the supplied already-validated private lock descriptor without
    /// waiting. A second process must fail closed rather than relying on SQLite
    /// contention to serialize wallet mutations.
    pub(crate) fn acquire(file: File) -> Result<Self, &'static str> {
        let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock)
            .map_err(|_| "scanner writer lease is held")?;
        Ok(Self { _lock: lock })
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, OpenOptions},
        os::unix::fs::PermissionsExt,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::WriterLease;

    #[test]
    fn descriptor_rooted_writer_lease_rejects_a_second_process_without_state_mutation() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ssf-task3-lease-{nonce}"));
        fs::create_dir(&root).expect("create private state root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("protect state root");
        let path = root.join("writer.lock");
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("create private lock file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("protect lock file");
        let _lease = WriterLease::acquire(file).expect("first lifecycle owns writer lease");

        let status = Command::new("flock")
            .args(["--nonblock", path.to_str().expect("lock path"), "true"])
            .status()
            .expect("run independent lock probe");
        assert!(!status.success(), "second process acquired writer lease");

        fs::remove_dir_all(root).expect("remove isolated state");
    }
}
