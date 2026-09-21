export const ALLOWED_EVENTS = [
  'http.request',
  'http.response',
  'order.created',
  'invoice.issued',
  'payment.observed',
  'fulfillment.dispatch',
  'admin.auth',
  'error',
] as const;

export const ALLOWED_LOG_FIELDS = new Set([
  'event',
  'ts',
  'method',
  'path',
  'status',
  'ok',
  'code',
]);

const FORBIDDEN_KEY_PATTERN =
  /invoice|memo|attr|uri|destination|credential|private|secret|key|proof|spending|payment|buyer|orderid|amount|wrapped/i;

export type LogSink = (line: string) => void;

export type OperationalLogger = {
  log(record: Record<string, unknown>): void;
  lines(): string[];
};

function isAllowedEvent(value: unknown): value is (typeof ALLOWED_EVENTS)[number] {
  return typeof value === 'string' && (ALLOWED_EVENTS as readonly string[]).includes(value);
}

function sanitize(record: Record<string, unknown>): Record<string, unknown> {
  const event = isAllowedEvent(record.event) ? record.event : 'error';
  const out: Record<string, unknown> = {
    event,
    ts: typeof record.ts === 'number' ? record.ts : Date.now(),
  };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'event' || key === 'ts') continue;
    if (!ALLOWED_LOG_FIELDS.has(key)) continue;
    if (FORBIDDEN_KEY_PATTERN.test(key)) continue;
    if (value !== null && typeof value === 'object') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

export function createOperationalLogger(sink?: LogSink): OperationalLogger {
  const lines: string[] = [];
  const write = sink ?? ((line: string) => {
    process.stdout.write(`${line}\n`);
  });
  return {
    log(record) {
      const line = JSON.stringify(sanitize(record));
      lines.push(line);
      write(line);
    },
    lines() {
      return [...lines];
    },
  };
}

export const silentLogger: OperationalLogger = createOperationalLogger(() => undefined);
