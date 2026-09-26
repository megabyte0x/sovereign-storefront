import { expect, test, vi } from 'vitest';
import { renderPurchasesView, startBrowserApp } from '../../src/browser/app.ts';
import type { BrowserPurchase, PurchaseStore } from '../../src/contracts/types.ts';

type Listener = (event: { target: unknown }) => unknown;

function fakeRoot() {
  const listeners = new Map<string, Listener[]>();
  const root = {
    innerHTML: '',
    querySelector() { return null; },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return {
    root,
    async dispatch(type: string, target: unknown) {
      await Promise.all((listeners.get(type) ?? []).map((listener) => listener({ target })));
    },
  };
}

const PURCHASE: BrowserPurchase = {
  version: 1, requestId: 'req-imported', orderId: 'ord-1', productVersion: 'book-v1',
  sellerOrigin: 'http://127.0.0.1', sellerKeyId: 'seller', credentialId: 'cred-1', invoice: null,
};

function store(importBackup: PurchaseStore['importBackup']): PurchaseStore & { rows: BrowserPurchase[] } {
  const rows: BrowserPurchase[] = [];
  return {
    rows,
    async save() {},
    async get() { return null; },
    async list() { return [...rows]; },
    async exportBackup() { return new Uint8Array(); },
    importBackup,
    async saveDelivery() {},
    async getDelivery() { return null; },
  };
}

function fetch404(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://127.0.0.1').pathname;
    if (path === '/api/product') {
      return new Response(JSON.stringify({ version: 'book-v1', description: 'x', amountZat: '1', network: 'test', fileSize: null, fileFormatVersion: null, sellerKeyId: 'seller' }));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function fileInput(bytes: Uint8Array) {
  return {
    id: 'import-backup',
    value: 'C:\\fakepath\\purchase.backup',
    getAttribute: (name: string) => (name === 'id' ? 'import-backup' : null),
    files: [{ name: 'purchase.backup', arrayBuffer: async () => bytes.slice().buffer }],
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('the purchases view offers a labelled Import backup file control', () => {
  const root = { innerHTML: '', querySelector: () => null };
  renderPurchasesView(root as never, { purchases: [] });
  expect(root.innerHTML).toMatch(/<label[^>]*>\s*Import backup\s*<input[^>]*type="file"[^>]*id="import-backup"/);
});

test('choosing a backup file imports its exact bytes and re-renders My purchases with the imported row', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const s = store(vi.fn(async (data: Uint8Array) => { s.rows.push(PURCHASE); expect([...data]).toEqual([...bytes]); return PURCHASE; }));
  const { root, dispatch } = fakeRoot();
  await startBrowserApp(root as never, { fetch: fetch404(), openStore: async () => s, origin: '' });
  await dispatch('change', fileInput(bytes));
  await settle();
  expect(s.importBackup).toHaveBeenCalledTimes(1);
  expect(root.innerHTML).toContain('data-request-id="req-imported"');
  expect(root.innerHTML).toContain('Backup imported');
});

test('a rejected backup shows an error and imports nothing', async () => {
  const s = store(vi.fn(async () => { throw new Error('backup signature invalid'); }));
  const { root, dispatch } = fakeRoot();
  await startBrowserApp(root as never, { fetch: fetch404(), openStore: async () => s, origin: '' });
  await dispatch('change', fileInput(new Uint8Array([9])));
  await settle();
  expect(root.innerHTML).toContain('Backup could not be imported');
  expect(root.innerHTML).not.toContain('backup signature invalid');
  expect(s.rows).toEqual([]);
});
