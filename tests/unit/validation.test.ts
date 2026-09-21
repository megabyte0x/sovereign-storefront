import { expect, test } from 'vitest';
import {
  MAX_PAYLOAD_BYTES,
  ValidationError,
  assertCanonicalAmountZat,
  assertDeliveryState,
  assertHexIdentity,
  assertNetwork,
  assertPayloadSize,
  assertPaymentState,
  assertProductNetwork,
  assertRequiredString,
  assertTestnetShieldedAddress,
  parseAmountZat,
} from '../../src/contracts/validation.ts';

test('rejects unknown and mainnet network values', () => {
  expect(() => assertNetwork('test')).not.toThrow();
  expect(() => assertNetwork('mainnet')).toThrow(ValidationError);
  expect(() => assertNetwork('main')).toThrow(ValidationError);
  expect(() => assertNetwork('foo')).toThrow(ValidationError);
  expect(() => assertProductNetwork('regtest')).not.toThrow();
  expect(() => assertProductNetwork('mainnet')).toThrow(ValidationError);
});

test('rejects negative and noncanonical amount strings and uses BigInt', () => {
  expect(() => assertCanonicalAmountZat('100000000')).not.toThrow();
  expect(() => assertCanonicalAmountZat('0')).not.toThrow();
  expect(() => assertCanonicalAmountZat('-1')).toThrow(ValidationError);
  expect(() => assertCanonicalAmountZat('01')).toThrow(ValidationError);
  expect(() => assertCanonicalAmountZat('1.0')).toThrow(ValidationError);
  expect(() => assertCanonicalAmountZat('1e2')).toThrow(ValidationError);
  expect(() => assertCanonicalAmountZat('1.5')).toThrow(ValidationError);
  expect(parseAmountZat('100000000')).toBe(100000000n);
  expect(parseAmountZat('100000000') + 1n).toBe(100000001n);
});

test('rejects malformed payloads, excessive sizes and invalid state names', () => {
  expect(() => assertRequiredString('', 'requestId')).toThrow(ValidationError);
  expect(() => assertRequiredString(undefined, 'requestId')).toThrow(ValidationError);
  expect(() => assertPayloadSize('x'.repeat(MAX_PAYLOAD_BYTES + 1))).toThrow(ValidationError);
  expect(() => assertPayloadSize(new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toThrow(ValidationError);
  expect(() => assertPaymentState('paid')).toThrow(ValidationError);
  expect(() => assertPaymentState('confirmed')).not.toThrow();
  expect(() => assertDeliveryState('shipped')).toThrow(ValidationError);
  expect(() => assertDeliveryState('queued')).not.toThrow();
});

test('rejects transparent and mainnet addresses and accepts test/regtest shielded receivers', () => {
  expect(() => assertTestnetShieldedAddress('tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU')).toThrow(ValidationError);
  expect(() =>
    assertTestnetShieldedAddress(
      'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    ),
  ).toThrow(ValidationError);
  expect(() =>
    assertTestnetShieldedAddress(
      'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez',
    ),
  ).not.toThrow();
  expect(() =>
    assertTestnetShieldedAddress(
      'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    ),
  ).not.toThrow();
  expect(() => assertHexIdentity('ab')).toThrow(ValidationError);
  expect(() => assertHexIdentity('aa'.repeat(32))).not.toThrow();
});
