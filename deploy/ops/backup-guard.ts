// Refuse to push a coordinated archive that still contains a viewing key in
// clear. The sealed SSBK file is binary; a real export encrypts scanner.json.
// This check never prints the match or the file bytes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLEARTEXT_UFVK = /uview|uivk|"ufvk"|\bufvk\b/i;

export function archiveHasCleartextUfvk(bytes: Uint8Array): boolean {
  return CLEARTEXT_UFVK.test(Buffer.from(bytes).toString('latin1'));
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const flag = process.argv.indexOf('--check');
  const file = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (file === undefined || file.length === 0) {
    process.stderr.write('usage: backup-guard.ts --check FILE\n');
    process.exitCode = 2;
  } else if (archiveHasCleartextUfvk(new Uint8Array(readFileSync(file)))) {
    process.stderr.write('refusing push: archive has a cleartext viewing-key shape\n');
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}
