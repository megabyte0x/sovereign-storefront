import * as jsQrModule from 'jsqr';
type JsQrFn = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const decodeQr = ((jsQrModule as unknown as { default?: JsQrFn }).default
  ?? (jsQrModule as unknown as JsQrFn));
import { describe, expect, test } from 'vitest';
import { buildQrMatrix, qrSvgMarkup } from '../../src/browser/payment-request.ts';
import { encodeZip321 } from '../../src/browser/app.ts';
import type { Invoice } from '../../src/contracts/types.ts';

/**
 * Rasterizes the exact `<rect>` primitives `qrSvgMarkup` emitted into an
 * RGBA bitmap jsQR can decode. This walks the real markup string (not the
 * matrix that produced it) so a bug in the SVG-emission loop itself -- an
 * off-by-one in x/y, wrong module size, wrong fill -- would show up as a
 * failed or wrong decode, not be masked by re-deriving pixels from the
 * matrix directly.
 */
function rasterizeSvg(svg: string): { width: number; height: number; data: Uint8ClampedArray } {
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!viewBox) throw new Error('svg missing viewBox');
  const width = Number(viewBox[1]);
  const height = Number(viewBox[2]);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rectRe = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="#111"\/>/g;
  let match: RegExpExecArray | null;
  while ((match = rectRe.exec(svg))) {
    const [, xs, ys, ws, hs] = match;
    const x0 = Number(xs);
    const y0 = Number(ys);
    const w = Number(ws);
    const h = Number(hs);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

function decode(svg: string): string {
  const { width, height, data } = rasterizeSvg(svg);
  const result = decodeQr(data, width, height);
  if (!result) throw new Error('jsQR failed to decode the rendered SVG');
  return result.data;
}

const LONG_DESTINATION =
  'uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    orderId: 'ord-1',
    productVersion: 'book-v1',
    buyerKeyId: 'buyer-1',
    network: 'test',
    amountZat: '100000000',
    destination: LONG_DESTINATION,
    attributionRef: 'attr-demo-1',
    expiresAt: Date.now() + 86_400_000,
    ...overrides,
  };
}

describe('payment-request QR', () => {
  test('renders a real, decodable QR for the exact long testnet ZIP-321 URI', () => {
    const uri = encodeZip321(invoice());
    const svg = qrSvgMarkup(uri);
    expect(decode(svg)).toBe(uri);
  });

  test('decodes the exact integer-amount URI with no memo when attributionRef is absent', () => {
    const withoutMemo = invoice({ attributionRef: '' as unknown as string });
    // encodeZip321 requires attributionRef to be truthy for a real invoice;
    // this exercises the raw matrix/decoder path directly with a short URI.
    const uri = 'zcash:uregtest1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq?amount=3';
    const svg = qrSvgMarkup(uri);
    expect(decode(svg)).toBe(uri);
    void withoutMemo;
  });

  test('two different valid URIs decode to two different strings (not a static placeholder)', () => {
    const uriA = encodeZip321(invoice({ amountZat: '100000000' }));
    const uriB = encodeZip321(invoice({ amountZat: '200000000', attributionRef: 'attr-demo-2' }));
    expect(decode(qrSvgMarkup(uriA))).toBe(uriA);
    expect(decode(qrSvgMarkup(uriB))).toBe(uriB);
    expect(uriA).not.toBe(uriB);
  });

  test('the matrix itself, not just the rasterized SVG, is a real QR structure', () => {
    const uri = encodeZip321(invoice());
    const matrix = buildQrMatrix(uri);
    expect(matrix.size).toBeGreaterThan(20);
    // Position-detection pattern: the top-left 7x7 finder is a fixed ring.
    expect(matrix.isDark(0, 0)).toBe(true);
    expect(matrix.isDark(3, 3)).toBe(true);
    expect(matrix.isDark(1, 1)).toBe(false);
  });

  test('rejects an empty payload rather than emitting a placeholder image', () => {
    expect(() => qrSvgMarkup('')).toThrow();
  });
});
