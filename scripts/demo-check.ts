import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialAdapter } from '../src/adapters/credentials.ts';
import { FIRST_RELEASE_MAX_CIPHERTEXT_BYTES, FIRST_RELEASE_MAX_PLAINTEXT_BYTES } from '../src/adapters/crypto.ts';
import { createMemoryMessaging } from '../src/adapters/messaging.ts';
import { MemoryScanner } from '../src/adapters/scanner.ts';
import { createMemoryStorageAdapter, detectLogosRuntime } from '../src/adapters/storage.ts';
import { BEARER_SECRET_WARNING } from '../src/browser/purchases.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { Invoice } from '../src/contracts/types.ts';
import { startSeller } from '../src/seller/server.ts';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export type CheckResult = {
  id: string;
  status: CheckStatus;
  detail: string;
};

export type ThsProbe = {
  running: boolean;
  version?: string;
  dashboard?: string;
  nodeChain?: string;
  network?: string;
  healthy?: boolean;
  caughtUp?: boolean;
  height?: number;
};

export type LogosProbe = {
  ok: boolean;
  reason?: string;
  independentPeers?: boolean;
};

export type LiveAdapterKind = 'memory' | 'real';

export type PreflightInput = {
  nodeVersion: string;
  env: NodeJS.Dict<string>;
  ths?: ThsProbe | null;
  logos?: LogosProbe | null;
  chromiumPath?: string | null;
  tlsTerminatedByApp?: boolean;
  liveAdapters?: {
    messaging: LiveAdapterKind;
    storage: LiveAdapterKind;
    scanner: LiveAdapterKind;
  };
};

export type PreflightResult = {
  ok: boolean;
  checks: CheckResult[];
  minConfirmations: number;
  networkLabel: 'zakura/regtest' | 'unproven';
  nodeChain: string | null;
  publicTestnet: false;
  walletReadWired: false;
};

export type LiveStepResult = {
  steps: CheckResult[];
  timings?: Record<string, number>;
  sizes?: Record<string, number>;
  txid?: string;
  faucetConfirmations?: number;
  policyConfirmations?: number;
};

export type DemoCheckResult = {
  ok: boolean;
  liveAttempted: boolean;
  preflight: CheckResult[];
  steps: CheckResult[];
  minConfirmations: number;
  networkLabel: 'zakura/regtest' | 'unproven';
  nodeChain: string | null;
  publicTestnet: false;
  walletReadWired: false;
  independentReplicaBytes: 73;
  zip321Qr: 'unproven';
  timings?: Record<string, number>;
  sizes?: Record<string, number>;
  txid?: string;
  faucetConfirmations?: number;
  policyConfirmations?: number;
};

const POLICY_MIN_CONFIRMATIONS = 10;

export function isOverallPass(checks: CheckResult[]): boolean {
  return checks.length > 0 && checks.every((item) => item.status === 'PASS');
}

function check(id: string, status: CheckStatus, detail: string): CheckResult {
  return { id, status, detail };
}

export type PaymentPath = {
  scannerKind: 'memory' | 'wallet-read';
  injectedObservation: boolean;
  outputIndexKnown: boolean;
};

export type AdapterPath = {
  configReal: boolean;
  liveMessaging: LiveAdapterKind;
  liveStorage: LiveAdapterKind;
  liveScanner: LiveAdapterKind;
};

export function classifyAdapters(path: AdapterPath): CheckResult {
  if (!path.configReal) {
    return check('adapters', 'FAIL', 'real-demo requires real messaging/storage/scanner adapters');
  }
  if (path.liveMessaging === 'memory' || path.liveStorage === 'memory' || path.liveScanner === 'memory') {
    return check(
      'adapters',
      'SKIP',
      'config selected real adapters; live constructs MemoryScanner, createMemoryMessaging(), and createMemoryStorageAdapter()',
    );
  }
  return check('adapters', 'PASS', 'real adapters selected and used; no fixture fallback');
}

export function classifyPayment(path: PaymentPath): CheckResult {
  if (path.scannerKind === 'memory' || path.injectedObservation || !path.outputIndexKnown) {
    return check(
      'payment',
      'SKIP',
      'MemoryScanner synthetic observation is not in-app settlement; faucet tx is chain evidence only. WalletRead not wired; output index unknown',
    );
  }
  return check('payment', 'PASS', 'WalletRead compact-block settlement with known output index');
}

export type CheckoutPath = {
  browserLaunched: boolean;
  httpOnly: boolean;
};

export function classifyCheckout(path: CheckoutPath): CheckResult {
  if (!path.browserLaunched || path.httpOnly) {
    return check(
      'checkout',
      'SKIP',
      'HTTP checkout is not open browser checkout / reopen same browser; Chromium was not launched',
    );
  }
  return check('checkout', 'PASS', 'opened browser checkout and reopened the same browser');
}

export type ReplicaRetrievePath = {
  twoNodesDetected: boolean;
  originStopped: boolean;
  retrieved: boolean;
  originStopUnsafeReason?: string;
  reason?: string;
};

export function classifyReplicaRetrieve(path: ReplicaRetrievePath): CheckResult {
  if (path.retrieved && path.originStopped) {
    return check(
      'replica-retrieve',
      'PASS',
      'ciphertext retrieved from independent replica after origin stop',
    );
  }
  if (path.originStopUnsafeReason) {
    return check('replica-retrieve', 'SKIP', path.originStopUnsafeReason);
  }
  if (path.twoNodesDetected) {
    return check(
      'replica-retrieve',
      'FAIL',
      'two Logos nodes detected; origin was not stopped and replica retrieve was not attempted. Gate B independent retrieval remains 73 ciphertext bytes',
    );
  }
  return check(
    'replica-retrieve',
    'FAIL',
    path.reason ?? 'independent storage replica is absent',
  );
}

export function classifyReplica(path: ReplicaRetrievePath): CheckResult {
  if (path.twoNodesDetected) {
    return check(
      'replica',
      'SKIP',
      'two Logos nodes detected; origin-stop retrieve is a live step, not a preflight pass',
    );
  }
  return check(
    'replica',
    'FAIL',
    path.reason ?? 'independent storage replica is absent',
  );
}

export type ChromiumPath = {
  path: string | null;
  launched: boolean;
};

export function classifyChromium(path: ChromiumPath): CheckResult {
  if (!path.path) {
    return check('chromium', 'SKIP', 'chromium not found');
  }
  if (!path.launched) {
    return check('chromium', 'SKIP', `chromium present at ${path.path} but not launched for checkout`);
  }
  return check('chromium', 'PASS', path.path);
}

export type RecoverPath = {
  usedInjectedObservation: boolean;
  browserReopened: boolean;
};

export function classifyRecover(path: RecoverPath): CheckResult {
  if (path.usedInjectedObservation || !path.browserReopened) {
    return check(
      'recover',
      'SKIP',
      'HTTP recover after seller restart is not reopen-same-browser; settlement was not observed by WalletRead',
    );
  }
  return check('recover', 'PASS', 'reopened same browser and recovered without re-paying');
}

function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const checks: CheckResult[] = [];
  const nodeMajor = parseNodeMajor(input.nodeVersion);
  checks.push(nodeMajor >= 22
    ? check('node', 'PASS', `node ${input.nodeVersion}`)
    : check('node', 'FAIL', `node ${input.nodeVersion} is below 22`));

  const networkRaw = input.env.SSF_NETWORK ?? 'test';
  if (networkRaw === 'mainnet' || networkRaw === 'main') {
    checks.push(check('network', 'FAIL', 'mainnet is forbidden'));
  } else if (networkRaw === 'test' || networkRaw === 'regtest') {
    const label = input.ths?.network === 'Regtest' ? 'zakura/regtest' : networkRaw;
    checks.push(check('network', 'PASS', `${label}; node.chain=${input.ths?.nodeChain ?? 'unknown'} is not public testnet`));
  } else {
    checks.push(check('network', 'FAIL', `invalid SSF_NETWORK ${networkRaw}`));
  }

  let minConfirmations = POLICY_MIN_CONFIRMATIONS;
  const minRaw = input.env.SSF_MIN_CONFIRMATIONS;
  if (minRaw !== undefined && minRaw !== '') {
    const parsed = Number(minRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      checks.push(check('confirmations', 'FAIL', `invalid minConfirmations ${minRaw}`));
    } else if (parsed === 1 || parsed === 0) {
      checks.push(check('confirmations', 'FAIL', 'real-demo must not use live-probe 1 or 0; policy is 10'));
      minConfirmations = parsed;
    } else {
      minConfirmations = parsed;
      checks.push(parsed === POLICY_MIN_CONFIRMATIONS
        ? check('confirmations', 'PASS', `minConfirmations ${parsed}`)
        : check('confirmations', 'FAIL', `real-demo policy is 10, got ${parsed}`));
    }
  } else {
    checks.push(check('confirmations', 'PASS', `minConfirmations default ${POLICY_MIN_CONFIRMATIONS}`));
  }

  try {
    const cfg = loadConfig(input.env);
    const adapters = cfg.adapters;
    const live = input.liveAdapters ?? { messaging: 'memory' as const, storage: 'memory' as const, scanner: 'memory' as const };
    checks.push(classifyAdapters({
      configReal: cfg.mode === 'real-demo'
        && adapters.messaging === 'real'
        && adapters.storage === 'real'
        && adapters.scanner === 'real',
      liveMessaging: live.messaging,
      liveStorage: live.storage,
      liveScanner: live.scanner,
    }));
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : 'config failed';
    checks.push(check('adapters', 'FAIL', message));
  }

  const ths = input.ths;
  if (!ths?.running) {
    checks.push(check('scanner', 'FAIL', 'ths is not running'));
  } else if (!ths.healthy || !ths.caughtUp) {
    checks.push(check('scanner', 'FAIL', `scanner not healthy/caught-up (healthy=${String(ths.healthy)} caughtUp=${String(ths.caughtUp)})`));
  } else {
    checks.push(check('scanner', 'PASS', `ths ${ths.version ?? 'unknown'} height ${ths.height ?? '?'} healthy caught-up; WalletRead not wired`));
  }

  const logos = input.logos;
  checks.push(classifyReplica({
    twoNodesDetected: logos?.ok === true && logos.independentPeers === true,
    originStopped: false,
    retrieved: false,
    reason: logos?.reason,
  }));

  if (input.tlsTerminatedByApp) {
    checks.push(check('origin', 'FAIL', 'this tree does not terminate TLS; do not claim an HTTPS origin'));
  } else {
    checks.push(check('origin', 'PASS', 'localhost HTTP origin; app does not terminate TLS'));
  }

  checks.push(classifyChromium({ path: input.chromiumPath ?? null, launched: false }));

  const networkLabel = ths?.network === 'Regtest' ? 'zakura/regtest' : 'unproven';
  return {
    ok: isOverallPass(checks),
    checks,
    minConfirmations,
    networkLabel,
    nodeChain: ths?.nodeChain ?? null,
    publicTestnet: false,
    walletReadWired: false,
  };
}

const HARD_PREFLIGHT = new Set(['node', 'network', 'confirmations', 'adapters', 'scanner', 'replica']);

function hardPreflightFailed(checks: CheckResult[]): boolean {
  return checks.some((item) => HARD_PREFLIGHT.has(item.id) && item.status === 'FAIL');
}

export async function runDemoCheck(input: {
  preflight: PreflightInput;
  runLive?: () => Promise<LiveStepResult>;
}): Promise<DemoCheckResult> {
  const preflight = evaluatePreflight(input.preflight);
  if (hardPreflightFailed(preflight.checks)) {
    return {
      ok: false,
      liveAttempted: false,
      preflight: preflight.checks,
      steps: [],
      minConfirmations: preflight.minConfirmations,
      networkLabel: preflight.networkLabel,
      nodeChain: preflight.nodeChain,
      publicTestnet: false,
      walletReadWired: false,
      independentReplicaBytes: 73,
      zip321Qr: 'unproven',
    };
  }

  const live = input.runLive ? await input.runLive() : { steps: [] as CheckResult[] };
  const all = [...preflight.checks, ...live.steps];
  return {
    ok: isOverallPass(all),
    liveAttempted: true,
    preflight: preflight.checks,
    steps: live.steps,
    minConfirmations: preflight.minConfirmations,
    networkLabel: preflight.networkLabel,
    nodeChain: preflight.nodeChain,
    publicTestnet: false,
    walletReadWired: false,
    independentReplicaBytes: 73,
    zip321Qr: 'unproven',
    timings: live.timings,
    sizes: live.sizes,
    txid: live.txid,
    faucetConfirmations: live.faucetConfirmations,
    policyConfirmations: live.policyConfirmations,
  };
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonObject;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} is not a number`);
  }
  return value;
}

async function readJsonCommand(command: string, args: string[]): Promise<unknown> {
  const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  const status = await new Promise<number>((resolve) => proc.on('close', (code) => resolve(code ?? 1)));
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${Buffer.concat(err).toString('utf8') || text}`);
  }
  return JSON.parse(text);
}

async function dashboardJson(dashboard: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${dashboard}${path}`, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} returned non-JSON (${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  return parsed;
}

export async function probeThs(): Promise<ThsProbe> {
  try {
    const status = asObject(await readJsonCommand('ths', ['status', '--json']), 'ths status');
    const running = status.running === true;
    const endpoints = status.endpoints && typeof status.endpoints === 'object'
      ? asObject(status.endpoints, 'endpoints')
      : asObject(await readJsonCommand('ths', ['endpoints', '--json']), 'ths endpoints');
    const dashboard = asString(endpoints.dashboard, 'dashboard');
    if (!running) {
      return { running: false, dashboard };
    }
    const body = asObject(await dashboardJson(dashboard, '/api/v1/status'), 'zakura status');
    const node = asObject(body.node, 'status.node');
    const sync = asObject(body.wallet_sync, 'status.wallet_sync');
    const height = asNumber(node.blocks, 'node.blocks');
    const fullyScanned = asNumber(sync.fully_scanned_height, 'fully_scanned_height');
    const observed = asNumber(sync.observed_height, 'observed_height');
    const walletState = asString(sync.state, 'wallet_sync.state');
    const caughtUp = walletState === 'ready' && sync.error === null && fullyScanned === height && observed === height;
    return {
      running: true,
      version: '0.2.1',
      dashboard,
      nodeChain: asString(node.chain, 'node.chain'),
      network: asString(body.network, 'status.network'),
      healthy: caughtUp,
      caughtUp,
      height,
    };
  } catch (error) {
    return { running: false };
  }
}

async function ensureThsRunning(): Promise<ThsProbe> {
  let probe = await probeThs();
  if (probe.running) return probe;
  await readJsonCommand('ths', ['doctor', '--json']).catch(() => ({ ok: false }));
  const child = spawn('ths', ['start', '--no-open'], { stdio: 'ignore', detached: true });
  child.unref();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    probe = await probeThs();
    if (probe.running && probe.healthy) return probe;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return probe;
}

async function loadAccountUa(dashboard: string, accountId: number): Promise<string> {
  const raw = await dashboardJson(dashboard, '/api/v1/accounts');
  if (!Array.isArray(raw)) throw new Error('accounts is not an array');
  for (const item of raw) {
    const row = asObject(item, 'account');
    if (typeof row.unified_full_viewing_key === 'string') {
      throw new Error('UFVK must not be retained from GET /accounts');
    }
    if (asNumber(row.id, 'account.id') === accountId) {
      return asString(row.unified_address, 'account.unified_address');
    }
  }
  throw new Error(`missing account ${accountId}`);
}

async function faucetOrchard(dashboard: string, accountId: number, amountZat: string, idempotencyKey: string): Promise<{ txid: string }> {
  const raw = asObject(await dashboardJson(dashboard, '/api/v1/faucet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account_id: accountId,
      pool: 'orchard',
      amount_zatoshi: Number(amountZat),
      idempotency_key: idempotencyKey,
    }),
  }), 'faucet');
  return { txid: asString(raw.txid, 'faucet.txid') };
}

async function fetchTransaction(dashboard: string, txid: string): Promise<{
  confirmations: number;
  vinCount: number;
  voutCount: number;
  orchardActions: number;
  blockHash: string | null;
  inActiveChain: boolean;
  height: number | null;
}> {
  const raw = asObject(await dashboardJson(dashboard, `/api/v1/transactions/${txid}`), 'transaction');
  const orchard = raw.orchard === undefined ? {} : asObject(raw.orchard, 'orchard');
  const actions = Array.isArray(orchard.actions) ? orchard.actions : [];
  const vin = Array.isArray(raw.vin) ? raw.vin : [];
  const vout = Array.isArray(raw.vout) ? raw.vout : [];
  return {
    confirmations: asNumber(raw.confirmations, 'tx.confirmations'),
    vinCount: vin.length,
    voutCount: vout.length,
    orchardActions: actions.length,
    blockHash: raw.blockhash === undefined || raw.blockhash === null ? null : asString(raw.blockhash, 'tx.blockhash'),
    inActiveChain: raw.in_active_chain === true,
    height: raw.height === undefined || raw.height === null ? null : asNumber(raw.height, 'tx.height'),
  };
}

async function mineBlocks(dashboard: string, blocks: number): Promise<void> {
  if (blocks <= 0) return;
  await dashboardJson(dashboard, '/api/v1/mine', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });
}

async function postJson(url: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function sanitize(result: DemoCheckResult): DemoCheckResult {
  return {
    ...result,
    steps: result.steps.map((step) => ({
      ...step,
      detail: step.detail
        .replace(/uregtest1[a-z0-9]+/g, 'uregtest1[redacted]')
        .replace(/zcash:[^\s]+/gi, 'zcash:[redacted]'),
    })),
  };
}

async function runLiveDemo(preflight: PreflightInput, ths: ThsProbe): Promise<LiveStepResult> {
  const steps: CheckResult[] = [];
  const timings: Record<string, number> = {};
  const sizes: Record<string, number> = {
    plaintextBytes: FIRST_RELEASE_MAX_PLAINTEXT_BYTES,
    ciphertextBytes: FIRST_RELEASE_MAX_CIPHERTEXT_BYTES,
  };
  const dashboard = ths.dashboard;
  if (!dashboard) {
    return { steps: [check('payment', 'FAIL', 'ths dashboard missing')] };
  }

  steps.push(check('messaging', 'SKIP', 'live Waku Light Push is not auto-constructed; composed app uses localhost HTTP possession proofs'));
  steps.push(check('zip321-qr', 'SKIP', 'ZIP-321 QR/wallet-open unproven; copy/link URI only'));

  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ssf-demo-check-'));
  const dbPath = join(scratch, 'seller.sqlite');
  const credentials = createCredentialAdapter();
  const scanner = new MemoryScanner();
  const messaging = createMemoryMessaging();
  const storage = createMemoryStorageAdapter();
  scanner.replaceSnapshot([], { id: 'zakura-tip', height: ths.height ?? 1 }, true, Date.now());

  const destination = await loadAccountUa(dashboard, 2);
  const env = {
    ...preflight.env,
    SSF_DB_PATH: dbPath,
    SSF_DESTINATION: destination,
    SSF_PUBLIC_PORT: '0',
    SSF_ADMIN_PORT: '0',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_ADMIN_HOST: '127.0.0.1',
  };

  let seller: Awaited<ReturnType<typeof startSeller>> | undefined;
  try {
    seller = await startSeller({
      config: loadConfig(env),
      seedProduct: true,
      scanner,
      credentials,
      messaging,
      storage,
    });
    const publishStarted = Date.now();
    const product = await fetch(`${seller!.publicUrl}/api/product`);
    if (!product.ok) {
      steps.push(check('publish', 'FAIL', `product ${product.status}`));
    } else {
      timings.publishMs = Date.now() - publishStarted;
      steps.push(check('publish', 'PASS', 'harmless 41-byte fixture published'));
    }

    const buyer = await credentials.createPurchaseCredential();
    const requestId = `demo-${Date.now()}`;
    const proof = Buffer.from(await credentials.provePossession(buyer.credentialId, { orderId: requestId })).toString('base64');
    const created = await postJson(seller!.publicUrl, '/api/orders', {
      requestId,
      productVersion: 'book-v1',
      buyerKeyId: buyer.buyerKeyId,
      proof,
    });
    if (created.status !== 200) {
      steps.push(check('checkout', 'FAIL', `order create ${created.status}`));
      return { steps, timings, sizes };
    }
    const invoice = created.json as Invoice;
    steps.push(classifyCheckout({ browserLaunched: false, httpOnly: true }));

    const payStarted = Date.now();
    const funded = await faucetOrchard(dashboard, 2, invoice.amountZat, `ssf-demo-${invoice.id}`);
    const tx = await fetchTransaction(dashboard, funded.txid);
    const faucetConfirmations = tx.confirmations;
    timings.scanMs = Date.now() - payStarted;
    if (tx.vinCount !== 0 || tx.voutCount !== 0 || tx.orchardActions <= 0) {
      steps.push(check('payment', 'FAIL', `not fully shielded orchard (vin=${tx.vinCount} vout=${tx.voutCount} actions=${tx.orchardActions})`));
      return { steps, timings, sizes, txid: funded.txid, faucetConfirmations, policyConfirmations: POLICY_MIN_CONFIRMATIONS };
    }

    const confirmStarted = Date.now();
    if (tx.confirmations < POLICY_MIN_CONFIRMATIONS) {
      await mineBlocks(dashboard, POLICY_MIN_CONFIRMATIONS - tx.confirmations);
    }
    timings.confirmMs = Date.now() - confirmStarted;

    const fulfillStarted = Date.now();
    await seller!.close();
    seller = await startSeller({
      config: loadConfig(env),
      seedProduct: false,
      scanner,
      credentials,
      messaging,
      storage,
    });
    const recoverProof = Buffer.from(await credentials.provePossession(buyer.credentialId, { orderId: invoice.orderId })).toString('base64');
    await postJson(seller.publicUrl, '/api/status', { orderId: invoice.orderId, proof: recoverProof });
    await postJson(seller.publicUrl, '/api/recover', { orderId: invoice.orderId, proof: recoverProof });
    timings.fulfillMs = Date.now() - fulfillStarted;

    steps.push(classifyPayment({
      scannerKind: 'memory',
      injectedObservation: false,
      outputIndexKnown: false,
    }));
    steps.push(classifyRecover({ usedInjectedObservation: false, browserReopened: false }));

    const backup = await credentials.exportBackupMaterial(buyer.credentialId);
    if (!BEARER_SECRET_WARNING.includes('bearer secret')) {
      steps.push(check('backup', 'FAIL', 'bearer-secret warning missing'));
    } else {
      const restored = await credentials.importBackupMaterial(backup);
      const restoredProof = await credentials.provePossession(restored.credentialId, { orderId: invoice.orderId });
      const ok = await credentials.verifyPossession(buyer.buyerKeyId, restoredProof, { orderId: invoice.orderId });
      steps.push(ok
        ? check('backup', 'PASS', 'exportable Gate A hex backup restores possession; bearer-secret warning present')
        : check('backup', 'FAIL', 'imported backup did not restore possession'));
    }
    steps.push(check('cleared-recovery', 'SKIP', 'browser clear-state/no false recovery is tests/browser/recovery.spec.ts; this process has no IndexedDB'));

    const twoNodesDetected = preflight.logos?.ok === true && preflight.logos.independentPeers === true;
    steps.push(classifyReplicaRetrieve({
      twoNodesDetected,
      originStopped: false,
      retrieved: false,
      originStopUnsafeReason: twoNodesDetected
        ? 'origin-stop is unsafe because another process needs the node (shared feat-mvp-t2 Logos runtime, not a demo-owned pair)'
        : undefined,
      reason: preflight.logos?.reason,
    }));
    return {
      steps,
      timings,
      sizes,
      txid: funded.txid,
      faucetConfirmations,
      policyConfirmations: POLICY_MIN_CONFIRMATIONS,
    };
  } catch (error) {
    steps.push(check('live', 'FAIL', error instanceof Error ? error.message : 'live demo failed'));
    return { steps, timings, sizes };
  } finally {
    await seller?.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function isMain(): boolean {
  const current = fileURLToPath(import.meta.url);
  const invoked = process.argv[1] ? join(process.cwd(), process.argv[1]) : '';
  return current === process.argv[1] || current === invoked || process.argv[1]?.endsWith('demo-check.ts') === true;
}

async function main(): Promise<void> {
  const chromiumPath = existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null;
  const ths = await ensureThsRunning();
  const logosDetected = detectLogosRuntime();
  const preflightInput: PreflightInput = {
    nodeVersion: process.version,
    env: {
      SSF_MODE: 'real-demo',
      SSF_NETWORK: 'regtest',
      SSF_MIN_CONFIRMATIONS: '10',
      SSF_MAX_HEALTH_AGE_MS: '120000',
      SSF_MAX_CIPHERTEXT_BYTES: '73',
      SSF_MAX_PLAINTEXT_BYTES: '41',
      SSF_INVOICE_TTL_MS: '86400000',
      SSF_DB_PATH: '/tmp/ssf-demo-check.sqlite',
      SSF_SELLER_KEY_ID: 'seller-key-1',
      SSF_DESTINATION: 'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      SSF_ADAPTER_MESSAGING: 'real',
      SSF_ADAPTER_STORAGE: 'real',
      SSF_ADAPTER_SCANNER: 'real',
      SSF_ADMIN_TOKEN: 'demo-check-admin-token',
    },
    ths,
    logos: logosDetected.ok
      ? { ok: true, independentPeers: true }
      : { ok: false, reason: logosDetected.reason, independentPeers: false },
    chromiumPath,
    tlsTerminatedByApp: false,
    liveAdapters: { messaging: 'memory', storage: 'memory', scanner: 'memory' },
  };

  const result = sanitize(await runDemoCheck({
    preflight: preflightInput,
    runLive: () => runLiveDemo(preflightInput, ths),
  }));

  const outPath = join(process.cwd(), 'test-results', 'demo-check.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(1);
}

if (isMain()) {
  await main();
}
