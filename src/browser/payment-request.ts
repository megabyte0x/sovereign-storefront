import QRCode from 'qrcode';

/**
 * A decoded QR module matrix: `isDark(row, col)` is true for a dark
 * (foreground) module. This is the exact matrix `qrcode` computed for the
 * given text — not an approximation, not a decorative placeholder.
 */
export type QrModuleMatrix = {
  size: number;
  isDark(row: number, col: number): boolean;
};

export function buildQrMatrix(text: string): QrModuleMatrix {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR payload must be a non-empty string');
  }
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = qr.modules;
  return {
    size,
    isDark(row, col) {
      if (row < 0 || col < 0 || row >= size || col >= size) return false;
      return (data[row * size + col] & 1) === 1;
    },
  };
}

export type QrRenderOptions = {
  moduleSize?: number;
  margin?: number;
};

/**
 * Renders `text` as a real, decodable QR code: an inline SVG built module-
 * by-module from `qrcode`'s own encoding of `text`, not a fixed decorative
 * placeholder image. `moduleSize`/`margin` default to values verified (via
 * `tests/unit/payment-request.test.ts`) to survive a real jsQR decode of a
 * full-length shielded testnet ZIP-321 URI.
 */
export function qrSvgMarkup(text: string, options: QrRenderOptions = {}): string {
  const matrix = buildQrMatrix(text);
  const moduleSize = options.moduleSize ?? 4;
  const margin = options.margin ?? 2;
  const dim = matrix.size + margin * 2;
  const pixelDim = dim * moduleSize;
  let rects = '';
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.isDark(row, col)) continue;
      const x = (col + margin) * moduleSize;
      const y = (row + margin) * moduleSize;
      rects += `<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}" fill="#111"/>`;
    }
  }
  return (
    `<svg viewBox="0 0 ${pixelDim} ${pixelDim}" width="168" height="168" `
    + 'shape-rendering="crispEdges" aria-hidden="true" focusable="false">'
    + `<rect width="${pixelDim}" height="${pixelDim}" fill="#fff"/>`
    + `${rects}</svg>`
  );
}
