import { makeOutputId } from './output-id.ts';
import type {
  Invoice,
  Observation,
  Policy,
  ScanHealth,
} from './types.ts';

/**
 * Live zakura/regtest observation adapter.
 *
 * Does not call WalletRead. GET /accounts on 0.2.1 omitted UFVK; this
 * process never stores a seed or viewing key. Receipts map dashboard
 * status/activity/transaction JSON onto Observation/ScanHealth.
 */

export const LIVE_PROBE_POLICY: Policy = {
  minConfirmations: 1,
  maxHealthAgeMs: 120_000,
};

export const DASHBOARD =
  process.env.ZAKURA_DASHBOARD ?? 'http://127.0.0.1:32771';

export type LiveNetworkLabel = 'zakura/regtest';

export type LiveReceipt = {
  networkLabel: LiveNetworkLabel;
  nodeChain: string;
  network: string;
  outputId: string;
  amountZat: string;
  destinationUa: string;
  memoText: string | null;
  confirmations: number;
  canonical: boolean;
  receivedAt: number;
  revision: { id: string; height: number };
};

export type FaucetResult = {
  txid: string;
  toAccount: number;
  amountZat: string;
  destinationPool: string;
  status: string;
  blockHash: string | null;
};

export type LiveTransaction = {
  txid: string;
  confirmations: number;
  height: number | null;
  blockHash: string | null;
  inActiveChain: boolean;
  vinCount: number;
  voutCount: number;
  orchardActions: number;
};

type JsonObject = Record<string, unknown>;

const memosByTxid = new Map<string, string>();

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

function takeMemo(raw: JsonObject): string | null {
  const memo = raw.memo;
  delete raw.memo;
  if (typeof memo !== 'string') return null;
  const trimmed = memo.replace(/\0+$/g, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rememberMemo(txid: string, raw: JsonObject): void {
  const memo = takeMemo(raw);
  if (memo) memosByTxid.set(txid, memo);
}

async function zakuraJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${DASHBOARD}${path}`, init);
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

export async function loadZakuraAccounts(): Promise<Map<number, string>> {
  const raw = await zakuraJson('/api/v1/accounts');
  if (!Array.isArray(raw)) throw new Error('accounts is not an array');
  const accounts = new Map<number, string>();
  for (const item of raw) {
    const row = asObject(item, 'account');
    const id = asNumber(row.id, 'account.id');
    const ua = asString(row.unified_address, 'account.unified_address');
    if (typeof row.unified_full_viewing_key === 'string') {
      throw new Error('UFVK must not be retained from GET /accounts');
    }
    accounts.set(id, ua);
  }
  return accounts;
}

export async function loadZakuraStatus(): Promise<{
  nodeChain: string;
  network: string;
  height: number;
  bestBlockHash: string;
  fullyScannedHeight: number;
  observedHeight: number;
  walletState: string;
  walletError: string | null;
  autoMine: boolean;
}> {
  const status = asObject(await zakuraJson('/api/v1/status'), 'status');
  const node = asObject(status.node, 'status.node');
  const sync = asObject(status.wallet_sync, 'status.wallet_sync');
  return {
    nodeChain: asString(node.chain, 'node.chain'),
    network: asString(status.network, 'status.network'),
    height: asNumber(node.blocks, 'node.blocks'),
    bestBlockHash: asString(node.bestblockhash, 'node.bestblockhash'),
    fullyScannedHeight: asNumber(sync.fully_scanned_height, 'fully_scanned_height'),
    observedHeight: asNumber(sync.observed_height, 'observed_height'),
    walletState: asString(sync.state, 'wallet_sync.state'),
    walletError: sync.error === null ? null : asString(sync.error, 'wallet_sync.error'),
    autoMine: status.auto_mine === true,
  };
}

export async function loadZakuraHealth(): Promise<ScanHealth> {
  const status = await loadZakuraStatus();
  const caughtUp =
    status.walletState === 'ready' &&
    status.walletError === null &&
    status.fullyScannedHeight === status.height &&
    status.observedHeight === status.height;
  return {
    healthy: caughtUp,
    checkedAt: Date.now(),
    revision: { id: status.bestBlockHash, height: status.height },
    caughtUp,
  };
}

export async function faucetOrchard(input: {
  accountId: number;
  amountZat: string;
  idempotencyKey: string;
  memoText?: string;
}): Promise<FaucetResult> {
  const body: JsonObject = {
    account_id: input.accountId,
    pool: 'orchard',
    amount_zatoshi: Number(input.amountZat),
    idempotency_key: input.idempotencyKey,
  };
  if (input.memoText !== undefined) {
    body.memo = input.memoText;
  }
  const raw = asObject(
    await zakuraJson('/api/v1/faucet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'faucet',
  );
  const txid = asString(raw.txid, 'faucet.txid');
  rememberMemo(txid, raw);
  return {
    txid,
    toAccount: asNumber(raw.to_account, 'faucet.to_account'),
    amountZat: String(asNumber(raw.amount_zatoshi, 'faucet.amount_zatoshi')),
    destinationPool: asString(raw.destination_pool, 'faucet.destination_pool'),
    status: asString(raw.status, 'faucet.status'),
    blockHash: raw.block_hash === null ? null : asString(raw.block_hash, 'faucet.block_hash'),
  };
}

export async function fetchTransaction(txid: string): Promise<LiveTransaction> {
  const raw = asObject(
    await zakuraJson(`/api/v1/transactions/${txid}`),
    'transaction',
  );
  const orchard = raw.orchard === undefined ? {} : asObject(raw.orchard, 'orchard');
  const actions = Array.isArray(orchard.actions) ? orchard.actions : [];
  const vin = Array.isArray(raw.vin) ? raw.vin : [];
  const vout = Array.isArray(raw.vout) ? raw.vout : [];
  return {
    txid: asString(raw.txid, 'tx.txid'),
    confirmations: asNumber(raw.confirmations, 'tx.confirmations'),
    height: raw.height === undefined || raw.height === null ? null : asNumber(raw.height, 'tx.height'),
    blockHash:
      raw.blockhash === undefined || raw.blockhash === null
        ? null
        : asString(raw.blockhash, 'tx.blockhash'),
    inActiveChain: raw.in_active_chain === true,
    vinCount: vin.length,
    voutCount: vout.length,
    orchardActions: actions.length,
  };
}

export async function observeActivity(
  funded: FaucetResult,
  accounts: Map<number, string>,
): Promise<LiveReceipt> {
  const destinationUa = accounts.get(funded.toAccount);
  if (!destinationUa) {
    throw new Error(`missing UA for account ${funded.toAccount}`);
  }
  const tx = await fetchTransaction(funded.txid);
  const status = await loadZakuraStatus();
  const height = tx.height ?? status.height;
  const revisionId = tx.blockHash ?? status.bestBlockHash;
  if (!tx.blockHash || tx.confirmations < 1 || !tx.inActiveChain) {
    throw new Error('live receipt is not yet in an active block');
  }
  return {
    networkLabel: 'zakura/regtest',
    nodeChain: status.nodeChain,
    network: status.network,
    outputId: makeOutputId({
      txid: funded.txid,
      pool: 'orchard',
      outputIndex: 0,
    }),
    amountZat: funded.amountZat,
    destinationUa,
    memoText: memosByTxid.get(funded.txid) ?? null,
    confirmations: tx.confirmations,
    canonical: tx.inActiveChain,
    receivedAt: Date.now(),
    revision: { id: revisionId, height },
  };
}

function memoMatches(memoText: string | null, attributionRef: string): boolean {
  if (memoText === null) return true;
  return memoText.replace(/\0+$/g, '') === attributionRef;
}

/** Destination UA, then memo when present. Never amount-only. */
export function attributeLiveOutput(
  receipt: LiveReceipt,
  invoice: Invoice,
): Observation {
  const destinationOk = receipt.destinationUa === invoice.destination;
  const memoOk = memoMatches(receipt.memoText, invoice.attributionRef);
  return {
    outputId: receipt.outputId,
    invoiceId: destinationOk && memoOk ? invoice.id : null,
    amountZat: receipt.amountZat,
    confirmations: receipt.confirmations,
    canonical: receipt.canonical,
    receivedAt: receipt.receivedAt,
    revision: { ...receipt.revision },
  };
}

export async function waitForConfirmations(
  txid: string,
  mineBlocks: number,
): Promise<{ before: number; after: number }> {
  const before = (await fetchTransaction(txid)).confirmations;
  if (mineBlocks > 0) {
    await zakuraJson('/api/v1/mine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: mineBlocks }),
    });
  }
  const after = (await fetchTransaction(txid)).confirmations;
  return { before, after };
}
