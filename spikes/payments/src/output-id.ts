export type ShieldedPool = 'sapling' | 'orchard';

export type OutputIdentity = {
  txid: string;
  pool: ShieldedPool;
  outputIndex: number;
};

const TXID = /^[0-9a-f]{64}$/;

export function makeOutputId(parts: OutputIdentity): string {
  if (!TXID.test(parts.txid)) {
    throw new Error('txid must be 32-byte lowercase hex');
  }
  if (parts.pool !== 'sapling' && parts.pool !== 'orchard') {
    throw new Error('pool must be sapling or orchard');
  }
  if (!Number.isInteger(parts.outputIndex) || parts.outputIndex < 0) {
    throw new Error('outputIndex must be a non-negative integer');
  }
  return `${parts.txid}:${parts.pool}:${parts.outputIndex}`;
}

export function parseOutputId(outputId: string): OutputIdentity {
  const match = /^([0-9a-f]{64}):(sapling|orchard):([0-9]+)$/.exec(outputId);
  if (!match) {
    throw new Error('outputId must be txid:pool:outputIndex');
  }
  return {
    txid: match[1],
    pool: match[2] as ShieldedPool,
    outputIndex: Number(match[3]),
  };
}
