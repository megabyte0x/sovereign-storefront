import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultLogosRunner } from '../adapters/storage.ts';
import { isTailnetIpv4, readReplicaToken } from '../adapters/remote-replica.ts';
import { createReplicaAgentHandler } from './handlers.ts';

export { readReplicaToken };

/** In-container bind. Compose publishes the tailnet IP; the bridge netns has no tailnet address. */
export function assertReplicaBindHost(host: string): void {
  if (host === '0.0.0.0' || isTailnetIpv4(host)) return;
  throw new Error('replica agent bind must be 0.0.0.0 or a tailnet address');
}

function portFrom(raw: string | undefined): number {
  const value = raw ?? '8790';
  if (!/^[1-9]\d{0,4}$/.test(value)) throw new Error('replica-agent config refused');
  const port = Number(value);
  if (port > 65535) throw new Error('replica-agent config refused');
  return port;
}

export async function listenReplicaAgent(env: NodeJS.Dict<string>): Promise<{ close(): Promise<void> }> {
  const host = env.SSF_REPLICA_BIND ?? '';
  assertReplicaBindHost(host);
  const token = readReplicaToken(env.SSF_REPLICA_TOKEN_FILE ?? '');
  const configDir = env.LOGOS_NODE_B ?? '';
  const logosctl = env.LOGOSCTL ?? '';
  if (configDir.length === 0 || logosctl.length === 0) throw new Error('replica-agent config refused');
  const port = portFrom(env.SSF_REPLICA_PORT);
  const server = createServer(createReplicaAgentHandler({
    runner: defaultLogosRunner(logosctl),
    configDir,
    token,
  }));
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(port, host, () => resolve());
  await promise;
  return {
    async close() {
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      await done.promise;
    },
  };
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
  try {
    await listenReplicaAgent(process.env);
    process.stdout.write('replica-agent ready\n');
    const stop = (): void => {
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch {
    process.stdout.write('replica-agent refused\n');
    process.exit(1);
  }
}
