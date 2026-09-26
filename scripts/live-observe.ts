// Manual-run recorder for the Task 12 live acceptance session.
//
// `init` captures build provenance and the running seller's adapter identities
// into a 0600 observations file. `stage` / `suite` append observed rows only;
// L matrix rows are never typed by hand — `finalize` derives them through
// assembleLiveReport, which also forces T01 to NOT_RUN (D4). Evidence is
// sanitized; a refused value fails the row and is never written.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  WORKFLOW_STAGE_IDS,
  adapterIdentityErrors,
  validateLiveReport,
  type AdapterIdentity,
  type BuildProvenance,
  type LiveStage,
  type LiveStageStatus,
  type WorkflowStageId,
} from './live-report.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** sha256 of an empty buffer: the digest clean-build writes for a clean tree. */
const EMPTY_DIFF_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Ready line plus the component-started log events a running seller emits. */
const REQUIRED_COMPONENTS = ['scanner', 'storage', 'waku'] as const;

export const DEFAULT_SELLER_LOG = path.join(LIVE_ROOT, 'diag', 'manual-seller.log');
const OBSERVATIONS_PATH = path.join(LIVE_ROOT, 'demo', 'observations.json');
const REPORT_PATH = path.join(LIVE_ROOT, 'demo', 'report.json');

const WORKFLOW_IDS = new Set<string>(WORKFLOW_STAGE_IDS);
const MATRIX_IDS = new Set<string>(L_MATRIX_IDS);
const STAGE_STATUSES = new Set<LiveStageStatus>(['PASS', 'FAIL', 'NOT_RUN']);

export type ObservationNote = { stageId: string; note: string };
export type Observations = {
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

/**
 * Adapter identities read from the running seller: the ready line proves the
 * scanner and messaging adapters are actually up, and the component log proves
 * storage. Versions come from the pinned sources the running build was made
 * from (scanner crate, @waku/sdk, logosctl AppImage digest prefix).
 */
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

export function emptyObservations(build: BuildProvenance, adapters: Observations['adapters']): Observations {
  return {
    build,
    adapters,
    adaptersOk: (['scanner', 'storage', 'messaging'] as const).every((name) => adapterIdentityErrors(name, adapters[name]).length === 0),
    stages: [],
    suites: { ok: true, evidence: [], rows: {} },
    notes: [],
  };
}

function writePrivate(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
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
  if (!WORKFLOW_IDS.has(id)) throw new Error(`unknown stage id '${id}'; expected one of ${WORKFLOW_STAGE_IDS.join(', ')}`);
  if (!STAGE_STATUSES.has(status)) throw new Error(`unknown status '${status}'; expected PASS, FAIL or NOT_RUN`);
  let row: LiveStage;
  let refused = false;
  try {
    row = { id: id as WorkflowStageId, status, ...(evidence.length > 0 ? { evidence: sanitizeEvidence(evidence) } : {}) };
  } catch {
    refused = true;
    row = { id: id as WorkflowStageId, status: 'FAIL', reason: 'evidence refused by sanitizer (sensitive value)' };
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
  return flagValue(argv, '--file') ?? (process.env.SSF_OBSERVE_ROOT
    ? path.join(process.env.SSF_OBSERVE_ROOT, 'observations.json')
    : OBSERVATIONS_PATH);
}

function save(file: string, observations: Observations, io: Io): void {
  io.writePrivate(file, `${JSON.stringify(observations, null, 2)}\n`);
}

export function run(argv: string[], io: Io = realIo()): number {
  const [command, ...rest] = argv;
  if (command === 'init') {
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
    save(observationsPath(rest), emptyObservations(build, adapters), io);
    process.stdout.write(`init ok: ready scanner=${facts.ready.scanner} messaging=${facts.ready.messaging} checkout=${facts.ready.checkout} products=${facts.ready.products}\n`);
    return 0;
  }

  if (command === 'stage' || command === 'suite') {
    const file = observationsPath(rest);
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
    const file = observationsPath(rest);
    const current = loadFrom(file, io);
    const report = assembleLiveReport({
      build: current.build,
      adapters: current.adapters,
      stages: current.stages,
      suites: current.suites,
      adaptersOk: current.adaptersOk,
    });
    const validation = validateLiveReport(report);
    const outPath = flagValue(rest, '--out') ?? REPORT_PATH;
    io.writePrivate(outPath, `${JSON.stringify(report, null, 2)}\n`);
    const rows = report.stages.map((stage) => ({ id: stage.id, status: stage.status }));
    process.stdout.write(`${renderTable(rows)}\n`);
    if (!validation.ok) {
      process.stdout.write(`${validation.errors.join('\n')}\n`);
      return 1;
    }
    return 0;
  }

  throw new Error('usage: live-observe init | stage <id> --status PASS|FAIL|NOT_RUN --evidence "..." | suite <L-id> --ok|--fail --evidence "..." | finalize');
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
