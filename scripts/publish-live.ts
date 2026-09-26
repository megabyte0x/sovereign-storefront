// Private admin publication command for the live seller.
//
//   SSF_ADMIN_TOKEN_FILE=<0600 file> node --experimental-strip-types scripts/publish-live.ts \
//     --admin-url http://127.0.0.1:<admin-port> --plaintext-file <path> \
//     --version <v> --amount-zat <int> --description <text>
//
// POSTs to the seller's private `/admin/products` route, which publishes via
// the seller's existing `publishProduct` API. There is no token flag (the token
// never enters argv), no product fixture and no default plaintext.
import { readFileSync, statSync } from 'node:fs';

export const MAX_PLAINTEXT_BYTES = 41;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const FLAGS = {
  '--admin-url': 'adminUrl',
  '--plaintext-file': 'plaintextFile',
  '--version': 'version',
  '--amount-zat': 'amountZat',
  '--description': 'description',
} as const;

export type PublishArgs = {
  adminUrl: string;
  plaintextFile: string;
  version: string;
  amountZat: string;
  description: string;
};

export type PublishRequest = {
  url: string;
  method: 'POST';
  headers: { authorization: string; 'content-type': 'application/json' };
  body: string;
};

export function parsePublishArgs(argv: readonly string[]): PublishArgs {
  const out: Partial<PublishArgs> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    if (!(flag in FLAGS)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    out[FLAGS[flag as keyof typeof FLAGS]] = value;
  }
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (!out[key]) throw new Error(`missing required ${flag}`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(out.amountZat as string)) {
    throw new Error('--amount-zat must be an integer string');
  }
  return out as PublishArgs;
}

function loopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('admin URL must be a loopback http URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error('admin URL must be a loopback http URL (127.0.0.1, localhost or [::1])');
  }
  return url;
}

export async function buildPublishRequest(
  args: PublishArgs,
  readToken: () => string | Promise<string>,
  readFile: (path: string) => Uint8Array | Promise<Uint8Array>,
): Promise<PublishRequest> {
  const base = loopbackUrl(args.adminUrl);
  const plaintext = await readFile(args.plaintextFile);
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error(`plaintext is ${plaintext.byteLength} bytes; the first release allows at most ${MAX_PLAINTEXT_BYTES}`);
  }
  if (plaintext.byteLength === 0) throw new Error('plaintext file is empty');
  const token = (await readToken()).trim();
  if (!token) throw new Error('admin token file is empty');
  return {
    url: new URL('/admin/products', base).toString(),
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      version: args.version,
      description: args.description,
      amountZat: args.amountZat,
      plaintextBase64: Buffer.from(plaintext).toString('base64'),
    }),
  };
}

export function formatPublishResult(status: number, body: unknown): string {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (status === 201 && typeof record.ciphertextCid === 'string' && record.replica === true) {
    const version = typeof record.version === 'string' ? record.version : '?';
    return `published version=${version} cid=${record.ciphertextCid.slice(0, 12)}… replica=ok`;
  }
  // Only fixed, known error strings are echoed; anything else is summarised.
  const known = new Set([
    'replica unavailable',
    'product version already published',
    'payload too large',
    'unauthorized',
    'invalid version',
    'invalid description',
    'amountZat must be an integer string',
    'invalid plaintextBase64',
    'malformed json',
    'malformed payload',
    'invalid product',
    'not found',
  ]);
  const error = typeof record.error === 'string' && known.has(record.error) ? record.error : 'unknown';
  return `publish failed: ${status} ${error}`;
}

export function readTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.SSF_ADMIN_TOKEN_FILE;
  if (!path) throw new Error('SSF_ADMIN_TOKEN_FILE is required');
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`SSF_ADMIN_TOKEN_FILE must be mode 0600 (is ${mode.toString(8)})`);
  return readFileSync(path, 'utf8');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parsePublishArgs(argv);
    const req = await buildPublishRequest(args, () => readTokenFile(), (p) => new Uint8Array(readFileSync(p)));
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = res.status === 401 ? { error: 'unauthorized' } : null;
    }
    const line = formatPublishResult(res.status, body);
    if (res.status === 201) {
      console.log(line);
      return 0;
    }
    console.error(line);
    return 1;
  } catch (error) {
    console.error(`publish failed: ${error instanceof Error ? error.message : 'error'}`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
