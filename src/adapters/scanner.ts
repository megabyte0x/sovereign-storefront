import type {
  ChainRevision,
  Observation,
  ScanCheckpoint,
  ScanHealth,
  Scanner,
} from '../contracts/types.ts';

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

export class MemoryScanner implements Scanner {
  consumerRunning = true;
  private snapshot: Observation[] = [];
  private tip: ChainRevision = { id: 'genesis', height: 0 };
  private caughtUp = false;
  private checkedAt = 0;
  private healthyOverride: boolean | null = null;

  replaceSnapshot(
    observations: Observation[],
    tip: ChainRevision,
    caughtUp: boolean,
    checkedAt = Date.now(),
  ): void {
    this.snapshot = observations.map((item) => ({ ...item, revision: { ...item.revision } }));
    this.tip = { ...tip };
    this.caughtUp = caughtUp;
    this.checkedAt = checkedAt;
  }

  setHealth(overrides: Partial<ScanHealth> & { revision?: ChainRevision }): void {
    if (overrides.healthy !== undefined) this.healthyOverride = overrides.healthy;
    if (overrides.caughtUp !== undefined) this.caughtUp = overrides.caughtUp;
    if (overrides.checkedAt !== undefined) this.checkedAt = overrides.checkedAt;
    if (overrides.revision) this.tip = { ...overrides.revision };
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
    const items = this.snapshot
      .filter((item) => item.revision.height >= minHeight)
      .sort((a, b) => a.revision.height - b.revision.height || a.outputId.localeCompare(b.outputId));
    for (const item of items) {
      yield { ...item, revision: { ...item.revision } };
    }
  }
}
