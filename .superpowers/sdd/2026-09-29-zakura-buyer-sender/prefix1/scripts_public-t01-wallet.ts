// Public T01 buyer wallet: a capped, testnet-only front end for the Zakura
// sender `tools/buyer-sender` (binary `ssf-buyer-sender`). It pays at most
// MAX_SENDS invoices, each at most once, records every attempt in the send
// ledger before the sender can broadcast, and resolves unknown outcomes only by
// asking the chain or rebroadcasting the identical signed bytes; it never builds
// a second transaction for an invoice with an unresolved attempt. The invoice
// URI is handed to the sender through a private 0600 file, never on argv, and
// nothing here prints the receiver, the URI, the wallet's addresses or any key.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, '.runtime/public');

export const MAX_SENDS = 2;
/** Per-invoice ceiling: 0.01 TAZ. Public T01 books cost 0.001 TAZ. */
export const MAX_INVOICE_ZAT = 1_000_000n;
/** Headroom left for the ZIP-317 fee of each send. */
export const FEE_RESERVE_ZAT = 100_000n;
export const LIGHTWALLETD = 'https://testnet.zec.rocks:443';
export const SENDER_BINARY = path.join(ROOT, 'tools/buyer-sender/target/release/ssf-buyer-sender');

const ZAT_PER_ZEC = 100_000_000n;
const REFUSED = 'no wallet command was invoked';
/** Exit code the default runner reports when the sender binary could not be started at all. */
export const SPAWN_FAILED = 127;

/** Runs `ssf-buyer-sender <args>`; the default adds `--lightwalletd LIGHTWALLETD`. */
export type SenderRunner = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;
export type WalletDeps = {
  runner?: SenderRunner;
  ledgerPath?: string;
  /** Directory for the private temp URI file (default `.runtime/public`). */
  tempDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

export type TestnetPayment = { address: string; amountZat: bigint; memo: string | null };
// 'expired': an attempt that never paid. Set by `resolve` when the sender reports the
// transaction absent past its expiry height (`resolvedBy: 'chain'`), or by hand after
// checking both scanners (`resolvedBy: 'manual'` or absent on older records). It does
// not count toward the cap or mark its invoice paid.
export type SendRecord = {
  status: 'pending' | 'sent' | 'expired';
  invoiceDigest: string;
  amountZat: string;
  txid?: string;
  expiryHeight?: number;
  resolvedBy?: 'chain' | 'manual';
  at?: string;
  failedAtHeight?: number;
};
export type Ledger = { sends: SendRecord[] };

function amountToZat(amount: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(amount);
  if (!match) throw new Error('invoice amount is malformed');
  return BigInt(match[1]) * ZAT_PER_ZEC + BigInt((match[2] ?? '').padEnd(8, '0'));
}

function base64UrlToUtf8(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('invoice memo is not base64url');
  const text = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(text, 'utf8').length > 512) throw new Error('invoice memo is too long');
  return text;
}

/** Parse a single-payment public-testnet ZIP-321 URI (unified `utest1` receiver). */
export function parseTestnetZip321(uri: string): TestnetPayment {
  if (!uri.startsWith('zcash:')) throw new Error('invoice URI scheme is not zcash:');
  const body = uri.slice('zcash:'.length);
  if (body.includes('#')) throw new Error('invoice URI has a fragment');
  const marker = body.indexOf('?');
  if (marker <= 0) throw new Error('invoice URI needs an address and an amount');
  const address = body.slice(0, marker);
  if (!/^utest1[02-9ac-hj-np-z]{20,}$/.test(address)) throw new Error('invoice address is not a testnet unified address');
  const params = new URLSearchParams(body.slice(marker + 1));
  const keys = [...params.keys()];
  if (keys.length === 0 || keys.some((key) => key !== 'amount' && key !== 'memo') || new Set(keys).size !== keys.length) {
    throw new Error('invoice URI must carry one amount and at most one memo');
  }
  if (!params.has('amount')) throw new Error('invoice URI has no amount');
  const amountZat = amountToZat(params.get('amount') ?? '');
  if (amountZat <= 0n || amountZat > MAX_INVOICE_ZAT) throw new Error('invoice amount is out of range');
  const memoParam = params.get('memo');
  return { address, amountZat, memo: memoParam === null ? null : base64UrlToUtf8(memoParam) };
}

/** Attempt id: sha256 of the exact URI string (no trim). The sender hashes the exact URI-file bytes. */
export function invoiceDigest(uri: string): string {
  return createHash('sha256').update(uri).digest('hex');
}

export function readLedger(file: string): Ledger {
  if (!existsSync(file)) return { sends: [] };
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const sends = (parsed as Ledger | null)?.sends;
  if (!Array.isArray(sends)) throw new Error('send ledger is malformed');
  return { sends };
}

export function writeLedger(file: string, ledger: Ledger): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** Strips receivers, viewing keys and hex blobs longer than a txid from wallet output. */
export function redactWalletText(text: string): string {
  return text
    .replace(/\b(?:u|utest|uview|uviewtest|ztestsapling|zs|tm|t1)1?[a-z0-9]{30,}\b/gi, '[REDACTED]')
    .replace(/\b[0-9a-f]{65,}\b/gi, '[REDACTED]');
}

const SENDER_COMMANDS = new Set(['import', 'status', 'pay', 'tx-status', 'rebroadcast']);

const defaultRunner: SenderRunner = (args) => new Promise((resolve) => {
  const child = spawn(SENDER_BINARY, ['--lightwalletd', LIGHTWALLETD, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const keepDiagnostics = (code: number | null): void => {
    // Private, git-ignored sender diagnostics; only the command word is logged, and
    // receivers, keys and long hex blobs are redacted from stderr.
    const command = args.find((arg) => SENDER_COMMANDS.has(arg)) ?? 'other';
    const text = redactWalletText(stderr).slice(-8000);
    mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(RUNTIME, 'wallet-stderr.log'), `--- ${new Date().toISOString()} ${command} exit=${code}\n${text}\n`, { mode: 0o600 });
  };
  let settled = false;
  child.on('error', () => {
    if (settled) return;
    settled = true;
    try { keepDiagnostics(null); } catch { /* diagnostics are best effort */ }
    resolve({ code: SPAWN_FAILED, stdout: '' });
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    try { keepDiagnostics(code); } catch { /* diagnostics are best effort */ }
    resolve({ code: code ?? 1, stdout });
  });
});

/** Strict parse of the sender's stdout: exactly one JSON object, nothing else. */
export function parseSenderJson(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isTxid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isHeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isZat(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

/** The sender's fixed error string, or a fixed fallback; never raw output. */
function senderError(stdout: string, fallback: string): string {
  const error = parseSenderJson(stdout)?.error;
  return typeof error === 'string' && /^[A-Za-z0-9 .,:;'()_/-]{1,200}$/.test(error) ? error : fallback;
}

export type SenderStatus = { network: 'test'; tip: number; spendableZat: bigint; orchardZat: bigint; ironwoodZat: bigint };

async function senderStatus(runner: SenderRunner): Promise<SenderStatus> {
  const result = await runner(['status']);
  const json = result.code === 0 ? parseSenderJson(result.stdout) : null;
  if (json === null) throw new Error(`wallet status is unavailable (${senderError(result.stdout, `sender exit ${result.code}`)})`);
  const { network, tip, spendableZat, orchardZat, ironwoodZat } = json;
  if (network !== 'test' || !isHeight(tip) || !isZat(spendableZat) || !isZat(orchardZat) || !isZat(ironwoodZat)) {
    throw new Error('wallet status is malformed');
  }
  return { network, tip, spendableZat: BigInt(spendableZat), orchardZat: BigInt(orchardZat), ironwoodZat: BigInt(ironwoodZat) };
}

export type ResolveSummary = { sent: number; expired: number; removed: number; pending: number; rebroadcast: number };

/**
 * Resolves every `pending` ledger record against the chain through the sender, in
 * place; the caller writes the ledger. Never builds a new transaction: the only
 * write action is `rebroadcast`, which resends the identical signed bytes.
 * - no txid yet: `tx-status`; exit 2 `no attempt recorded` means the sender never
 *   wrote an attempt (nothing was broadcast), so the record is removed.
 * - `mined` → `sent`; `expired` → `expired` (both `resolvedBy: 'chain'`).
 * - `not_found` / `forked` → one `rebroadcast`, stays pending.
 * - `mempool`, exit 3, or any other failure → stays pending (still blocks new sends).
 */
export async function resolvePending(ledger: Ledger, runner: SenderRunner): Promise<ResolveSummary> {
  const summary: ResolveSummary = { sent: 0, expired: 0, removed: 0, pending: 0, rebroadcast: 0 };
  const removed = new Set<SendRecord>();
  for (const record of ledger.sends) {
    if (record.status !== 'pending') continue;
    const result = await runner(['tx-status', '--attempt-id', record.invoiceDigest]);
    const json = parseSenderJson(result.stdout);
    if (result.code === 2 && json?.error === 'no attempt recorded') {
      if (isTxid(record.txid)) {
        // The ledger holds a txid the sender no longer knows: never drop a record that
        // may have been broadcast. Leave it for a manual check.
        summary.pending += 1;
        continue;
      }
      removed.add(record);
      summary.removed += 1;
      continue;
    }
    if (result.code !== 0 || json === null || (record.txid !== undefined && json.txid !== record.txid)) {
      summary.pending += 1;
      continue;
    }
    if (record.txid === undefined && isTxid(json.txid)) record.txid = json.txid;
    if (record.expiryHeight === undefined && isHeight(json.expiryHeight)) record.expiryHeight = json.expiryHeight;
    switch (json.state) {
      case 'mined':
        if (!isTxid(record.txid)) { summary.pending += 1; break; }
        record.status = 'sent';
        record.resolvedBy = 'chain';
        summary.sent += 1;
        break;
      case 'expired':
        record.status = 'expired';
        record.resolvedBy = 'chain';
        summary.expired += 1;
        break;
      case 'not_found':
      case 'forked':
        await runner(['rebroadcast', '--attempt-id', record.invoiceDigest]).catch(() => null);
        summary.rebroadcast += 1;
        summary.pending += 1;
        break;
      default:
        summary.pending += 1;
    }
  }
  if (removed.size > 0) ledger.sends = ledger.sends.filter((send) => !removed.has(send));
  return summary;
}

/** Writes the exact URI (no trailing newline) to a fresh 0600 file; the caller deletes it. */
function writeUriFile(dir: string, uri: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `pay-uri-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, uri);
  } finally {
    closeSync(fd);
  }
  return file;
}

export async function runPublicT01Wallet(argv: readonly string[], deps: WalletDeps = {}): Promise<number> {
  const runner = deps.runner ?? defaultRunner;
  const ledgerPath = deps.ledgerPath ?? path.join(RUNTIME, 'buyer-sends.json');
  const tempDir = deps.tempDir ?? RUNTIME;
  const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const refuse = (reason: string, invoked = false): number => {
    err(`BLOCKED: ${reason}${invoked ? '' : `; ${REFUSED}`}\n`);
    return 2;
  };
  const live = (ledger: Ledger): SendRecord[] => ledger.sends.filter((send) => send.status !== 'expired');

  if (argv.length === 1 && argv[0] === 'status') {
    let ledger: Ledger;
    try {
      ledger = readLedger(ledgerPath);
    } catch {
      return refuse('send ledger is malformed');
    }
    try {
      const status = await senderStatus(runner);
      const pending = ledger.sends.filter((send) => send.status === 'pending').length;
      const sends = live(ledger).length;
      out(`${JSON.stringify({
        network: status.network,
        tip: status.tip,
        spendableZat: status.spendableZat.toString(),
        orchardZat: status.orchardZat.toString(),
        ironwoodZat: status.ironwoodZat.toString(),
        sends,
        pending,
        remaining: Math.max(0, MAX_SENDS - sends),
      })}\n`);
      return 0;
    } catch (error) {
      return refuse((error as Error).message, true);
    }
  }

  if (argv.length === 1 && argv[0] === 'resolve') {
    let ledger: Ledger;
    try {
      ledger = readLedger(ledgerPath);
    } catch {
      return refuse('send ledger is malformed');
    }
    if (!ledger.sends.some((send) => send.status === 'pending')) {
      out(`${JSON.stringify({ sent: 0, expired: 0, removed: 0, pending: 0, rebroadcast: 0 })}\n`);
      return 0;
    }
    const summary = await resolvePending(ledger, runner);
    writeLedger(ledgerPath, ledger);
    out(`${JSON.stringify(summary)}\n`);
    return 0;
  }

  if (argv.length !== 3 || argv[0] !== 'send' || argv[1] !== '--uri') {
    return refuse('unsupported public T01 wallet operation (use: status | resolve | send --uri <zip321>)');
  }
  const uri = argv[2];
  let ledger: Ledger;
  try {
    ledger = readLedger(ledgerPath);
  } catch {
    return refuse('send ledger is malformed');
  }
  let invoked = false;
  if (ledger.sends.some((send) => send.status === 'pending')) {
    invoked = true;
    await resolvePending(ledger, runner);
    writeLedger(ledgerPath, ledger);
  }
  let payment: TestnetPayment;
  try {
    payment = parseTestnetZip321(uri);
  } catch (error) {
    return refuse((error as Error).message, invoked);
  }
  const digest = invoiceDigest(uri);
  if (ledger.sends.some((send) => send.status === 'pending')) {
    return refuse('an earlier send is unresolved; it will be resolved automatically (resolve); do not pay again', invoked);
  }
  if (live(ledger).some((send) => send.invoiceDigest === digest)) return refuse('this invoice was already paid', invoked);
  if (live(ledger).length >= MAX_SENDS) return refuse(`purchase cap of ${MAX_SENDS} sends reached`, invoked);

  let status: SenderStatus;
  try {
    status = await senderStatus(runner);
  } catch (error) {
    return refuse((error as Error).message, true);
  }
  if (status.spendableZat < payment.amountZat + FEE_RESERVE_ZAT) return refuse('spendable balance does not cover the invoice plus fee reserve', true);

  let uriFile: string;
  try {
    uriFile = writeUriFile(tempDir, uri);
  } catch {
    return refuse('could not write the private invoice file', true);
  }
  try {
    const record: SendRecord = { status: 'pending', invoiceDigest: digest, amountZat: payment.amountZat.toString(), at: new Date().toISOString() };
    ledger.sends.push(record);
    writeLedger(ledgerPath, ledger);

    const result = await runner(['pay', '--uri-file', uriFile, '--attempt-id', digest]);
    const json = parseSenderJson(result.stdout);

    if (result.code === 2 || result.code === SPAWN_FAILED) {
      // Refused before any broadcast (a signed transaction may exist in the sender's
      // wallet with its notes locked until expiry, but nothing was broadcast).
      ledger.sends = ledger.sends.filter((send) => send !== record);
      writeLedger(ledgerPath, ledger);
      const reason = result.code === SPAWN_FAILED ? 'sender binary could not be started' : senderError(result.stdout, 'sender refused the payment');
      err(`BLOCKED: ${reason}; nothing was broadcast\n`);
      return 2;
    }

    if (json !== null && json.attemptId === digest && isTxid(json.txid)) record.txid = json.txid;
    if (json !== null && json.attemptId === digest && isHeight(json.expiryHeight)) record.expiryHeight = json.expiryHeight;

    if (result.code === 0 && json?.broadcast === 'accepted' && record.txid !== undefined && record.expiryHeight !== undefined) {
      record.status = 'sent';
      writeLedger(ledgerPath, ledger);
      out(`${JSON.stringify({ status: 'sent', txid: record.txid, amountZat: record.amountZat })}\n`);
      return 0;
    }

    // Exit 3 / 4, a non-accepted broadcast, unparseable output or any other exit:
    // the outcome is unknown. Keep the record pending and ask the chain.
    writeLedger(ledgerPath, ledger);
    await resolvePending(ledger, runner);
    writeLedger(ledgerPath, ledger);
    if (record.status === 'sent' && record.txid !== undefined) {
      out(`${JSON.stringify({ status: 'sent', txid: record.txid, amountZat: record.amountZat })}\n`);
      return 0;
    }
    err('UNRESOLVED: the broadcast outcome is unknown; the send is recorded as pending and will be resolved automatically; do not pay again\n');
    return 3;
  } finally {
    try { unlinkSync(uriFile); } catch { /* already gone */ }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPublicT01Wallet(process.argv.slice(2));
}
