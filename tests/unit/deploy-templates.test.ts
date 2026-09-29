import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { publicEnv } from './helpers/public-env.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function text(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function templateVars(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

function exampleKeys(source: string): string[] {
  const keys: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) throw new Error(`malformed example line: ${line}`);
    keys.push(match[1]!);
  }
  return keys;
}

function serviceBlocks(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'services:');
  if (start < 0) return [];
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z]/.test(line)) break;
    if (/^  [A-Za-z0-9-]+:\s*$/.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
      continue;
    }
    current?.push(line);
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

/**
 * Deploy orchestration keys. Frozen `loadConfig` does not read them.
 * `SSF_WSS_ORIGIN` / `WSS_HOSTNAME` stay empty (D1=a). Tailnet binds are compose-only.
 */
const DEPLOY_ONLY = new Set([
  'PI_TAILNET_IP',
  'REPLICA_TAILNET_IP',
  'WSS_HOSTNAME',
  'SSF_WSS_ORIGIN',
]);

describe('deploy templates', () => {
  const compose = text('deploy/compose.yaml');
  const replica = text('deploy/compose.replica.yaml');
  const cloudflared = text('deploy/cloudflared/config.yml.tmpl');
  const example = text('deploy/env/public-testnet.env.example');
  const keys = exampleKeys(example);

  it('every ${VAR} in compose and cloudflared templates is in the example', () => {
    const vars = [
      ...templateVars(compose),
      ...templateVars(replica),
      ...templateVars(cloudflared),
    ];
    for (const name of vars) {
      expect(keys, name).toContain(name);
    }
  });

  it('every example key is read by loadConfig in public-testnet mode, except the closed deploy set', () => {
    const seen = new Set<string>();
    const env = new Proxy(publicEnv(), {
      get(target, prop, receiver) {
        if (typeof prop === 'string') seen.add(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    loadConfig(env, { getuid: () => process.getuid?.() ?? 0 });
    for (const key of keys) {
      if (DEPLOY_ONLY.has(key)) continue;
      expect(seen.has(key), `${key} was not read by loadConfig`).toBe(true);
    }
    for (const key of keys) {
      if (!DEPLOY_ONLY.has(key)) continue;
      expect(seen.has(key), `${key} is deploy-only and must not be a seller config read`).toBe(false);
    }
  });

  it('cloudflared ingress does not mention 8788 or admin', () => {
    const ingress = cloudflared.slice(cloudflared.indexOf('ingress:'));
    expect(ingress).not.toMatch(/8788/);
    expect(ingress.toLowerCase()).not.toMatch(/admin/);
    expect(cloudflared).toMatch(/http_status:404/);
    expect(cloudflared).toMatch(/\$\{WSS_HOSTNAME\}/);
  });

  it('seller admin port binds only 127.0.0.1', () => {
    const seller = serviceBlocks(compose).find((block) => block.startsWith('  seller:'));
    expect(seller).toBeDefined();
    expect(seller).toMatch(/127\.0\.0\.1:8788:8788/);
    expect(seller).not.toMatch(/0\.0\.0\.0:8788/);
    expect(seller).not.toMatch(/\$\{[^}]+\}:8788/);
  });

  it('Pi services are linux/arm64 and replica services are linux/amd64, all non-root', () => {
    for (const block of serviceBlocks(compose)) {
      expect(block, block.slice(0, 40)).toMatch(/platform:\s*linux\/arm64/);
      expect(block).toMatch(/user:\s*["']?65532:65532["']?/);
      expect(block).not.toMatch(/user:\s*["']?(0|root)(:0)?["']?/);
    }
    for (const block of serviceBlocks(replica)) {
      expect(block, block.slice(0, 40)).toMatch(/platform:\s*linux\/amd64/);
      expect(block).toMatch(/user:\s*["']?65532:65532["']?/);
    }
  });

  it('8091 and 8790 bind only to tailnet IP variables, never 0.0.0.0', () => {
    const published = `${compose}\n${replica}`;
    expect(published).not.toMatch(/0\.0\.0\.0:(8091|8790)/);
    expect(compose).toMatch(/\$\{PI_TAILNET_IP\}:8091:8091/);
    expect(replica).toMatch(/\$\{REPLICA_TAILNET_IP\}:8790:8790/);
    expect(replica).not.toMatch(/0\.0\.0\.0:8790/);
    expect(compose).not.toMatch(/\$\{PI_TAILNET_IP\}:8790/);
  });

  it('only cloudflared mounts deploy secrets, and only read-only', () => {
    const blocks = serviceBlocks(compose);
    const secretBlocks = blocks.filter((block) => /secrets/.test(block));
    expect(secretBlocks).toHaveLength(1);
    expect(secretBlocks[0]).toMatch(/^  cloudflared:/);
    expect(secretBlocks[0]).toMatch(/\.\/secrets:\/etc\/cloudflared\/creds:ro/);
    expect(replica).not.toMatch(/secrets/);
  });
});

describe('VPS single-host compose', () => {
  const vps = text('deploy/compose.vps.yaml');
  const keys = exampleKeys(text('deploy/env/public-testnet.env.example'));
  const blocks = serviceBlocks(vps);
  const block = (name: string) => blocks.find((b) => b.startsWith(`  ${name}:`)) ?? '';

  it('runs logos-a, scanner, seller and cloudflared as amd64 non-root services', () => {
    expect(blocks.map((b) => b.trim().split(':')[0]).sort()).toEqual(['cloudflared', 'logos-a', 'scanner', 'seller']);
    for (const b of blocks) {
      expect(b, b.slice(0, 40)).toMatch(/platform:\s*linux\/amd64/);
      expect(b).toMatch(/user:\s*["']?65532:65532["']?/);
      expect(b).toMatch(/read_only:\s*true/);
    }
  });

  it('uses only example keys and binds 8091 to the tailnet IP and admin to loopback', () => {
    for (const name of templateVars(vps)) expect(keys, name).toContain(name);
    expect(vps).not.toMatch(/PI_TAILNET_IP/);
    expect(block('logos-a')).toMatch(/"\$\{REPLICA_TAILNET_IP\}:8091:8091"/);
    expect(vps).not.toMatch(/0\.0\.0\.0:(8091|8790|8788)/);
    expect(block('seller')).toMatch(/"127\.0\.0\.1:8788:8788"/);
    expect(block('seller')).toMatch(/SSF_LOGOS_ADVERTISE_HOST: \$\{REPLICA_TAILNET_IP\}/);
    expect(block('seller')).toMatch(/SSF_REPLICA_AGENT_URL: http:\/\/\$\{REPLICA_TAILNET_IP\}:8790/);
  });

  it('only cloudflared mounts a secret, read-only, and runs from a token file', () => {
    const secretBlocks = blocks.filter((b) => /secrets/.test(b));
    expect(secretBlocks).toHaveLength(1);
    expect(secretBlocks[0]).toMatch(/^  cloudflared:/);
    expect(secretBlocks[0]).toMatch(/\/srv\/ssf\/secrets\/ssf-store\.token:\/etc\/cloudflared\/token:ro/);
    expect(secretBlocks[0]).toMatch(/--token-file/);
  });

  it('Logos healthchecks require storage_module loaded, not just the daemon', () => {
    for (const [file, name] of [['deploy/compose.vps.yaml', 'logos-a'], ['deploy/compose.replica.yaml', 'logos-b']] as const) {
      const svc = serviceBlocks(text(file)).find((b) => b.startsWith(`  ${name}:`)) ?? '';
      expect(svc, name).toMatch(/module ls/);
      expect(svc, name).toMatch(/storage_module\\?"?,\\?"?status\\?"?:\\?"?loaded/);
    }
  });

  it('storage init omits log-file, whose EBADF storm crashes storage_module', () => {
    const entry = text('deploy/images/logos-entrypoint.sh');
    expect(entry).toMatch(/storage-init\.json/);
    const init = entry.split('\n').find((line) => line.includes('data-dir')) ?? '';
    expect(init).toMatch(/storage-data/);
    expect(init).not.toMatch(/log-file/);
    expect(entry).toMatch(/sed -i 's\/"log-file":"\[\^"\]\*",\/\/' "\$INIT"/);
  });

  it('cloudflared loads a local ingress config, because the tunnel is locally managed', () => {
    const cf = block('cloudflared');
    expect(cf).toMatch(/\.\/cloudflared\/config\.vps\.yml:\/etc\/cloudflared\/config\.yml:ro/);
    expect(cf).toMatch(/"--config", "\/etc\/cloudflared\/config\.yml"/);
    const config = text('deploy/cloudflared/config.vps.yml');
    expect(config).toMatch(/hostname: store\.agentmascot\.app\n\s+service: http:\/\/seller:8787/);
    expect(config).toMatch(/- service: http_status:404\s*$/);
    const rules = config.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(rules).not.toMatch(/8788|admin|credentials-file/);
  });
});
