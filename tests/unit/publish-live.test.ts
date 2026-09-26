import { expect, test } from 'vitest';
import {
  buildPublishRequest,
  formatPublishResult,
  parsePublishArgs,
} from '../../scripts/publish-live.ts';

const TOKEN = 'tok-SECRET-0123456789';
const PLAINTEXT = new TextEncoder().encode('hello live book');

function argv(overrides: Record<string, string> = {}): string[] {
  const values: Record<string, string> = {
    '--admin-url': 'http://127.0.0.1:8081',
    '--plaintext-file': '/tmp/book.txt',
    '--version': 'book-v1',
    '--amount-zat': '100000000',
    '--description': 'A book',
    ...overrides,
  };
  return Object.entries(values).flat();
}

test('parsePublishArgs requires every flag and has no token flag', () => {
  const args = parsePublishArgs(argv());
  expect(args).toEqual({
    adminUrl: 'http://127.0.0.1:8081',
    plaintextFile: '/tmp/book.txt',
    version: 'book-v1',
    amountZat: '100000000',
    description: 'A book',
  });
  expect(() => parsePublishArgs(argv().slice(2))).toThrow(/--admin-url/);
  expect(() => parsePublishArgs([...argv(), '--token', 'x'])).toThrow(/unknown/i);
  expect(() => parsePublishArgs(argv({ '--amount-zat': '1.5' }))).toThrow(/amount/i);
});

test('buildPublishRequest reads the token only via readToken and puts it only in Authorization', async () => {
  let tokenReads = 0;
  const req = await buildPublishRequest(
    parsePublishArgs(argv()),
    () => {
      tokenReads += 1;
      return TOKEN;
    },
    (path) => {
      expect(path).toBe('/tmp/book.txt');
      return PLAINTEXT;
    },
  );
  expect(tokenReads).toBe(1);
  expect(req.url).toBe('http://127.0.0.1:8081/admin/products');
  expect(req.method).toBe('POST');
  expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
  const others = JSON.stringify({ url: req.url, body: req.body, headers: { ...req.headers, authorization: '' } });
  expect(others).not.toContain(TOKEN);
  expect(JSON.parse(req.body)).toEqual({
    version: 'book-v1',
    description: 'A book',
    amountZat: '100000000',
    plaintextBase64: Buffer.from(PLAINTEXT).toString('base64'),
  });
});

test.each(['http://10.0.0.5:8081', 'http://example.com:8081', 'http://127.0.0.1.evil.com', 'ftp://127.0.0.1'])(
  'rejects non-loopback admin URL %s',
  async (url) => {
    await expect(buildPublishRequest(parsePublishArgs(argv({ '--admin-url': url })), () => TOKEN, () => PLAINTEXT))
      .rejects.toThrow(/loopback/);
  },
);

test.each(['http://localhost:8081', 'http://[::1]:8081/'])('accepts loopback admin URL %s', async (url) => {
  const req = await buildPublishRequest(parsePublishArgs(argv({ '--admin-url': url })), () => TOKEN, () => PLAINTEXT);
  expect(req.url.endsWith('/admin/products')).toBe(true);
});

test('rejects plaintext over 41 bytes before reading the token', async () => {
  let tokenReads = 0;
  await expect(buildPublishRequest(parsePublishArgs(argv()), () => {
    tokenReads += 1;
    return TOKEN;
  }, () => new Uint8Array(42))).rejects.toThrow(/41/);
  expect(tokenReads).toBe(0);
});

test('formatPublishResult prints no token and at most a 12-character CID prefix', () => {
  const cid = 'zDvZRwzmAbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const ok = formatPublishResult(201, { version: 'book-v1', ciphertextCid: cid, replica: true });
  expect(ok).toBe(`published version=book-v1 cid=${cid.slice(0, 12)}… replica=ok`);
  expect(ok).not.toContain(cid.slice(0, 13));
  const failed = formatPublishResult(503, { error: 'replica unavailable' });
  expect(failed).toBe('publish failed: 503 replica unavailable');
  const echoed = formatPublishResult(401, { error: `bad ${TOKEN}` });
  expect(echoed).not.toContain(TOKEN);
  expect(formatPublishResult(500, null)).toBe('publish failed: 500 unknown');
});
