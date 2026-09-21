import { bytesToHex, hexToBytes } from "@waku/utils/bytes";
import {
  persistPurchaseCredentials,
  loadPurchaseCredentials,
  exportRecoveryMaterial,
  importRecoveryMaterial,
  provePossession
} from "./credentials.js";
import { probeContentTopic } from "./routing.js";
import {
  createBuyerSession,
  generateIdentity,
  identityFromHex,
  startNetworkNode
} from "./waku-session.js";

const CREDENTIAL_ID = "probe-purchase";

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = text;
  }
}

const state = {
  node: null,
  session: null,
  identity: null,
  contentTopic: null
};

async function persistIdentity(identity) {
  const wrote = await persistPurchaseCredentials({
    id: CREDENTIAL_ID,
    privateKey: identity.privateKey,
    publicKey: identity.publicKey
  });
  if (!wrote) {
    throw new Error("credential persist failed");
  }
  return loadPurchaseCredentials(CREDENTIAL_ID);
}

window.ssfProbe = {
  probeContentTopic,
  async startBuyer({ contentTopic, sellerPublicKeyHex, privateKeyHex }) {
    setStatus("starting");
    if (state.node) {
      await state.node.stop();
      state.node = null;
    }
    const identity = privateKeyHex
      ? identityFromHex(privateKeyHex)
      : generateIdentity();
    const stored = await persistIdentity(identity);
    state.identity = {
      ...identity,
      privateKey: stored.privateKey,
      publicKey: stored.publicKey
    };
    state.contentTopic = contentTopic;
    const { node } = await startNetworkNode({ contentTopic });
    state.node = node;
    state.session = createBuyerSession({
      contentTopic,
      buyerIdentity: state.identity,
      sellerPublicKey: hexToBytes(sellerPublicKeyHex)
    });
    await state.session.start(node);
    setStatus("connected");
    return {
      publicKeyHex: state.identity.publicKeyHex,
      peerId: node.peerId.toString(),
      connected: node.isConnected()
    };
  },
  async sendOrderRequest(body) {
    if (!state.session) {
      throw new Error("buyer session not started");
    }
    setStatus("sending");
    const ack = await state.session.sendRequest({
      type: "order-request",
      buyerPublicKeyHex: state.identity.publicKeyHex,
      ...body
    });
    setStatus("sent");
    return ack;
  },
  async waitAccepted(timeoutMs) {
    const accepted = await state.session.waitAccepted(timeoutMs);
    setStatus("accepted");
    return {
      ok: accepted.ok,
      requestId: accepted.payload.requestId,
      responseId: accepted.payload.responseId,
      logicalCount: accepted.payload.logicalCount
    };
  },
  routingInspections() {
    return state.session?.routingInspections ?? [];
  },
  lastTransportAck() {
    return state.session?.lastTransportAck ?? null;
  },
  async proveStoredPossession() {
    const loaded = await loadPurchaseCredentials(CREDENTIAL_ID);
    if (!loaded) {
      return { ok: false, reason: "missing credentials" };
    }
    return {
      ok: provePossession(loaded.privateKey, loaded.publicKey),
      publicKeyHex: loaded.publicKeyHex
    };
  },
  async exportRecovery() {
    const loaded = await loadPurchaseCredentials(CREDENTIAL_ID);
    return exportRecoveryMaterial(loaded);
  },
  async importRecovery(exported) {
    const restored = importRecoveryMaterial(exported);
    if (!restored) {
      throw new Error("import failed");
    }
    const identity = identityFromHex(bytesToHex(restored.privateKey));
    await persistIdentity(identity);
    state.identity = identity;
    return {
      ok: provePossession(identity.privateKey, restored.publicKey),
      publicKeyHex: identity.publicKeyHex
    };
  },
  async stop() {
    if (state.node) {
      await state.node.stop();
      state.node = null;
    }
    state.session = null;
    setStatus("stopped");
  }
};

setStatus("probe-loaded");
