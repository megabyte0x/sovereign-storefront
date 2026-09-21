import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeZip321, parseZip321, Zip321Error } from '../src/zip321.ts';

const sapling =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';

test('encodes a testnet shielded ZIP-321 request with amount and memo', () => {
  const uri = encodeZip321({
    address: sapling,
    amountZat: '100000000',
    memoUtf8: 'This is a simple memo.',
    message: 'Thank you for your purchase',
  });
  assert.equal(
    uri,
    `zcash:${sapling}?amount=1&memo=VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg&message=Thank%20you%20for%20your%20purchase`,
  );
  const parsed = parseZip321(uri);
  assert.equal(parsed.address, sapling);
  assert.equal(parsed.amountZat, '100000000');
  assert.equal(parsed.memoUtf8, 'This is a simple memo.');
});

test('rejects transparent addresses; no transparent fallback', () => {
  assert.throws(
    () =>
      encodeZip321({
        address: 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU',
        amountZat: '1',
        memoUtf8: 'nope',
      }),
    (error: unknown) => error instanceof Zip321Error && error.code === 'transparent_forbidden',
  );
});

test('rejects mainnet addresses; testnet only', () => {
  assert.throws(
    () =>
      encodeZip321({
        address: 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        amountZat: '1',
      }),
    (error: unknown) => error instanceof Zip321Error && error.code === 'network_forbidden',
  );
});
