import { createDecoder, createEncoder, createLightNode, DefaultNetworkConfig, Protocols } from "@waku/sdk";
import { generatePrivateKey, getPublicKey } from "@waku/message-encryption";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@waku/utils/bytes";
import { createRoutingInfo } from "@waku/utils";
import { sha256 } from "@noble/hashes/sha256";
import * as secp from "@noble/secp256k1";

export interface RoundtripRequest {
  peers: string[];
  count: number;
  contentTopic: string;
  peerTimeoutMs: number;
  recvTimeoutMs: number;
}

export interface RoundtripResult {
  ok: boolean;
  error?: string;
  dialed: string[];
  connected: number;
  protocols: string[];
  sent: number;
  sendAck: number;
  received: number;
  verified: number;
  successRate: number;
  p95Ms: number | null;
  latenciesMs: number[];
  pubsubTopic: string;
  clusterId: number;
  numShardsInCluster: number;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)];
}

export async function runRoundtrip(req: RoundtripRequest): Promise<RoundtripResult> {
  const routing = createRoutingInfo(DefaultNetworkConfig, { contentTopic: req.contentTopic });
  const base: RoundtripResult = {
    ok: false,
    dialed: req.peers,
    connected: 0,
    protocols: [],
    sent: 0,
    sendAck: 0,
    received: 0,
    verified: 0,
    successRate: 0,
    p95Ms: null,
    latenciesMs: [],
    pubsubTopic: routing.pubsubTopic,
    clusterId: DefaultNetworkConfig.clusterId,
    numShardsInCluster: DefaultNetworkConfig.numShardsInCluster,
  };
  const priv = generatePrivateKey();
  const pub = getPublicKey(priv);
  const pubHex = bytesToHex(pub);
  let node: Awaited<ReturnType<typeof createLightNode>> | null = null;
  try {
    node = await createLightNode({
      defaultBootstrap: false,
      bootstrapPeers: req.peers,
      networkConfig: DefaultNetworkConfig,
    });
    await node.start();
    const peerDeadline = Date.now() + Math.min(req.peerTimeoutMs, 20_000);
    while (node.libp2p.getConnections().length === 0 && Date.now() < peerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    base.connected = node.libp2p.getConnections().length;
    const seen = new Set<string>();
    for (const conn of node.libp2p.getConnections()) {
      try {
        const peer = await node.libp2p.peerStore.get(conn.remotePeer);
        for (const proto of peer.protocols) seen.add(proto);
      } catch {
        /* peer store race */
      }
    }
    base.protocols = [...seen].sort();
    await node.waitForPeers([Protocols.LightPush, Protocols.Filter], req.peerTimeoutMs);
    const encoder = createEncoder({ contentTopic: req.contentTopic, routingInfo: routing });
    const decoder = createDecoder(req.contentTopic, routing);
    const latencies: number[] = [];
    const got = new Set<number>();
    await node.filter.subscribe(decoder, (message) => {
      try {
        const text = new TextDecoder().decode(message.payload);
        const parsed = JSON.parse(text) as { n?: number; t?: number; sig?: string; pub?: string };
        if (typeof parsed.n !== "number" || typeof parsed.t !== "number" || !parsed.sig || parsed.pub !== pubHex) return;
        const hash = sha256(utf8ToBytes(`${parsed.n}.${parsed.t}.${req.contentTopic}`));
        if (!secp.verify(hexToBytes(parsed.sig), hash, hexToBytes(parsed.pub))) return;
        if (got.has(parsed.n)) return;
        got.add(parsed.n);
        latencies.push(Math.max(0, Date.now() - parsed.t));
      } catch {
        /* ignore undecodable */
      }
    });
    for (let n = 0; n < req.count; n += 1) {
      const t = Date.now();
      const hash = sha256(utf8ToBytes(`${n}.${t}.${req.contentTopic}`));
      const sig = secp.utils.bytesToHex(await secp.sign(hash, priv));
      const payload = utf8ToBytes(JSON.stringify({ n, t, sig, pub: pubHex }));
      base.sent += 1;
      const res = await node.lightPush.send(encoder, { payload, timestamp: new Date(t) }, { autoRetry: false });
      if ((res?.successes?.length ?? 0) > 0) base.sendAck += 1;
    }
    const deadline = Date.now() + req.recvTimeoutMs;
    while (got.size < req.count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    base.received = got.size;
    base.verified = got.size;
    base.latenciesMs = latencies;
    base.successRate = req.count === 0 ? 0 : got.size / req.count;
    base.p95Ms = p95(latencies);
    base.ok = got.size === req.count;
    return base;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    return base;
  } finally {
    await node?.stop().catch(() => undefined);
  }
}

declare global {
  interface Window {
    runRoundtrip: typeof runRoundtrip;
    listPeerProtocols: (peers: string[], waitMs: number) => Promise<{ connected: number; protocols: string[] }>;
  }
}

window.runRoundtrip = runRoundtrip;

export async function listPeerProtocols(peers: string[], waitMs: number): Promise<{ connected: number; protocols: string[] }> {
  const node = await createLightNode({
    defaultBootstrap: false,
    bootstrapPeers: peers,
    networkConfig: DefaultNetworkConfig,
  });
  try {
    await node.start();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (node.libp2p.getConnections().length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const seen = new Set<string>();
    for (const conn of node.libp2p.getConnections()) {
      try {
        const peer = await node.libp2p.peerStore.get(conn.remotePeer);
        for (const proto of peer.protocols) seen.add(proto);
      } catch { /* ignore */ }
    }
    return { connected: node.libp2p.getConnections().length, protocols: [...seen].sort() };
  } finally {
    await node.stop().catch(() => undefined);
  }
}
window.listPeerProtocols = listPeerProtocols;
