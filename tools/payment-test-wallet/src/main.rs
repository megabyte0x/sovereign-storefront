//! Disposable UFVK provisioning for the local Task 1 qualification only.
//!
//! This process owns a one-use seed long enough to derive a viewing key. It neither
//! accepts nor reads existing wallet material, and it writes no file other than the
//! scanner configuration containing the derived UFVK and birthday.

use std::{
    env,
    ffi::OsString,
    fs::File,
    io::Write,
    os::fd::OwnedFd,
    path::{Path, PathBuf},
    process::ExitCode,
};

use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::{Mode, fstat},
    unistd::{UnlinkatFlags, geteuid, unlinkat},
};
use serde::Serialize;
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork};
use zeroize::Zeroizing;
use zip32::AccountId;

#[derive(Serialize)]
struct ScannerConfig {
    ufvk: String,
    birthday: u32,
}

struct ProvisioningRequest {
    config: PathBuf,
    birthday: u32,
    params: LocalNetwork,
}

fn take_u32(arguments: &mut impl Iterator<Item = String>) -> Option<u32> {
    arguments.next()?.parse().ok()
}

fn take_height(arguments: &mut impl Iterator<Item = String>) -> Option<Option<u32>> {
    match arguments.next()?.as_str() {
        "none" => Some(None),
        value => value.parse().ok().map(Some),
    }
}

fn parse_request() -> Option<ProvisioningRequest> {
    let mut arguments = env::args().skip(1);
    let mut config = None;
    let mut birthday = None;
    let mut overwinter = None;
    let mut sapling = None;
    let mut blossom = None;
    let mut heartwood = None;
    let mut canopy = None;
    let mut nu5 = None;
    let mut nu6 = None;
    let mut nu6_1 = None;
    let mut nu6_2 = None;
    let mut nu6_3 = None;

    while let Some(flag) = arguments.next() {
        match flag.as_str() {
            "--config" if config.is_none() => config = arguments.next().map(PathBuf::from),
            "--birthday" if birthday.is_none() => birthday = take_u32(&mut arguments),
            "--overwinter" if overwinter.is_none() => overwinter = take_height(&mut arguments),
            "--sapling" if sapling.is_none() => sapling = take_height(&mut arguments),
            "--blossom" if blossom.is_none() => blossom = take_height(&mut arguments),
            "--heartwood" if heartwood.is_none() => heartwood = take_height(&mut arguments),
            "--canopy" if canopy.is_none() => canopy = take_height(&mut arguments),
            "--nu5" if nu5.is_none() => nu5 = take_height(&mut arguments),
            "--nu6" if nu6.is_none() => nu6 = take_height(&mut arguments),
            "--nu6-1" if nu6_1.is_none() => nu6_1 = take_height(&mut arguments),
            "--nu6-2" if nu6_2.is_none() => nu6_2 = take_height(&mut arguments),
            "--nu6-3" if nu6_3.is_none() => nu6_3 = take_height(&mut arguments),
            _ => return None,
        }
    }

    Some(ProvisioningRequest {
        config: config?,
        birthday: birthday?,
        params: LocalNetwork {
            overwinter: overwinter?.map(BlockHeight::from_u32),
            sapling: sapling?.map(BlockHeight::from_u32),
            blossom: blossom?.map(BlockHeight::from_u32),
            heartwood: heartwood?.map(BlockHeight::from_u32),
            canopy: canopy?.map(BlockHeight::from_u32),
            nu5: nu5?.map(BlockHeight::from_u32),
            nu6: nu6?.map(BlockHeight::from_u32),
            nu6_1: nu6_1?.map(BlockHeight::from_u32),
            nu6_2: nu6_2?.map(BlockHeight::from_u32),
            nu6_3: nu6_3?.map(BlockHeight::from_u32),
        },
    })
}

fn private_runtime_parent(config: &Path) -> Option<(OwnedFd, OsString)> {
    let parent = config.parent()?;
    let name = config.file_name()?.to_os_string();
    let directory = open(
        parent,
        OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .ok()?;
    let metadata = fstat(&directory).ok()?;
    let mode = metadata.st_mode as u32;
    let is_private_owner_directory = (mode & nix::libc::S_IFMT) == nix::libc::S_IFDIR
        && metadata.st_uid == geteuid().as_raw()
        && (mode & 0o777) == 0o700;
    if is_private_owner_directory {
        Some((directory, name))
    } else {
        None
    }
}

fn derive_ufvk(params: &LocalNetwork) -> Option<String> {
    let mut seed = Zeroizing::new([0_u8; 32]);
    if getrandom::fill(seed.as_mut()).is_err() {
        return None;
    }

    let ufvk = UnifiedSpendingKey::from_seed(params, &seed[..], AccountId::ZERO)
        .ok()
        .map(|spending_key| spending_key.to_unified_full_viewing_key());
    drop(seed);

    ufvk.map(|viewing_key| viewing_key.encode(params))
}

fn write_config(request: ProvisioningRequest) -> bool {
    let Some((parent, name)) = private_runtime_parent(&request.config) else {
        return false;
    };

    let Some(ufvk) = derive_ufvk(&request.params) else {
        return false;
    };
    let config = ScannerConfig {
        ufvk,
        birthday: request.birthday,
    };
    let Ok(encoded) = serde_json::to_vec(&config) else {
        return false;
    };

    let Ok(file) = openat(
        &parent,
        name.as_os_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::from_bits_truncate(0o600),
    ) else {
        return false;
    };
    let valid_new_file = fstat(&file)
        .map(|metadata| {
            let mode = metadata.st_mode as u32;
            (mode & nix::libc::S_IFMT) == nix::libc::S_IFREG
                && metadata.st_uid == geteuid().as_raw()
                && (mode & 0o777) == 0o600
        })
        .unwrap_or(false);
    if !valid_new_file {
        let _ = unlinkat(&parent, name.as_os_str(), UnlinkatFlags::NoRemoveDir);
        return false;
    }
    let mut file = File::from(file);
    if file.write_all(&encoded).is_err()
        || file.write_all(b"\n").is_err()
        || file.sync_all().is_err()
    {
        drop(file);
        let _ = unlinkat(&parent, name.as_os_str(), UnlinkatFlags::NoRemoveDir);
        return false;
    }

    true
}

fn main() -> ExitCode {
    let Some(request) = parse_request() else {
        return ExitCode::FAILURE;
    };
    if !write_config(request) {
        return ExitCode::FAILURE;
    }

    // This is intentionally the complete success output: it contains no key,
    // address, URI, memo, seed, network endpoint, or runtime-file contents.
    println!("provisioned");
    ExitCode::SUCCESS
}
