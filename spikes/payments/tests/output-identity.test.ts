import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeOutputId, parseOutputId } from '../src/output-id.ts';

test('stable output identity includes pool and output position, not txid alone', () => {
  const txid = 'ab'.repeat(32);
  const sapling0 = makeOutputId({ txid, pool: 'sapling', outputIndex: 0 });
  const orchard0 = makeOutputId({ txid, pool: 'orchard', outputIndex: 0 });
  const orchard1 = makeOutputId({ txid, pool: 'orchard', outputIndex: 1 });

  assert.notEqual(sapling0, orchard0);
  assert.notEqual(orchard0, orchard1);
  assert.notEqual(sapling0, txid);
  assert.equal(parseOutputId(orchard1).txid, txid);
  assert.equal(parseOutputId(orchard1).pool, 'orchard');
  assert.equal(parseOutputId(orchard1).outputIndex, 1);
});
