import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryScanner } from '../src/scanner.ts';
import { MemorySellerStore } from '../src/seller-store.ts';
import type { Observation, ScanCheckpoint } from '../src/types.ts';

const outputId = 'ff'.repeat(32) + ':orchard:0';

function observation(height: number, id: string): Observation {
  return {
    outputId,
    invoiceId: 'inv-1',
    amountZat: '100000000',
    confirmations: 10,
    canonical: true,
    receivedAt: 1_700_000_000_000,
    revision: { id, height },
  };
}

async function collect(from: ScanCheckpoint | null, scanner: MemoryScanner) {
  const items: Observation[] = [];
  for await (const item of scanner.observations(from)) {
    items.push(item);
  }
  return items;
}

test('crash before commit leaves seller checkpoint unchanged and replay recovers the same output', async () => {
  const scanner = new MemoryScanner();
  const store = new MemorySellerStore();
  const first = observation(100, 'h100');
  scanner.replaceSnapshot([first], { id: 'h100', height: 100 }, true);

  const seen = await collect(await store.getCheckpoint(), scanner);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outputId, outputId);

  // Crash before commit: checkpoint stays null.
  assert.equal(await store.getCheckpoint(), null);

  const replayed = await collect(await store.getCheckpoint(), scanner);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].outputId, outputId);
  assert.deepEqual(replayed[0].revision, first.revision);

  await store.commitReconciliation({
    checkpoint: { revision: first.revision },
    observations: replayed,
    settlements: [],
  });
  const afterCommit = await store.getCheckpoint();
  assert.deepEqual(afterCommit, { revision: first.revision });
});

test('payment received while consumer is stopped is recovered after restart via snapshot replay', async () => {
  const scanner = new MemoryScanner();
  const store = new MemorySellerStore();
  const committed = observation(90, 'h90');
  committed.outputId = '00'.repeat(32) + ':orchard:0';
  scanner.replaceSnapshot([committed], { id: 'h90', height: 90 }, true);
  await store.commitReconciliation({
    checkpoint: { revision: committed.revision },
    observations: [committed],
    settlements: [],
  });

  scanner.stopConsumer();
  const later = observation(120, 'h120');
  scanner.replaceSnapshot([committed, later], { id: 'h120', height: 120 }, true);
  assert.equal(scanner.consumerRunning, false);

  scanner.startConsumer();
  const recovered = await collect(await store.getCheckpoint(), scanner);
  assert.equal(recovered.some((item) => item.outputId === later.outputId), true);
  assert.equal(recovered.every((item) => item.revision.height >= 90), true);
});

test('health and observations share one ChainRevision type', async () => {
  const scanner = new MemoryScanner();
  const obs = observation(80, 'h80');
  scanner.replaceSnapshot([obs], obs.revision, true);
  const health = await scanner.health();
  const items = await collect(null, scanner);
  assert.equal(health.revision.id, items[0].revision.id);
  assert.equal(health.revision.height, items[0].revision.height);
});
