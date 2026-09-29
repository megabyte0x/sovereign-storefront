// Builds the body posted to a ntfy or healthchecks.io URL. Secret-shaped spans
// are replaced, then any line that still matches is dropped. The webhook URL
// is never part of the body.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_SHAPES = [
  /zcash:\S+/gi,
  /(?:u(?:regtest|test)?|z(?:regtest|test)?sapling|zs)1[0-9a-z]{8,}/gi,
  /\bt[m1-3][A-Za-z0-9]{25,40}\b/g,
  /bearer\s+\S+/gi,
  /uview[a-z0-9]*/gi,
  /uivk[a-z0-9]*/gi,
  /ufvk/gi,
  /secret\S*/gi,
  /token\S*/gi,
  /mnemonic|seed/gi,
  /private/gi,
  /password/gi,
  /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g,
];

export function buildHealthPayload(text: string, exitCode: number): string {
  const status = exitCode === 0 ? 'PASS' : 'FAIL';
  let body = text.replace(/\r\n/g, '\n');
  for (const pattern of SECRET_SHAPES) {
    pattern.lastIndex = 0;
    body = body.replace(pattern, '[redacted]');
  }
  const lines = body.split('\n').map((line) => line.trim()).filter((line) => {
    if (line.length === 0) return false;
    return SECRET_SHAPES.every((pattern) => {
      pattern.lastIndex = 0;
      return !pattern.test(line);
    });
  });
  return [`public-doctor ${status}`, ...lines.slice(0, 20)].join('\n');
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const flag = process.argv.indexOf('--exit');
  const exitCode = Number(flag >= 0 ? process.argv[flag + 1] : '1');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  process.stdout.write(`${buildHealthPayload(text, Number.isFinite(exitCode) ? exitCode : 1)}\n`);
}
