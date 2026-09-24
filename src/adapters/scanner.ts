import { createHash } from 'node:crypto';
import type {
  ChainRevision,
  Observation,
  ScanCheckpoint,
  ScanHealth,
  Scanner,
} from '../contracts/types.ts';
import type {
  AllocateReceiver,
  ChainIdentity,
  ReceiverAllocation,
  ReceiverRef,
  ReceiptSource,
  ScanSnapshot,
} from '../contracts/live.ts';

/**
 * Scanner in this task is a test double / labelled dashboard mapping.
 * Compact-block WalletRead is not wired. Live zakura attribution was
 * destination-UA; the reducer still uses invoiceId on Observation (memo path).
 */
export const SCANNER_MAPPING = {
  kind: 'test-double-or-labelled-dashboard',
  walletReadWired: false,
  compactBlockScan: false,
  publicTestnet: false,
  liveBackend: 'ths 0.2.1 zakura/regtest (labelled, not WalletRead)',
  liveAttribution: 'destination-ua',
  reducerAttribution: 'invoiceId on Observation (random-memo / attributionRef path)',
  minConfirmationsDefault: 10,
  maxHealthAgeMsDefault: 120_000,
} as const;

function hexId(seed: string, bytes: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, bytes * 2);
}
export class MemoryScanner implements Scanner, ReceiptSource {
  consumerRunning = true;
  private observationsSnapshot: Observation[] = [];
  private tip: ChainRevision = { id: 'genesis', height: 0 };
  private caughtUp = false;
  private checkedAt = 0;
  private healthyOverride: boolean | null = null;
  private generation = 1n;
  private sourceId = 'fixture-scanner';
  private chain: ChainIdentity = { network: 'regtest', genesisHash: 'a'.repeat(64), consensusFingerprint: 'c'.repeat(64) };
  private accountId = 'fixture-account';
  private allocated = new Map<string, ReceiverAllocation>();
  private receiverByOutput = new Map<string, ReceiverRef>();

  /** Fixture-only: bind a receipt's outputId to the exact receiver it paid, so snapshot() reports real attribution. */
  setReceiptReceiver(outputId: string, receiver: ReceiverRef): void {
    this.receiverByOutput.set(outputId, receiver);
  }

  /** Fixture-only: set the chain identity's network label to match the configured product network. */
  setChainNetwork(network: ChainIdentity['network']): void {
    this.chain = { ...this.chain, network };
    this.generation += 1n;
  }

  replaceSnapshot(
    observations: Observation[],
    tip: ChainRevision,
    caughtUp: boolean,
    checkedAt = Date.now(),
  ): void {
    this.observationsSnapshot = observations.map((item) => ({ ...item, revision: { ...item.revision } }));
    this.tip = { ...tip };
    this.caughtUp = caughtUp;
    this.checkedAt = checkedAt;
    this.generation += 1n;
  }

  setHealth(overrides: Partial<ScanHealth> & { revision?: ChainRevision }): void {
    if (overrides.healthy !== undefined) this.healthyOverride = overrides.healthy;
    if (overrides.caughtUp !== undefined) this.caughtUp = overrides.caughtUp;
    if (overrides.checkedAt !== undefined) this.checkedAt = overrides.checkedAt;
    if (overrides.revision) this.tip = { ...overrides.revision };
    // Any observable change to the snapshot envelope is a new generation:
    // commitSnapshot enforces that a given (sourceId, generation) pair's
    // content is immutable, so silently mutating health/tip under the same
    // generation would trip that real invariant rather than a test bug.
    this.generation += 1n;
  }

  stopConsumer(): void {
    this.consumerRunning = false;
  }

  startConsumer(): void {
    this.consumerRunning = true;
  }

  async health(): Promise<ScanHealth> {
    return {
      healthy: this.healthyOverride ?? (this.consumerRunning && this.tip.height > 0),
      checkedAt: this.checkedAt,
      revision: { ...this.tip },
      caughtUp: this.caughtUp,
    };
  }

  async *observations(from: ScanCheckpoint | null): AsyncIterable<Observation> {
    const minHeight = from?.revision.height ?? 0;
    const items = this.observationsSnapshot
      .filter((item) => item.revision.height >= minHeight)
      .sort((a, b) => a.revision.height - b.revision.height || a.outputId.localeCompare(b.outputId));
    for (const item of items) {
      yield { ...item, revision: { ...item.revision } };
    }
  }

  replaceReceiptSourceSnapshot(snapshot: ScanSnapshot): void {
    this.sourceId = snapshot.sourceId;
    this.generation = BigInt(snapshot.generation);
    this.chain = { ...snapshot.chain };
    this.accountId = snapshot.accountId;
    this.tip = { id: snapshot.tip.hash, height: snapshot.tip.height };
    this.caughtUp = snapshot.caughtUp;
    this.checkedAt = snapshot.checkedAt;
    this.healthyOverride = snapshot.health === 'ready';
    this.observationsSnapshot = snapshot.receipts.map((receipt) => ({
      outputId: receipt.outputId,
      invoiceId: null,
      amountZat: receipt.amountZat,
      confirmations: receipt.mined ? snapshot.tip.height - receipt.mined.height + 1 : 0,
      canonical: receipt.canonical,
      receivedAt: receipt.firstSeenAt,
      revision: { id: snapshot.tip.hash, height: snapshot.tip.height },
      sourceId: snapshot.sourceId,
      generation: snapshot.generation,
    }));
  }

  async snapshot(): Promise<ScanSnapshot> {
    const ready = this.healthyOverride ?? (this.consumerRunning && this.tip.height > 0);
    return {
      version: 1,
      sourceId: this.sourceId,
      generation: this.generation.toString(),
      chain: { ...this.chain },
      accountId: this.accountId,
      tip: { height: this.tip.height, hash: hexId(this.tip.id, 32) },
      scanned: { height: this.tip.height, hash: hexId(this.tip.id, 32) },
      checkedAt: this.checkedAt,
      caughtUp: this.caughtUp,
      complete: this.consumerRunning,
      health: ready ? 'ready' : 'unavailable',
      receipts: this.observationsSnapshot.map((receipt, outputIndex) => {
        const receiver = this.receiverByOutput.get(receipt.outputId);
        return {
          outputId: receipt.outputId,
          txid: hexId(receipt.outputId, 32),
          pool: 'orchard' as const, outputIndex,
          accountId: receiver?.accountId ?? this.accountId,
          scope: receiver?.scope ?? 'external' as const,
          receiverHex: receiver?.receiverHex ?? '02'.repeat(43),
          amountZat: receipt.amountZat, firstSeenAt: receipt.receivedAt,
          mined: receipt.canonical ? { height: receipt.revision.height, hash: hexId(receipt.revision.id, 32) } : null,
          canonical: receipt.canonical,
        };
      }),
    };
  }

  async allocateReceiver(input: AllocateReceiver): Promise<ReceiverAllocation> {
    if (input.chain.network !== this.chain.network || input.chain.genesisHash !== this.chain.genesisHash
      || input.chain.consensusFingerprint !== this.chain.consensusFingerprint || input.accountId !== this.accountId) {
      throw new Error('fixture scanner chain/account mismatch');
    }
    const prior = this.allocated.get(input.allocationId);
    if (prior) return prior;
    const index = this.allocated.size + 1;
    const allocation: ReceiverAllocation = {
      ...input, destination: `uregtest1fixture${index}`,
      receiver: { accountId: input.accountId, scope: 'external', pool: 'orchard', diversifierIndex: index.toString(16).padStart(22, '0'), receiverHex: index.toString(16).padStart(86, '0') },
      paymentUri: `zcash:uregtest1fixture${index}?amount=1`,
    };
    this.allocated.set(input.allocationId, allocation);
    return allocation;
  }

  async close(): Promise<void> { this.stopConsumer(); }
}
