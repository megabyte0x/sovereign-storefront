import { generatePrivateKey, getPublicKey } from "@waku/message-encryption";
import { createDecoder, createEncoder } from "@waku/message-encryption/ecies";
import { DefaultNetworkConfig, Protocols } from "@waku/sdk";
import { createLightNode } from "@waku/sdk";
import { createRoutingInfo } from "@waku/utils";
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from "@waku/utils/bytes";
import { acceptApplicationResponse } from "./application-response.js";
import { createSellerFulfillment } from "./fulfillment.js";
import { inspectPublicRouting } from "./routing.js";

export const NETWORK_CONFIG = DefaultNetworkConfig;

export function routingFor(contentTopic) {
  return createRoutingInfo(NETWORK_CONFIG, { contentTopic });
}

export function generateIdentity() {
  const privateKey = generatePrivateKey();
  return {
    privateKey,
    publicKey: getPublicKey(privateKey),
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(getPublicKey(privateKey))
  };
}

export function identityFromHex(privateKeyHex) {
  const privateKey = hexToBytes(privateKeyHex);
  return {
    privateKey,
    publicKey: getPublicKey(privateKey),
    privateKeyHex,
    publicKeyHex: bytesToHex(getPublicKey(privateKey))
  };
}

export function createEciesPair({ contentTopic, recipientPublicKey, senderPrivateKey, ownPrivateKey }) {
  const routingInfo = routingFor(contentTopic);
  return {
    routingInfo,
    encoder: createEncoder({
      contentTopic,
      routingInfo,
      publicKey: recipientPublicKey,
      sigPrivKey: senderPrivateKey
    }),
    decoder: createDecoder(contentTopic, routingInfo, ownPrivateKey)
  };
}

export async function startNetworkNode({ contentTopic, timeoutMs = 90_000 } = {}) {
  const node = await createLightNode({
    defaultBootstrap: true,
    networkConfig: NETWORK_CONFIG
  });
  await node.waitForPeers([Protocols.LightPush, Protocols.Filter], timeoutMs);
  return { node, contentTopic };
}

export function publicEnvelopeFields(message) {
  return {
    contentTopic: message.contentTopic,
    pubsubTopic: message.pubsubTopic,
    version: message.version,
    timestamp: message.timestamp,
    ephemeral: message.ephemeral,
    meta: message.meta,
    rateLimitProof: message.rateLimitProof
  };
}

export function encodeJson(value) {
  return utf8ToBytes(JSON.stringify(value));
}

export function decodeJson(bytes) {
  return JSON.parse(bytesToUtf8(bytes));
}

export async function sendEncrypted(node, encoder, body) {
  const transportAck = await node.lightPush.send(encoder, {
    payload: encodeJson(body)
  });
  return {
    transportAck: {
      successCount: transportAck.successes?.length ?? 0,
      failureCount: transportAck.failures?.length ?? 0
    }
  };
}

export async function subscribeEncrypted(node, decoder, onMessage) {
  const ok = await node.filter.subscribe(decoder, onMessage);
  if (!ok) {
    throw new Error("filter subscribe failed");
  }
  return ok;
}

export function createSellerSession({
  contentTopic,
  sellerIdentity,
  expectedAuthorization
}) {
  const fulfillment = createSellerFulfillment({ expectedAuthorization });

  return {
    contentTopic,
    sellerIdentity,
    fulfillment,
    routingInspections: [],
    async start(node) {
      this.node = node;
      const codecs = createEciesPair({
        contentTopic,
        recipientPublicKey: sellerIdentity.publicKey,
        senderPrivateKey: sellerIdentity.privateKey,
        ownPrivateKey: sellerIdentity.privateKey
      });
      this.inboundDecoder = codecs.decoder;
      await subscribeEncrypted(node, codecs.decoder, async (message) => {
        if (!message?.payload) {
          return;
        }
        const item = {
          message,
          body: (() => {
            try {
              return decodeJson(message.payload);
            } catch {
              return null;
            }
          })(),
          routing: inspectPublicRouting(publicEnvelopeFields(message))
        };
        this.routingInspections.push(item.routing);
        if (item.body?.type !== "order-request") {
          return;
        }
        const result = fulfillment.handleRequest({
          requestId: item.body.requestId,
          authorization: item.body.authorization
        });
        if (!result.ok) {
          return;
        }
        const buyerPublicKey = hexToBytes(item.body.buyerPublicKeyHex);
        const outbound = createEciesPair({
          contentTopic,
          recipientPublicKey: buyerPublicKey,
          senderPrivateKey: sellerIdentity.privateKey,
          ownPrivateKey: sellerIdentity.privateKey
        });
        await sendEncrypted(node, outbound.encoder, {
          type: "order-response",
          requestId: result.requestId,
          responseId: result.responseId,
          logicalCount: result.logicalCount
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
}

export function createBuyerSession({
  contentTopic,
  buyerIdentity,
  sellerPublicKey
}) {
  const accepted = [];
  const routingInspections = [];
  let lastTransportAck = null;
  let consumed = 0;

  return {
    contentTopic,
    buyerIdentity,
    sellerPublicKey,
    accepted,
    routingInspections,
    get lastTransportAck() {
      return lastTransportAck;
    },
    async start(node) {
      this.node = node;
      const inbound = createEciesPair({
        contentTopic,
        recipientPublicKey: buyerIdentity.publicKey,
        senderPrivateKey: buyerIdentity.privateKey,
        ownPrivateKey: buyerIdentity.privateKey
      });
      await subscribeEncrypted(node, inbound.decoder, (message) => {
        if (!message?.payload) {
          return;
        }
        routingInspections.push(inspectPublicRouting(publicEnvelopeFields(message)));
        const result = acceptApplicationResponse(message, sellerPublicKey);
        if (result.ok) {
          accepted.push(result);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    },
    async sendRequest(body) {
      const outbound = createEciesPair({
        contentTopic,
        recipientPublicKey: sellerPublicKey,
        senderPrivateKey: buyerIdentity.privateKey,
        ownPrivateKey: buyerIdentity.privateKey
      });
      const sent = await sendEncrypted(this.node, outbound.encoder, body);
      lastTransportAck = sent.transportAck;
      const ackAccepted = acceptApplicationResponse(
        sent.transportAck,
        sellerPublicKey
      );
      if (ackAccepted.ok) {
        throw new Error("transport ack was treated as application response");
      }
      return sent.transportAck;
    },
    async waitAccepted(timeoutMs = 90_000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (accepted.length > consumed) {
          const next = accepted[consumed];
          consumed += 1;
          return next;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("timed out waiting for accepted application response");
    }
  };
}
