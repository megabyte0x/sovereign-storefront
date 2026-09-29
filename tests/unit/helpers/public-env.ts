import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consensusFingerprint } from '../../../src/contracts/consensus.ts';

const ACTIVATIONS = {
  overwinter: 1, sapling: 1, blossom: 1, heartwood: 1, canopy: 1, nu5: 1, nu6: 1,
  'nu6-1': null, 'nu6-2': null, 'nu6-3': null,
};
const GENESIS = 'ab'.repeat(32);

function protectedFile(dir: string, name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Valid public-testnet env. Creates a 0600 token file and a testnet scanner.json. */
export function publicEnv(overrides: Record<string, string | undefined> = {}): NodeJS.Dict<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ssf-public-cfg-'));
  const scannerConfig = protectedFile(dir, 'scanner.json', JSON.stringify({
    ufvk: 'not-a-real-ufvk',
    runtime: {
      sourceId: 'fixture-scanner',
      chain: {
        network: 'test',
        genesisHash: GENESIS,
        consensusFingerprint: consensusFingerprint('test', ACTIVATIONS),
      },
      activations: ACTIVATIONS,
    },
  }));
  const env: NodeJS.Dict<string> = {
    SSF_MODE: 'public-testnet',
    SSF_NETWORK: 'test',
    SSF_PUBLIC_ORIGIN: 'https://store.example.org',
    SSF_EMBED_ORIGINS: 'https://store.example.org',
    SSF_MIN_CONFIRMATIONS: '10',
    SSF_MAX_HEALTH_AGE_MS: '120000',
    SSF_MAX_PLAINTEXT_BYTES: '41',
    SSF_INVOICE_TTL_MS: '86400000',
    SSF_PUBLIC_HOST: '127.0.0.1',
    SSF_PUBLIC_PORT: '8787',
    SSF_ADMIN_HOST: '127.0.0.1',
    SSF_ADMIN_PORT: '8788',
    SSF_DB_PATH: join(dir, 'seller.sqlite'),
    SSF_ADAPTER_MESSAGING: 'real',
    SSF_ADAPTER_STORAGE: 'real',
    SSF_ADAPTER_SCANNER: 'real',
    SSF_ADMIN_TOKEN_FILE: protectedFile(dir, 'admin.token', 'admin-secret-from-file\n'),
    SSF_SCANNER_SOCKET: '/tmp/ssf-pt.sock',
    SSF_SCANNER_ACCOUNT_ID: 'seller-account-0',
    SSF_SCANNER_CONFIG: scannerConfig,
    SSF_WAKU_CONTENT_TOPIC: '/ssf/1/public-testnet/proto',
    WAKU_BOOTSTRAP_PEERS: '/dns4/a.example/tcp/8000/wss/p2p/16Uiu2HAmA',
    LOGOSCTL: '/opt/logos/logosctl',
    LOGOS_NODE_A: '/var/lib/ssf/logos/node-a',
    LOGOS_NODE_B: '/var/lib/ssf/logos/node-b',
    ...overrides,
  };
  return env;
}
