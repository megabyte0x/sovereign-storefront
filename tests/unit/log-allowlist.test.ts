import { expect, test } from 'vitest';
import { ALLOWED_LOG_FIELDS, createOperationalLogger } from '../../src/ops/log.ts';

function capture() {
  const lines: string[] = [];
  const logger = createOperationalLogger((line) => lines.push(line));
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

test('allow-list holds the documented safe fields only', () => {
  for (const field of ['event', 'component', 'status', 'ok', 'code', 'count', 'durationMs', 'generation', 'timing']) {
    expect(ALLOWED_LOG_FIELDS.has(field), field).toBe(true);
  }
  for (const field of ['path', 'socket', 'message', 'detail', 'error', 'url']) {
    expect(ALLOWED_LOG_FIELDS.has(field), field).toBe(false);
  }
});

test('logger drops disallowed keys, socket paths and secret-bearing values', () => {
  const { logger, lines, records } = capture();
  logger.log({
    event: 'runtime.component',
    component: 'scanner',
    status: 'started',
    ok: true,
    socket: '/run/user/1000/ssf/scanner.sock',
    path: '/run/user/1000/ssf/scanner.sock',
    message: 'connect ENOENT /run/user/1000/ssf/scanner.sock',
    detail: 'secret admin token',
    code: 'connect ENOENT /run/user/1000/ssf/scanner.sock',
  });
  logger.log({ event: 'error', code: 'secret-token-abc', count: '/run/x' });
  logger.log({ event: 'runtime.readiness', status: 'the secret is /run/x', component: '/run/scanner.sock' });
  const text = lines.join('\n');
  expect(text).not.toContain('/run/');
  expect(text).not.toMatch(/secret/i);
  for (const record of records()) {
    for (const key of Object.keys(record)) {
      expect(['event', 'ts', ...ALLOWED_LOG_FIELDS].includes(key), `unexpected key ${key}`).toBe(true);
    }
  }
  const first = records()[0]!;
  expect(first).toMatchObject({ event: 'runtime.component', component: 'scanner', status: 'started', ok: true });
  expect(first).not.toHaveProperty('code');
});

test('code must be a short identifier; count and timing must be numeric', () => {
  const { logger, records } = capture();
  logger.log({ event: 'error', code: 'ScannerUnavailableError', count: 3, durationMs: 12, generation: 4, timing: 7 });
  logger.log({ event: 'error', code: 503 });
  logger.log({ event: 'error', code: 'has spaces in it', durationMs: '12', ok: 'yes' });
  const [a, b, c] = records();
  expect(a).toMatchObject({ code: 'ScannerUnavailableError', count: 3, durationMs: 12, generation: 4, timing: 7 });
  expect(b).toMatchObject({ code: 503 });
  expect(c).not.toHaveProperty('code');
  expect(c).not.toHaveProperty('durationMs');
  expect(c).not.toHaveProperty('ok');
});

test('waku.handler_error is an allow-listed event class and carries no message text', () => {
  const { logger, records } = capture();
  logger.log({ event: 'waku.handler_error', message: 'boom with detail', payload: 'deadbeef', error: 'x' });
  expect(records()).toHaveLength(1);
  const [record] = records();
  expect(record.event).toBe('waku.handler_error');
  expect(Object.keys(record).sort()).toEqual(['event', 'ts']);
});
