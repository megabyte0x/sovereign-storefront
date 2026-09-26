// Strict validator for the Task 12 live acceptance report.
//
// A report is only "ok" when a live run was actually attempted against concrete
// (non-fixture, non-memory) adapters from a provenance-identified build, and every
// L01-L16 matrix row plus every Task 12 workflow stage PASSed with evidence.
// SKIP / unavailable / unsupported / fixture / NOT_RUN / FAIL can never produce
// overall live success. T01 (public testnet) is reported separately: it may be
// NOT_RUN with a reason, and may only be PASS with a complete testnet block.

export const LIVE_REPORT_SCHEMA_VERSION = 1 as const;

export const L_MATRIX_IDS = [
  'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08',
  'L09', 'L10', 'L11', 'L12', 'L13', 'L14', 'L15', 'L16',
] as const;

export const WORKFLOW_STAGE_IDS = [
  'publish',
  'replica-b',
  'two-invoices',
  'fund-a',
  'below-threshold',
  'threshold',
  'interrupt',
  'restart',
  'waku-recover',
  'origin-stop',
  'gateway-restart',
  'fresh-context-import',
  'decrypt-equal',
  'ack',
  'b-stays-locked',
  'normal-delivery',
  'response-loss-reconnect',
] as const;

export const TESTNET_STAGE_ID = 'T01' as const;
export const MIN_CONFIRMATIONS = 10;

export type LMatrixId = (typeof L_MATRIX_IDS)[number];
export type WorkflowStageId = (typeof WORKFLOW_STAGE_IDS)[number];
export type RequiredStageId = LMatrixId | WorkflowStageId;

export type LiveStageStatus = 'PASS' | 'FAIL' | 'SKIP' | 'NOT_RUN';

export type LiveStage = {
  id: RequiredStageId;
  status: LiveStageStatus;
  evidence?: string[];
  reason?: string;
};

export type TestnetEvidence = {
  network: 'test';
  wallet: string;
  walletVersion: string;
  lightwalletd: string;
  txid: string;
  confirmations: number;
};

export type TestnetStage =
  | { id: typeof TESTNET_STAGE_ID; status: 'NOT_RUN'; reason: string }
  | { id: typeof TESTNET_STAGE_ID; status: 'PASS'; evidence: string[]; testnet: TestnetEvidence };

export type AdapterIdentity = { kind: string; version: string };

export type BuildProvenance = {
  commit: string;
  dirty: boolean;
  /** Required when `dirty` is true: sha256 of the uncommitted diff the build was made from. */
  diffSha256?: string;
  cleanBuild: true;
  builtAt: string;
};

export type LiveReport = {
  schemaVersion: typeof LIVE_REPORT_SCHEMA_VERSION;
  liveAttempted: true;
  network: 'regtest';
  build: BuildProvenance;
  scanner: AdapterIdentity;
  storage: AdapterIdentity;
  messaging: AdapterIdentity;
  stages: Array<LiveStage | TestnetStage>;
};

export type LiveReportValidation = { ok: boolean; errors: string[] };

const REQUIRED_STAGE_IDS: readonly string[] = [...L_MATRIX_IDS, ...WORKFLOW_STAGE_IDS];
const KNOWN_STAGE_IDS = new Set<string>([...REQUIRED_STAGE_IDS, TESTNET_STAGE_ID]);

/** Adapter kinds (or tokens in them) that are never live evidence. */
const NON_LIVE_ADAPTER_TOKENS = [
  'memory', 'fixture', 'fake', 'mock', 'stub', 'synthetic', 'dummy', 'noop',
  'unavailable', 'unsupported', 'skip', 'none', 'unknown', 'double',
];
const NON_CONCRETE_VERSIONS = new Set(['', 'unknown', 'n/a', 'na', 'none', 'unavailable', 'unsupported', 'fixture', '0.0.0-fixture']);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyEvidence(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

/** Errors for one adapter identity (empty when it is a concrete live adapter). */
export function adapterIdentityErrors(name: string, value: unknown): string[] {
  const errors: string[] = [];
  validateAdapter(name, value, errors);
  return errors;
}

function validateAdapter(name: string, value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${name}: adapter identity missing`);
    return;
  }
  const { kind, version } = value;
  if (!nonEmptyString(kind)) {
    errors.push(`${name}.kind: must be a concrete adapter kind`);
  } else {
    // Split camelCase too, so 'MemoryScanner' / 'InMemoryMessaging' yield 'memory'.
    const parts = kind.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
    const hit = NON_LIVE_ADAPTER_TOKENS.find((token) => parts.includes(token));
    if (hit) errors.push(`${name}.kind: '${kind}' is not a live adapter (${hit})`);
  }
  if (!nonEmptyString(version) || NON_CONCRETE_VERSIONS.has(version.trim().toLowerCase())) {
    errors.push(`${name}.version: must be a concrete version`);
  }
}

function validateBuild(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('build: provenance missing');
    return;
  }
  if (typeof value.commit !== 'string' || !HEX40.test(value.commit)) errors.push('build.commit: must be a 40-hex git commit');
  if (typeof value.dirty !== 'boolean') errors.push('build.dirty: must be a boolean');
  if (value.dirty === true && (typeof value.diffSha256 !== 'string' || !HEX64.test(value.diffSha256))) {
    errors.push('build.diffSha256: required 64-hex diff digest for a dirty tree');
  }
  if (value.cleanBuild !== true) errors.push('build.cleanBuild: must be true (clean current-source build)');
  if (typeof value.builtAt !== 'string' || !ISO_TIMESTAMP.test(value.builtAt) || Number.isNaN(Date.parse(value.builtAt))) {
    errors.push('build.builtAt: must be an ISO-8601 UTC timestamp');
  }
}

function validateTestnetStage(stage: Record<string, unknown>, errors: string[]): void {
  if (stage.status === 'NOT_RUN') {
    if (!nonEmptyString(stage.reason)) errors.push('T01: NOT_RUN requires a reason');
    return;
  }
  if (stage.status !== 'PASS') {
    errors.push(`T01: status must be NOT_RUN (with reason) or PASS (with testnet evidence), got ${String(stage.status)}`);
    return;
  }
  if (!nonEmptyEvidence(stage.evidence)) errors.push('T01: PASS requires non-empty evidence');
  const block = stage.testnet;
  if (!isRecord(block)) {
    errors.push('T01: PASS requires a testnet evidence block');
    return;
  }
  if (block.network !== 'test') errors.push('T01.testnet.network: must be test');
  for (const key of ['wallet', 'walletVersion', 'lightwalletd'] as const) {
    if (!nonEmptyString(block[key])) errors.push(`T01.testnet.${key}: required`);
  }
  if (typeof block.txid !== 'string' || !HEX64.test(block.txid)) errors.push('T01.testnet.txid: must be a 64-hex txid');
  if (typeof block.confirmations !== 'number' || !Number.isInteger(block.confirmations) || block.confirmations < MIN_CONFIRMATIONS) {
    errors.push(`T01.testnet.confirmations: must be an integer >= ${MIN_CONFIRMATIONS}`);
  }
}

function validateStages(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('stages: must be an array');
    return;
  }
  const seen = new Set<string>();
  for (const [index, stage] of value.entries()) {
    if (!isRecord(stage) || typeof stage.id !== 'string') {
      errors.push(`stages[${index}]: must be an object with a string id`);
      continue;
    }
    const { id } = stage;
    if (!KNOWN_STAGE_IDS.has(id)) {
      errors.push(`stages[${index}]: unknown stage id '${id}'`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${id}: duplicate stage`);
      continue;
    }
    seen.add(id);
    if (id === TESTNET_STAGE_ID) {
      validateTestnetStage(stage, errors);
      continue;
    }
    if (stage.status !== 'PASS') {
      errors.push(`${id}: status ${String(stage.status)} is not PASS`);
      continue;
    }
    if (!nonEmptyEvidence(stage.evidence)) errors.push(`${id}: PASS requires non-empty evidence`);
  }
  for (const id of REQUIRED_STAGE_IDS) {
    if (!seen.has(id)) errors.push(`${id}: required stage missing`);
  }
  if (!seen.has(TESTNET_STAGE_ID)) errors.push('T01: row missing (report NOT_RUN with reason if not attempted)');
}

export function validateLiveReport(value: unknown): LiveReportValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['report: must be an object'] };
  if (value.schemaVersion !== LIVE_REPORT_SCHEMA_VERSION) errors.push(`schemaVersion: must be ${LIVE_REPORT_SCHEMA_VERSION}`);
  if (value.liveAttempted !== true) errors.push('liveAttempted: must be true');
  if ('synthetic' in value && value.synthetic !== false) errors.push('synthetic: a synthetic report is never live evidence');
  if (value.network !== 'regtest') errors.push('network: L evidence must come from the local regtest network');
  validateBuild(value.build, errors);
  validateAdapter('scanner', value.scanner, errors);
  validateAdapter('storage', value.storage, errors);
  validateAdapter('messaging', value.messaging, errors);
  validateStages(value.stages, errors);
  return { ok: errors.length === 0, errors };
}
