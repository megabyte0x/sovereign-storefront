import { writeFileSync, chmodSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createLightNode, DefaultNetworkConfig, Protocols } from '@waku/sdk';
import type { LightNode } from '@waku/sdk';
import { LIVE_ROOT, ensurePrivateDir, mergeLiveEnv } from './paths.ts';

const WAKU_ROOT = path.join(LIVE_ROOT, 'waku');
const PEER_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 90_000;
const MIN_PEERS = 2;
const CONTENT_TOPIC = '/sovereign-storefront/1/live/proto';

// Browsers under HTTPS need `wss` (plain `ws` is mixed-content-blocked), and
// the CSP pins hostnames, so an IP-only or peer-id-less address is useless.
const DIALABLE_PATTERN = /^\/(?:dns4|dns6|dnsaddr)\/[^/]+\/tcp\/\d+\/(?:wss|tls\/ws)\/p2p\/[A-Za-z0-9]+$/;

/**
 * Keep only secure-websocket multiaddrs that carry a peer id, deduplicated
 * and order-preserving.
 */
export function browserDialable(addrs: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const addr of addrs) {
    if (!DIALABLE_PATTERN.test(addr)) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    kept.push(addr);
  }
  return kept;
}

// Protocol IDs as registered by @waku/core 0.0.40 (hoisted with @waku/sdk 0.0.36):
//   light_push/constants.js: /vac/waku/lightpush/2.0.0-beta1, /vac/waku/lightpush/3.0.0
//   filter/filter.js:        /vac/waku/filter-subscribe/2.0.0-beta1 (client dials this one)
// Note: there is no `/filter/` path segment, so a naive `includes('/filter/')` never matches.
// PeerStore Peer shape, derived from the SDK's own Libp2p type (no direct @libp2p/interface dep).
type Peer = Awaited<ReturnType<LightNode['libp2p']['peerStore']['get']>>;

const LIGHTPUSH_PREFIX = '/vac/waku/lightpush/';
const FILTER_SUBSCRIBE_PREFIX = '/vac/waku/filter-subscribe/';

export interface DiscoveredPeer {
  id: string;
  protocols: string[];
  addrs: string[];
}

export function supportsLightPushAndFilter(protocols: string[]): boolean {
  return protocols.some((p) => p.startsWith(LIGHTPUSH_PREFIX))
    && protocols.some((p) => p.startsWith(FILTER_SUBSCRIBE_PREFIX));
}

/**
 * Pure: keep peers that serve both lightpush and filter, make every address
 * carry `/p2p/<id>`, then keep only browser-dialable addrs (deduplicated).
 */
export function dialableFromPeers(peers: DiscoveredPeer[]): string[] {
  const candidates: string[] = [];
  for (const peer of peers) {
    if (!supportsLightPushAndFilter(peer.protocols)) continue;
    for (const addr of peer.addrs) {
      candidates.push(addr.includes('/p2p/') ? addr : `${addr}/p2p/${peer.id}`);
    }
  }
  return browserDialable(candidates);
}

export interface PollOptions {
  min: number;
  intervalMs: number;
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Re-sample `collect` every `intervalMs` until it yields at least `min`
 * dialable addrs or `deadlineMs` elapses. Always samples at least once and
 * returns the last sample; the caller decides what "not enough" means.
 */
export async function pollDialable(
  collect: () => Promise<string[]>,
  opts: PollOptions,
): Promise<{ peers: string[]; attempts: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.deadlineMs;
  let attempts = 0;
  for (;;) {
    const peers = await collect();
    attempts += 1;
    if (peers.length >= opts.min || now() >= deadline) return { peers, attempts };
    await sleep(opts.intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Live bring-up (not exercised by unit tests)
// ---------------------------------------------------------------------------

async function collectPeers(node: LightNode): Promise<{ connected: number; peers: DiscoveredPeer[] }> {
  // IWaku.libp2p: Libp2p (@waku/interfaces waku.d.ts:47); getConnections(): Connection[]
  // (@libp2p/interface index.d.ts:569); Connection.remotePeer: PeerId (connection.d.ts:237).
  const libp2p = node.libp2p;
  const seen = new Set<string>();
  const peers: DiscoveredPeer[] = [];
  for (const connection of libp2p.getConnections()) {
    const peerId = connection.remotePeer;
    const id = peerId.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    // peerStore.get(peerId): Promise<Peer> (peer-store.d.ts:212); Peer.protocols: string[],
    // Peer.addresses: Address[] with .multiaddr: Multiaddr (peer-store.d.ts:18-44).
    let peer: Peer;
    try {
      peer = await libp2p.peerStore.get(peerId);
    } catch {
      continue;
    }
    const addrs = peer.addresses.map((a) => a.multiaddr.toString());
    const remote = connection.remoteAddr.toString();
    if (!addrs.includes(remote)) addrs.push(remote);
    peers.push({ id, protocols: peer.protocols, addrs });
  }
  return { connected: seen.size, peers };
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  if (!dryRun) {
    ensurePrivateDir(LIVE_ROOT);
    ensurePrivateDir(WAKU_ROOT);
  }

  const node = await createLightNode({ defaultBootstrap: true, networkConfig: DefaultNetworkConfig });
  try {
    try {
      await node.waitForPeers([Protocols.LightPush, Protocols.Filter], PEER_TIMEOUT_MS);
    } catch (e) {
      if (!dryRun) throw e;
      process.stderr.write(`waitForPeers: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    // waitForPeers resolves after ONE suitable peer; keep sampling until the
    // fleet yields MIN_PEERS dialable peers or the deadline passes.
    let connected = 0;
    let both: DiscoveredPeer[] = [];
    const { peers } = await pollDialable(async () => {
      const sample = await collectPeers(node);
      connected = sample.connected;
      both = sample.peers.filter((p) => supportsLightPushAndFilter(p.protocols));
      return dialableFromPeers(sample.peers);
    }, { min: dryRun ? 0 : MIN_PEERS, intervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_DEADLINE_MS });

    if (dryRun) {
      process.stdout.write(`dry_run connected=${connected} both_protocols=${both.length} dialable=${peers.length}\n`);
      return;
    }

    if (peers.length < MIN_PEERS) {
      throw new Error(`waku_peers=${peers.length} connected=${connected} both_protocols=${both.length}: need at least ${MIN_PEERS} browser-dialable peers`);
    }

    const peersJsonPath = path.join(WAKU_ROOT, 'peers.json');
    const tmpPath = `${peersJsonPath}.tmp`;
    writeFileSync(
      tmpPath,
      `${JSON.stringify({ discoveredAt: new Date().toISOString(), clusterId: 1, peers }, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, peersJsonPath);

    mergeLiveEnv({
      WAKU_BOOTSTRAP_PEERS: peers.join(','),
      SSF_WAKU_CONTENT_TOPIC: CONTENT_TOPIC,
    });

    process.stdout.write(`waku_peers=${peers.length} cluster=1\n`);
  } finally {
    await node.stop().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    () => process.exit(process.exitCode ?? 0),
    (e: unknown) => {
      process.stderr.write(`waku-peers failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
