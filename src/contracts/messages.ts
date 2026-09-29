import type { DeliveryPackage, LiveInvoice, OrderStatus } from './types.ts';
import type { Network } from './live.ts';
import { MAX_MONEY_ZAT, validateChainIdentity, validateReceiver } from './live-validation.ts';
import { assertCanonicalAmountZat } from './validation.ts';

export type RequestHeader = {
  version: 1; messageId: string; sellerKeyId: string;
  network: Network; issuedAt: number; expiresAt: number;
};
export type BuyerRequest = RequestHeader & (
  | { type: 'create'; requestId: string; productVersion: string; expectedAmountZat: string }
  | { type: 'status'; orderId: string }
  | { type: 'recover'; orderId: string }
  | { type: 'acknowledge'; orderId: string; packageId: string }
);
export type SellerResponse = {
  version: 1; messageId: string; inReplyTo: string;
  sellerKeyId: string; buyerKeyId: string; network: Network; issuedAt: number; expiresAt: number;
} & (
  | { type: 'invoice'; invoice: LiveInvoice }
  | { type: 'status'; orderId: string; status: OrderStatus }
  | { type: 'delivery'; packageId: string; package: DeliveryPackage }
  | { type: 'acknowledged'; orderId: string; packageId: string }
  | { type: 'error'; code: 'unavailable' | 'invalid' | 'forbidden' | 'not_eligible' | 'rate_limited' }
);
export type AuthenticatedRequest = { signerKeyId: string; body: BuyerRequest };
export type DecodedWakuMessage = {
  signerKeyId: string;
  body: BuyerRequest | SellerResponse;
  wireEnvelope: Uint8Array;
};
export type StoredDelivery = { packageId: string; wireEnvelope: Uint8Array };
export interface SellerApplication {
  handle(request: AuthenticatedRequest): Promise<SellerResponse>;
}
export interface WakuSession {
  ready(): Promise<boolean>;
  send(recipientKeyId: string, body: BuyerRequest | SellerResponse): Promise<void>;
  subscribe(handler: (message: DecodedWakuMessage) => Promise<void>): Promise<() => Promise<void>>;
  decodeStored(wireEnvelope: Uint8Array): Promise<DecodedWakuMessage>;
  close(): Promise<void>;
}
export type WakuConfig = { contentTopic: string; bootstrapPeers: string[]; peerTimeoutMs: number };

export const MAX_MESSAGE_BYTES = 65_536;
export const MAX_MESSAGE_STRING_BYTES = 4_096;
const MAX_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const idPattern = /^[A-Za-z0-9._:-]+$/;

type Row = Record<string, unknown>;

function fail(field: string): never { throw new Error(`malformed message: ${field}`); }
function row(value: unknown, field: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array) fail(field);
  return value as Row;
}
function exactKeys(value: Row, expected: string[], field: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) fail(`${field} unknown field`);
}
function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !idPattern.test(value)) fail(field);
  return value;
}
function boundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_MESSAGE_STRING_BYTES) fail(field);
  return value;
}
function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(field);
  return value;
}
function network(value: unknown, field: string): Network {
  if (value !== 'test' && value !== 'regtest') fail(field);
  return value;
}
function amount(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field);
  try {
    assertCanonicalAmountZat(value);
    if (BigInt(value) <= 0n || BigInt(value) > MAX_MONEY_ZAT) fail(field);
  } catch { fail(field); }
  return value;
}
function header(value: Row, response: boolean): void {
  const required = response
    ? ['version', 'messageId', 'inReplyTo', 'sellerKeyId', 'buyerKeyId', 'network', 'issuedAt', 'expiresAt', 'type']
    : ['version', 'messageId', 'sellerKeyId', 'network', 'issuedAt', 'expiresAt', 'type'];
  for (const key of required) if (!(key in value)) fail(key);
  if (value.version !== 1) fail('version');
  identifier(value.messageId, 'messageId');
  identifier(value.sellerKeyId, 'sellerKeyId');
  if (response) {
    identifier(value.inReplyTo, 'inReplyTo');
    identifier(value.buyerKeyId, 'buyerKeyId');
  }
  network(value.network, 'network');
  const issuedAt = timestamp(value.issuedAt, 'issuedAt');
  const expiresAt = timestamp(value.expiresAt, 'expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MESSAGE_TTL_MS) fail('expiresAt');
}
function validateInvoice(value: unknown, expectedNetwork: Network): void {
  const invoice = row(value, 'invoice');
  exactKeys(invoice, ['id', 'orderId', 'productVersion', 'buyerKeyId', 'network', 'chain', 'accountId', 'amountZat', 'destination', 'paymentUri', 'attribution', 'expiresAt'], 'invoice');
  identifier(invoice.id, 'invoice.id'); identifier(invoice.orderId, 'invoice.orderId'); identifier(invoice.productVersion, 'invoice.productVersion');
  identifier(invoice.buyerKeyId, 'invoice.buyerKeyId');
  if (network(invoice.network, 'invoice.network') !== expectedNetwork) fail('invoice.network');
  const chain = validateChainIdentity(invoice.chain);
  if (chain.network !== expectedNetwork) fail('invoice.chain');
  const accountId = identifier(invoice.accountId, 'invoice.accountId');
  amount(invoice.amountZat, 'invoice.amountZat'); boundedText(invoice.destination, 'invoice.destination');
  const paymentUri = boundedText(invoice.paymentUri, 'invoice.paymentUri');
  if (!paymentUri.startsWith('zcash:')) fail('invoice.paymentUri');
  const attribution = row(invoice.attribution, 'invoice.attribution');
  exactKeys(attribution, ['kind', 'allocationId', 'receiver'], 'invoice.attribution');
  if (attribution.kind !== 'receiver') fail('invoice.attribution.kind');
  identifier(attribution.allocationId, 'invoice.attribution.allocationId');
  validateReceiver(attribution.receiver, accountId);
  timestamp(invoice.expiresAt, 'invoice.expiresAt');
}
function validateStatus(value: unknown): void {
  const status = row(value, 'status');
  exactKeys(status, ['payment', 'delivery', 'verification', 'exceptions'], 'status');
  if (!['awaiting', 'detected', 'confirming', 'confirmed', 'review_required', 'reorged'].includes(String(status.payment))) fail('status.payment');
  if (!['locked', 'prepared', 'queued', 'sent_unacknowledged', 'acknowledged', 'retry_required'].includes(String(status.delivery))) fail('status.delivery');
  if (!['available', 'unavailable', 'stale'].includes(String(status.verification))) fail('status.verification');
  if (!Array.isArray(status.exceptions) || status.exceptions.length > 128) fail('status.exceptions');
  for (const exception of status.exceptions) {
    const item = row(exception, 'status.exceptions'); exactKeys(item, ['code'], 'status.exceptions'); identifier(item.code, 'status.exceptions.code');
  }
}
function validatePackage(value: unknown): void {
  const pkg = row(value, 'package');
  exactKeys(pkg, ['orderId', 'productVersion', 'buyerKeyId', 'encryptedEnvelope'], 'package');
  identifier(pkg.orderId, 'package.orderId'); identifier(pkg.productVersion, 'package.productVersion'); identifier(pkg.buyerKeyId, 'package.buyerKeyId');
  if (!(pkg.encryptedEnvelope instanceof Uint8Array) || pkg.encryptedEnvelope.byteLength === 0 || pkg.encryptedEnvelope.byteLength > MAX_MESSAGE_BYTES) fail('package.encryptedEnvelope');
}
function validateRequest(value: Row): BuyerRequest {
  header(value, false);
  switch (value.type) {
    case 'create':
      exactKeys(value, ['version', 'messageId', 'sellerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'requestId', 'productVersion', 'expectedAmountZat'], 'create');
      identifier(value.requestId, 'requestId'); identifier(value.productVersion, 'productVersion'); amount(value.expectedAmountZat, 'expectedAmountZat'); break;
    case 'status': case 'recover':
      exactKeys(value, ['version', 'messageId', 'sellerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'orderId'], String(value.type));
      identifier(value.orderId, 'orderId'); break;
    case 'acknowledge':
      exactKeys(value, ['version', 'messageId', 'sellerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'orderId', 'packageId'], 'acknowledge');
      identifier(value.orderId, 'orderId'); identifier(value.packageId, 'packageId'); break;
    default: fail('type');
  }
  return value as BuyerRequest;
}
function validateResponse(value: Row): SellerResponse {
  header(value, true);
  switch (value.type) {
    case 'invoice':
      exactKeys(value, ['version', 'messageId', 'inReplyTo', 'sellerKeyId', 'buyerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'invoice'], 'invoice');
      validateInvoice(value.invoice, network(value.network, 'network')); break;
    case 'status':
      exactKeys(value, ['version', 'messageId', 'inReplyTo', 'sellerKeyId', 'buyerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'orderId', 'status'], 'status');
      identifier(value.orderId, 'orderId'); validateStatus(value.status); break;
    case 'delivery':
      exactKeys(value, ['version', 'messageId', 'inReplyTo', 'sellerKeyId', 'buyerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'packageId', 'package'], 'delivery');
      identifier(value.packageId, 'packageId'); validatePackage(value.package); break;
    case 'acknowledged':
      exactKeys(value, ['version', 'messageId', 'inReplyTo', 'sellerKeyId', 'buyerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'orderId', 'packageId'], 'acknowledged');
      identifier(value.orderId, 'orderId'); identifier(value.packageId, 'packageId'); break;
    case 'error':
      exactKeys(value, ['version', 'messageId', 'inReplyTo', 'sellerKeyId', 'buyerKeyId', 'network', 'issuedAt', 'expiresAt', 'type', 'code'], 'error');
      if (!['unavailable', 'invalid', 'forbidden', 'not_eligible', 'rate_limited'].includes(String(value.code))) fail('code'); break;
    default: fail('type');
  }
  return value as SellerResponse;
}
function validateMessage(value: unknown): BuyerRequest | SellerResponse {
  const message = row(value, 'body');
  return ('inReplyTo' in message || 'buyerKeyId' in message) ? validateResponse(message) : validateRequest(message);
}
function wireReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Array.from(value) };
  return value;
}
function wireReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = value as Row;
    if (Object.keys(candidate).length === 1 && Array.isArray(candidate.$bytes)
      && candidate.$bytes.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) {
      return Uint8Array.from(candidate.$bytes as number[]);
    }
  }
  return value;
}

export function encodeMessage(body: BuyerRequest | SellerResponse): Uint8Array {
  validateMessage(body);
  const encoded = new TextEncoder().encode(JSON.stringify(body, wireReplacer));
  if (encoded.byteLength > MAX_MESSAGE_BYTES) throw new Error('message exceeds size limit');
  return encoded;
}

export function decodeMessage(value: Uint8Array): BuyerRequest | SellerResponse {
  if (!(value instanceof Uint8Array)) throw new Error('malformed message');
  if (value.byteLength > MAX_MESSAGE_BYTES) throw new Error('message exceeds size limit');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value), wireReviver); } catch { throw new Error('malformed message'); }
  return validateMessage(parsed);
}
