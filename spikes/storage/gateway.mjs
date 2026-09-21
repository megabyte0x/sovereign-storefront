import { execFile } from "node:child_process";
import { mkdtemp, readFile, chmod, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CIPHERTEXT_PREFIX = "/ciphertext/";

function inspectRawPath(rawUrl) {
  const pathOnly = String(rawUrl ?? "").split("?")[0];
  if (
    pathOnly.includes("..") ||
    pathOnly.includes("%") ||
    pathOnly.includes("\\") ||
    pathOnly.includes("//") ||
    pathOnly.includes("./")
  ) {
    return { status: 400 };
  }
  if (pathOnly === "/decrypt.html" || pathOnly === "/decrypt.js") {
    return { page: pathOnly.slice(1) };
  }
  if (!pathOnly.startsWith(CIPHERTEXT_PREFIX)) {
    return { status: 400 };
  }
  const id = pathOnly.slice(CIPHERTEXT_PREFIX.length);
  if (!ID_RE.test(id)) {
    return { status: 400 };
  }
  return { id };
}

const DECRYPT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>ciphertext decrypt</title></head>
<body>
<pre id="status">idle</pre>
<script type="module" src="/decrypt.js"></script>
</body>
</html>
`;

const DECRYPT_JS = `const MAGIC = new TextEncoder().encode("SSF1");
const statusEl = document.getElementById("status");
function setStatus(obj) { statusEl.textContent = JSON.stringify(obj); }
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function main() {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    setStatus({ ok: false, error: "bad-id" });
    return;
  }
  const keyB64 = sessionStorage.getItem("aesKey");
  if (!keyB64) {
    setStatus({ ok: false, error: "missing-key" });
    return;
  }
  const res = await fetch("/ciphertext/" + id);
  if (!res.ok) {
    setStatus({ ok: false, error: "fetch", status: res.status });
    return;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < MAGIC.length + 12 + 16) {
    setStatus({ ok: false, error: "short" });
    return;
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) {
      setStatus({ ok: false, error: "magic" });
      return;
    }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(keyB64),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.subarray(4, 16) },
      key,
      buf.subarray(16),
    ));
    const digest = await crypto.subtle.digest("SHA-256", plain);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    setStatus({ ok: true, bytes: plain.byteLength, sha256: hex, text: new TextDecoder().decode(plain) });
  } catch {
    setStatus({ ok: false, error: "decrypt-failed", plaintextExposed: false });
  }
}
main();
`;

async function makeTlsMaterial(tlsDir) {
  const dir = tlsDir ?? (await mkdtemp(path.join(tmpdir(), "ssf-tls-")));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ]);
  await chmod(keyPath, 0o600);
  await chmod(certPath, 0o600);
  return {
    key: await readFile(keyPath),
    cert: await readFile(certPath),
    keyPath,
    certPath,
    dir,
    ephemeral: !tlsDir,
  };
}

export async function startGateway({
  objects,
  host = "127.0.0.1",
  port = 0,
  tlsDir,
} = {}) {
  const store = objects instanceof Map ? objects : new Map();
  const tls = await makeTlsMaterial(tlsDir);
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    const inspected = inspectRawPath(req.url);
    if (inspected.page === "decrypt.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(DECRYPT_HTML);
      return;
    }
    if (inspected.page === "decrypt.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(DECRYPT_JS);
      return;
    }
    if (inspected.status) {
      res.writeHead(inspected.status, { "content-type": "text/plain" });
      res.end("rejected");
      return;
    }
    const body = store.get(inspected.id);
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("unknown");
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  return {
    url: `https://${host}:${addr.port}/`,
    port: addr.port,
    close: async () => {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      if (tls.ephemeral) {
        await rm(tls.dir, { recursive: true, force: true });
      }
    },
  };
}
