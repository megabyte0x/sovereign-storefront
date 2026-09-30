// Run recorder for the Task 12 live acceptance sessions.
//
// Regtest `init` captures local provenance. Public init captures the running
// Pi directly over authenticated Tailscale SSH; caller-authored bundles are
// never deployment provenance.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleLiveReport,
  parseSellerLine,
  readBuildProvenance,
  sanitizeEvidence,
  type SuiteRow,
  type SuitesResult,
} from './demo-check.ts';
import { LIVE_ROOT } from './live-infra/paths.ts';
import {
  L_MATRIX_IDS,
  PUBLIC_MIN_CONFIRMATIONS,
  PUBLIC_STAGE_IDS,
  WORKFLOW_STAGE_IDS,
  adapterIdentityErrors,
  validateLiveReport,
  type AdapterIdentity,
  type BuildProvenance,
  type LiveReport,
  type LiveStage,
  type LiveStageStatus,
  type TestnetStage,
} from './live-report.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** sha256 of an empty buffer: the digest clean-build writes for a clean tree. */
const EMPTY_DIFF_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The public collector reads one fixed seller container and its live outputs. */
const PUBLIC_TARGET = 'root@ssf-replica';
const PUBLIC_CAPTURE_FAILURE = 'public init blocked: live VPS evidence is missing or inconsistent';
const PUBLIC_MODULES = [
  ['scanner', 'dist/service/adapters/scanner.js'],
  ['storage', 'dist/service/adapters/storage.js'],
  ['messaging', 'dist/service/adapters/waku.js'],
] as const;

const PUBLIC_REMOTE_SCRIPT = String.raw`set -eu
container=ssf-public-seller-1
found=$(docker ps --filter "name=^/$container$" --format '{{.Names}}')
test "$found" = "$container"
mounts=$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$container")
case " $mounts " in *" /app "*|*" /app/"*) exit 1 ;; esac
identity=$(docker inspect --format '{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.State.Running}}|{{.HostConfig.ReadonlyRootfs}}' "$container")
printf 'I|%s\n' "$identity"
docker exec "$container" sh -c 'base64 < /app/dist/build-info.json' | tr -d '\n' | { printf 'B|'; cat; printf '\n'; }
for module in scanner:dist/service/adapters/scanner.js storage:dist/service/adapters/storage.js messaging:dist/service/adapters/waku.js; do
  name=$(printf '%s' "$module" | cut -d ':' -f 1)
  file=$(printf '%s' "$module" | cut -d ':' -f 2-)
  digest=$(docker exec "$container" sha256sum "/app/$file" | cut -d " " -f 1)
  printf 'M|%s|%s\n' "$name" "$digest"
done
started=$(docker inspect --format '{{.State.StartedAt}}' "$container")
seller_log=$(docker logs --since "$started" "$container" 2>&1 | python3 -c 'import json,re,sys
ready=[]
components=set()
for raw in sys.stdin:
 line=raw.strip()
 if re.fullmatch(r"ready scanner=(true|false) messaging=(true|false) checkout=(true|false) products=\d+", line):
  ready.append(line)
  continue
 try:
  item=json.loads(line)
 except Exception:
  continue
 if type(item) is dict and set(item)-{"ts"}=={"event","component","status","ok"} and type(item.get("ts",0)) is int and item["event"]=="runtime.component" and item["status"]=="started" and item["ok"] is True and item["component"] in {"scanner","storage","waku"}:
  components.add(item["component"])
if len(ready)!=1 or components!={"scanner","storage","waku"}:
 sys.exit(1)
print(ready[0])
for component in sorted(components):
 print(json.dumps({"event":"runtime.component","component":component,"status":"started","ok":True},separators=(",",":")))')
printf '%s' "$seller_log" | base64 | tr -d '\n' | { printf 'L|'; cat; printf '\n'; }
`;

export type PublicCapture = {
  containerId: string;
  imageId: string;
  imageRef: string;
  buildInfo: unknown;
  moduleHashes: Record<(typeof PUBLIC_MODULES)[number][0], string>;
  sellerFacts: SellerLogFacts;
};

/** Parse only the fixed output protocol emitted by the remote read-only collector. */
export function parsePublicCapture(text: string): PublicCapture {
  const lines = text.trim().split(/\r?\n/);
  const identityLines = lines.filter((line) => line.startsWith('I|'));
  const buildLines = lines.filter((line) => line.startsWith('B|'));
  const logLines = lines.filter((line) => line.startsWith('L|'));
  const moduleLines = lines.filter((line) => line.startsWith('M|'));
  const identity = identityLines[0]?.split('|');
  if (identityLines.length !== 1 || identity?.length !== 6 || identity[4] !== 'true' || identity[5] !== 'true'
    || !/^[0-9a-f]{64}$/.test(identity[1] ?? '') || !/^sha256:[0-9a-f]{64}$/.test(identity[2] ?? '')
    || !/^[A-Za-z0-9._/:@-]+$/.test(identity[3] ?? '')) throw new Error(PUBLIC_CAPTURE_FAILURE);
  if (buildLines.length !== 1 || logLines.length !== 1) throw new Error(PUBLIC_CAPTURE_FAILURE);
  let buildInfo: unknown;
  let sellerLog: string;
  let sellerFacts: SellerLogFacts;
  try {
    buildInfo = JSON.parse(Buffer.from(buildLines[0]!.slice(2), 'base64').toString('utf8'));
    readBuildProvenance(buildInfo, EMPTY_DIFF_SHA256);
    const buildRecord = buildInfo as { adapterEntrypoints?: unknown };
    const entrypoints = buildRecord.adapterEntrypoints;
    if (!Array.isArray(entrypoints) || !entrypoints.every((entry) => typeof entry === 'string')
      || new Set(entrypoints).size !== entrypoints.length
      || !PUBLIC_MODULES.every(([, file]) => entrypoints.includes(file))) {
      throw new Error(PUBLIC_CAPTURE_FAILURE);
    }
    sellerLog = Buffer.from(logLines[0]!.slice(2), 'base64').toString('utf8');
    sellerFacts = readSellerLog(sellerLog);
  } catch {
    throw new Error(PUBLIC_CAPTURE_FAILURE);
  }
  const moduleHashes: Record<string, string> = {};
  for (const line of moduleLines) {
    const [, name, digest, extra] = line.split('|');
    if (extra !== undefined || !PUBLIC_MODULES.some(([expected]) => expected === name)
      || !/^[0-9a-f]{64}$/.test(digest ?? '') || moduleHashes[name!] !== undefined) {
      throw new Error(PUBLIC_CAPTURE_FAILURE);
    }
    moduleHashes[name!] = digest!;
  }
  if (Object.keys(moduleHashes).length !== PUBLIC_MODULES.length || sellerLog.length === 0) {
    throw new Error(PUBLIC_CAPTURE_FAILURE);
  }
  return {
    containerId: identity[1]!,
    imageId: identity[2]!,
    imageRef: identity[3]!,
    buildInfo,
    moduleHashes: moduleHashes as PublicCapture['moduleHashes'],
    sellerFacts,
  };
}

export function collectPublicCapture(): PublicCapture {
  const local = process.env.SSF_T01_LOCAL_VPS === '1';
  const result = spawnSync(local ? 'sh' : 'tailscale', local ? ['-s'] : ['ssh', PUBLIC_TARGET, 'sh', '-s'], {
    input: PUBLIC_REMOTE_SCRIPT,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal) throw new Error(PUBLIC_CAPTURE_FAILURE);
  try {
    return parsePublicCapture(result.stdout);
  } catch {
    throw new Error(PUBLIC_CAPTURE_FAILURE);
  }
}
const REQUIRED_COMPONENTS = ['scanner', 'storage', 'waku'] as const;

export const DEFAULT_SELLER_LOG = path.join(LIVE_ROOT, 'diag', 'manual-seller.log');
const OBSERVATIONS_PATH = path.join(LIVE_ROOT, 'demo', 'observations.json');
const REPORT_PATH = path.join(LIVE_ROOT, 'demo', 'report.json');

const WORKFLOW_IDS = new Set<string>(WORKFLOW_STAGE_IDS);
const MATRIX_IDS = new Set<string>(L_MATRIX_IDS);
const STAGE_STATUSES = new Set<LiveStageStatus>(['PASS', 'FAIL', 'NOT_RUN']);

export type ObservationNote = { stageId: string; note: string };
export type Observations = {
  profile?: 'public';
  deployment?: { target: string; containerId: string; imageId: string; imageRef: string };
  build: BuildProvenance;
  adapters: { scanner: AdapterIdentity; storage: AdapterIdentity; messaging: AdapterIdentity };
  adaptersOk: boolean;
  stages: LiveStage[];
  suites: SuitesResult;
  notes: ObservationNote[];
};


export type SellerLogFacts = {
  ready: { scanner: boolean; messaging: boolean; checkout: boolean; products: number };
  components: string[];
};

/** Read the seller's plain ready line and the component-started JSON log events. */
export function readSellerLog(text: string): SellerLogFacts {
  let ready: SellerLogFacts['ready'] | undefined;
  const components = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseSellerLine(line);
    if (parsed?.kind === 'ready') ready = { scanner: parsed.scanner, messaging: parsed.messaging, checkout: parsed.checkout, products: parsed.products };
    if (parsed) continue;
    try {
      const record = JSON.parse(line) as { event?: unknown; component?: unknown; status?: unknown; ok?: unknown };
      if (record.event === 'runtime.component' && record.status === 'started' && record.ok === true && typeof record.component === 'string') {
        components.add(record.component);
      }
    } catch {
      // Non-protocol, non-JSON lines (shell prompt, warnings) carry no facts.
    }
  }
  if (!ready) throw new Error('seller log has no ready line; pass --log pointing at the running seller output');
  const missing = REQUIRED_COMPONENTS.filter((component) => !components.has(component));
  if (missing.length > 0) throw new Error(`seller log is missing started component events: ${missing.join(', ')}`);
  return { ready, components: [...components] };
}

/** Bind readiness facts to concrete source versions or deployed artifact digests. */
export function adapterIdentitiesFromLog(
  facts: SellerLogFacts,
  versions: { scanner: string; storage: string; messaging: string },
): Observations['adapters'] {
  if (!facts.ready.scanner || !facts.ready.messaging) {
    throw new Error('seller ready line does not report scanner and messaging up');
  }
  return {
    scanner: { kind: 'zcash-scanner-socket', version: versions.scanner },
    storage: { kind: 'logos-storage', version: versions.storage },
    messaging: { kind: 'waku-lightpush-filter', version: versions.messaging },
  };
}
function adaptersForCapture(capture: PublicCapture): Observations['adapters'] {
  return adapterIdentitiesFromLog(capture.sellerFacts, {
    scanner: `sha256:${capture.moduleHashes.scanner}`,
    storage: `sha256:${capture.moduleHashes.storage}`,
    messaging: `sha256:${capture.moduleHashes.messaging}`,
  });
}

function samePublicCapture(current: Observations, capture: PublicCapture): boolean {
  const deployment = current.deployment;
  if (!deployment || deployment.target !== PUBLIC_TARGET
    || deployment.containerId !== capture.containerId
    || deployment.imageId !== capture.imageId
    || deployment.imageRef !== capture.imageRef) return false;
  const build = readBuildProvenance(capture.buildInfo, EMPTY_DIFF_SHA256);
  const adapters = adaptersForCapture(capture);
  return current.build.commit === build.commit
    && current.build.dirty === build.dirty
    && current.build.diffSha256 === build.diffSha256
    && current.build.cleanBuild === build.cleanBuild
    && current.build.builtAt === build.builtAt
    && (['scanner', 'storage', 'messaging'] as const).every((name) =>
      current.adapters[name].kind === adapters[name].kind
      && current.adapters[name].version === adapters[name].version);
}



export function emptyObservations(build: BuildProvenance, adapters: Observations['adapters'], profile?: 'public'): Observations {
  return {
    ...(profile ? { profile } : {}),
    build,
    adapters,
    adaptersOk: (['scanner', 'storage', 'messaging'] as const).every((name) => adapterIdentityErrors(name, adapters[name]).length === 0),
    stages: [],
    suites: { ok: true, evidence: [], rows: {} },
    notes: [],
  };
}

function writePrivate(file: string, text: string): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o777) !== 0o700) {
    throw new Error('private output directory must have mode 0700');
  }
  try {
    const fileInfo = lstatSync(file);
    if (!fileInfo.isFile()) throw new Error('private output must be a regular file');
    chmodSync(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadObservations(file: string): Observations {
  if (!existsSync(file)) throw new Error(`no observations file at ${file}; run init first`);
  return JSON.parse(readFileSync(file, 'utf8')) as Observations;
}

/** Append or replace one workflow stage. A refused evidence value fails the row and is never stored. */
export function recordStage(
  observations: Observations,
  id: string,
  status: LiveStageStatus,
  evidence: string[],
): { observations: Observations; overwritten: boolean; refused: boolean } {
  const publicProfile = observations.profile === 'public';
  const allowed = publicProfile
    ? (PUBLIC_STAGE_IDS as readonly string[]).includes(id)
    : WORKFLOW_IDS.has(id);
  if (!allowed) {
    const expected = publicProfile ? PUBLIC_STAGE_IDS.join(', ') : WORKFLOW_STAGE_IDS.join(', ');
    throw new Error(`unknown stage id '${id}'; expected one of ${expected}`);
  }
  if (!STAGE_STATUSES.has(status)) throw new Error(`unknown status '${status}'; expected PASS, FAIL or NOT_RUN`);
  let row: LiveStage;
  let refused = false;
  try {
    row = { id: id as LiveStage['id'], status, ...(evidence.length > 0 ? { evidence: sanitizeEvidence(evidence) } : {}) };
  } catch {
    refused = true;
    row = { id: id as LiveStage['id'], status: 'FAIL', reason: 'evidence refused by sanitizer (sensitive value)' };
  }
  const index = observations.stages.findIndex((stage) => stage.id === id);
  const overwritten = index >= 0;
  const stages = overwritten
    ? observations.stages.map((stage, i) => (i === index ? row : stage))
    : [...observations.stages, row];
  const notes = overwritten
    ? [...observations.notes, { stageId: id, note: `overwrite: ${id} recorded again; kept the last row` }]
    : observations.notes;
  return { observations: { ...observations, stages, notes }, overwritten, refused };
}

/** Record named suite evidence for one L row. A refused value fails the row and is never stored. */
export function recordSuite(
  observations: Observations,
  id: string,
  ok: boolean,
  evidence: string[],
): { observations: Observations; refused: boolean } {
  if (!MATRIX_IDS.has(id)) throw new Error(`unknown suite id '${id}'; expected one of ${L_MATRIX_IDS.join(', ')}`);
  let row: SuiteRow;
  let refused = false;
  try {
    row = { ok, evidence: sanitizeEvidence(evidence) };
  } catch {
    refused = true;
    row = { ok: false, evidence: ['evidence refused by sanitizer (sensitive value)'] };
  }
  const rows = { ...observations.suites.rows, [id]: row };
  const suites: SuitesResult = {
    ok: Object.values(rows).every((entry) => entry?.ok !== false),
    evidence: observations.suites.evidence,
    rows,
  };
  return { observations: { ...observations, suites }, refused };
}

export function renderTable(stages: readonly { id: string; status: string }[]): string {
  return stages.map((stage) => `${stage.id} ${stage.status}`).join('\n');
}

type Io = {
  readText(file: string): string;
  readJson(file: string): unknown;
  writePrivate(file: string, text: string): void;
  exists(file: string): boolean;
  fileSha256(file: string): string | undefined;
};

function realIo(): Io {
  return {
    readText: (file) => readFileSync(file, 'utf8'),
    readJson: (file) => JSON.parse(readFileSync(file, 'utf8')),
    writePrivate,
    exists: existsSync,
    fileSha256: (file) => {
      if (!existsSync(file)) return undefined;
      const result = spawnSync('sha256sum', [file], { encoding: 'utf8' });
      return result.status === 0 ? result.stdout.split(' ')[0] : undefined;
    },
  };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
  return value;
}

function evidenceArgs(argv: string[]): string[] {
  const evidence: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--evidence') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('missing value for --evidence');
      evidence.push(value);
      i += 1;
    }
  }
  return evidence;
}

function observationsPath(argv: string[]): string {
  const explicit = flagValue(argv, '--file');
  if (explicit) return explicit;
  if (process.env.SSF_OBSERVE_ROOT) return path.join(process.env.SSF_OBSERVE_ROOT, 'observations.json');
  if (flagValue(argv, '--profile') === 'public') return path.join(REPO_ROOT, '.runtime/public/observations.json');
  return OBSERVATIONS_PATH;
}

function save(file: string, observations: Observations, io: Io): void {
  io.writePrivate(file, `${JSON.stringify(observations, null, 2)}\n`);
}

function withoutFlag(argv: string[], flag: string): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      i += 1;
      continue;
    }
    kept.push(argv[i]!);
  }
  return kept;
}

function assemblePublicReport(current: Observations, rest: string[]): LiveReport {
  const txid = flagValue(rest, '--txid');
  const wallet = flagValue(rest, '--wallet');
  const walletVersion = flagValue(rest, '--wallet-version');
  const lightwalletd = flagValue(rest, '--lightwalletd');
  const confirmations = Number(flagValue(rest, '--confirmations'));
  const complete = typeof txid === 'string'
    && typeof wallet === 'string'
    && typeof walletVersion === 'string'
    && typeof lightwalletd === 'string'
    && Number.isInteger(confirmations)
    && confirmations >= PUBLIC_MIN_CONFIRMATIONS;
  let t01: TestnetStage;
  if (!complete || txid === undefined || wallet === undefined || walletVersion === undefined || lightwalletd === undefined) {
    t01 = { id: 'T01', status: 'NOT_RUN', reason: 'testnet block not recorded' };
  } else {
    try {
      const endpoint = new URL(lightwalletd);
      if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(wallet)
        || walletVersion.length > 128 || /[\r\n]/.test(walletVersion)
        || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
        throw new Error('unsafe public testnet report value');
      }
      t01 = {
        id: 'T01',
        status: 'PASS',
        evidence: sanitizeEvidence([`wallet ${wallet}`, `wallet-version ${walletVersion}`, `lightwalletd ${lightwalletd}`, `confirmations ${confirmations}`]),
        testnet: { network: 'test', wallet, walletVersion, lightwalletd, txid, confirmations },
      };
    } catch {
      t01 = { id: 'T01', status: 'NOT_RUN', reason: 'testnet block refused by sanitizer' };
    }
  }
  return {
    schemaVersion: 1,
    liveAttempted: true,
    profile: 'public',
    network: 'test',
    build: current.build,
    scanner: current.adapters.scanner,
    storage: current.adapters.storage,
    messaging: current.adapters.messaging,
    stages: [...current.stages, t01],
  };
}

export function run(argv: string[], io: Io = realIo()): number {
  const profileFlag = flagValue(argv, '--profile');
  if (profileFlag !== undefined && profileFlag !== 'public') throw new Error('--profile must be public');
  const profile = profileFlag === 'public' ? 'public' as const : undefined;
  const [command, ...rest] = withoutFlag(argv, '--profile');
  const scoped = profile ? ['--profile', profile, ...rest] : rest;
  if (command === 'init') {
    const file = observationsPath(scoped);
    if (io.exists(file)) throw new Error('observations already exist; refusing to overwrite init state');
    if (profile === 'public') {
      if (rest.includes('--build-info') || rest.includes('--log') || rest.includes('--deployment-evidence')) {
        throw new Error(PUBLIC_CAPTURE_FAILURE);
      }
      const capture = collectPublicCapture();
      try {
        const build = readBuildProvenance(capture.buildInfo, EMPTY_DIFF_SHA256);
        const facts = capture.sellerFacts;
        const adapters = adapterIdentitiesFromLog(facts, {
          scanner: `sha256:${capture.moduleHashes.scanner}`,
          storage: `sha256:${capture.moduleHashes.storage}`,
          messaging: `sha256:${capture.moduleHashes.messaging}`,
        });
        const observations = emptyObservations(build, adapters, profile);
        observations.deployment = {
          target: PUBLIC_TARGET,
          containerId: capture.containerId,
          imageId: capture.imageId,
          imageRef: capture.imageRef,
        };
        save(file, observations, io);
        process.stdout.write(`init ok: authenticated ${PUBLIC_TARGET}; container=${capture.containerId.slice(0, 12)} image=${capture.imageId.slice(7, 19)} ready scanner=${facts.ready.scanner} messaging=${facts.ready.messaging} checkout=${facts.ready.checkout} products=${facts.ready.products}\n`);
        return 0;
      } catch {
        throw new Error(PUBLIC_CAPTURE_FAILURE);
      }
    }
    const buildInfoPath = flagValue(rest, '--build-info') ?? path.join(REPO_ROOT, 'dist', 'build-info.json');
    const logPath = flagValue(rest, '--log') ?? DEFAULT_SELLER_LOG;
    const build = readBuildProvenance(io.readJson(buildInfoPath), EMPTY_DIFF_SHA256);
    const facts = readSellerLog(io.readText(logPath));
    const logosctl = path.join(LIVE_ROOT, 'logos', 'bin', 'logosctl-aarch64.AppImage');
    const versions = {
      scanner: cargoVersion(io.readText(path.join(REPO_ROOT, 'services', 'scanner', 'Cargo.toml'))),
      messaging: packageVersion(io.readText(path.join(REPO_ROOT, 'package.json')), '@waku/sdk'),
      storage: io.fileSha256(logosctl)?.slice(0, 12) ?? 'unresolved',
    };
    const adapters = adapterIdentitiesFromLog(facts, versions);
    save(file, emptyObservations(build, adapters, profile), io);
    process.stdout.write(`init ok: ready scanner=${facts.ready.scanner} messaging=${facts.ready.messaging} checkout=${facts.ready.checkout} products=${facts.ready.products}\n`);
    return 0;
  }

  if (command === 'stage' || command === 'suite') {
    const file = observationsPath(scoped);
    const current = loadFrom(file, io);
    const id = rest.find((arg) => !arg.startsWith('--') && arg !== flagValue(rest, '--status'));
    if (!id) throw new Error(`usage: live-observe ${command} <id> ...`);
    if (command === 'stage') {
      const status = flagValue(rest, '--status');
      if (!status) throw new Error('usage: live-observe stage <id> --status PASS|FAIL|NOT_RUN --evidence "<text>"...');
      const result = recordStage(current, id, status as LiveStageStatus, evidenceArgs(rest));
      save(file, result.observations, io);
      if (result.overwritten) process.stdout.write(`overwrite: ${id} recorded again; kept the last row\n`);
      if (result.refused) process.stdout.write(`${id} FAIL: evidence refused by sanitizer; value not written\n`);
      return 0;
    }
    const ok = rest.includes('--ok');
    const fail = rest.includes('--fail');
    if (ok === fail) throw new Error('usage: live-observe suite <L-id> --ok|--fail --evidence ...');
    const result = recordSuite(current, id, ok, evidenceArgs(rest));
    save(file, result.observations, io);
    if (result.refused) process.stdout.write(`${id} FAIL: evidence refused by sanitizer; value not written\n`);
    return 0;
  }

  if (command === 'finalize') {
    const file = observationsPath(scoped);
    const current = loadFrom(file, io);
    if (profile === 'public' && current.profile !== 'public') {
      throw new Error('public finalize requires public-profile observations');
    }
    const report = current.profile === 'public'
      ? assemblePublicReport(current, rest)
      : assembleLiveReport({
        build: current.build,
        adapters: current.adapters,
        stages: current.stages,
        suites: current.suites,
        adaptersOk: current.adaptersOk,
      });
    const validation = validateLiveReport(report);
    const rows = report.stages.map((stage) => ({ id: stage.id, status: stage.status }));
    const errors = [...validation.errors];
    if (current.profile === 'public') {
      if (!current.deployment) {
        errors.push('deployment: no authenticated Pi capture in observations');
      } else if (errors.length === 0) {
        try {
          if (!samePublicCapture(current, collectPublicCapture())) {
            errors.push('deployment: current Pi capture differs from init; refusing public report');
          }
        } catch {
          errors.push('deployment: live VPS evidence could not be revalidated; refusing public report');
        }
      }
    }
    if (current.profile === 'public' && !report.stages.some((stage) => stage.id === 'T01' && stage.status === 'PASS')) {
      errors.push('T01: public finalize requires PASS testnet evidence');
    }
    process.stdout.write(`${renderTable(rows)}\n`);
    if (current.profile === 'public' && errors.length > 0) {
      process.stdout.write(`${errors.join('\n')}\n`);
      return 1;
    }
    const outPath = flagValue(rest, '--out') ?? (current.profile === 'public' ? path.join(path.dirname(file), 'report.json') : REPORT_PATH);
    if (current.profile === 'public' && path.dirname(path.resolve(outPath)) !== path.resolve(path.dirname(file))) {
      throw new Error('public report must be stored beside observations in the private public runtime directory');
    }
    io.writePrivate(outPath, `${JSON.stringify(report, null, 2)}\n`);
    if (errors.length > 0) {
      process.stdout.write(`${errors.join('\n')}\n`);
      return 1;
    }
    return 0;
  }

  throw new Error('usage: live-observe [--profile public] init [--deployment-evidence <private-path>] | stage <id> --status PASS|FAIL|NOT_RUN --evidence "<text>" | suite <L-id> --ok|--fail --evidence ... | finalize');
}

function loadFrom(file: string, io: Io): Observations {
  if (!io.exists(file)) throw new Error(`no observations file at ${file}; run init first`);
  return io.readJson(file) as Observations;
}

function cargoVersion(toml: string): string {
  const match = /^version = "([^"]+)"/m.exec(toml);
  if (!match) throw new Error('scanner Cargo.toml has no version');
  return match[1]!;
}

function packageVersion(text: string, name: string): string {
  const pkg = JSON.parse(text) as { dependencies?: Record<string, string> };
  const version = pkg.dependencies?.[name];
  if (!version) throw new Error(`${name} is not a dependency`);
  return version.replace(/^[^\d]*/, '');
}

function isMain(): boolean {
  const current = fileURLToPath(import.meta.url);
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return current === invoked;
}

if (isMain()) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
