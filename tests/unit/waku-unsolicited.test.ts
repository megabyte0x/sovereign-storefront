import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@waku/message-encryption';
import { createDecoder, createEncoder } from '@waku/message-encryption/ecies';
import { bytesToHex } from '@waku/utils/bytes';
import type { SellerResponse, WakuConfig, WakuSession } from '../../src/contracts/messages.ts';
import { createWakuSession, type WakuNode } from '../../src/adapters/waku.ts';
import type { BrowserPurchase, CredentialAdapter, Invoice, PurchaseStore } from '../../src/contracts/types.ts';
import { createWakuOrderTransport } from '../../src/browser/waku-transport.ts';

type EciesEncoder = ReturnType<typeof createEncoder>;
type EciesDecoder = ReturnType<typeof createDecoder>;

const CONTENT_TOPIC = '/ssf/1/unsolicited-run/proto';
const NETWORK = 'regtest' as const;
const AMOUNT = '100';
const PRODUCT = 'book-v1';
const ORDER = 'ord-push-1';

function freshConfig(): WakuConfig {
  return { contentTopic: CONTENT_TOPIC, bootstrapPeers: [], peerTimeoutMs: 1000 };
}

/** The makeFakeNode pattern from tests/unit/waku.test.ts: every lightPush.send
 * is routed through real ECIES encoder→decoder round trips to every
 * subscriber, and the subscriber callbacks are awaited, so once the seller's
 * `send` resolves the buyer's handler has fully run. */
function makeFakeNode(): WakuNode {
  const subscribers: Array<{ decoder: EciesDecoder; callback: (msg: unknown) => unknown }> = [];
  return {
    async waitForPeers() { return; },
    lightPush: {
      async send(encoder: EciesEncoder, message: { payload: Uint8Array }) {
        const proto = await encoder.toProtoObj(message);
        if (proto) {
          for (const { decoder, callback } of subscribers) {
            const decoded = await decoder.fromProtoObj(encoder.pubsubTopic, proto);
            await callback(decoded);
          }
        }
        return { successes: ['peer-a'], failures: [] } as never;
      },
    } as never,
    filter: {
      async subscribe(decoder: EciesDecoder, callback: (msg: unknown) => unknown) {
        subscribers.push({ decoder, callback });
        return true;
      },
      async unsubscribe() { return true; },
    } as never,
    events: { addEventListener() { }, removeEventListener() { } } as never,
    async stop() { return; },
  };
}

function memoryPurchaseStore(records: BrowserPurchase[]): PurchaseStore & { saves: number } {
  const saved = new Map(records.map((r) => [r.requestId, r]));
  const deliveries = new Map<string, { packageId: string; wireEnvelope: Uint8Array }>();
  const store = {
    saves: 0,
    async save(record: BrowserPurchase) { saved.set(record.requestId, record); },
    async get(requestId: string) { return saved.get(requestId) ?? null; },
    async list() { return [...saved.values()]; },
    async exportBackup(): Promise<Uint8Array> { throw new Error('not used'); },
    async importBackup(): Promise<BrowserPurchase> { throw new Error('not used'); },
    async saveDelivery(orderId: string, record: { packageId: string; wireEnvelope: Uint8Array }) {
      store.saves += 1;
      deliveries.set(orderId, record);
    },
    async getDelivery(orderId: string) { return deliveries.get(orderId) ?? null; },
  };
  return store;
}

function fakeCredentialAdapter(credentialId: string, publicKeyHex: string): CredentialAdapter {
  const unused = async (): Promise<never> => { throw new Error('not used in this test'); };
  return {
    createPurchaseCredential: unused, provePossession: unused, verifyPossession: unused,
    decryptWrapped: unused, exportBackupMaterial: unused, importBackupMaterial: unused,
    async publicKey(id: string) {
      if (id !== credentialId) throw new Error('unknown credential');
      return publicKeyHex;
    },
    createWakuSession: unused,
  };
}

/** Mirrors src/seller/db.ts immutablePackageId. */
function packageIdOf(orderId: string, productVersion: string, buyerKeyId: string, envelope: Uint8Array): string {
  return createHash('sha256')
    .update(orderId).update('\0').update(productVersion).update('\0').update(buyerKeyId).update('\0')
    .update(envelope).digest('hex');
}

type Overrides = {
  signer?: 'seller' | 'impostor';
  buyerKeyId?: string;
  network?: 'test' | 'regtest';
  productVersion?: string;
  orderId?: string;
  packageId?: string;
  inReplyTo?: string;
  sellerKeyId?: string;
};

async function setup(options: { invoiceAmount?: string; recordProduct?: string } = {}) {
  const node = makeFakeNode();
  const sellerIdentity = generatePrivateKey();
  const sellerKeyId = bytesToHex(getPublicKey(sellerIdentity));
  const sellerSession = createWakuSession(freshConfig(), sellerIdentity, { createNode: async () => node });
  const impostorSession = createWakuSession(freshConfig(), generatePrivateKey(), { createNode: async () => node });

  const buyerIdentity = generatePrivateKey();
  const buyerKeyId = bytesToHex(getPublicKey(buyerIdentity));
  const credentialId = 'cred-push';
  const buyerSession: WakuSession = createWakuSession(freshConfig(), buyerIdentity, { createNode: async () => node });

  const invoice: Invoice = {
    id: 'inv-push-1', orderId: ORDER, productVersion: options.recordProduct ?? PRODUCT, buyerKeyId,
    network: NETWORK, amountZat: options.invoiceAmount ?? AMOUNT, destination: 'zregtestsapling1fixture', expiresAt: Date.now() + 60_000,
  };
  const record: BrowserPurchase = {
    version: 1, requestId: 'req-push-1', orderId: ORDER, productVersion: options.recordProduct ?? PRODUCT,
    sellerOrigin: 'https://seller.example', sellerKeyId, credentialId, invoice,
  };
  const purchases = memoryPurchaseStore([record]);
  const transport = createWakuOrderTransport(fakeCredentialAdapter(credentialId, buyerKeyId), buyerSession, {
    sellerKeyId, network: NETWORK, amountZat: AMOUNT, productVersion: PRODUCT,
  }, purchases);
  await transport.listen();
  const envelope = new Uint8Array([9, 9, 9, 7]);

  async function push(o: Overrides = {}): Promise<void> {
    const orderId = o.orderId ?? ORDER;
    const productVersion = o.productVersion ?? PRODUCT;
    const bodyBuyer = o.buyerKeyId ?? buyerKeyId;
    const packageId = o.packageId ?? packageIdOf(orderId, productVersion, bodyBuyer, envelope);
    const messageId = `push-${packageId}`;
    const at = Date.now();
    const body: SellerResponse = {
      version: 1, messageId, inReplyTo: o.inReplyTo ?? messageId, sellerKeyId: o.sellerKeyId ?? sellerKeyId,
      buyerKeyId: bodyBuyer, network: o.network ?? NETWORK, issuedAt: at, expiresAt: at + 15 * 60 * 1000,
      type: 'delivery', packageId,
      package: { orderId, productVersion, buyerKeyId: bodyBuyer, encryptedEnvelope: envelope },
    };
    const session = o.signer === 'impostor' ? impostorSession : sellerSession;
    await session.send(buyerKeyId, body);
  }
  return { push, purchases, buyerKeyId, sellerKeyId, buyerSession, envelope };
}

describe('unsolicited Waku delivery (seller dispatch-loop push)', () => {
  test('a well-formed push for a known order is persisted with its original signed envelope', async () => {
    const { push, purchases, buyerSession, sellerKeyId, buyerKeyId, envelope } = await setup();
    await push();
    const stored = await purchases.getDelivery(ORDER);
    expect(stored).not.toBeNull();
    expect(stored!.packageId).toBe(packageIdOf(ORDER, PRODUCT, buyerKeyId, envelope));
    // The stored bytes are the signed ECIES wire envelope: decodeStored
    // re-verifies the seller's signature and yields the same delivery.
    const reopened = await buyerSession.decodeStored(stored!.wireEnvelope);
    expect(reopened.signerKeyId).toBe(sellerKeyId);
    const body = reopened.body as { type: string; packageId: string; sellerKeyId: string };
    expect(body.type).toBe('delivery');
    expect(body.packageId).toBe(stored!.packageId);
    expect(body.sellerKeyId).toBe(sellerKeyId);
  });

  const negatives: Array<[string, Overrides, { invoiceAmount?: string; recordProduct?: string }?]> = [
    ['signed by a key other than the configured seller', { signer: 'impostor' }],
    ['body claims a different seller identity', { sellerKeyId: 'ab'.repeat(33) }],
    ['addressed to a different buyer key', { buyerKeyId: '04' + 'cd'.repeat(64) }],
    ['for the wrong network', { network: 'test' }],
    ['for a different product version', { productVersion: 'book-v2' }],
    ['for an unknown order', { orderId: 'ord-unknown' }],
    ['with a package id that does not match the sealed envelope', { packageId: 'f'.repeat(64) }],
    ['with an inReplyTo that is not the push self-reference', { inReplyTo: 'req-someone-else' }],
    ['when the known order was invoiced for a different amount', {}, { invoiceAmount: '999' }],
    ['when the known order records a different product version than configured', {}, { recordProduct: 'book-v0' }],
  ];
  for (const [label, overrides, opts] of negatives) {
    test(`drops silently: ${label}`, async () => {
      const { push, purchases } = await setup(opts);
      await expect(push(overrides)).resolves.toBeUndefined();
      expect(purchases.saves).toBe(0);
      expect(await purchases.getDelivery(overrides.orderId ?? ORDER)).toBeNull();
    });
  }

  test('a second push with a different package for an already-delivered order is not overwritten', async () => {
    const { push, purchases } = await setup();
    await push();
    const first = await purchases.getDelivery(ORDER);
    await push({ packageId: 'e'.repeat(64) }); // mismatched id: dropped
    expect((await purchases.getDelivery(ORDER))!.packageId).toBe(first!.packageId);
    await push(); // idempotent replay of the same package: no second write
    expect(purchases.saves).toBe(1);
  });
});
