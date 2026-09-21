export class Zip321Error extends Error {
  code: 'transparent_forbidden' | 'network_forbidden' | 'invalid_uri' | 'memo_too_long';
  constructor(
    code: Zip321Error['code'],
    message: string,
  ) {
    super(message);
    this.name = 'Zip321Error';
    this.code = code;
  }
}

export type Zip321Request = {
  address: string;
  amountZat: string;
  memoUtf8?: string;
  message?: string;
};

const SAPLING_TEST = /^ztestsapling1[0-9a-z]+$/;
const UA_TEST = /^utest1[0-9a-z]+$/;
const UA_REGTEST = /^uregtest1[0-9a-z]+$/;
const TRANSPARENT = /^(t[13]|tm)[1-9A-HJ-NP-Za-km-z]+$/;
const MAINNET_SHIELDED = /^(zs1|u1)[0-9a-z]+$/;

function assertTestnetShielded(address: string): void {
  if (TRANSPARENT.test(address)) {
    throw new Zip321Error('transparent_forbidden', 'transparent addresses are not allowed');
  }
  if (MAINNET_SHIELDED.test(address) || address.startsWith('zs1') || address.startsWith('u1')) {
    throw new Zip321Error('network_forbidden', 'mainnet addresses are not allowed');
  }
  if (!SAPLING_TEST.test(address) && !UA_TEST.test(address) && !UA_REGTEST.test(address)) {
    throw new Zip321Error('network_forbidden', 'address is not a testnet or regtest shielded receiver');
  }
}

function zatToAmount(zat: string): string {
  if (!/^[0-9]+$/.test(zat)) {
    throw new Zip321Error('invalid_uri', 'amountZat must be an unsigned decimal integer');
  }
  const n = BigInt(zat);
  const whole = n / 100_000_000n;
  const frac = n % 100_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(8, '0').replace(/0+$/, '')}`;
}

function amountToZat(amount: string): string {
  if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(amount)) {
    throw new Zip321Error('invalid_uri', 'invalid ZIP-321 amount');
  }
  const [whole, frac = ''] = amount.split('.');
  return (BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0'))).toString();
}

function encodeMemo(memoUtf8: string): string {
  const bytes = Buffer.from(memoUtf8, 'utf8');
  if (bytes.length > 512) {
    throw new Zip321Error('memo_too_long', 'memo exceeds 512 bytes');
  }
  return bytes.toString('base64url');
}

function qcharEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeZip321(request: Zip321Request): string {
  assertTestnetShielded(request.address);
  const params = [`amount=${zatToAmount(request.amountZat)}`];
  if (request.memoUtf8 !== undefined) {
    params.push(`memo=${encodeMemo(request.memoUtf8)}`);
  }
  if (request.message !== undefined) {
    params.push(`message=${qcharEncode(request.message)}`);
  }
  return `zcash:${request.address}?${params.join('&')}`;
}

export function parseZip321(uri: string): Zip321Request {
  if (!uri.startsWith('zcash:')) {
    throw new Zip321Error('invalid_uri', 'not a zcash URI');
  }
  const body = uri.slice('zcash:'.length);
  const q = body.indexOf('?');
  const address = q === -1 ? body : body.slice(0, q);
  const query = q === -1 ? '' : body.slice(q + 1);
  assertTestnetShielded(address);
  const params = new URLSearchParams(query);
  const amount = params.get('amount');
  if (!amount) {
    throw new Zip321Error('invalid_uri', 'amount required');
  }
  const memo = params.get('memo');
  const message = params.get('message');
  return {
    address,
    amountZat: amountToZat(amount),
    memoUtf8: memo ? Buffer.from(memo, 'base64url').toString('utf8') : undefined,
    message: message ?? undefined,
  };
}
