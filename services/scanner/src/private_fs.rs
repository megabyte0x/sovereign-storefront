//! Owner-private, descriptor-relative filesystem operations for scanner state.
//!
//! The scanner accepts a private directory as a trust boundary, opens it with
//! `O_DIRECTORY | O_NOFOLLOW`, verifies its owner and exact `0700` mode, then
//! performs every state/cache/result operation relative to that held descriptor.
//! This prevents a later path replacement from redirecting scanner state.

use std::{
    ffi::OsString,
    fs::File,
    io::{Read, Write},
    os::fd::{AsFd, AsRawFd, OwnedFd},
    path::{Component, Path, PathBuf},
};

use nix::{
    dir::Dir,
    errno::Errno,
    fcntl::{AtFlags, OFlag, open, openat, renameat},
    sys::stat::{Mode, fstat, fstatat, mkdirat},
    unistd::{UnlinkatFlags, geteuid, unlinkat},
};

const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;

/// An open owner-private directory held for the lifetime of all relative I/O.
pub struct PrivateDir {
    dir: OwnedFd,
    display_path: PathBuf,
}

/// Stable identity captured from a validated directory entry before an
/// operation that must never delete a later replacement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SocketIdentity {
    device: u64,
    inode: u64,
}

impl PrivateDir {
    /// Opens an existing owner-private directory without following its final
    /// path component. Its descriptor remains the authority for child I/O.
    pub fn open(path: &Path) -> Result<Self, &'static str> {
        let dir = open(
            path,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|_| "private directory cannot be opened safely")?;
        validate_directory(&dir)?;
        Ok(Self {
            dir,
            display_path: path.to_path_buf(),
        })
    }

    /// Opens a private directory immediately beneath a trusted descriptor.
    pub fn open_child(&self, name: &str) -> Result<Self, &'static str> {
        validate_component(name)?;
        let dir = openat(
            &self.dir,
            name,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|_| "private child directory cannot be opened safely")?;
        validate_directory(&dir)?;
        Ok(Self {
            dir,
            display_path: self.display_path.join(name),
        })
    }

    /// Opens an existing private direct child or creates it once through this
    /// descriptor; no path component is re-resolved after the boundary opens.
    pub fn open_or_create_child(&self, name: &str) -> Result<Self, &'static str> {
        validate_component(name)?;
        match fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(stat) => {
                validate_directory_stat(&stat)?;
                self.open_child(name)
            }
            Err(Errno::ENOENT) => self.create_child(name),
            Err(_) => Err("private child directory cannot be inspected"),
        }
    }

    /// Creates a private direct child once, then reopens it through the held
    /// descriptor. Existing children are intentionally rejected.
    pub fn create_child(&self, name: &str) -> Result<Self, &'static str> {
        validate_component(name)?;
        mkdirat(
            &self.dir,
            name,
            Mode::from_bits_truncate(PRIVATE_DIRECTORY_MODE),
        )
        .map_err(|_| "private directory cannot be created")?;
        self.open_child(name)
    }

    /// Produces a stable descriptor-backed pathname for libraries whose public
    /// APIs accept only a path. The parent is an already-held private descriptor.
    pub fn proc_path(&self, name: &str) -> Result<PathBuf, &'static str> {
        validate_component(name)?;
        Ok(PathBuf::from(format!("/proc/self/fd/{}", self.dir.as_raw_fd())).join(name))
    }

    /// Ensures a direct child is a `0600` regular file owned by this user and
    /// opens it with `O_NOFOLLOW`. Creation is `O_EXCL` to prevent replacement.
    pub fn ensure_file(&self, name: &str) -> Result<File, &'static str> {
        validate_component(name)?;
        match fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(stat) => validate_file_stat(&stat)?,
            Err(Errno::ENOENT) => {
                let fd = openat(
                    &self.dir,
                    name,
                    OFlag::O_WRONLY
                        | OFlag::O_CLOEXEC
                        | OFlag::O_CREAT
                        | OFlag::O_EXCL
                        | OFlag::O_NOFOLLOW,
                    Mode::from_bits_truncate(PRIVATE_FILE_MODE),
                )
                .map_err(|_| "private file cannot be created")?;
                validate_file_fd(&fd)?;
                return Ok(File::from(fd));
            }
            Err(_) => return Err("private file cannot be inspected"),
        }
        let fd = openat(
            &self.dir,
            name,
            OFlag::O_RDWR | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|_| "private file cannot be opened safely")?;
        validate_file_fd(&fd)?;
        Ok(File::from(fd))
    }

    /// Reads a direct, private regular file without a pathname re-resolution.
    pub fn read_file(&self, name: &str) -> Result<Vec<u8>, &'static str> {
        validate_component(name)?;
        let fd = openat(
            &self.dir,
            name,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|_| "private file cannot be opened safely")?;
        validate_file_fd(&fd)?;
        let mut file = File::from(fd);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|_| "private file cannot be read")?;
        Ok(bytes)
    }

    /// Removes one validated regular file through this descriptor.
    pub fn remove_file(&self, name: &str) -> Result<(), &'static str> {
        validate_component(name)?;
        let stat = fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW)
            .map_err(|_| "private file cannot be inspected")?;
        validate_file_stat(&stat)?;
        unlinkat(&self.dir, name, UnlinkatFlags::NoRemoveDir)
            .map_err(|_| "private file cannot be removed")
    }

    /// Captures an owner-private Unix socket's stable directory-entry identity.
    /// A caller can later require this exact identity before unlinking, so an
    /// observation cannot authorize deletion of a replacement listener.
    pub(crate) fn socket_identity_if_present(
        &self,
        name: &str,
    ) -> Result<Option<SocketIdentity>, &'static str> {
        validate_component(name)?;
        match fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(stat) => {
                validate_socket_stat(&stat)?;
                Ok(Some(SocketIdentity {
                    device: stat.st_dev,
                    inode: stat.st_ino,
                }))
            }
            Err(Errno::ENOENT) => Ok(None),
            Err(_) => Err("private socket cannot be inspected"),
        }
    }

    /// Removes a direct child only when it remains the exact owner-private Unix
    /// socket observed earlier. A missing or replaced entry fails closed without
    /// unlinking it; unsafe replacements are rejected by validation.
    pub(crate) fn remove_socket_if_identity(
        &self,
        name: &str,
        expected: SocketIdentity,
    ) -> Result<bool, &'static str> {
        validate_component(name)?;
        match fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(stat) => {
                validate_socket_stat(&stat)?;
                let observed = SocketIdentity {
                    device: stat.st_dev,
                    inode: stat.st_ino,
                };
                if observed != expected {
                    return Ok(false);
                }
                unlinkat(&self.dir, name, UnlinkatFlags::NoRemoveDir)
                    .map(|_| true)
                    .map_err(|_| "private socket cannot be removed")
            }
            Err(Errno::ENOENT) => Ok(false),
            Err(_) => Err("private socket cannot be inspected"),
        }
    }

    /// Checks a direct child if it exists, rejecting every non-socket or unsafe
    /// socket entry without following a pathname component.
    pub fn verify_socket_if_present(&self, name: &str) -> Result<bool, &'static str> {
        Ok(self.socket_identity_if_present(name)?.is_some())
    }

    /// Checks the just-bound descriptor-relative socket before it is exposed.
    pub fn verify_socket(&self, name: &str) -> Result<(), &'static str> {
        validate_component(name)?;
        let stat = fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW)
            .map_err(|_| "private socket cannot be inspected")?;
        validate_socket_stat(&stat)
    }

    /// Returns whether this held private directory has no direct children. This
    /// is used before first scanner trust-root persistence: an existing state
    /// directory must never be silently re-anchored with a new configuration.
    pub fn is_empty(&self) -> Result<bool, &'static str> {
        let fd = openat(
            &self.dir,
            ".",
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|_| "private directory cannot be opened safely")?;
        validate_directory(&fd)?;
        let mut cursor =
            Dir::from_fd(fd).map_err(|_| "private directory cannot be opened safely")?;
        for entry in cursor.iter() {
            let entry = entry.map_err(|_| "private directory cannot be read")?;
            let name = entry.file_name();
            if name.to_bytes() != b"." && name.to_bytes() != b".." {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Lists only validated `0600` regular-file names from this held directory.
    pub fn file_names(&self) -> Result<Vec<OsString>, &'static str> {
        let fd = openat(
            &self.dir,
            ".",
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|_| "private directory cannot be opened safely")?;
        validate_directory(&fd)?;
        let mut cursor =
            Dir::from_fd(fd).map_err(|_| "private directory cannot be opened safely")?;
        let mut names = Vec::new();
        for entry in cursor.iter() {
            let entry = entry.map_err(|_| "private directory cannot be read")?;
            let name = entry.file_name();
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let name = name.to_str().map_err(|_| "private file name is invalid")?;
            validate_component(name)?;
            let stat = fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW)
                .map_err(|_| "private file cannot be inspected")?;
            validate_file_stat(&stat)?;
            names.push(OsString::from(name));
        }
        Ok(names)
    }

    /// Atomically replaces a direct `0600` file using a `create_new` temporary
    /// and `renameat` inside the same held directory descriptor.
    pub fn write_file_atomic(&self, name: &str, bytes: &[u8]) -> Result<(), &'static str> {
        validate_component(name)?;
        match fstatat(&self.dir, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
            Ok(stat) => validate_file_stat(&stat)?,
            Err(Errno::ENOENT) => {}
            Err(_) => return Err("private file cannot be inspected"),
        }
        let temporary = format!(".{name}.{}.new", std::process::id());
        let fd = openat(
            &self.dir,
            temporary.as_str(),
            OFlag::O_WRONLY | OFlag::O_CLOEXEC | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW,
            Mode::from_bits_truncate(PRIVATE_FILE_MODE),
        )
        .map_err(|_| "private file replacement cannot be created")?;
        if validate_file_fd(&fd).is_err() {
            let _ = unlinkat(&self.dir, temporary.as_str(), UnlinkatFlags::NoRemoveDir);
            return Err("private file replacement is unsafe");
        }
        let mut file = File::from(fd);
        if file.write_all(bytes).is_err() || file.sync_all().is_err() {
            let _ = unlinkat(&self.dir, temporary.as_str(), UnlinkatFlags::NoRemoveDir);
            return Err("private file cannot be written");
        }
        drop(file);
        renameat(&self.dir, temporary.as_str(), &self.dir, name)
            .map_err(|_| "private file cannot be finalized")?;
        Ok(())
    }

    /// Ensures no caller can treat the descriptor as an unvalidated path.
    pub fn verify(&self) -> Result<(), &'static str> {
        validate_directory(&self.dir)
    }
}

/// Opens the private parent directory and extracts a safe final filename.
pub fn private_parent(path: &Path) -> Result<(PrivateDir, OsString), &'static str> {
    let parent = path
        .parent()
        .ok_or("private file has no parent directory")?;
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or("private file name is invalid")?
        .to_os_string();
    let name_text = name.to_str().ok_or("private file name is invalid")?;
    validate_component(name_text)?;
    Ok((PrivateDir::open(parent)?, name))
}

fn validate_component(name: &str) -> Result<(), &'static str> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) if name != "." && name != ".." => Ok(()),
        _ => Err("private path component is invalid"),
    }
}

fn validate_directory<Fd: AsFd>(directory: Fd) -> Result<(), &'static str> {
    let stat = fstat(directory).map_err(|_| "private directory cannot be inspected")?;
    validate_directory_stat(&stat)
}

fn validate_directory_stat(stat: &nix::sys::stat::FileStat) -> Result<(), &'static str> {
    let mode = stat.st_mode;
    if mode & nix::libc::S_IFMT != nix::libc::S_IFDIR
        || stat.st_uid != geteuid().as_raw()
        || mode & 0o777 != PRIVATE_DIRECTORY_MODE
    {
        return Err("private directory boundary is unsafe");
    }
    Ok(())
}

fn validate_file_fd(fd: &OwnedFd) -> Result<(), &'static str> {
    let stat = fstat(fd).map_err(|_| "private file cannot be inspected")?;
    validate_file_stat(&stat)
}

fn validate_file_stat(stat: &nix::sys::stat::FileStat) -> Result<(), &'static str> {
    let mode = stat.st_mode;
    if mode & nix::libc::S_IFMT != nix::libc::S_IFREG
        || stat.st_uid != geteuid().as_raw()
        || mode & 0o777 != PRIVATE_FILE_MODE
    {
        return Err("private file boundary is unsafe");
    }
    Ok(())
}

fn validate_socket_stat(stat: &nix::sys::stat::FileStat) -> Result<(), &'static str> {
    let mode = stat.st_mode;
    if mode & nix::libc::S_IFMT != nix::libc::S_IFSOCK
        || stat.st_uid != geteuid().as_raw()
        || mode & 0o777 != PRIVATE_FILE_MODE
    {
        return Err("private socket boundary is unsafe");
    }
    Ok(())
}
