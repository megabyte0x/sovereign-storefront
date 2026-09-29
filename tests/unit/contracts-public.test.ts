import { describe, expect, it } from 'vitest';
import { profileFor, validateCheckoutResult, validateProductSummary } from '../../src/contracts/public.ts';
import { ValidationError } from '../../src/contracts/validation.ts';

const summary = {
  version: 'v1',
  title: 'Note',
  description: 'A note',
  amountZat: '1000',
  network: 'test' as const,
  sizeBytes: 12,
  mediaType: 'text/plain',
  available: true,
};

describe('public contracts', () => {
  it("profileFor('test') uses the utest1 prefix and omits explorerTxUrl", () => {
    const profile = profileFor('test');
    expect(profile.uaPrefix).toBe('utest1');
    expect(profile.minConfirmationsFloor).toBe(3);
    expect('explorerTxUrl' in profile).toBe(false);
  });

  it('rejects a negative sizeBytes', () => {
    expect(() => validateProductSummary({ ...summary, sizeBytes: -1 })).toThrow(ValidationError);
  });

  it('rejects a non-digit amountZat', () => {
    expect(() => validateProductSummary({ ...summary, amountZat: '12a' })).toThrow(ValidationError);
  });

  it('rejects an unknown extra key', () => {
    expect(() => validateProductSummary({ ...summary, extra: true })).toThrow(ValidationError);
  });

  it("rejects a checkout type other than ssf:checkout", () => {
    expect(() => validateCheckoutResult({
      type: 'other',
      version: 'v1',
      requestId: 'r1',
      state: 'invoiced',
    })).toThrow(ValidationError);
  });
});
