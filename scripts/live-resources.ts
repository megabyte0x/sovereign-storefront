/**
 * Live demo resource ownership registry.
 *
 * Records every resource the live demo creates (seller PIDs, ports, scratch
 * dirs, CIDs, invoice/order ids, the Waku content topic and second-context
 * browser profile dirs) in a 0600 JSON file under `.runtime/live/demo/`.
 * `cleanup()` stops ONLY registered PIDs whose `/proc/<pid>/cmdline` still
 * names both the registered binary and the owned path, and removes ONLY
 * registered scratch/profile dirs that sit strictly inside an allowed root.
 *
 * Secrets never enter the registry: each record kind has a key allow-list and
 * every string value is checked against secret-looking prefixes.
 * The process/kill layer is injected per instance (no global hooks).
 */
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_ROOT, ensurePrivateDir } from './live-infra/paths.ts';

export const REGISTRY_VERSION = 1;
export const DEMO_DIR: string = path.join(LIVE_ROOT, 'demo');
export const DEFAULT_REGISTRY_PATH: string = path.join(DEMO_DIR, 'resources.json');
const STOP_POLL_ATTEMPTS = 50;
const STOP_POLL_INTERVAL_MS = 100;

export type PidResource = { kind: 'pid'; pid: number; binary: string; ownedPath: string; label: string; cleaned: boolean };
export type PortResource = { kind: 'port'; port: number; label: string };
export type DirResource = { kind: 'scratchDir' | 'browserProfileDir'; path: string; label: string; cleaned: boolean };
export type CidResource = { kind: 'cid'; cid: string; label: string };
export type IdResource = { kind: 'invoiceId' | 'orderId'; id: string; label: string };
export type TopicResource = { kind: 'wakuContentTopic'; topic: string; label: string };
export type LiveResource = PidResource | PortResource | DirResource | CidResource | IdResource | TopicResource;

/** Key allow-list per record kind. Anything else is refused on write and on load. */
const ALLOWED_KEYS: Record<LiveResource['kind'], readonly string[]> = {
  pid: ['kind', 'pid', 'binary', 'ownedPath', 'label', 'cleaned'],
  port: ['kind', 'port', 'label'],
  scratchDir: ['kind', 'path', 'label', 'cleaned'],
  browserProfileDir: ['kind', 'path', 'label', 'cleaned'],
  cid: ['kind', 'cid', 'label'],
  invoiceId: ['kind', 'id', 'label'],
  orderId: ['kind', 'id', 'label'],
  wakuContentTopic: ['kind', 'topic', 'label'],
};

/** Value prefixes/markers that indicate key material; never recorded. */
const SECRET_MARKERS = [
  /^uview/i, /^uivk/i, /^zxview/i, /^zxviews/i, /^zivk/i,
  /^secret-extended-key/i, /^SK/, /^xprv/i, /^tprv/i,
  /token/i, /mnemonic/i, /seed/i, /private/i, /BEGIN [A-Z ]*KEY/,
];
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export type ProcessLayer = {
  /** argv of a live process, or undefined if it does not exist / is unreadable. */
  readCmdline(pid: number): string[] | undefined;
  kill(pid: number, signal: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
};

export type PidOutcome = 'stopped' | 'gone' | 'skipped-cmdline-changed' | 'still-running' | 'already-cleaned';
export type DirOutcome = 'removed' | 'gone' | 'skipped-not-directory' | 'skipped-outside-roots' | 'already-cleaned';
export type CleanupReport = {
  ok: boolean;
  pids: Array<{ pid: number; label: string; outcome: PidOutcome }>;
  dirs: Array<{ path: string; label: string; outcome: DirOutcome }>;
};

export type RegistryOptions = {
  path?: string;
  processes?: ProcessLayer;
  /** Dirs may only be registered strictly inside one of these roots. */
  scratchRoots?: string[];
};

export function realProcessLayer(): ProcessLayer {
  return {
    readCmdline(pid) {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a !== '');
      } catch {
        return undefined;
      }
    },
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function assertNoSecret(value: string, field: string): void {
  if (SECRET_MARKERS.some((re) => re.test(value))) {
    throw new Error(`refusing to record ${field}: value looks like a secret`);
  }
}

function assertLabel(label: unknown): void {
  if (typeof label !== 'string' || !LABEL_RE.test(label)) throw new Error('invalid label (1-64 chars of [A-Za-z0-9._:-])');
  assertNoSecret(label, 'label');
}

function assertAllowedKeys(rec: Record<string, unknown>): void {
  const allowed = ALLOWED_KEYS[rec.kind as LiveResource['kind']];
  if (!allowed) throw new Error(`resource kind not allowed: ${String(rec.kind)}`);
  for (const k of Object.keys(rec)) {
    if (!allowed.includes(k)) throw new Error(`resource key not allowed for ${String(rec.kind)}: ${k}`);
  }
}

function isStrictlyInside(p: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), p);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/** Full validation of a record; used for both new registrations and loaded files. */
function validate(rec: Record<string, unknown>, roots: string[]): LiveResource {
  assertAllowedKeys(rec);
  assertLabel(rec.label);
  for (const [k, v] of Object.entries(rec)) if (typeof v === 'string') assertNoSecret(v, k);
  switch (rec.kind) {
    case 'pid': {
      if (!Number.isSafeInteger(rec.pid) || (rec.pid as number) <= 1) throw new Error('invalid pid');
      if (typeof rec.binary !== 'string' || rec.binary === '' || rec.binary.includes('/')) throw new Error('invalid binary name');
      if (typeof rec.ownedPath !== 'string' || !path.isAbsolute(rec.ownedPath)) throw new Error('ownedPath must be absolute');
      break;
    }
    case 'port':
      if (!Number.isSafeInteger(rec.port) || (rec.port as number) < 1 || (rec.port as number) > 65535) throw new Error('invalid port');
      break;
    case 'scratchDir':
    case 'browserProfileDir': {
      if (typeof rec.path !== 'string' || !path.isAbsolute(rec.path)) throw new Error('dir path must be absolute');
      if (path.normalize(rec.path) !== rec.path.replace(/\/+$/, '') || !isStrictlyInside(rec.path, roots)) {
        throw new Error('dir must be strictly inside an allowed scratch root');
      }
      break;
    }
    case 'cid':
      if (typeof rec.cid !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(rec.cid)) throw new Error('invalid cid');
      break;
    case 'invoiceId':
    case 'orderId':
      if (typeof rec.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(rec.id)) throw new Error('invalid id');
      break;
    case 'wakuContentTopic':
      if (typeof rec.topic !== 'string' || !/^\/[\x21-\x7e]{1,255}$/.test(rec.topic)) throw new Error('invalid content topic');
      break;
  }
  if ('cleaned' in rec && typeof rec.cleaned !== 'boolean') throw new Error('invalid cleaned flag');
  return rec as LiveResource;
}

function identity(r: LiveResource): string {
  switch (r.kind) {
    case 'pid': return `pid:${r.pid}:${r.binary}:${r.ownedPath}`;
    case 'port': return `port:${r.port}`;
    case 'scratchDir':
    case 'browserProfileDir': return `${r.kind}:${r.path}`;
    case 'cid': return `cid:${r.cid}`;
    case 'invoiceId':
    case 'orderId': return `${r.kind}:${r.id}`;
    case 'wakuContentTopic': return `topic:${r.topic}`;
  }
}

function argvOwns(argv: string[], binary: string, ownedPath: string): boolean {
  const binaryOk = argv.length > 0 && path.basename(argv[0]) === binary;
  const pathOk = argv.some((a) => a === ownedPath || a.endsWith(`=${ownedPath}`));
  return binaryOk && pathOk;
}

export function createLiveResourceRegistry(opts: RegistryOptions = {}) {
  const file = opts.path ?? DEFAULT_REGISTRY_PATH;
  const procs = opts.processes ?? realProcessLayer();
  const roots = (opts.scratchRoots ?? [tmpdir(), DEMO_DIR]).map((r) => path.resolve(r));
  let resources: LiveResource[] = load();

  function load(): LiveResource[] {
    if (!existsSync(file)) return [];
    const st = lstatSync(file);
    if (!st.isFile()) throw new Error('registry is not a regular file');
    if ((st.mode & 0o077) !== 0) throw new Error('registry file must be mode 0600');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const k of Object.keys(doc)) if (k !== 'version' && k !== 'resources') throw new Error(`registry key not allowed: ${k}`);
    if (doc.version !== REGISTRY_VERSION || !Array.isArray(doc.resources)) throw new Error('unsupported registry format');
    return doc.resources.map((r) => validate(r as Record<string, unknown>, roots));
  }

  function save(): void {
    ensurePrivateDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: REGISTRY_VERSION, resources }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }

  function add(rec: Record<string, unknown>): void {
    const r = validate(rec, roots);
    const id = identity(r);
    if (resources.some((x) => identity(x) === id)) return;
    resources = [...resources, r];
    save();
  }

  // Known limit: a PID can be reused between the cmdline check and SIGTERM.
  // The window is one syscall; the cmdline check (binary + owned path) keeps
  // an unrelated reuse from matching, and SIGKILL is never sent.
  async function stopPid(r: PidResource): Promise<PidOutcome> {
    const argv = procs.readCmdline(r.pid);
    if (argv === undefined) return 'gone';
    if (!argvOwns(argv, r.binary, r.ownedPath)) return 'skipped-cmdline-changed';
    try {
      procs.kill(r.pid, 'SIGTERM');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
      throw e;
    }
    for (let i = 0; i < STOP_POLL_ATTEMPTS; i += 1) {
      if (!procs.isAlive(r.pid)) return 'stopped';
      await procs.sleep(STOP_POLL_INTERVAL_MS);
    }
    return procs.isAlive(r.pid) ? 'still-running' : 'stopped';
  }

  function removeDir(r: DirResource): DirOutcome {
    if (!isStrictlyInside(r.path, roots)) return 'skipped-outside-roots';
    let st;
    try {
      st = lstatSync(r.path);
    } catch {
      return 'gone';
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return 'skipped-not-directory';
    // A parent swapped for a symlink would redirect the delete: the fully
    // resolved path must sit at the same relative location under a resolved root.
    let real: string;
    try {
      real = realpathSync(r.path);
    } catch {
      return 'gone';
    }
    const owned = roots.some((root) => {
      const rel = path.relative(root, r.path);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      let realRoot: string;
      try {
        realRoot = realpathSync(root);
      } catch {
        return false;
      }
      return path.relative(realRoot, real) === rel;
    });
    if (!owned) return 'skipped-outside-roots';
    rmSync(real, { recursive: true, force: true });
    return 'removed';
  }

  return {
    path: file,
    registerPid: (r: { pid: number; binary: string; ownedPath: string; label: string }) =>
      add({ kind: 'pid', ...r, cleaned: false }),
    registerPort: (r: { port: number; label: string }) => add({ kind: 'port', ...r }),
    registerScratchDir: (r: { path: string; label: string }) => add({ kind: 'scratchDir', ...r, cleaned: false }),
    registerBrowserProfileDir: (r: { path: string; label: string }) =>
      add({ kind: 'browserProfileDir', ...r, cleaned: false }),
    registerCid: (r: { cid: string; label: string }) => add({ kind: 'cid', ...r }),
    registerInvoiceId: (r: { id: string; label: string }) => add({ kind: 'invoiceId', ...r }),
    registerOrderId: (r: { id: string; label: string }) => add({ kind: 'orderId', ...r }),
    registerWakuContentTopic: (r: { topic: string; label: string }) => add({ kind: 'wakuContentTopic', ...r }),
    snapshot: (): LiveResource[] => resources.map((r) => ({ ...r })),

    /** Stop registered PIDs (cmdline-checked, SIGTERM only), then remove registered dirs. Idempotent. */
    async cleanup(): Promise<CleanupReport> {
      const report: CleanupReport = { ok: true, pids: [], dirs: [] };
      const next: LiveResource[] = [];
      for (const r of resources) {
        if (r.kind === 'pid') {
          const outcome = r.cleaned ? 'already-cleaned' : await stopPid(r);
          report.pids.push({ pid: r.pid, label: r.label, outcome });
          const done = outcome === 'stopped' || outcome === 'gone' || outcome === 'already-cleaned';
          if (!done) report.ok = false;
          next.push({ ...r, cleaned: done });
        } else {
          next.push(r);
        }
      }
      resources = next;
      save();
      // Dirs only after processes: a live process may still hold them open.
      resources = resources.map((r) => {
        if (r.kind !== 'scratchDir' && r.kind !== 'browserProfileDir') return r;
        const outcome = r.cleaned ? 'already-cleaned' : removeDir(r);
        report.dirs.push({ path: r.path, label: r.label, outcome });
        const done = outcome === 'removed' || outcome === 'gone' || outcome === 'already-cleaned';
        if (!done) report.ok = false;
        return { ...r, cleaned: done };
      });
      save();
      return report;
    },
  };
}

export type LiveResourceRegistry = ReturnType<typeof createLiveResourceRegistry>;

/** CLI: `node scripts/live-resources.ts cleanup` prints only outcomes (no secrets are ever stored). */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd !== 'cleanup') {
    console.error('usage: live-resources.ts cleanup');
    process.exit(2);
  }
  const report = await createLiveResourceRegistry().cleanup();
  for (const p of report.pids) console.log(`pid ${p.pid} ${p.label} ${p.outcome}`);
  for (const d of report.dirs) console.log(`dir ${d.label} ${d.outcome}`);
  process.exit(report.ok ? 0 : 1);
}
