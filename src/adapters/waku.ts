import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { createLightNode, DefaultNetworkConfig, Protocols, waku, WakuEvent } from '@waku/sdk';
import { createRoutingInfo } from '@waku/utils';
import { bytesToHex, hexToBytes } from '@waku/utils/bytes';
import type { BuyerRequest, DecodedWakuMessage, SellerResponse, WakuConfig, WakuSession } from '../contracts/messages.ts';
import { decodeMessage, encodeMessage } from '../contracts/messages.ts';

/**
 * Narrow surface of the real `@waku/sdk` LightNode this module actually uses,
 * so tests can inject a fake transport without standing up a live network.
 */
export type WakuNode = {
  waitForPeers(protocols?: unknown[], timeoutMs?: number): Promise<void>;
  lightPush: { send(encoder: unknown, message: { payload: Uint8Array }): Promise<{ successes: unknown[]; failures: unknown[] }> };
  filter: {
    subscribe(decoder: unknown, callback: (msg: unknown) => void | Promise<void>): Promise<boolean>;
    unsubscribe(decoders: unknown): Promise<boolean>;
  };
  events: {
    addEventListener(type: string, listener: (event: { detail: unknown }) => void): void;
    removeEventListener(type: string, listener: (event: { detail: unknown }) => void): void;
  };
  stop(): Promise<void>;
  /**
   * `IWaku.isConnected()` from `@waku/interfaces` (true while at least one
   * peer is connected). Optional so narrow test fakes may omit it; the
   * session then relies on `waku:connection` events alone.
   */
  isConnected?(): boolean;
};

type EciesDecodedMessage = {
  payload: Uint8Array;
  /** The received protobuf message (still ECIES-encrypted and signed); set by @waku/core DecodedMessage. */
  proto?: unknown;
  verifySignature(publicKey: Uint8Array): boolean;
  signaturePublicKey?: Uint8Array;
  signature?: Uint8Array;
};

function wireBytes(decoded: EciesDecodedMessage): Uint8Array | null {
  if (!decoded.proto || typeof decoded.proto !== 'object') return null;
  try {
    return waku.message.version_0.proto.WakuMessage.encode(decoded.proto as never);
  } catch {
    return null;
  }
}

export type WakuSessionOptions = {
  createNode?: (config: WakuConfig) => Promise<WakuNode>;
  retryIntervalMs?: number;
  /**
   * Per-instance report of a failed delivery handler. It receives no
   * arguments: never the payload, signer or error text. Callers log it as the
   * allow-listed `waku.handler_error` event class. Undecodable or unsigned
   * deliveries are dropped without calling it.
   */
  onHandlerError?: () => void;
};

const MAX_PENDING_REQUESTS = 128;
const MAX_CONCURRENT_DECODES = 16;
const RATE_LIMIT_PER_SIGNER_PER_MINUTE = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_SEND_ATTEMPTS = 3;
const DEFAULT_RETRY_INTERVAL_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function defaultCreateNode(config: WakuConfig): Promise<WakuNode> {
  const node = await createLightNode({
    defaultBootstrap: config.bootstrapPeers.length === 0,
    bootstrapPeers: config.bootstrapPeers.length > 0 ? config.bootstrapPeers : undefined,
    networkConfig: DefaultNetworkConfig,
  });
  await node.waitForPeers([Protocols.LightPush, Protocols.Filter], config.peerTimeoutMs);
  return withLibp2pConnectivity(node as unknown as WakuNode);
}

type ConnectionListener = (event: { detail: unknown }) => void;

/**
 * Under Node 22 `globalThis.navigator` exists without `onLine`, so
 * @waku/core's NetworkMonitor reports `isConnected() === false` and dispatches
 * every `waku:connection` event with `detail: false`, even while libp2p holds
 * live peer connections. Derive connectivity from libp2p's own connection
 * list instead. Nodes without `libp2p` (narrow test fakes) are returned as-is.
 */
export function withLibp2pConnectivity(node: WakuNode): WakuNode {
  const libp2p = (node as { libp2p?: { getConnections?: () => unknown[] } }).libp2p;
  if (!libp2p || typeof libp2p.getConnections !== 'function') return node;
  const connected = (): boolean => libp2p.getConnections!().length > 0;
  const wrapped = new Map<ConnectionListener, ConnectionListener>();
  return {
    waitForPeers: (protocols, timeoutMs) => node.waitForPeers(protocols, timeoutMs),
    lightPush: node.lightPush,
    filter: node.filter,
    events: {
      addEventListener(type, listener) {
        if (type !== WakuEvent.Connection) return node.events.addEventListener(type, listener);
        const relay: ConnectionListener = () => listener({ detail: connected() });
        wrapped.set(listener, relay);
        node.events.addEventListener(type, relay);
      },
      removeEventListener(type, listener) {
        const relay = type === WakuEvent.Connection ? wrapped.get(listener) : undefined;
        if (relay) wrapped.delete(listener);
        node.events.removeEventListener(type, relay ?? listener);
      },
    },
    stop: () => node.stop(),
    isConnected: connected,
  };
}

/** Extra test-only accessor exposed alongside the public WakuSession contract. */
export type WakuSessionForTest = WakuSession & {
  toWireForTest(recipientKeyId: string, body: BuyerRequest | SellerResponse): Promise<Uint8Array>;
};

export function createWakuSession(
  config: WakuConfig,
  ownPrivateKey: Uint8Array,
  options: WakuSessionOptions = {},
): WakuSessionForTest {
  const createNode = options.createNode ?? defaultCreateNode;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const ownPublicKey = getPublicKey(ownPrivateKey);
  const ownPublicKeyHex = bytesToHex(ownPublicKey);
  const routingInfo = createRoutingInfo(DefaultNetworkConfig, { contentTopic: config.contentTopic });

  let node: WakuNode | null = null;
  let started = false;
  let handler: ((message: DecodedWakuMessage) => Promise<void>) | null = null;
  let ownDecoder: ReturnType<typeof createDecoder> | null = null;
  let connectionListener: ((event: { detail: unknown }) => void) | null = null;
  // Current connectivity, so ready() never latches: the last
  // `waku:connection` event, and whether our filter subscription is live.
  let connectedByEvent = true;
  let subscribed = false;

  let pendingCount = 0;
  let activeDecodes = 0;
  const rateWindowStart = new Map<string, number>();
  const rateWindowCount = new Map<string, number>();

  function withinRateLimit(signerKeyId: string): boolean {
    const now = Date.now();
    const windowStart = rateWindowStart.get(signerKeyId);
    if (windowStart === undefined || now - windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateWindowStart.set(signerKeyId, now);
      rateWindowCount.set(signerKeyId, 1);
      return true;
    }
    const count = (rateWindowCount.get(signerKeyId) ?? 0) + 1;
    rateWindowCount.set(signerKeyId, count);
    return count <= RATE_LIMIT_PER_SIGNER_PER_MINUTE;
  }

  function verifiedSignerKeyId(decoded: EciesDecodedMessage | null | undefined): string | null {
    // The live @waku/sdk filter hands the subscriber fromProtoObj's result even
    // when it is undefined (traffic on our topic we cannot decrypt).
    if (!decoded || !decoded.signaturePublicKey || !decoded.signature) return null;
    try {
      if (!decoded.verifySignature(decoded.signaturePublicKey)) return null;
    } catch {
      return null;
    }
    return bytesToHex(decoded.signaturePublicKey);
  }

  async function handleDecoded(decoded: EciesDecodedMessage | undefined): Promise<void> {
    if (!handler) return;
    const signerKeyId = verifiedSignerKeyId(decoded);
    if (!signerKeyId || !decoded) return;
    if (!withinRateLimit(signerKeyId)) return;
    if (pendingCount >= MAX_PENDING_REQUESTS || activeDecodes >= MAX_CONCURRENT_DECODES) return;

    pendingCount += 1;
    activeDecodes += 1;
    try {
      let body: BuyerRequest | SellerResponse;
      try {
        body = decodeMessage(decoded.payload);
      } catch {
        return;
      }
      // Keep the signed ECIES wire bytes (not the decrypted payload) so a stored
      // delivery can be re-verified later with decodeStored().
      const wireEnvelope = wireBytes(decoded);
      if (!wireEnvelope) return;
      await handler({ signerKeyId, body, wireEnvelope });
    } finally {
      pendingCount -= 1;
      activeDecodes -= 1;
    }
  }

  function reportHandlerError(): void {
    try {
      options.onHandlerError?.();
    } catch {
      // A failing reporter must not turn into an unhandled rejection either.
    }
  }

  async function subscribeOwnDecoder(activeNode: WakuNode): Promise<void> {
    ownDecoder = createDecoder(config.contentTopic, routingInfo, ownPrivateKey);
    const ok = await activeNode.filter.subscribe(ownDecoder, (message) =>
      // Never let one bad delivery become an unhandled rejection in the seller;
      // report the failure class only (no payload, no message text).
      handleDecoded(message as EciesDecodedMessage | undefined).catch(reportHandlerError));
    if (!ok) {
      subscribed = false;
      throw new Error('waku filter subscribe failed');
    }
    subscribed = true;
  }

  async function ensureStarted(): Promise<WakuNode> {
    if (node && started) return node;
    node = await withTimeout(createNode(config), config.peerTimeoutMs, 'waku node startup timed out');
    await subscribeOwnDecoder(node);
    connectedByEvent = true;
    connectionListener = (event) => {
      if (event.detail === true) {
        connectedByEvent = true;
        const current = node;
        if (current) subscribeOwnDecoder(current).catch(() => { subscribed = false; });
      } else if (event.detail === false) {
        connectedByEvent = false;
        subscribed = false;
      }
    };
    node.events.addEventListener(WakuEvent.Connection, connectionListener);
    started = true;
    return node;
  }

  return {
    async ready() {
      const activeNode = await ensureStarted();
      if (!connectedByEvent || !subscribed) return false;
      return typeof activeNode.isConnected === 'function' ? activeNode.isConnected() : true;
    },
    async send(recipientKeyId, body) {
      const activeNode = await ensureStarted();
      const encoder = createEncoder({
        contentTopic: config.contentTopic,
        routingInfo,
        publicKey: hexToBytes(recipientKeyId),
        sigPrivKey: ownPrivateKey,
      });
      const payload = encodeMessage(body);
      let lastFailureCount = 0;
      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        const result = await activeNode.lightPush.send(encoder, { payload });
        if (result.successes && result.successes.length > 0) {
          return;
        }
        lastFailureCount = result.failures?.length ?? 0;
        if (attempt < MAX_SEND_ATTEMPTS) {
          await delay(retryIntervalMs);
        }
      }
      throw new Error(`waku light push delivered to zero peers after ${MAX_SEND_ATTEMPTS} attempts (last failures: ${lastFailureCount})`);
    },
    async toWireForTest(recipientKeyId, body) {
      const encoder = createEncoder({
        contentTopic: config.contentTopic,
        routingInfo,
        publicKey: hexToBytes(recipientKeyId),
        sigPrivKey: ownPrivateKey,
      });
      const wire = await encoder.toWire({ payload: encodeMessage(body) });
      if (!wire) throw new Error('failed to encode wire envelope');
      return wire;
    },
    async subscribe(callback) {
      handler = callback;
      await ensureStarted();
      return async () => {
        handler = null;
        if (node && ownDecoder) {
          await node.filter.unsubscribe(ownDecoder);
        }
      };
    },
    async decodeStored(wireEnvelope) {
      const decoder = createDecoder(config.contentTopic, routingInfo, ownPrivateKey);
      const proto = await decoder.fromWireToProtoObj(wireEnvelope);
      if (!proto) throw new Error('malformed waku wire envelope');
      const decoded = (await decoder.fromProtoObj(routingInfo.pubsubTopic, proto)) as EciesDecodedMessage | undefined;
      if (!decoded) throw new Error('failed to decrypt stored waku envelope');
      const signerKeyId = verifiedSignerKeyId(decoded);
      if (!signerKeyId) throw new Error('stored waku envelope has no verified signer');
      const body = decodeMessage(decoded.payload);
      return { signerKeyId, body, wireEnvelope };
    },
    async close() {
      handler = null;
      if (node) {
        if (connectionListener) node.events.removeEventListener(WakuEvent.Connection, connectionListener);
        if (ownDecoder) await node.filter.unsubscribe(ownDecoder);
        await node.stop();
      }
      node = null;
      started = false;
      subscribed = false;
    },
  };
}

export function generateWakuIdentity(): { privateKey: Uint8Array; publicKeyHex: string } {
  const privateKey = generatePrivateKey();
  return { privateKey, publicKeyHex: bytesToHex(getPublicKey(privateKey)) };
}
