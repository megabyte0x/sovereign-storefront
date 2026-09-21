import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, chmodSync, existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, encrypt, exportKey, generateKey } from "./crypto.mjs";
import { startGateway } from "./gateway.mjs";
import {
  CHUNK_SIZE,
  LOGOSCTL_VERSION,
  MODULE,
  MODULE_ROOT_HASH,
  MODULE_VERSION,
  call,
  unwrap,
  watch,
  waitForLine,
} from "./logos.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeA = path.join(here, "runtime", "node-a");
const nodeB = path.join(here, "runtime", "node-b");
const dataDir = path.join(here, "data");
const walletsDir = path.join(here, "wallets");

const PLAINTEXT = new TextEncoder().encode(
  "sovereign-storefront harmless fixture v1\n",
);
const DECOY_PLAINTEXT = Buffer.from("DECOY-PLAINTEXT-MUST-NOT-BE-USED\n");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function resultValue(parsed) {
  const result = unwrap(parsed);
  if (result && typeof result === "object" && "success" in result) {
    if (!result.success) {
      throw new Error(`module call failed: ${JSON.stringify(result)}`);
    }
    return result.value;
  }
  return result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function eventBody(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const arg0 = parsed.data?.arg0;
  if (typeof arg0 === "string") {
    try {
      return { event: parsed.event, ...JSON.parse(arg0) };
    } catch {
      return { event: parsed.event, raw: arg0 };
    }
  }
  return { event: parsed.event, ...(parsed.data ?? {}) };
}

async function waitUntil(fn, timeoutMs, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

async function uploadAndWait(configDir, filePath) {
  const watcher = watch(configDir, "storageUploadDone");
  try {
    await sleep(500);
    const accepted = call(configDir, "uploadUrl", [filePath, String(CHUNK_SIZE)]);
    const session = resultValue(accepted);
    const done = await waitForLine(
      watcher,
      (parsed) => {
        const body = eventBody(parsed);
        return body?.event === "storageUploadDone" && body.success === true && Boolean(body.cid);
      },
      120_000,
    );
    const body = eventBody(done);
    const manifests = resultValue(call(configDir, "manifests"));
    const match =
      (manifests ?? []).find((m) => m.cid === body.cid) ??
      (manifests ?? []).find((m) => m.filename === path.basename(filePath));
    if (!match?.cid) {
      throw new Error(
        `upload accepted (${session}) but no manifest cid; event=${JSON.stringify(done)} manifests=${JSON.stringify(manifests)}`,
      );
    }
    const exists = resultValue(call(configDir, "exists", [match.cid]));
    if (exists !== true) {
      throw new Error(`storageUploadDone but exists(${match.cid})=${exists}`);
    }
    return {
      acceptedSession: session,
      acceptedRaw: accepted,
      completionEvent: { event: body.event, success: body.success, sessionId: body.sessionId },
      cid: match.cid,
      manifest: match,
    };
  } finally {
    watcher.stop();
  }
}

async function downloadAndWait(configDir, cid, destPath, { local }) {
  if (!local) {
    const manifestWatcher = watch(configDir, "storageDownloadManifestDone");
    try {
      await sleep(400);
      const manifestAccepted = call(configDir, "downloadManifest", [cid]);
      if (unwrap(manifestAccepted)?.success === false) {
        throw new Error(`downloadManifest not accepted: ${JSON.stringify(manifestAccepted)}`);
      }
      try {
        await waitForLine(
          manifestWatcher,
          (parsed) => eventBody(parsed)?.event === "storageDownloadManifestDone",
          60_000,
        );
      } catch {
        // manifests() is the completion check if the watch line is missed
      }
    } finally {
      manifestWatcher.stop();
    }
    await waitUntil(
      () => (resultValue(call(configDir, "manifests")) ?? []).some((m) => m.cid === cid),
      60_000,
      `manifest ${cid} on replica`,
    );
  }

  const watcher = watch(configDir, "storageDownloadDone");
  try {
    await sleep(400);
    if (existsSync(destPath)) rmSync(destPath);
    const accepted = call(configDir, "downloadToUrl", [
      cid,
      destPath,
      local ? "true" : "false",
      String(CHUNK_SIZE),
    ]);
    const session = resultValue(accepted);
    await waitForLine(
      watcher,
      (parsed) => {
        const body = eventBody(parsed);
        return body?.event === "storageDownloadDone" && body.success === true;
      },
      180_000,
    );
    await waitUntil(
      () => existsSync(destPath) && readFileSync(destPath).byteLength > 0,
      30_000,
      `downloaded file ${destPath}`,
    );
    return { acceptedSession: session, acceptedRaw: accepted, bytes: readFileSync(destPath) };
  } finally {
    watcher.stop();
  }
}

async function browserDecrypt(url, objectId, keyRaw, expectedPlain) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--ignore-certificate-errors", "--no-sandbox", "--disable-gpu"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const keyB64 = Buffer.from(keyRaw).toString("base64");
    await page.addInitScript((k) => sessionStorage.setItem("aesKey", k), keyB64);
    await page.goto(`${url}decrypt.html?id=${objectId}`, { waitUntil: "networkidle" });
    const status = await page.waitForFunction(
      () => {
        const t = document.getElementById("status")?.textContent ?? "";
        return t && t !== "idle" ? t : false;
      },
      { timeout: 30_000 },
    );
    const parsed = JSON.parse(await status.jsonValue());
    if (!parsed.ok) {
      throw new Error(`browser decrypt failed: ${JSON.stringify(parsed)}`);
    }
    const expectedText = new TextDecoder().decode(expectedPlain);
    if (parsed.text !== expectedText) {
      throw new Error("browser plaintext mismatch");
    }
    return parsed;
  } finally {
    await Promise.race([browser.close(), sleep(3000)]);
  }
}

async function main() {
  const evidence = {
    probe: "encrypted-browser-downloads-independent-storage",
    mock: false,
    cloudObjectStoreSubstitution: false,
    streamingClaimed: false,
    module: {
      name: MODULE,
      version: MODULE_VERSION,
      rootHash: MODULE_ROOT_HASH,
      logosctl: LOGOSCTL_VERSION,
      libstorage: null,
      methods: {
        uploadCompletionEvent: "storageUploadDone",
        downloadCompletionEvent: "storageDownloadDone",
        startCompletionEvent: "storageStart",
        acceptVsComplete:
          "call result reports command acceptance; storageUploadDone/storageDownloadDone and exists()/manifests() report completion. fetch() is acceptance-only and was not used as replica proof.",
      },
    },
    crypto: {
      algorithm: "AES-256-GCM",
      implementation: "Web Crypto SubtleCrypto (Node + Chromium)",
      format: "SSF1 || 12-byte nonce || ciphertext+tag",
      maxPlaintextBytes: 8 * 1024 * 1024,
    },
    nodes: {},
    sizes: [],
    replica: {},
    gateway: {},
    browser: {},
  };

  mkdirSync(path.join(dataDir, "downloads"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dataDir, "decoy-plaintext.txt"), DECOY_PLAINTEXT, { mode: 0o600 });

  const peerA = resultValue(call(nodeA, "peerId"));
  const peerB = resultValue(call(nodeB, "peerId"));
  const dirA = resultValue(call(nodeA, "dataDir"));
  const dirB = resultValue(call(nodeB, "dataDir"));
  evidence.module.libstorage = resultValue(call(nodeA, "version"));
  if (peerA === peerB) throw new Error("nodes share peer identity");
  if (dirA === dirB) throw new Error("nodes share data-dir");
  evidence.nodes = {
    a: { peerIdPrefix: peerA.slice(0, 12), dataDirBasename: path.basename(dirA), listenPort: 18091 },
    b: { peerIdPrefix: peerB.slice(0, 12), dataDirBasename: path.basename(dirB), listenPort: 18191 },
    identitySeparated: peerA !== peerB,
    storageSeparated: dirA !== dirB,
  };

  const connectAccepted = call(nodeB, "connect", [peerA, `json:[]`]);
  evidence.replica.connectAccepted = unwrap(connectAccepted)?.success === true || unwrap(connectAccepted) == null;

  const key = await generateKey();
  const keyRaw = await exportKey(key);
  writeFileSync(path.join(walletsDir, "aes-256-gcm.key"), keyRaw, { mode: 0o600 });
  chmodSync(path.join(walletsDir, "aes-256-gcm.key"), 0o600);

  const ciphertext = Buffer.from(await encrypt(key, PLAINTEXT));
  const cipherPath = path.join(dataDir, "fixture.ssf1");
  writeFileSync(cipherPath, ciphertext, { mode: 0o600 });
  const cipherDigest = sha256(ciphertext);
  const plainDigest = sha256(PLAINTEXT);

  const sizes = [
    { label: "fixture", bytes: ciphertext.byteLength },
  ];
  const memBefore = process.memoryUsage();
  evidence.sizes.push({
    label: "fixture-encrypt",
    plaintextBytes: PLAINTEXT.byteLength,
    ciphertextBytes: ciphertext.byteLength,
    rssBytes: memBefore.rss,
  });

  const uploaded = await uploadAndWait(nodeA, cipherPath);
  evidence.replica.upload = {
    accepted: Boolean(uploaded.acceptedSession),
    acceptedIsNotCompletion: true,
    cidPrefix: String(uploaded.cid).slice(0, 12),
    datasetSize: uploaded.manifest.datasetSize,
    filename: uploaded.manifest.filename,
  };

  const replicaPath = path.join(dataDir, "downloads", "from-node-b.bin");
  const retrieved = await downloadAndWait(nodeB, uploaded.cid, replicaPath, { local: false });
  const replicaDigest = sha256(retrieved.bytes);
  if (replicaDigest !== cipherDigest) {
    throw new Error("replica ciphertext digest mismatch");
  }
  if (retrieved.bytes.equals(DECOY_PLAINTEXT) || retrieved.bytes.equals(Buffer.from(PLAINTEXT))) {
    throw new Error("replica returned plaintext; expected ciphertext");
  }
  evidence.replica.firstRetrieval = {
    via: "node-b downloadToUrl local=false",
    digestMatch: true,
    bytes: retrieved.bytes.byteLength,
  };

  const stopWatcher = watch(nodeA, "storageStop");
  let stopCompleted = false;
  try {
    await sleep(400);
    const stopAccepted = call(nodeA, "stop");
    evidence.replica.stopOriginal = {
      accepted: unwrap(stopAccepted)?.success !== false,
    };
    try {
      const stopEvent = await waitForLine(
        stopWatcher,
        (parsed) => eventBody(parsed)?.event === "storageStop",
        30_000,
      );
      stopCompleted = eventBody(stopEvent)?.success !== false;
    } catch {
      stopCompleted = false;
    }
  } finally {
    stopWatcher.stop();
  }
  evidence.replica.originalNodeStopped = stopCompleted;

  const replicaPath2 = path.join(dataDir, "downloads", "from-node-b-after-stop.bin");
  if (existsSync(replicaPath2)) rmSync(replicaPath2);
  const retrieved2 = await downloadAndWait(nodeB, uploaded.cid, replicaPath2, { local: true });
  const replicaDigest2 = sha256(retrieved2.bytes);
  if (replicaDigest2 !== cipherDigest) {
    throw new Error("post-stop replica ciphertext digest mismatch");
  }
  const decoy = readFileSync(path.join(dataDir, "decoy-plaintext.txt"));
  if (retrieved2.bytes.equals(decoy)) {
    throw new Error("missing cache silently fetched local plaintext fixture");
  }
  evidence.replica.afterOriginalStopped = {
    via: "node-b downloadToUrl local=true",
    digestMatch: true,
    didNotUseDecoyPlaintext: true,
  };

  const objectId = "fixture-v1";
  const { url, close } = await startGateway({
    objects: new Map([[objectId, retrieved2.bytes]]),
    host: "127.0.0.1",
    tlsDir: path.join(here, "runtime", "tls"),
  });
  try {
    const browser = await browserDecrypt(url, objectId, keyRaw, PLAINTEXT);
    evidence.gateway = {
      urlHost: "127.0.0.1",
      served: "ciphertext-only",
      objectId,
    };
    evidence.browser = {
      decrypted: true,
      plaintextSha256: browser.sha256,
      matchesFixture: browser.sha256 === plainDigest,
      bytes: browser.bytes,
    };
    if (browser.sha256 !== plainDigest) {
      throw new Error("browser digest mismatch");
    }
  } finally {
    await close();
  }

  evidence.pass = true;
  const outPath = path.join(here, "..", "results", "storage.json");
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({ ok: true, outPath, cidPrefix: evidence.replica.upload.cidPrefix }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
