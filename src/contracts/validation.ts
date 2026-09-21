import type {
  DeliveryState,
  ExceptionCode,
  PaymentState,
} from './types.ts';

export const MAX_PAYLOAD_BYTES = 65_536;
export const INVOICE_TTL_MS = 86_400_000;

const PAYMENT_STATES = new Set<PaymentState>([
  'awaiting', 'detected', 'confirming', 'confirmed', 'review_required', 'reorged',
]);
const DELIVERY_STATES = new Set<DeliveryState>([
  'locked', 'prepared', 'queued', 'sent_unacknowledged', 'acknowledged', 'retry_required',
]);
const EXCEPTION_CODES = new Set<ExceptionCode>([
  'underpayment', 'overpayment', 'late', 'unmatched', 'duplicate',
  'reorg_after_release', 'delivery_failed', 'verification_unavailable',
]);

const SAPLING_TEST = /^ztestsapling1[0-9a-z]+$/;
const UA_TEST = /^utest1[0-9a-z]+$/;
const UA_REGTEST = /^uregtest1[0-9a-z]+$/;
const TRANSPARENT = /^(t[13]|tm)[1-9A-HJ-NP-Za-km-z]+$/;
const MAINNET_SHIELDED = /^(zs1|u1)[0-9a-z]+$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function assertCanonicalAmountZat(value: string): void {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new ValidationError('amount must be a canonical unsigned decimal string');
  }
}

export function parseAmountZat(value: string): bigint {
  assertCanonicalAmountZat(value);
  return BigInt(value);
}

export function assertNetwork(value: string): asserts value is 'test' {
  if (value === 'mainnet' || value === 'main') {
    throw new ValidationError('mainnet is forbidden');
  }
  if (value !== 'test') {
    throw new ValidationError('unknown network');
  }
}

export function assertProductNetwork(value: string): asserts value is 'test' | 'regtest' {
  if (value === 'mainnet' || value === 'main') {
    throw new ValidationError('mainnet is forbidden');
  }
  if (value !== 'test' && value !== 'regtest') {
    throw new ValidationError('unknown network');
  }
}

export function assertPaymentState(value: string): asserts value is PaymentState {
  if (!PAYMENT_STATES.has(value as PaymentState)) {
    throw new ValidationError('invalid payment state');
  }
}

export function assertDeliveryState(value: string): asserts value is DeliveryState {
  if (!DELIVERY_STATES.has(value as DeliveryState)) {
    throw new ValidationError('invalid delivery state');
  }
}

export function assertExceptionCode(value: string): asserts value is ExceptionCode {
  if (!EXCEPTION_CODES.has(value as ExceptionCode)) {
    throw new ValidationError('invalid exception code');
  }
}

export function assertPayloadSize(payload: Uint8Array | string): void {
  const size = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.byteLength;
  if (size > MAX_PAYLOAD_BYTES) {
    throw new ValidationError('payload exceeds size limit');
  }
}

export function assertTestnetShieldedAddress(address: string): void {
  if (typeof address !== 'string' || address.length === 0) {
    throw new ValidationError('malformed address');
  }
  if (TRANSPARENT.test(address)) {
    throw new ValidationError('transparent addresses are not allowed');
  }
  if (MAINNET_SHIELDED.test(address) || address.startsWith('zs1') || address.startsWith('u1')) {
    throw new ValidationError('mainnet addresses are not allowed');
  }
  if (!SAPLING_TEST.test(address) && !UA_TEST.test(address) && !UA_REGTEST.test(address)) {
    throw new ValidationError('address is not a testnet or regtest shielded receiver');
  }
}

export function assertHexIdentity(value: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length < 64 || value.length % 2 !== 0) {
    throw new ValidationError('malformed cryptographic identity');
  }
}

export function assertRequiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`malformed payload: ${field}`);
  }
  assertPayloadSize(value);
}
