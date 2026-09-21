import type {
  ChainRevision,
  Observation,
  ScanCheckpoint,
  ScanHealth,
  Scanner,
} from './types.ts';

/**
 * Replayable scanner snapshot.
 *
 * Maps onto zcash_client_backend::data_api::WalletRead as:
 * - health.revision.height <= WalletRead::block_fully_scanned / chain_height
 * - health.revision.id = WalletRead::get_block_hash(height) / get_max_height_hash
 * - health.caughtUp when block_fully_scanned == chain_height and suggest_scan_ranges has no Verify gaps
 * - observations are a seller-side snapshot of received notes, not a live-only cursor
 *
 * WalletRead::get_received_outputs(txid) requires a txid and does not enumerate history.
 * The adapter therefore retains an authoritative snapshot (from scan_cached_blocks results
 * and/or zcash_client_sqlite received-note tables) and replays from ScanCheckpoint.
 */
export class MemoryScanner implements Scanner {
  consumerRunning = true;
  private snapshot: Observation[] = [];
  private tip: ChainRevision = { id: 'genesis', height: 0 };
  private caughtUp = false;
  private checkedAt = 0;

  replaceSnapshot(
    observations: Observation[],
    tip: ChainRevision,
    caughtUp: boolean,
    checkedAt = Date.now(),
  ): void {
    this.snapshot = observations.map((item) => ({ ...item }));
    this.tip = { ...tip };
    this.caughtUp = caughtUp;
    this.checkedAt = checkedAt;
  }

  stopConsumer(): void {
    this.consumerRunning = false;
  }

  startConsumer(): void {
    this.consumerRunning = true;
  }

  async health(): Promise<ScanHealth> {
    return {
      healthy: this.consumerRunning && this.tip.height > 0,
      checkedAt: this.checkedAt,
      revision: { ...this.tip },
      caughtUp: this.caughtUp,
    };
  }

  async *observations(from: ScanCheckpoint | null): AsyncIterable<Observation> {
    const minHeight = from?.revision.height ?? 0;
    const items = this.snapshot
      .filter((item) => item.revision.height >= minHeight)
      .sort((a, b) => a.revision.height - b.revision.height);
    for (const item of items) {
      yield { ...item, revision: { ...item.revision } };
    }
  }
}
