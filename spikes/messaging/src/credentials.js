import { getPublicKey } from "@waku/message-encryption";
import { bytesToHex, hexToBytes } from "@waku/utils/bytes";

const DB_NAME = "ssf-purchase-credentials";
const STORE = "credentials";
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return hexToBytes(value);
  }
  return hexToBytes(bytesToHex(new Uint8Array(value)));
}

export async function persistPurchaseCredentials(record) {
  const db = await openDb();
  const stored = {
    id: record.id,
    privateKeyHex: bytesToHex(bytesFrom(record.privateKey)),
    publicKeyHex: bytesToHex(bytesFrom(record.publicKey))
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(stored);
  });
  const loaded = await loadPurchaseCredentials(record.id);
  return Boolean(loaded?.privateKeyHex);
}

export async function loadPurchaseCredentials(id) {
  const db = await openDb();
  const stored = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!stored) {
    return null;
  }
  return {
    id: stored.id,
    privateKey: hexToBytes(stored.privateKeyHex),
    publicKey: hexToBytes(stored.publicKeyHex),
    privateKeyHex: stored.privateKeyHex,
    publicKeyHex: stored.publicKeyHex
  };
}

export function exportRecoveryMaterial(record) {
  if (!record?.privateKey) {
    return null;
  }
  return JSON.stringify({
    v: 1,
    privateKeyHex: bytesToHex(bytesFrom(record.privateKey)),
    publicKeyHex: bytesToHex(bytesFrom(record.publicKey))
  });
}

export function importRecoveryMaterial(exported) {
  if (typeof exported !== "string") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(exported);
  } catch {
    return null;
  }
  if (!parsed?.privateKeyHex || !parsed?.publicKeyHex) {
    return null;
  }
  return {
    privateKey: hexToBytes(parsed.privateKeyHex),
    publicKey: hexToBytes(parsed.publicKeyHex)
  };
}

export function provePossession(privateKeyBytes, expectedPublicKey) {
  try {
    const derived = getPublicKey(bytesFrom(privateKeyBytes));
    return bytesToHex(derived) === bytesToHex(bytesFrom(expectedPublicKey));
  } catch {
    return false;
  }
}
