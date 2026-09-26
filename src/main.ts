import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, type RuntimeConfig } from './config.ts';
import { startRuntime, type Runtime, type RuntimeReadiness } from './runtime.ts';
import { startSeller, type SellerServer } from './seller/server.ts';
import { createOperationalLogger } from './ops/log.ts';

export type SignalSource = {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export type MainDeps = {
  loadConfig: (env: NodeJS.Dict<string>) => RuntimeConfig;
  startRuntime: (config: RuntimeConfig) => Promise<Runtime>;
  startSeller: (config: RuntimeConfig) => Promise<SellerServer>;
  signals: SignalSource;
  exit: (code: number) => void;
  stdout: (line: string) => void;
  /** Hard deadline for one shutdown; default 10 s. */
  shutdownTimeoutMs?: number;
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const EXIT_FORCED = 130;

/** Only the error class name: messages can carry paths or other private detail. */
function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)) return error.name;
  return 'Error';
}

/**
 * Start the service, print only URL and readiness lines, and unwind on
 * SIGINT/SIGTERM. Never throws; every terminal outcome goes through `deps.exit`.
 */
export async function runMain(env: NodeJS.Dict<string>, deps: MainDeps): Promise<void> {
  const timeoutMs = deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let stopResource: (() => Promise<void>) | undefined;
  let stopping = false;
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };

  const shutdown = (): void => {
    if (!stopResource) return; // startup still in flight; resumed once it settles
    const stop = stopResource;
    stopResource = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const work = stop().then(
      () => 'ok' as const,
      () => 'error' as const,
    );
    void Promise.race([work, deadline]).then((result) => {
      clearTimeout(timer);
      if (exited) return;
      if (result === 'ok') return exit(0);
      deps.stdout(`shutdown failed: code=${result === 'timeout' ? 'shutdown_timeout' : 'shutdown_error'}`);
      exit(1);
    });
  };

  const onSignal = (): void => {
    if (exited) return;
    if (stopping) {
      exit(EXIT_FORCED);
      return;
    }
    stopping = true;
    shutdown();
  };
  deps.signals.on('SIGINT', onSignal);
  deps.signals.on('SIGTERM', onSignal);

  let runtime: Runtime;
  try {
    const config = deps.loadConfig(env);
    if (config.mode !== 'real-demo') {
      const seller = await deps.startSeller(config);
      stopResource = () => seller.close();
      if (stopping) return shutdown();
      deps.stdout(`public ${seller.publicUrl}`);
      deps.stdout(`admin ${seller.adminUrl}`);
      return;
    }
    // Real adapters only; the fixture factory is not reachable from this path.
    runtime = await deps.startRuntime(config);
    stopResource = () => runtime.stop();
  } catch (error) {
    // startRuntime/startSeller unwind their own partial start before rejecting.
    deps.stdout(`startup failed: ${errorName(error)}`);
    exit(1);
    return;
  }

  if (stopping) return shutdown();
  // URLs first: the first readiness refresh is bounded but can still take a while.
  deps.stdout(`public ${runtime.server?.publicUrl ?? 'unavailable'}`);
  deps.stdout(`admin ${runtime.server?.adminUrl ?? 'unavailable'}`);
  let readiness: RuntimeReadiness;
  try {
    readiness = await runtime.refreshReadiness();
  } catch {
    readiness = runtime.readiness();
  }
  if (stopping || exited) return;
  deps.stdout(
    `ready scanner=${readiness.scanner} messaging=${readiness.messaging} checkout=${readiness.checkout} products=${Object.keys(readiness.products).length}`,
  );
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  await runMain(process.env, {
    loadConfig,
    startRuntime: (config) => startRuntime(config, {
      logger: createOperationalLogger(),
      // Compiled entry is dist/service/main.js; the built UI is dist/browser.
      publicDir: fileURLToPath(new URL('../browser/', import.meta.url)),
    }),
    startSeller: (config) => startSeller({ config, seedProduct: true }),
    signals: process,
    exit: (code) => process.exit(code),
    stdout: (line) => process.stdout.write(`${line}\n`),
  });
}
