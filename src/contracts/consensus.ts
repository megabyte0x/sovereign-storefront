// Server-only: derives ChainIdentity.consensusFingerprint exactly as the Rust
// scanner does (services/scanner/src/consensus.rs). Never import from browser code.
import { createHash } from 'node:crypto';
import type { Network } from './live.ts';
import { ValidationError } from './validation.ts';

export const CONSENSUS_FINGERPRINT_DOMAIN = 'sovereign-storefront.consensus-fingerprint.v1';
export const ACTIVATION_ORDER = [
  'overwinter', 'sapling', 'blossom', 'heartwood', 'canopy', 'nu5', 'nu6', 'nu6-1', 'nu6-2', 'nu6-3',
] as const;
const REQUIRED_ACTIVATIONS = 7;
const MAX_HEIGHT = 0xffff_ffff;

export type ActivationName = (typeof ACTIVATION_ORDER)[number];
export type ActivationSchedule = Partial<Record<ActivationName, number | null>>;

function fail(reason: string): never {
  throw new ValidationError(`invalid consensus parameters: ${reason}`);
}

/** Returns the exact UTF-8 preimage hashed into the v1 fingerprint. */
export function consensusFingerprintPreimage(network: string, activations: Record<string, unknown>): string {
  if (network !== 'regtest' && network !== 'test') fail('network');
  for (const name of Object.keys(activations)) {
    if (!(ACTIVATION_ORDER as readonly string[]).includes(name)) fail(`unknown activation ${name}`);
  }
  let preimage = `${CONSENSUS_FINGERPRINT_DOMAIN}\nnetwork=${network satisfies Network}\n`;
  let previous: number | null = 0;
  ACTIVATION_ORDER.forEach((name, index) => {
    const raw = activations[name] ?? null;
    if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_HEIGHT)) fail(name);
    const height = raw as number | null;
    if (height === null && index < REQUIRED_ACTIVATIONS) fail(`${name} is required`);
    if (height !== null && (previous === null || height < previous)) fail(`${name} is out of protocol order`);
    previous = height;
    preimage += `${name}=${height === null ? 'none' : String(height)}\n`;
  });
  return preimage;
}

/** Lowercase hex SHA-256 of the canonical v1 preimage. */
export function consensusFingerprint(network: string, activations: Record<string, unknown>): string {
  return createHash('sha256').update(consensusFingerprintPreimage(network, activations), 'utf8').digest('hex');
}
