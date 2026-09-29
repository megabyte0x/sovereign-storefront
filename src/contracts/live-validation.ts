import { isReceiptPool } from './live.ts';
import type { ChainIdentity, ReceiptPool, ReceiverAllocation, ReceiverRef, ScanSnapshot } from './live.ts';
import { ValidationError } from './validation.ts';

export const MAX_SNAPSHOT_RECEIPTS = 10_000;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_ENCRYPTED_ENVELOPE_BYTES = 65_536;
export const ORCHARD_RECEIVER_BYTES = 43;
export const ORCHARD_DIVERSIFIER_INDEX_BYTES = 11;
export const MAX_MONEY_ZAT = 21_000_000n * 100_000_000n;
export const MAX_SAFE_PROTOCOL_INTEGER = Number.MAX_SAFE_INTEGER;
const FIXTURE_PURPOSE = 'non-production protocol compatibility vector; contains no wallet material';

type Row = Record<string, unknown>;
type Revision = { height: number; hash: string };
type ProtocolIdentity = ChainIdentity & { accountId: string };
type ProtocolProduct = { version: string; amountZat: string; network: ChainIdentity['network']; ciphertextCid: string; ciphertextDigest: string };
type ProtocolObservation = { outputId: string; sourceId: string; generation: string; chainNetwork: ChainIdentity['network']; txid: string; pool: ReceiptPool; outputIndex: number };
type ProtocolPackage = { orderId: string; productVersion: string; buyerKeyId: string; packageId: string; encryptedEnvelopeBytes: number };
type NegativeCase = { name: string; candidate: Row };
type ProtocolNegative = { snapshots: NegativeCase[]; allocations: NegativeCase[]; vectors: NegativeCase[] };
export type ProtocolVector = {
  version: 1; fixturePurpose: typeof FIXTURE_PURPOSE; identity: ProtocolIdentity; product: ProtocolProduct;
  snapshot: ScanSnapshot; allocation: ReceiverAllocation; observation: ProtocolObservation;
  preparedPackage: ProtocolPackage; negative: ProtocolNegative;
};

function fail(field: string): never {
  throw new ValidationError(`malformed payload: ${field}`);
}

function record(value: unknown, field: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field);
  return value as Row;
}

function exact(row: Row, field: string, required: readonly string[]): void {
  const keys = Object.keys(row);
  if (keys.length !== required.length || required.some((key) => !(key in row)) || keys.some((key) => !required.includes(key))) {
    fail(field);
  }
}

function text(value: unknown, field: string, max = 65_536): string {
  if (typeof value !== 'string' || Array.from(value).length === 0 || Array.from(value).length > max) fail(field);
  return value;
}

function boundedText(value: unknown, field: string, max: number): string {
  return text(value, field, max);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(field);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}

function hex(value: unknown, field: string, bytes: number): string {
  const result = text(value, field, bytes * 2);
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(result)) fail(field);
  return result;
}

function hash(value: unknown, field: string): string {
  return hex(value, field, 32);
}

function positiveAmount(value: unknown, field: string): string {
  const amount = text(value, field, 16);
  if (!/^[1-9][0-9]*$/.test(amount)) fail(field);
  let parsed: bigint;
  try { parsed = BigInt(amount); } catch { fail(field); }
  if (parsed > MAX_MONEY_ZAT) fail(field);
  return amount;
}

function generation(value: unknown, field: string): string {
  const result = text(value, field, 256);
  if (!/^[1-9][0-9]*$/.test(result)) fail(field);
  return result;
}

function revision(value: unknown, field: string): Revision {
  const row = record(value, field);
  exact(row, field, ['height', 'hash']);
  return { height: nonNegativeInteger(row.height, `${field}.height`), hash: hash(row.hash, `${field}.hash`) };
}

export function validateChainIdentity(value: unknown): ChainIdentity {
  const row = record(value, 'chain');
  exact(row, 'chain', ['network', 'genesisHash', 'consensusFingerprint']);
  if (row.network !== 'test' && row.network !== 'regtest') fail('chain.network');
  return {
    network: row.network,
    genesisHash: hash(row.genesisHash, 'chain.genesisHash'),
    consensusFingerprint: hash(row.consensusFingerprint, 'chain.consensusFingerprint'),
  };
}

function validateProtocolIdentity(value: unknown): ProtocolIdentity {
  const row = record(value, 'identity');
  exact(row, 'identity', ['network', 'genesisHash', 'consensusFingerprint', 'accountId']);
  const chain = validateChainIdentity({ network: row.network, genesisHash: row.genesisHash, consensusFingerprint: row.consensusFingerprint });
  return { ...chain, accountId: boundedText(row.accountId, 'identity.accountId', 256) };
}

export function validateReceiver(value: unknown, expectedAccountId?: string): ReceiverRef {
  const row = record(value, 'receiver');
  exact(row, 'receiver', ['accountId', 'scope', 'pool', 'diversifierIndex', 'receiverHex']);
  const accountId = boundedText(row.accountId, 'receiver.accountId', 256);
  if (expectedAccountId !== undefined && accountId !== expectedAccountId) {
    throw new ValidationError('receiver account does not match allocation');
  }
  if (row.scope !== 'external' || row.pool !== 'orchard') fail('receiver scope/pool');
  return {
    accountId,
    scope: 'external',
    pool: 'orchard',
    diversifierIndex: hex(row.diversifierIndex, 'receiver.diversifierIndex', ORCHARD_DIVERSIFIER_INDEX_BYTES),
    receiverHex: hex(row.receiverHex, 'receiver.receiverHex', ORCHARD_RECEIVER_BYTES),
  };
}

function sameChain(a: ChainIdentity, b: ChainIdentity): boolean {
  return a.network === b.network && a.genesisHash === b.genesisHash && a.consensusFingerprint === b.consensusFingerprint;
}

export function validateAllocation(value: unknown): ReceiverAllocation {
  const row = record(value, 'allocation');
  exact(row, 'allocation', ['allocationId', 'chain', 'accountId', 'amountZat', 'expiresAt', 'destination', 'receiver', 'paymentUri']);
  const chain = validateChainIdentity(row.chain);
  const accountId = boundedText(row.accountId, 'allocation.accountId', 256);
  const paymentUri = boundedText(row.paymentUri, 'allocation.paymentUri', 4096);
  if (!paymentUri.startsWith('zcash:')) fail('allocation.paymentUri');
  return {
    allocationId: boundedText(row.allocationId, 'allocation.allocationId', 256),
    chain,
    accountId,
    amountZat: positiveAmount(row.amountZat, 'allocation.amountZat'),
    expiresAt: nonNegativeInteger(row.expiresAt, 'allocation.expiresAt'),
    destination: boundedText(row.destination, 'allocation.destination', 4096),
    receiver: validateReceiver(row.receiver, accountId),
    paymentUri,
  };
}

function validateReceipt(value: unknown, index: number): ScanSnapshot['receipts'][number] {
  const field = `snapshot.receipts.${index}`;
  const row = record(value, field);
  exact(row, field, ['outputId', 'txid', 'pool', 'outputIndex', 'accountId', 'scope', 'receiverHex', 'amountZat', 'firstSeenAt', 'mined', 'canonical']);
  if (!isReceiptPool(row.pool)) fail(`${field}.pool`);
  const pool = row.pool;
  if (row.scope !== 'external' && row.scope !== 'internal') fail(`${field}.scope`);
  return {
    outputId: boundedText(row.outputId, `${field}.outputId`, 256),
    txid: hash(row.txid, `${field}.txid`),
    pool,
    outputIndex: nonNegativeInteger(row.outputIndex, `${field}.outputIndex`),
    accountId: boundedText(row.accountId, `${field}.accountId`, 256),
    scope: row.scope,
    receiverHex: hex(row.receiverHex, `${field}.receiverHex`, ORCHARD_RECEIVER_BYTES),
    amountZat: positiveAmount(row.amountZat, `${field}.amountZat`),
    firstSeenAt: nonNegativeInteger(row.firstSeenAt, `${field}.firstSeenAt`),
    mined: row.mined === null ? null : revision(row.mined, `${field}.mined`),
    canonical: boolean(row.canonical, `${field}.canonical`),
  };
}

export function validateSnapshot(value: unknown): ScanSnapshot {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) throw new ValidationError('snapshot exceeds byte limit');
  const row = record(value, 'snapshot');
  exact(row, 'snapshot', ['version', 'sourceId', 'generation', 'chain', 'accountId', 'tip', 'scanned', 'checkedAt', 'caughtUp', 'complete', 'health', 'receipts']);
  if (row.version !== 1) fail('snapshot.version');
  if (!Array.isArray(row.receipts) || row.receipts.length > MAX_SNAPSHOT_RECEIPTS) throw new ValidationError('snapshot exceeds receipt limit');
  const accountId = boundedText(row.accountId, 'snapshot.accountId', 256);
  const receipts = row.receipts.map(validateReceipt);
  if (receipts.some((receipt) => receipt.accountId !== accountId)) throw new ValidationError('receipt account does not match snapshot account');
  if (new Set(receipts.map((receipt) => receipt.outputId)).size !== receipts.length) throw new ValidationError('snapshot contains duplicate output IDs');
  if (new Set(receipts.map((receipt) => `${receipt.txid}:${receipt.pool}:${receipt.outputIndex}`)).size !== receipts.length) throw new ValidationError('snapshot contains duplicate receipt identity');
  if (row.health !== 'ready' && row.health !== 'syncing' && row.health !== 'unavailable') fail('snapshot.health');
  return {
    version: 1,
    sourceId: boundedText(row.sourceId, 'snapshot.sourceId', 256),
    generation: generation(row.generation, 'snapshot.generation'),
    chain: validateChainIdentity(row.chain),
    accountId,
    tip: revision(row.tip, 'snapshot.tip'),
    scanned: revision(row.scanned, 'snapshot.scanned'),
    checkedAt: nonNegativeInteger(row.checkedAt, 'snapshot.checkedAt'),
    caughtUp: boolean(row.caughtUp, 'snapshot.caughtUp'),
    complete: boolean(row.complete, 'snapshot.complete'),
    health: row.health,
    receipts,
  };
}

function validateProduct(value: unknown): ProtocolProduct {
  const row = record(value, 'product');
  exact(row, 'product', ['version', 'amountZat', 'network', 'ciphertextCid', 'ciphertextDigest']);
  if (row.network !== 'test' && row.network !== 'regtest') fail('product.network');
  return {
    version: boundedText(row.version, 'product.version', 256),
    amountZat: positiveAmount(row.amountZat, 'product.amountZat'),
    network: row.network,
    ciphertextCid: boundedText(row.ciphertextCid, 'product.ciphertextCid', 4096),
    ciphertextDigest: hash(row.ciphertextDigest, 'product.ciphertextDigest'),
  };
}

function validateObservation(value: unknown): ProtocolObservation {
  const row = record(value, 'observation');
  exact(row, 'observation', ['outputId', 'sourceId', 'generation', 'chainNetwork', 'txid', 'pool', 'outputIndex']);
  if (row.chainNetwork !== 'test' && row.chainNetwork !== 'regtest') fail('observation.chainNetwork');
  if (!isReceiptPool(row.pool)) fail('observation.pool');
  const pool = row.pool;
  return {
    outputId: boundedText(row.outputId, 'observation.outputId', 256),
    sourceId: boundedText(row.sourceId, 'observation.sourceId', 256),
    generation: generation(row.generation, 'observation.generation'),
    chainNetwork: row.chainNetwork,
    txid: hash(row.txid, 'observation.txid'),
    pool,
    outputIndex: nonNegativeInteger(row.outputIndex, 'observation.outputIndex'),
  };
}

function validatePackage(value: unknown): ProtocolPackage {
  const row = record(value, 'preparedPackage');
  exact(row, 'preparedPackage', ['orderId', 'productVersion', 'buyerKeyId', 'packageId', 'encryptedEnvelopeBytes']);
  const encryptedEnvelopeBytes = nonNegativeInteger(row.encryptedEnvelopeBytes, 'preparedPackage.encryptedEnvelopeBytes');
  if (encryptedEnvelopeBytes === 0 || encryptedEnvelopeBytes > MAX_ENCRYPTED_ENVELOPE_BYTES) fail('preparedPackage.encryptedEnvelopeBytes');
  return {
    orderId: boundedText(row.orderId, 'preparedPackage.orderId', 256),
    productVersion: boundedText(row.productVersion, 'preparedPackage.productVersion', 256),
    buyerKeyId: boundedText(row.buyerKeyId, 'preparedPackage.buyerKeyId', 256),
    packageId: hash(row.packageId, 'preparedPackage.packageId'),
    encryptedEnvelopeBytes,
  };
}

function validateNegativeCases(value: unknown, field: string): NegativeCase[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) fail(field);
  return value.map((item, index) => {
    const row = record(item, `${field}.${index}`);
    exact(row, `${field}.${index}`, ['name', 'candidate']);
    const candidate = record(row.candidate, `${field}.${index}.candidate`);
    if (Object.keys(candidate).length === 0) fail(`${field}.${index}.candidate`);
    return { name: boundedText(row.name, `${field}.${index}.name`, 256), candidate };
  });
}

function validateNegative(value: unknown): ProtocolNegative {
  const row = record(value, 'negative');
  exact(row, 'negative', ['snapshots', 'allocations', 'vectors']);
  return {
    snapshots: validateNegativeCases(row.snapshots, 'negative.snapshots'),
    allocations: validateNegativeCases(row.allocations, 'negative.allocations'),
    vectors: validateNegativeCases(row.vectors, 'negative.vectors'),
  };
}

export function validateProtocolVector(value: unknown): ProtocolVector {
  const row = record(value, 'protocol vector');
  exact(row, 'protocol vector', ['version', 'fixturePurpose', 'identity', 'product', 'snapshot', 'allocation', 'observation', 'preparedPackage', 'negative']);
  if (row.version !== 1) fail('protocol vector.version');
  if (row.fixturePurpose !== FIXTURE_PURPOSE) fail('protocol vector.fixturePurpose');
  const identity = validateProtocolIdentity(row.identity);
  const product = validateProduct(row.product);
  const snapshot = validateSnapshot(row.snapshot);
  const allocation = validateAllocation(row.allocation);
  const observation = validateObservation(row.observation);
  const preparedPackage = validatePackage(row.preparedPackage);
  const negative = validateNegative(row.negative);

  const chain = { network: identity.network, genesisHash: identity.genesisHash, consensusFingerprint: identity.consensusFingerprint };
  if (product.network !== identity.network || !sameChain(snapshot.chain, chain) || !sameChain(allocation.chain, chain)) {
    throw new ValidationError('protocol vector chain/network binding');
  }
  if (snapshot.accountId !== identity.accountId || allocation.accountId !== identity.accountId || allocation.receiver.accountId !== identity.accountId) {
    throw new ValidationError('protocol vector account binding');
  }
  if (product.amountZat !== allocation.amountZat) throw new ValidationError('protocol vector amount binding');
  const observed = snapshot.receipts.find((receipt) => receipt.outputId === observation.outputId);
  if (!observed || observation.sourceId !== snapshot.sourceId || observation.generation !== snapshot.generation
    || observation.chainNetwork !== identity.network || observation.txid !== observed.txid
    || observation.pool !== observed.pool || observation.outputIndex !== observed.outputIndex) {
    throw new ValidationError('protocol vector observation identity binding');
  }
  return { version: 1, fixturePurpose: FIXTURE_PURPOSE, identity, product, snapshot, allocation, observation, preparedPackage, negative };
}

function mustReject(name: string, validate: (candidate: Row) => unknown, candidate: Row): string {
  try {
    validate(candidate);
  } catch {
    return name;
  }
  throw new ValidationError(`negative protocol vector was accepted: ${name}`);
}

/** Validates the fixture's actual invalid candidates; it succeeds only when every candidate is rejected. */
export function validateNegativeProtocolVectors(value: unknown): string[] {
  const vector = validateProtocolVector(value);
  return [
    ...vector.negative.snapshots.map(({ name, candidate }) => mustReject(name, validateSnapshot, candidate)),
    ...vector.negative.allocations.map(({ name, candidate }) => mustReject(name, validateAllocation, candidate)),
    ...vector.negative.vectors.map(({ name, candidate }) => mustReject(name, (patch) => validateProtocolVector({ ...vector, ...patch }), candidate)),
  ];
}

export function sameReceiver(a: ReceiverRef, b: ReceiverRef): boolean {
  return a.accountId === b.accountId && a.scope === b.scope && a.pool === b.pool && a.receiverHex === b.receiverHex;
}

export function eligibleSnapshot(snapshot: ScanSnapshot, now: number, maxAgeMs: number): boolean {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return false;
  if (snapshot.checkedAt > now || now - snapshot.checkedAt > maxAgeMs) return false;
  return snapshot.health === 'ready' && snapshot.complete && snapshot.caughtUp
    && snapshot.tip.height === snapshot.scanned.height && snapshot.tip.hash === snapshot.scanned.hash;
}

export function sameChainIdentity(a: ChainIdentity, b: ChainIdentity): boolean {
  return sameChain(a, b);
}
