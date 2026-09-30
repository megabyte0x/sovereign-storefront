use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            ffi::OsStrExt,
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
    },
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

use crate::{
    allocate::{AllocationDeriver, AllocationJournal, AllocationRequest, ChainIdentity},
    lease::WriterLease,
    private_fs::PrivateDir,
    snapshot::SnapshotStore,
};

#[cfg(test)]
use crate::allocate::ReceiverDerivation;

const MAX_BODY_BYTES: usize = 65_536;
const MAX_REJECTED_BODY_DRAIN_BYTES: usize = MAX_BODY_BYTES + 1;
const MAX_HEADER_BYTES: usize = 8_192;
const MAX_REQUEST_BYTES: usize = MAX_BODY_BYTES + MAX_HEADER_BYTES;
const CONNECTION_WORKERS: usize = 4;
const CONNECTION_QUEUE: usize = CONNECTION_WORKERS * 2;
const SOCKET_PROBE_TIMEOUT_MS: i32 = 250;

pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
}
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn get(path: &str) -> Self {
        Self {
            method: "GET".to_owned(),
            path: path.to_owned(),
            body: Vec::new(),
        }
    }
    pub fn post(path: &str, body: Vec<u8>) -> Self {
        Self {
            method: "POST".to_owned(),
            path: path.to_owned(),
            body,
        }
    }
}

#[derive(Clone)]
pub struct ApiService {
    snapshots: Arc<SnapshotStore>,
    lifecycle: Option<Arc<LifecycleApi>>,
}

struct LifecycleApi {
    /// The production service owns the exact non-blocking lifecycle lease that
    /// was acquired before its wallet and scanner journal were opened.
    _writer_lease: WriterLease,
    allocations: Arc<AllocationJournal>,
    chain: ChainIdentity,
    account_id: String,
    deriver: Arc<dyn AllocationDeriver>,
    allocation_gate: Mutex<()>,
    /// Test-only, per-service crash seam. It is deliberately owned by this
    /// lifecycle instance, never global, so parallel scanner tests cannot
    /// alter another service's allocation behavior.
    #[cfg(test)]
    post_wallet_exposure_hook: Mutex<Option<Box<dyn FnOnce(&ReceiverDerivation) + Send>>>,
}

impl ApiService {
    /// Gives the crate-owned daemon lifecycle the same durable snapshot store
    /// that the socket reads. This is intentionally not public: external
    /// callers still cannot publish, invalidate, or open snapshots.
    pub(crate) fn shared_snapshot_store(&self) -> Arc<SnapshotStore> {
        Arc::clone(&self.snapshots)
    }

    /// Exposes only read-only snapshot handling. It cannot reserve a wallet
    /// address, mutate an allocation journal, or bind a Unix socket.
    #[cfg(test)]
    pub(crate) fn new(snapshots: SnapshotStore) -> Self {
        Self {
            snapshots: Arc::new(snapshots),
            lifecycle: None,
        }
    }

    /// Creates the production service only from an already-acquired lifecycle
    /// writer lease. This is crate-internal so external callers cannot combine a
    /// wallet deriver and a direct bind path outside `PersistentScanner`.
    pub(crate) fn with_deriver(
        writer_lease: WriterLease,
        allocations: AllocationJournal,
        snapshots: SnapshotStore,
        chain: ChainIdentity,
        account_id: &str,
        deriver: Arc<dyn AllocationDeriver>,
    ) -> Self {
        Self {
            snapshots: Arc::new(snapshots),
            lifecycle: Some(Arc::new(LifecycleApi {
                _writer_lease: writer_lease,
                allocations: Arc::new(allocations),
                chain,
                account_id: account_id.to_owned(),
                deriver,
                allocation_gate: Mutex::new(()),
                #[cfg(test)]
                post_wallet_exposure_hook: Mutex::new(None),
            })),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_deriver_and_post_wallet_exposure_hook(
        writer_lease: WriterLease,
        allocations: AllocationJournal,
        snapshots: SnapshotStore,
        chain: ChainIdentity,
        account_id: &str,
        deriver: Arc<dyn AllocationDeriver>,
        hook: impl FnOnce(&ReceiverDerivation) + Send + 'static,
    ) -> Self {
        Self {
            snapshots: Arc::new(snapshots),
            lifecycle: Some(Arc::new(LifecycleApi {
                _writer_lease: writer_lease,
                allocations: Arc::new(allocations),
                chain,
                account_id: account_id.to_owned(),
                deriver,
                allocation_gate: Mutex::new(()),
                post_wallet_exposure_hook: Mutex::new(Some(Box::new(hook))),
            })),
        }
    }
    pub fn validate_socket_bind(value: &str) -> Result<(), &'static str> {
        if value.starts_with('/') {
            Ok(())
        } else {
            Err("scanner API only supports Unix socket paths")
        }
    }
    pub fn handle(&self, request: HttpRequest) -> Result<HttpResponse, &'static str> {
        if request.body.len() > MAX_BODY_BYTES {
            return Ok(response(413, br#"{"error":"request_too_large"}"#.to_vec()));
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/snapshot") => match self.snapshots.current() {
                Ok(snapshot) => json(200, &snapshot),
                Err(_) => Ok(response(503, br#"{"error":"unavailable"}"#.to_vec())),
            },
            ("POST", "/v1/allocations") => {
                let Some(lifecycle) = &self.lifecycle else {
                    return Ok(response(503, br#"{"error":"unavailable"}"#.to_vec()));
                };
                let allocation: AllocationRequest = serde_json::from_slice(&request.body)
                    .map_err(|_| "allocation request is malformed")?;
                if allocation.chain != lifecycle.chain
                    || allocation.account_id != lifecycle.account_id
                {
                    return Ok(response(403, br#"{"error":"identity_mismatch"}"#.to_vec()));
                }
                let _gate = lifecycle
                    .allocation_gate
                    .lock()
                    .map_err(|_| "scanner allocation mutex poisoned")?;
                if let Some(finalized) = lifecycle.allocations.finalized(&allocation)? {
                    return json(200, &finalized);
                }
                let mut reserved = lifecycle.allocations.reserve(allocation)?;
                loop {
                    match lifecycle.deriver.derive(&reserved) {
                        Ok(derived) => {
                            #[cfg(test)]
                            if let Some(hook) = lifecycle
                                .post_wallet_exposure_hook
                                .lock()
                                .map_err(|_| "scanner allocation mutex poisoned")?
                                .take()
                            {
                                hook(&derived);
                            }
                            let allocation = lifecycle.allocations.finalize(&reserved, derived)?;
                            return json(200, &allocation);
                        }
                        // `get_address_for_index` returned `None`: no address was
                        // exposed, so the journal may durably burn a successor.
                        Err("wallet address derivation has no receiver") => {
                            reserved = lifecycle.allocations.advance_candidate(&reserved)?;
                        }
                        // Operational wallet failures retain the pending index;
                        // the caller gets unavailable and retries that exact index.
                        Err(_) => {
                            return Ok(response(503, br#"{"error":"unavailable"}"#.to_vec()));
                        }
                    }
                }
            }
            _ => Ok(response(404, br#"{"error":"not_found"}"#.to_vec())),
        }
    }

    /// Binds beneath an already-held owner-private directory descriptor. It
    /// removes only a verified stale socket, never an arbitrary path entry.
    /// It is unavailable to read-only public services and external callers.
    pub(crate) fn serve_in(
        &self,
        parent: &PrivateDir,
        socket_name: &str,
    ) -> Result<(), &'static str> {
        if self.lifecycle.is_none() {
            return Err("scanner socket binding requires a lifecycle writer lease");
        }
        let socket_path = parent
            .proc_path(socket_name)
            .map_err(|_| "scanner socket path is invalid")?;
        Self::validate_socket_bind(
            socket_path
                .to_str()
                .ok_or("scanner socket path is invalid")?,
        )?;
        recover_stale_socket(parent, socket_name)?;
        let listener =
            UnixListener::bind(&socket_path).map_err(|_| "scanner socket cannot bind")?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "scanner socket permissions are unsafe")?;
        parent
            .verify_socket(socket_name)
            .map_err(|_| "scanner socket permissions are unsafe")?;
        let identity = parent
            .socket_identity_if_present(socket_name)
            .map_err(|_| "scanner socket permissions are unsafe")?
            .ok_or("scanner socket disappeared before it could bind")?;
        let _cleanup = BoundSocket {
            parent,
            socket_name,
            identity,
        };

        let (sender, receiver) = mpsc::sync_channel::<UnixStream>(CONNECTION_QUEUE);
        let receiver = Arc::new(Mutex::new(receiver));
        for worker in 0..CONNECTION_WORKERS {
            let service = self.clone();
            let receiver = Arc::clone(&receiver);
            thread::Builder::new()
                .name(format!("scanner-socket-{worker}"))
                .spawn(move || {
                    loop {
                        let stream = {
                            let receiver = match receiver.lock() {
                                Ok(receiver) => receiver,
                                Err(_) => return,
                            };
                            match receiver.recv() {
                                Ok(stream) => stream,
                                Err(_) => return,
                            }
                        };
                        // Parse/read/timeout/write faults belong solely to this
                        // worker's connection; the bounded dispatcher continues.
                        let _ = service.serve_connection(stream);
                    }
                })
                .map_err(|_| "scanner socket workers cannot start")?;
        }

        loop {
            match listener.accept() {
                Ok((stream, _)) => match sender.try_send(stream) {
                    Ok(()) | Err(mpsc::TrySendError::Full(_)) => {}
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        return Err("scanner socket workers are unavailable");
                    }
                },
                Err(_) => continue,
            }
        }
    }

    fn serve_connection(&self, mut stream: UnixStream) -> Result<(), &'static str> {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| "scanner socket timeout cannot set")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| "scanner socket timeout cannot set")?;
        let reply = match read_http_request(&mut stream) {
            Ok(request) => self
                .handle(request)
                .unwrap_or_else(|_| response(400, br#"{"error":"request_malformed"}"#.to_vec())),
            // A peer that times out or disconnects while framing a request is
            // silently isolated. No request was complete enough to respond to.
            Err("scanner socket read failed") => return Ok(()),
            Err(error) => response(
                request_error_status(error),
                br#"{"error":"request_malformed"}"#.to_vec(),
            ),
        };
        stream
            .write_all(&serialize_http_response(&reply))
            .map_err(|_| "scanner socket write failed")?;
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SocketProbe {
    LiveOrUnknown,
    Stale,
}

/// Performs a descriptor-rooted, nonblocking Unix-socket liveness probe. Only
/// an observed `ECONNREFUSED` is definitive enough to unlink; success, timeout,
/// and every other outcome preserve the private socket entry.
fn recover_stale_socket(parent: &PrivateDir, socket_name: &str) -> Result<(), &'static str> {
    recover_stale_socket_after_probe(parent, socket_name, probe_socket, || {})
}

fn recover_stale_socket_after_probe<P, F>(
    parent: &PrivateDir,
    socket_name: &str,
    probe: P,
    after_probe: F,
) -> Result<(), &'static str>
where
    P: FnOnce(&Path) -> SocketProbe,
    F: FnOnce(),
{
    let Some(identity) = parent
        .socket_identity_if_present(socket_name)
        .map_err(|_| "scanner stale socket is unsafe")?
    else {
        return Ok(());
    };
    let socket_path = parent
        .proc_path(socket_name)
        .map_err(|_| "scanner socket path is invalid")?;
    match probe(&socket_path) {
        SocketProbe::Stale => {
            after_probe();
            match parent
                .remove_socket_if_identity(socket_name, &identity)
                .map_err(|_| "scanner stale socket is unsafe")?
            {
                true => Ok(()),
                false => Err("scanner stale socket changed during recovery"),
            }
        }
        SocketProbe::LiveOrUnknown => Err("scanner socket is live or liveness is unavailable"),
    }
}

/// Test-only seam: simulate a completed stale liveness observation, then allow
/// the test to replace the observed entry before identity-checked removal.
#[cfg(test)]
fn recover_stale_socket_after_stale_observation<F>(
    parent: &PrivateDir,
    socket_name: &str,
    after_probe: F,
) -> Result<(), &'static str>
where
    F: FnOnce(),
{
    recover_stale_socket_after_probe(parent, socket_name, |_| SocketProbe::Stale, after_probe)
}

fn probe_socket(path: &Path) -> SocketProbe {
    let path = path.as_os_str().as_bytes();
    let max_path = std::mem::size_of::<nix::libc::sockaddr_un>()
        - std::mem::size_of::<nix::libc::sa_family_t>();
    if path.is_empty() || path.len() + 1 > max_path {
        return SocketProbe::LiveOrUnknown;
    }
    // SAFETY: AF_UNIX/SOCK_STREAM creates only a local, nonblocking probe fd.
    let raw = unsafe {
        nix::libc::socket(
            nix::libc::AF_UNIX,
            nix::libc::SOCK_STREAM | nix::libc::SOCK_NONBLOCK | nix::libc::SOCK_CLOEXEC,
            0,
        )
    };
    if raw < 0 {
        return SocketProbe::LiveOrUnknown;
    }
    // SAFETY: `socket` returned a unique owned non-negative descriptor above.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: zero is a valid initial representation for sockaddr_un before we
    // set the family and NUL-terminated pathname below.
    let mut address: nix::libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = nix::libc::AF_UNIX as nix::libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(path) {
        *slot = *byte as nix::libc::c_char;
    }
    let address_length =
        (std::mem::size_of::<nix::libc::sa_family_t>() + path.len() + 1) as nix::libc::socklen_t;
    // SAFETY: `address` is initialized as a pathname sockaddr_un and its exact
    // encoded length is supplied. The fd remains owned for the full call.
    let connected = unsafe {
        nix::libc::connect(
            fd.as_raw_fd(),
            (&raw const address).cast::<nix::libc::sockaddr>(),
            address_length,
        )
    };
    if connected == 0 {
        return SocketProbe::LiveOrUnknown;
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(nix::libc::ECONNREFUSED) {
        return SocketProbe::Stale;
    }
    if !matches!(
        error.raw_os_error(),
        Some(nix::libc::EINPROGRESS | nix::libc::EAGAIN)
    ) {
        return SocketProbe::LiveOrUnknown;
    }
    let mut ready = nix::libc::pollfd {
        fd: fd.as_raw_fd(),
        events: nix::libc::POLLOUT,
        revents: 0,
    };
    // SAFETY: `ready` points to one initialized pollfd and the timeout bounds
    // startup liveness probing even when an endpoint is overloaded.
    if unsafe { nix::libc::poll(&mut ready, 1, SOCKET_PROBE_TIMEOUT_MS) } != 1 {
        return SocketProbe::LiveOrUnknown;
    }
    let mut socket_error: nix::libc::c_int = 0;
    let mut socket_error_length = std::mem::size_of_val(&socket_error) as nix::libc::socklen_t;
    // SAFETY: all pointers reference initialized writable local values sized
    // exactly for SO_ERROR, and the probe fd remains valid.
    let status = unsafe {
        nix::libc::getsockopt(
            fd.as_raw_fd(),
            nix::libc::SOL_SOCKET,
            nix::libc::SO_ERROR,
            (&mut socket_error as *mut nix::libc::c_int).cast::<nix::libc::c_void>(),
            &mut socket_error_length,
        )
    };
    if status == 0 && socket_error == nix::libc::ECONNREFUSED {
        SocketProbe::Stale
    } else {
        SocketProbe::LiveOrUnknown
    }
}

struct BoundSocket<'a> {
    parent: &'a PrivateDir,
    socket_name: &'a str,
    identity: crate::private_fs::SocketIdentity,
}

impl Drop for BoundSocket<'_> {
    fn drop(&mut self) {
        let _ = self
            .parent
            .remove_socket_if_identity(self.socket_name, &self.identity);
    }
}

/// Reads a single HTTP/1.1 request incrementally: first a bounded header, then
/// exactly the declared bounded body. It intentionally never waits for EOF;
/// clients may keep their write side open while waiting for the response.
fn read_http_request(stream: &mut UnixStream) -> Result<HttpRequest, &'static str> {
    let mut bytes = Vec::with_capacity(MAX_REQUEST_BYTES);
    let mut chunk = [0_u8; 1024];
    let header_end = loop {
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        if bytes.len() >= MAX_HEADER_BYTES {
            return Err("scanner request is too large");
        }
        let maximum = (MAX_HEADER_BYTES - bytes.len()).min(chunk.len());
        let read = stream
            .read(&mut chunk[..maximum])
            .map_err(|_| "scanner socket read failed")?;
        if read == 0 {
            return Err("scanner request is malformed");
        }
        bytes.extend_from_slice(&chunk[..read]);
    };
    let (_, _, content_length) = parse_http_head(&bytes[..header_end])?;
    if content_length > MAX_BODY_BYTES {
        discard_rejected_body(
            stream,
            content_length.saturating_sub(bytes.len().saturating_sub(header_end)),
        )?;
        return Err("scanner request is too large");
    }
    let expected_length = header_end
        .checked_add(content_length)
        .ok_or("scanner request is too large")?;
    if expected_length > MAX_REQUEST_BYTES || bytes.len() > expected_length {
        return Err("scanner request is malformed");
    }
    while bytes.len() < expected_length {
        let remaining = expected_length - bytes.len();
        let maximum = remaining.min(chunk.len());
        let read = stream
            .read(&mut chunk[..maximum])
            .map_err(|_| "scanner socket read failed")?;
        if read == 0 {
            return Err("scanner request is malformed");
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    parse_http(&bytes)
}

/// Drains only a fixed maximum of an oversized request so a complete local
/// client can receive its framed 413 response without allowing unbounded memory
/// or read work for an attacker-controlled Content-Length.
fn discard_rejected_body(stream: &mut UnixStream, remaining: usize) -> Result<(), &'static str> {
    let mut remaining = remaining.min(MAX_REJECTED_BODY_DRAIN_BYTES);
    let mut chunk = [0_u8; 1024];
    while remaining > 0 {
        let maximum = remaining.min(chunk.len());
        let read = stream
            .read(&mut chunk[..maximum])
            .map_err(|_| "scanner socket read failed")?;
        if read == 0 {
            break;
        }
        remaining -= read;
    }
    Ok(())
}

fn parse_http(bytes: &[u8]) -> Result<HttpRequest, &'static str> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("scanner request is too large");
    }
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("scanner request is malformed")?
        + 4;
    let (method, path, content_length) = parse_http_head(&bytes[..header_end])?;
    let body = &bytes[header_end..];
    if content_length != body.len() {
        return Err("scanner request is malformed");
    }
    Ok(HttpRequest {
        method,
        path,
        body: body.to_vec(),
    })
}

fn parse_http_head(head: &[u8]) -> Result<(String, String, usize), &'static str> {
    if head.len() > MAX_HEADER_BYTES {
        return Err("scanner request is too large");
    }
    let head = std::str::from_utf8(head).map_err(|_| "scanner request is malformed")?;
    let mut lines = head.split("\r\n");
    let line = lines.next().ok_or("scanner request is malformed")?;
    let mut fields = line.split_ascii_whitespace();
    let method = fields.next().ok_or("scanner request is malformed")?;
    let path = fields.next().ok_or("scanner request is malformed")?;
    if fields.next() != Some("HTTP/1.1") || fields.next().is_some() {
        return Err("scanner request is malformed");
    }
    let mut content_length = None;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or("scanner request is malformed")?;
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some()
                || value.trim().is_empty()
                || !value.trim().bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err("scanner request is malformed");
            }
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "scanner request is malformed")?,
            );
        }
    }
    Ok((
        method.to_owned(),
        path.to_owned(),
        content_length.ok_or("scanner request is malformed")?,
    ))
}

fn request_error_status(error: &str) -> u16 {
    if error == "scanner request is too large" {
        413
    } else {
        400
    }
}

fn serialize_http_response(response: &HttpResponse) -> Vec<u8> {
    let status = match response.status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let mut encoded = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        status,
        response.body.len(),
    )
    .into_bytes();
    encoded.extend_from_slice(&response.body);
    encoded
}

fn json<T: serde::Serialize>(status: u16, value: &T) -> Result<HttpResponse, &'static str> {
    Ok(response(
        status,
        serde_json::to_vec(value).map_err(|_| "scanner response cannot encode")?,
    ))
}
fn response(status: u16, body: Vec<u8>) -> HttpResponse {
    HttpResponse { status, body }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use super::{
        ApiService, HttpRequest, recover_stale_socket, recover_stale_socket_after_stale_observation,
    };
    use crate::{
        lease::WriterLease,
        private_fs::PrivateDir,
        projection::Receipt,
        snapshot::{Revision, Snapshot, SnapshotStore},
    };

    #[test]
    fn external_crate_cannot_access_unleased_mutation_or_socket_binding() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let fixture = std::env::temp_dir().join(format!("scanner-public-api-{nonce}"));
        fs::create_dir(&fixture).expect("create external-crate fixture");
        fs::write(
            fixture.join("Cargo.toml"),
            format!(
                "[package]\nname = \"scanner-public-api-fixture\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[dependencies]\nsovereign-storefront-scanner = {{ path = \"{}\" }}\n",
                env!("CARGO_MANIFEST_DIR")
            ),
        )
        .expect("write external-crate manifest");
        fs::create_dir(fixture.join("src")).expect("create external-crate source directory");
        fs::write(
            fixture.join("src/main.rs"),
            "use sovereign_storefront_scanner::api::ApiService;\n\nfn main() {\n    let _ = ApiService::with_deriver;\n    let _ = ApiService::serve;\n}\n",
        )
        .expect("write unleased production API probe");

        let result = Command::new("cargo")
            .args(["check", "--offline", "--quiet"])
            .current_dir(&fixture)
            .output()
            .expect("compile external-crate API probe");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success(),
            "an external crate compiled unleased mutation/binding access: {stderr}"
        );
        fs::remove_dir_all(fixture).expect("remove external-crate fixture");
    }

    #[test]
    fn external_crate_cannot_construct_or_mutate_snapshot_store() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let fixture = std::env::temp_dir().join(format!("scanner-snapshot-store-api-{nonce}"));
        fs::create_dir(&fixture).expect("create external-crate fixture");
        fs::write(
            fixture.join("Cargo.toml"),
            format!(
                "[package]\nname = \"scanner-snapshot-store-api-fixture\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[dependencies]\nsovereign-storefront-scanner = {{ path = \"{}\" }}\n",
                env!("CARGO_MANIFEST_DIR")
            ),
        )
        .expect("write external-crate manifest");
        fs::create_dir(fixture.join("src")).expect("create external-crate source directory");
        fs::write(
            fixture.join("src/main.rs"),
            "use sovereign_storefront_scanner::snapshot::SnapshotStore;\n\nfn main() {\n    let _ = SnapshotStore::open;\n    let _ = SnapshotStore::publish;\n    let _ = SnapshotStore::invalidate;\n    let _ = SnapshotStore::current;\n    let _ = SnapshotStore::read_generation;\n}\n",
        )
        .expect("write snapshot store capability probe");

        let result = Command::new("cargo")
            .args(["check", "--offline", "--quiet"])
            .current_dir(&fixture)
            .output()
            .expect("compile external-crate snapshot store probe");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success(),
            "an external crate compiled snapshot store construction/mutation access: {stderr}"
        );
        assert!(
            stderr.contains("module `snapshot` is private"),
            "external crate failed for an unexpected reason: {stderr}"
        );
        fs::remove_dir_all(fixture).expect("remove external-crate fixture");
    }

    #[test]
    fn api_accepts_only_private_routes_and_never_returns_secret_configuration() {
        let root = private_root("private-routes");
        let chain = crate::allocate::ChainIdentity::fixture();
        let snapshots = SnapshotStore::open(
            &root.join("snapshot.sqlite"),
            "scanner-a",
            chain,
            "seller-account-0",
        )
        .expect("snapshot");
        let api = ApiService::new(snapshots);

        let unknown = api
            .handle(HttpRequest::get("/v1/secret"))
            .expect("response");
        assert_eq!(unknown.status, 404);
        let remote = ApiService::validate_socket_bind("127.0.0.1:9999");
        assert_eq!(remote, Err("scanner API only supports Unix socket paths"));
        let oversized = api
            .handle(HttpRequest::post("/v1/allocations", vec![b'x'; 65_537]))
            .expect("response");
        assert_eq!(oversized.status, 413);
        let allocation = api
            .handle(HttpRequest::post("/v1/allocations", br#"{}"#.to_vec()))
            .expect("read-only response");
        assert_eq!(allocation.status, 503);

        drop(api);
        fs::remove_dir_all(root).expect("remove private API root");
    }

    #[test]
    fn external_crate_cannot_construct_unleased_wallet_or_journal_mutators() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let fixture = std::env::temp_dir().join(format!("scanner-mutator-api-{nonce}"));
        fs::create_dir(&fixture).expect("create external-crate fixture");
        fs::write(
            fixture.join("Cargo.toml"),
            format!(
                "[package]\nname = \"scanner-mutator-api-fixture\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[dependencies]\nsovereign-storefront-scanner = {{ path = \"{}\" }}\n",
                env!("CARGO_MANIFEST_DIR")
            ),
        )
        .expect("write external-crate manifest");
        fs::create_dir(fixture.join("src")).expect("create external-crate source directory");
        fs::write(
            fixture.join("src/main.rs"),
            "use sovereign_storefront_scanner::{\n    allocate::AllocationJournal,\n    lease::WriterLease,\n    wallet::WalletAllocationDeriver,\n};\n\nfn main() {\n    let _ = AllocationJournal::open;\n    let _ = WriterLease::acquire;\n    let _ = WalletAllocationDeriver::new;\n}\n",
        )
        .expect("write unleased mutator probe");

        let result = Command::new("cargo")
            .args(["check", "--offline", "--quiet"])
            .current_dir(&fixture)
            .output()
            .expect("compile external-crate mutator probe");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(
            !result.status.success(),
            "an external crate compiled unleased wallet/journal mutation access: {stderr}"
        );
        fs::remove_dir_all(fixture).expect("remove external-crate fixture");
    }

    #[test]
    fn stale_socket_recovery_preserves_active_replacement_after_liveness_probe() {
        use std::{
            os::unix::{
                fs::PermissionsExt,
                net::{UnixListener, UnixStream},
            },
            time::Duration,
        };

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("scanner-socket-race-{nonce}"));
        fs::create_dir(&root).expect("create private socket root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("protect private socket root");
        let socket = root.join("scanner.sock");
        let stale = UnixListener::bind(&socket).expect("create stale socket");
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .expect("protect stale socket");
        drop(stale);
        let parent = PrivateDir::open(&root).expect("hold private socket parent");
        let mut replacement = None;

        let result = recover_stale_socket_after_stale_observation(&parent, "scanner.sock", || {
            fs::remove_file(&socket).expect("replace observed stale socket entry");
            replacement = Some(UnixListener::bind(&socket).expect("bind active replacement"));
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
                .expect("protect active replacement");
        });

        assert_eq!(
            result,
            Err("scanner stale socket changed during recovery"),
            "recovery must fail closed after the observed entry changes"
        );
        UnixStream::connect(&socket)
            .expect("the replacement listener remains reachable after failed recovery");
        drop(replacement);
        drop(parent);
        std::thread::sleep(Duration::from_millis(1));
        fs::remove_dir_all(root).expect("remove private socket fixture");
    }

    #[test]
    fn live_socket_is_preserved_instead_of_being_removed() {
        use std::os::unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        };

        let root = private_root("live-socket");
        let socket = root.join("scanner.sock");
        let listener = UnixListener::bind(&socket).expect("bind active socket");
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .expect("protect active socket");
        let parent = PrivateDir::open(&root).expect("hold private socket parent");

        assert_eq!(
            recover_stale_socket(&parent, "scanner.sock"),
            Err("scanner socket is live or liveness is unavailable")
        );
        UnixStream::connect(&socket).expect("active socket remains reachable");

        drop(listener);
        drop(parent);
        fs::remove_dir_all(root).expect("remove private socket fixture");
    }

    #[test]
    fn stale_socket_is_removed_so_a_successor_can_bind() {
        use std::os::unix::{fs::PermissionsExt, net::UnixListener};

        let root = private_root("stale-socket");
        let socket = root.join("scanner.sock");
        let stale = UnixListener::bind(&socket).expect("create stale socket");
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .expect("protect stale socket");
        drop(stale);
        let parent = PrivateDir::open(&root).expect("hold private socket parent");

        recover_stale_socket(&parent, "scanner.sock").expect("recover observed stale socket");
        let successor = UnixListener::bind(&socket).expect("bind successor after stale recovery");
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))
            .expect("protect successor socket");

        drop(successor);
        drop(parent);
        fs::remove_dir_all(root).expect("remove private socket fixture");
    }

    #[test]
    fn unsafe_socket_entries_are_preserved_without_removal() {
        use std::os::unix::fs::PermissionsExt;

        let root = private_root("unsafe-socket-entry");
        let parent = PrivateDir::open(&root).expect("hold private socket parent");

        let directory = root.join("socket-directory");
        fs::create_dir(&directory).expect("create unsafe directory entry");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("protect unsafe directory entry");
        assert_eq!(
            recover_stale_socket(&parent, "socket-directory"),
            Err("scanner stale socket is unsafe")
        );
        assert!(
            fs::symlink_metadata(&directory)
                .expect("directory entry remains")
                .file_type()
                .is_dir()
        );

        let regular = root.join("socket-regular");
        fs::write(&regular, b"preserve").expect("create unsafe regular entry");
        fs::set_permissions(&regular, fs::Permissions::from_mode(0o600))
            .expect("protect unsafe regular entry");
        assert_eq!(
            recover_stale_socket(&parent, "socket-regular"),
            Err("scanner stale socket is unsafe")
        );
        assert_eq!(
            fs::read(&regular).expect("regular entry remains"),
            b"preserve"
        );

        let target = root.join("protected-target");
        fs::write(&target, b"preserve").expect("create protected target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).expect("protect target");
        let link = root.join("socket-link");
        std::os::unix::fs::symlink(&target, &link).expect("create unsafe socket symlink");
        assert_eq!(
            recover_stale_socket(&parent, "socket-link"),
            Err("scanner stale socket is unsafe")
        );
        assert!(
            fs::symlink_metadata(&link)
                .expect("symlink entry remains")
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read(&target).expect("protected target remains"),
            b"preserve"
        );

        drop(parent);
        fs::remove_dir_all(root).expect("remove private socket fixture");
    }

    struct DeterministicDeriver;

    impl crate::allocate::AllocationDeriver for DeterministicDeriver {
        fn derive(
            &self,
            reserved: &crate::allocate::ReservedAllocation,
        ) -> Result<crate::allocate::ReceiverDerivation, &'static str> {
            Ok(crate::allocate::ReceiverDerivation::for_index(
                &reserved.index,
            ))
        }
    }

    fn private_root(label: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("scanner-api-{label}-{nonce}"));
        fs::create_dir(&root).expect("create private root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("protect private root");
        root
    }

    fn lifecycle_api(root: &Path, ready_snapshot: bool) -> ApiService {
        use std::{fs::OpenOptions, os::unix::fs::PermissionsExt, sync::Arc};

        let chain = crate::allocate::ChainIdentity::fixture();
        let snapshots = SnapshotStore::open(
            &root.join("snapshots.sqlite"),
            "scanner",
            chain.clone(),
            "account",
        )
        .expect("open snapshots");
        if ready_snapshot {
            snapshots
                .publish(1, "b".repeat(64), Vec::new(), true, true, 1)
                .expect("publish snapshot");
        }
        let lock_path = root.join("writer.lock");
        let lock_file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("create lifecycle lease file");
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
            .expect("protect lifecycle lease file");
        ApiService::with_deriver(
            WriterLease::acquire(lock_file).expect("hold lifecycle writer lease"),
            crate::allocate::AllocationJournal::open(&root.join("scanner.sqlite"))
                .expect("open scanner journal"),
            snapshots,
            chain,
            "account",
            Arc::new(DeterministicDeriver),
        )
    }

    fn serve_lifecycle_socket(api: ApiService, root: &Path) {
        let parent = PrivateDir::open(root).expect("hold socket parent");
        std::thread::spawn(move || {
            let _ = api.serve_in(&parent, "scanner.sock");
        });
        for _ in 0..100 {
            if root.join("scanner.sock").exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("lifecycle socket did not bind");
    }

    fn insert_oversized_snapshot(path: &Path) {
        let snapshot = Snapshot {
            version: 1,
            source_id: "scanner".to_owned(),
            generation: "1".to_owned(),
            chain: crate::allocate::ChainIdentity::fixture(),
            account_id: "account".to_owned(),
            tip: Revision {
                height: 1,
                hash: "b".repeat(64),
            },
            scanned: Revision {
                height: 1,
                hash: "b".repeat(64),
            },
            checked_at: 1,
            caught_up: true,
            complete: true,
            health: "ready".to_owned(),
            receipts: vec![Receipt {
                output_id: "receipt-too-large".to_owned(),
                txid: "a".repeat(64),
                pool: "orchard".to_owned(),
                output_index: 0,
                account_id: "account".to_owned(),
                scope: "external".to_owned(),
                receiver_hex: "02".repeat(43),
                amount_zat: "1".repeat(16 * 1024 * 1024),
                first_seen_at: 1,
                mined: None,
                canonical: false,
            }],
        };
        let body = serde_json::to_vec(&snapshot).expect("encode oversized snapshot");
        assert!(body.len() > 16 * 1024 * 1024);
        rusqlite::Connection::open(path)
            .expect("open snapshot database")
            .execute(
                "INSERT INTO snapshots (generation, body) VALUES (?1, ?2)",
                rusqlite::params![1_u64, body],
            )
            .expect("seed oversized existing snapshot");
    }

    fn request(socket: &Path, bytes: &[u8]) -> Vec<u8> {
        use std::io::{Read, Write};
        use std::os::unix::net::UnixStream;

        let mut stream = UnixStream::connect(socket).expect("connect lifecycle socket");
        stream.write_all(bytes).expect("send request");
        stream
            .shutdown(std::net::Shutdown::Write)
            .expect("complete request");
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .expect("read framed response");
        response
    }

    #[test]
    fn oversized_existing_snapshot_is_unavailable_over_the_unix_socket() {
        let root = private_root("oversized-snapshot");
        let api = lifecycle_api(&root, false);
        let socket = root.join("scanner.sock");
        insert_oversized_snapshot(&root.join("snapshots.sqlite"));
        serve_lifecycle_socket(api, &root);

        let response = request(
            &socket,
            b"GET /v1/snapshot HTTP/1.1\r\nContent-Length: 0\r\n\r\n",
        );

        assert!(response.starts_with(b"HTTP/1.1 503"));
        assert!(response.len() < 16 * 1024 * 1024);
    }

    #[test]
    fn leased_lifecycle_finalizes_and_replays_a_reserved_allocation() {
        let root = private_root("allocation");
        let api = lifecycle_api(&root, false);
        let request = crate::allocate::AllocationRequest {
            allocation_id: "allocation-a".to_owned(),
            chain: crate::allocate::ChainIdentity::fixture(),
            account_id: "account".to_owned(),
            amount_zat: "100000000".to_owned(),
            expires_at: 2_000_000,
        };
        let body = serde_json::to_vec(&request).expect("encode request");
        let first = api
            .handle(HttpRequest::post("/v1/allocations", body.clone()))
            .expect("allocation response");
        assert_eq!(first.status, 200);
        let first: crate::allocate::ReceiverAllocation =
            serde_json::from_slice(&first.body).expect("decode allocation");
        assert_eq!(first.receiver.diversifier_index, "00".repeat(11));
        let replay = api
            .handle(HttpRequest::post("/v1/allocations", body))
            .expect("replay allocation response");
        assert_eq!(replay.status, 200);
        assert_eq!(
            serde_json::from_slice::<crate::allocate::ReceiverAllocation>(&replay.body)
                .expect("decode replay"),
            first
        );
        drop(api);
        fs::remove_dir_all(root).expect("remove private allocation root");
    }

    #[test]
    fn real_wallet_reopen_after_post_exposure_crash_replays_the_original_receiver() {
        use std::{
            fs::OpenOptions,
            panic::{AssertUnwindSafe, catch_unwind},
            sync::{Arc, Mutex},
        };

        use crate::wallet::{
            WalletAllocationDeriver, ensure_view_only_account, open_persistent_wallet_db,
            seed_allocation_watermark,
        };
        use zcash_client_backend::{
            data_api::{Account as _, AccountBirthday},
            proto::service::TreeState,
        };
        use zcash_keys::keys::UnifiedSpendingKey;
        use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork};
        use zip32::AccountId;

        fn params() -> LocalNetwork {
            LocalNetwork {
                overwinter: Some(BlockHeight::from_u32(1)),
                sapling: Some(BlockHeight::from_u32(1)),
                blossom: Some(BlockHeight::from_u32(1)),
                heartwood: Some(BlockHeight::from_u32(1)),
                canopy: Some(BlockHeight::from_u32(1)),
                nu5: Some(BlockHeight::from_u32(1)),
                nu6: Some(BlockHeight::from_u32(1)),
                nu6_1: Some(BlockHeight::from_u32(1)),
                nu6_2: Some(BlockHeight::from_u32(1)),
                nu6_3: Some(BlockHeight::from_u32(1)),
            }
        }

        fn birthday() -> AccountBirthday {
            AccountBirthday::from_treestate(
                TreeState {
                    network: "regtest".to_owned(),
                    height: 0,
                    hash: "00".repeat(32),
                    time: 0,
                    sapling_tree: String::new(),
                    orchard_tree: String::new(),
                    ironwood_tree: String::new(),
                },
                None,
            )
            .expect("empty genesis tree state is valid")
        }

        fn real_wallet_api(
            root: &Path,
            ufvk: &zcash_keys::keys::UnifiedFullViewingKey,
            hook: Option<Box<dyn FnOnce(&crate::allocate::ReceiverDerivation) + Send>>,
        ) -> (ApiService, String) {
            let params = params();
            let mut wallet = open_persistent_wallet_db(&root.join("wallet.sqlite"), params.clone())
                .expect("open real persisted WalletDb");
            let account = ensure_view_only_account(&mut wallet, "scanner", ufvk, &birthday())
                .expect("import or reopen view-only account");
            let account_id = account.id().expose_uuid().to_string();
            let snapshots = SnapshotStore::open(
                &root.join("snapshots.sqlite"),
                "scanner",
                crate::allocate::ChainIdentity::fixture(),
                &account_id,
            )
            .expect("open snapshot store");
            let lock = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .open(root.join("writer.lock"))
                .expect("open lifecycle writer lock");
            let lease = WriterLease::acquire(lock).expect("hold lifecycle writer lease");
            let allocations =
                crate::allocate::AllocationJournal::open(&root.join("scanner.sqlite"))
                    .expect("open scanner allocation journal");
            seed_allocation_watermark(&wallet, account.id(), &account_id, &allocations)
                .expect("burn imported wallet addresses before accepting allocations");
            let deriver = Arc::new(WalletAllocationDeriver::new(wallet, account.id(), params));
            let chain = crate::allocate::ChainIdentity::fixture();
            let api = match hook {
                Some(hook) => ApiService::with_deriver_and_post_wallet_exposure_hook(
                    lease,
                    allocations,
                    snapshots,
                    chain,
                    &account_id,
                    deriver,
                    hook,
                ),
                None => ApiService::with_deriver(
                    lease,
                    allocations,
                    snapshots,
                    chain,
                    &account_id,
                    deriver,
                ),
            };
            (api, account_id)
        }

        let root = private_root("real-wallet-post-exposure-crash");
        let params = params();
        let mut seed = [0_u8; 32];
        getrandom::fill(&mut seed).expect("OS entropy for test wallet");
        let spending_key = UnifiedSpendingKey::from_seed(&params, &seed, AccountId::ZERO)
            .expect("derive ephemeral test wallet key");
        seed.fill(0);
        let ufvk = spending_key.to_unified_full_viewing_key();
        let captured = Arc::new(Mutex::new(None));
        let captured_by_hook = Arc::clone(&captured);
        let (first, account_id) = real_wallet_api(
            &root,
            &ufvk,
            Some(Box::new(move |derived| {
                *captured_by_hook
                    .lock()
                    .expect("capture real exposed address") = Some(derived.clone());
                panic!("simulate process death after wallet exposure before finalization");
            })),
        );
        let request = crate::allocate::AllocationRequest {
            allocation_id: "crash-boundary-allocation".to_owned(),
            chain: crate::allocate::ChainIdentity::fixture(),
            account_id,
            amount_zat: "100000000".to_owned(),
            expires_at: 2_000_000,
        };
        let body = serde_json::to_vec(&request).expect("encode allocation request");
        assert!(
            catch_unwind(AssertUnwindSafe(|| {
                first
                    .handle(HttpRequest::post("/v1/allocations", body.clone()))
                    .expect("request reaches post-exposure crash seam");
            }))
            .is_err()
        );
        let exposed = captured
            .lock()
            .expect("read captured exposed address")
            .clone()
            .expect("wallet exposure happened before the simulated crash");
        drop(first);

        let (restarted, _) = real_wallet_api(&root, &ufvk, None);
        let replay = restarted
            .handle(HttpRequest::post("/v1/allocations", body.clone()))
            .expect("retry after real WalletDb reopen");
        assert_eq!(replay.status, 200);
        let replay: crate::allocate::ReceiverAllocation =
            serde_json::from_slice(&replay.body).expect("decode replay allocation");
        assert_eq!(replay.destination, exposed.destination);
        assert_eq!(replay.receiver.diversifier_index, exposed.diversifier_index);
        let replay_again = restarted
            .handle(HttpRequest::post("/v1/allocations", body))
            .expect("lost response replay");
        assert_eq!(replay_again.status, 200);
        assert_eq!(
            serde_json::from_slice::<crate::allocate::ReceiverAllocation>(&replay_again.body)
                .expect("decode replay after lost response"),
            replay
        );
        drop(restarted);
        fs::remove_dir_all(root).expect("remove real wallet crash fixture");
    }

    #[test]
    fn leased_socket_preserves_http_and_adapter_coverage() {
        use std::{
            io::{Read, Write},
            os::unix::net::UnixStream,
            process::Command,
            sync::mpsc,
        };

        let root = private_root("socket");
        let socket = root.join("scanner.sock");
        serve_lifecycle_socket(lifecycle_api(&root, true), &root);

        let mut open_write = UnixStream::connect(&socket).expect("connect open-write peer");
        open_write
            .set_read_timeout(Some(Duration::from_millis(500)))
            .expect("set read timeout");
        open_write
            .write_all(b"GET /v1/snapshot HTTP/1.1\r\nContent-Length: 0\r\n\r\n")
            .expect("send complete request without EOF");
        let mut response = [0_u8; 128];
        let read = open_write.read(&mut response).expect("reply before EOF");
        assert!(response[..read].starts_with(b"HTTP/1.1 200"));

        let mut stalled = UnixStream::connect(&socket).expect("connect stalled peer");
        stalled
            .write_all(b"GET /v1/snapshot HTTP/1.1\r\nContent-Length: 0")
            .expect("write incomplete peer");
        let (sender, receiver) = mpsc::channel();
        let request_socket = socket.clone();
        std::thread::spawn(move || {
            let _ = sender.send(request(
                &request_socket,
                b"GET /v1/snapshot HTTP/1.1\r\nContent-Length: 0\r\n\r\n",
            ));
        });
        assert!(
            receiver
                .recv_timeout(Duration::from_millis(750))
                .expect("stalled peer cannot block valid request")
                .starts_with(b"HTTP/1.1 200")
        );
        assert!(request(&socket, b"not an HTTP request").starts_with(b"HTTP/1.1 400"));
        let mut oversized =
            b"POST /v1/allocations HTTP/1.1\r\nContent-Length: 65537\r\n\r\n".to_vec();
        oversized.extend(std::iter::repeat_n(b'x', 65_537));
        assert!(request(&socket, &oversized).starts_with(b"HTTP/1.1 413"));

        let output = Command::new("npx")
            .args([
                "tsx",
                "services/scanner/tests/real_socket_adapter.ts",
                socket.to_str().expect("private socket path"),
            ])
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .output()
            .expect("run TypeScript adapter against bound Rust socket");
        assert!(
            output.status.success(),
            "TypeScript adapter stderr: {:?}",
            output.stderr
        );
        drop(stalled);
    }
}
