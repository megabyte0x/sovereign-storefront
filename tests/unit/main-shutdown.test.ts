import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../../src/config.ts';
import type { Runtime, RuntimeReadiness } from '../../src/runtime.ts';
import { runMain, type MainDeps } from '../../src/main.ts';

const TOKEN = 'a'.repeat(64);
const SOCKET = '/run/secret.sock';

function readiness(): RuntimeReadiness {
  return { scanner: true, messaging: false, products: { v1: true, v2: false }, checkout: true, checkedAt: 1 };
}

function fakeConfig(mode: 'real-demo' | 'fixture' = 'real-demo'): RuntimeConfig {
  return { mode, adminToken: TOKEN, scannerSocket: SOCKET } as unknown as RuntimeConfig;
}

type Harness = {
  deps: MainDeps;
  out: string[];
  exits: number[];
  signals: EventEmitter;
  stopCalls: () => number;
  order: string[];
};

function harness(options: {
  stop?: () => Promise<void>;
  start?: () => Promise<Runtime>;
  mode?: 'real-demo' | 'fixture';
  shutdownTimeoutMs?: number;
} = {}): Harness {
  const out: string[] = [];
  const exits: number[] = [];
  const order: string[] = [];
  const signals = new EventEmitter();
  let stops = 0;
  const runtime: Runtime = {
    sellerKeyId: 'k',
    server: {
      publicUrl: 'http://127.0.0.1:1111',
      adminUrl: 'http://127.0.0.1:2222',
    } as Runtime['server'],
    readiness: readiness,
    async refreshReadiness() {
      order.push('refresh');
      return readiness();
    },
    async runLoopsOnce() {},
    async stop() {
      stops += 1;
      await (options.stop ? options.stop() : Promise.resolve());
    },
  };
  const deps: MainDeps = {
    loadConfig: () => fakeConfig(options.mode),
    startRuntime: async () => (options.start ? options.start() : runtime),
    startSeller: async () =>
      ({ publicUrl: 'http://127.0.0.1:3333', adminUrl: 'http://127.0.0.1:4444', close: async () => { stops += 1; } }) as never,
    signals,
    exit: (code) => {
      exits.push(code);
    },
    stdout: (line) => {
      order.push(`out:${line.split(' ')[0]}`);
      out.push(line);
    },
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  };
  return { deps, out, exits, signals, stopCalls: () => stops, order };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runMain output', () => {
  it('prints URL lines before the ready line and nothing secret', async () => {
    const h = harness();
    await runMain({}, h.deps);
    expect(h.out).toEqual([
      'public http://127.0.0.1:1111',
      'admin http://127.0.0.1:2222',
      'ready scanner=true messaging=false checkout=true products=2',
    ]);
    expect(h.order.indexOf('out:admin')).toBeLessThan(h.order.indexOf('refresh'));
    const all = h.out.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(SOCKET);
    expect(h.exits).toEqual([]);
  });

  it('fixture mode prints its URLs and still handles signals', async () => {
    const h = harness({ mode: 'fixture' });
    await runMain({}, h.deps);
    expect(h.out).toEqual(['public http://127.0.0.1:3333', 'admin http://127.0.0.1:4444']);
    h.signals.emit('SIGINT');
    await flush();
    expect(h.stopCalls()).toBe(1);
    expect(h.exits).toEqual([0]);
  });
});

describe('runMain signals', () => {
  it('SIGTERM stops exactly once and exits 0', async () => {
    const h = harness();
    await runMain({}, h.deps);
    h.signals.emit('SIGTERM');
    await flush();
    expect(h.stopCalls()).toBe(1);
    expect(h.exits).toEqual([0]);
  });

  it('a second signal during a slow stop forces exit 130', async () => {
    let release!: () => void;
    const h = harness({ stop: () => new Promise<void>((r) => { release = r; }) });
    await runMain({}, h.deps);
    h.signals.emit('SIGTERM');
    await flush();
    h.signals.emit('SIGINT');
    await flush();
    expect(h.stopCalls()).toBe(1);
    expect(h.exits).toEqual([130]);
    release();
    await flush();
    expect(h.exits).toEqual([130]);
  });

  it('a stop that never resolves exits 1 with shutdown_timeout after the deadline', async () => {
    const h = harness({ stop: () => new Promise<void>(() => undefined), shutdownTimeoutMs: 20 });
    await runMain({}, h.deps);
    h.signals.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 60));
    expect(h.exits).toEqual([1]);
    expect(h.out.some((l) => l.includes('shutdown_timeout'))).toBe(true);
  });
});

describe('runMain startup failure', () => {
  it('prints only the error name and exits 1', async () => {
    const h = harness({ start: async () => { throw new Error(`cannot connect ${SOCKET}`); } });
    await runMain({}, h.deps);
    expect(h.out).toEqual(['startup failed: Error']);
    expect(h.out.join('\n')).not.toContain(SOCKET);
    expect(h.exits).toEqual([1]);
  });

  it('a config error is also sanitized', async () => {
    const h = harness();
    h.deps.loadConfig = () => {
      const e = new Error(`bad file ${SOCKET}`);
      e.name = 'ConfigError';
      throw e;
    };
    await runMain({}, h.deps);
    expect(h.out).toEqual(['startup failed: ConfigError']);
    expect(h.exits).toEqual([1]);
  });
});
