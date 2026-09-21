import type {
  InvoiceSettlement,
  Observation,
  ScanCheckpoint,
} from './types.ts';

export class MemorySellerStore {
  private checkpoint: ScanCheckpoint | null = null;
  private observations: Observation[] = [];
  private settlements: InvoiceSettlement[] = [];

  async getCheckpoint(): Promise<ScanCheckpoint | null> {
    return this.checkpoint ? { revision: { ...this.checkpoint.revision } } : null;
  }

  async commitReconciliation(input: {
    checkpoint: ScanCheckpoint;
    observations: Observation[];
    settlements: InvoiceSettlement[];
  }): Promise<void> {
    this.observations = input.observations.map((item) => ({ ...item }));
    this.settlements = input.settlements.map((item) => ({
      ...item,
      backingOutputIds: [...item.backingOutputIds],
      exceptions: item.exceptions.map((record) => ({ ...record })),
    }));
    this.checkpoint = { revision: { ...input.checkpoint.revision } };
  }
}
