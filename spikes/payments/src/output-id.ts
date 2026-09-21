export type ShieldedPool = 'sapling' | 'orchard';

export type OutputIdentity = {
  txid: string;
  pool: ShieldedPool;
  outputIndex?: number;
  indexUnknown?: boolean;
};

const TXID = /^[0-9a-f]{64}$/;

export function makeOutputId(parts: OutputIdentity): string {
  if (!TXID.test(parts.txid)) {
    throw new Error('txid must be 32-byte lowercase hex');
  }
  if (parts.pool !== 'sapling' && parts.pool !== 'orchard') {
    throw new Error('pool must be sapling or orchard');
  }
  if (parts.indexUnknown) {
    return `${parts.txid}:${parts.pool}`;
  }
  if (parts.outputIndex === undefined || !Number.isInteger(parts.outputIndex) || parts.outputIndex < 0) {
    throw new Error('outputIndex must be a non-negative integer');
  }
  return `${parts.txid}:${parts.pool}:${parts.outputIndex}`;
}

export function parseOutputId(outputId: string): OutputIdentity {
  const unknown = /^([0-9a-f]{64}):(sapling|orchard)$/.exec(outputId);
  if (unknown) {
    return {
      txid: unknown[1],
      pool: unknown[2] as ShieldedPool,
      indexUnknown: true,
    };
  }
  const match = /^([0-9a-f]{64}):(sapling|orchard):([0-9]+)$/.exec(outputId);
  if (!match) {
    throw new Error('outputId must be txid:pool or txid:pool:outputIndex');
  }
  return {
    txid: match[1],
    pool: match[2] as ShieldedPool,
    outputIndex: Number(match[3]),
  };
}
