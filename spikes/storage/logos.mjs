import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const LOGOSCTL = path.join(here, "runtime", "logosctl-aarch64.AppImage");
export const MODULE = "storage_module";
export const MODULE_VERSION = "2.1.2";
export const MODULE_ROOT_HASH =
  "19b11b153748c30665608c5527776ba2be74f7764481a11d33f687098764b740";
export const LOGOSCTL_VERSION = "0.2.3";
export const CHUNK_SIZE = 65536;

function envFor() {
  return { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" };
}

export function callRaw(configDir, args, { timeoutMs = 60_000 } = {}) {
  const result = spawnSync(
    LOGOSCTL,
    ["--config-dir", configDir, "--json", ...args],
    { env: envFor(), encoding: "utf8", timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export function call(configDir, method, methodArgs = []) {
  const raw = callRaw(configDir, ["call", MODULE, method, ...methodArgs.map(String)]);
  if (raw.status !== 0 && !raw.stdout) {
    throw new Error(`logosctl call ${method} failed: ${raw.stderr || raw.error}`);
  }
  const parsed = parseJson(raw.stdout);
  if (!parsed) {
    throw new Error(`logosctl call ${method} produced no JSON: ${raw.stdout} ${raw.stderr}`);
  }
  return parsed;
}

export function daemonStatus(configDir) {
  const raw = callRaw(configDir, ["daemon", "status"]);
  return parseJson(raw.stdout);
}

export function watch(configDir, eventName) {
  const proc = spawn(
    LOGOSCTL,
    ["--config-dir", configDir, "--json", "watch", MODULE, "--event", eventName],
    { env: envFor(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = [];
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) lines.push(line);
    }
  });
  return {
    proc,
    lines,
    stop() {
      if (!proc.killed) proc.kill("SIGTERM");
    },
  };
}

export async function waitForLine(watcher, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const line of watcher.lines) {
      try {
        const parsed = JSON.parse(line);
        if (predicate(parsed, line)) return parsed;
      } catch {
        if (predicate(null, line)) return line;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for watch event after ${timeoutMs}ms; saw ${watcher.lines.length} lines`);
}

export function unwrap(parsed) {
  if (!parsed || parsed.status === "error") {
    throw new Error(`logosctl error: ${JSON.stringify(parsed)}`);
  }
  return parsed.result;
}

export function ensureDir(p, mode = 0o700) {
  mkdirSync(p, { recursive: true, mode });
}
