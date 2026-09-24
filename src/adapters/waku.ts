import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { createLightNode, DefaultNetworkConfig, Protocols, WakuEvent } from '@waku/sdk';
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
};

type EciesDecodedMessage = {
  payload: Uint8Array;
  verifySignature(publicKey: Uint8Array): boolean;
  signaturePublicKey?: Uint8Array;
  signature?: Uint8Array;
};

export type WakuSessionOptions = {
  createNode?: (config: WakuConfig) => Promise<WakuNode>;
  retryIntervalMs?: number;
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
  return node as unknown as WakuNode;
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

  function verifiedSignerKeyId(decoded: EciesDecodedMessage): string | null {
    if (!decoded.signaturePublicKey || !decoded.signature) return null;
    if (!decoded.verifySignature(decoded.signaturePublicKey)) return null;
    return bytesToHex(decoded.signaturePublicKey);
  }

  async function handleDecoded(decoded: EciesDecodedMessage): Promise<void> {
    if (!handler) return;
    const signerKeyId = verifiedSignerKeyId(decoded);
    if (!signerKeyId) return;
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
      await handler({ signerKeyId, body, wireEnvelope: decoded.payload });
    } finally {
      pendingCount -= 1;
      activeDecodes -= 1;
    }
  }

  async function subscribeOwnDecoder(activeNode: WakuNode): Promise<void> {
    ownDecoder = createDecoder(config.contentTopic, routingInfo, ownPrivateKey);
    const ok = await activeNode.filter.subscribe(ownDecoder, (message) => handleDecoded(message as EciesDecodedMessage));
    if (!ok) {
      throw new Error('waku filter subscribe failed');
    }
  }

  async function ensureStarted(): Promise<WakuNode> {
    if (node && started) return node;
    node = await withTimeout(createNode(config), config.peerTimeoutMs, 'waku node startup timed out');
    await subscribeOwnDecoder(node);
    connectionListener = (event) => {
      if (event.detail === true) {
        void subscribeOwnDecoder(node!);
      }
    };
    node.events.addEventListener(WakuEvent.Connection, connectionListener);
    started = true;
    return node;
  }

  return {
    async ready() {
      await ensureStarted();
      return true;
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
    },
  };
}

export function generateWakuIdentity(): { privateKey: Uint8Array; publicKeyHex: string } {
  const privateKey = generatePrivateKey();
  return { privateKey, publicKeyHex: bytesToHex(getPublicKey(privateKey)) };
}
