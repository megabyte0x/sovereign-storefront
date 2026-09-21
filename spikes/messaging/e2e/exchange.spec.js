import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { test, expect, chromium } from "@playwright/test";
import { bytesToHex } from "@waku/utils/bytes";
import { ROUTING_MARKERS, probeContentTopic } from "../src/routing.js";
import {
  createSellerSession,
  generateIdentity,
  startNetworkNode
} from "../src/waku-session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "data");

function uniqueRunId() {
  return bytesToHex(randomBytes(8));
}

async function waitForProbe(page) {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.ssfProbe));
}

test.describe.configure({ mode: "serial" });

test("browser sends encrypted request over Logos and accepts only authenticated seller response", async ({
  page
}) => {
  const contentTopic = probeContentTopic(uniqueRunId());
  const sellerIdentity = generateIdentity();
  const authorization = bytesToHex(randomBytes(16));
  const seller = createSellerSession({
    contentTopic,
    sellerIdentity,
    expectedAuthorization: authorization
  });
  const { node } = await startNetworkNode({ contentTopic, timeoutMs: 120_000 });
  try {
    await seller.start(node);
    await waitForProbe(page);
    const started = await page.evaluate(
      async ({ contentTopic, sellerPublicKeyHex }) => {
        return window.ssfProbe.startBuyer({ contentTopic, sellerPublicKeyHex });
      },
      {
        contentTopic,
        sellerPublicKeyHex: sellerIdentity.publicKeyHex
      }
    );
    expect(started.connected).toBeTruthy();

    const requestId = "order-1";
    const t0 = Date.now();
    const ack = await page.evaluate(
      async ({ requestId, authorization }) => {
        return window.ssfProbe.sendOrderRequest({
          requestId,
          authorization,
          ORDER_MARK: "ORDER_MARK",
          BUYER_MARK: "BUYER_MARK",
          PRODUCT_MARK: "PRODUCT_MARK"
        });
      },
      { requestId, authorization }
    );
    expect(ack.successCount).toBeGreaterThan(0);

    const accepted = await page.evaluate(async () => {
      return window.ssfProbe.waitAccepted(120000);
    });
    const latencyMs = Date.now() - t0;
    expect(accepted.ok).toBeTruthy();
    expect(accepted.requestId).toBe(requestId);
    expect(accepted.responseId).toBeTruthy();

    const inspections = await page.evaluate(() => window.ssfProbe.routingInspections());
    for (const inspection of [...inspections, ...seller.routingInspections]) {
      expect(inspection.ok).toBeTruthy();
      expect(inspection.found).toEqual([]);
    }
    for (const marker of ROUTING_MARKERS) {
      expect(contentTopic.includes(marker)).toBeFalsy();
    }

    const ackAccepted = await page.evaluate(async () => {
      return window.ssfProbe.lastTransportAck();
    });
    expect(ackAccepted).toBeTruthy();
    expect(accepted.responseId).not.toBe(String(ackAccepted.successCount));

    page.once("console", () => {});
    test.info().annotations.push({
      type: "latencyMs",
      description: String(latencyMs)
    });
  } finally {
    await page.evaluate(async () => {
      if (window.ssfProbe) {
        await window.ssfProbe.stop();
      }
    }).catch(() => {});
    await node.stop();
  }
});

test("IndexedDB credentials survive browser restart and export restores a fresh profile", async () => {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const profileDir = join(DATA_DIR, "buyer-profile");
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const first = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  let exported;
  let publicKeyHex;
  try {
    const page = first.pages()[0] || (await first.newPage());
    await waitForProbe(page);
    const identity = generateIdentity();
    publicKeyHex = identity.publicKeyHex;
    await page.evaluate(async (privateKeyHex) => {
      const { persistPurchaseCredentials, provePossession, loadPurchaseCredentials, exportRecoveryMaterial } =
        await import("/src/credentials.js");
      const { identityFromHex } = await import("/src/waku-session.js");
      const ident = identityFromHex(privateKeyHex);
      const wrote = await persistPurchaseCredentials({
        id: "probe-purchase",
        privateKey: ident.privateKey,
        publicKey: ident.publicKey
      });
      if (!wrote) {
        throw new Error("write failed");
      }
      window.__probeExport = await exportRecoveryMaterial(
        await loadPurchaseCredentials("probe-purchase")
      );
      window.__probeProve = provePossession(ident.privateKey, ident.publicKey);
    }, identity.privateKeyHex);
    const firstProve = await page.evaluate(() => window.__probeProve);
    expect(firstProve).toBeTruthy();
    exported = await page.evaluate(() => window.__probeExport);
    expect(typeof exported).toBe("string");
  } finally {
    await first.close();
  }

  const restarted = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = restarted.pages()[0] || (await restarted.newPage());
    await waitForProbe(page);
    const proved = await page.evaluate(async () => {
      return window.ssfProbe.proveStoredPossession();
    });
    expect(proved.ok).toBeTruthy();
    expect(proved.publicKeyHex).toBe(publicKeyHex);
  } finally {
    await restarted.close();
  }

  const freshDir = join(DATA_DIR, "fresh-profile");
  rmSync(freshDir, { recursive: true, force: true });
  mkdirSync(freshDir, { recursive: true, mode: 0o700 });
  const fresh = await chromium.launchPersistentContext(freshDir, {
    headless: true,
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = fresh.pages()[0] || (await fresh.newPage());
    await waitForProbe(page);
    const imported = await page.evaluate(async (exported) => {
      return window.ssfProbe.importRecovery(exported);
    }, exported);
    expect(imported.ok).toBeTruthy();
    expect(imported.publicKeyHex).toBe(publicKeyHex);
  } finally {
    await fresh.close();
  }
});

test("reconnect resend yields one logical order response", async ({ page }) => {
  const contentTopic = probeContentTopic(uniqueRunId());
  const sellerIdentity = generateIdentity();
  const authorization = bytesToHex(randomBytes(16));
  const seller = createSellerSession({
    contentTopic,
    sellerIdentity,
    expectedAuthorization: authorization
  });
  const { node } = await startNetworkNode({ contentTopic, timeoutMs: 120_000 });
  try {
    await seller.start(node);
    await waitForProbe(page);
    await page.evaluate(
      async ({ contentTopic, sellerPublicKeyHex }) => {
        return window.ssfProbe.startBuyer({ contentTopic, sellerPublicKeyHex });
      },
      {
        contentTopic,
        sellerPublicKeyHex: sellerIdentity.publicKeyHex
      }
    );
    const request = {
      requestId: "order-retry",
      authorization,
      ORDER_MARK: "ORDER_MARK",
      BUYER_MARK: "BUYER_MARK",
      PRODUCT_MARK: "PRODUCT_MARK"
    };
    await page.evaluate(async (request) => window.ssfProbe.sendOrderRequest(request), request);
    const first = await page.evaluate(async () => window.ssfProbe.waitAccepted(120000));
    await page.evaluate(async () => window.ssfProbe.stop());
    await page.evaluate(
      async ({ contentTopic, sellerPublicKeyHex }) => {
        return window.ssfProbe.startBuyer({ contentTopic, sellerPublicKeyHex });
      },
      {
        contentTopic,
        sellerPublicKeyHex: sellerIdentity.publicKeyHex
      }
    );
    await page.evaluate(async (request) => window.ssfProbe.sendOrderRequest(request), request);
    const second = await page.evaluate(async () => window.ssfProbe.waitAccepted(120000));
    expect(first.responseId).toBe(second.responseId);
    expect(first.logicalCount).toBe(1);
    expect(second.logicalCount).toBe(1);
  } finally {
    await page.evaluate(async () => window.ssfProbe.stop()).catch(() => {});
    await node.stop();
  }
});
