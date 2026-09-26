export const ALLOWED_EVENTS = [
  'http.request',
  'http.response',
  'order.created',
  'invoice.issued',
  'payment.observed',
  'fulfillment.dispatch',
  'admin.auth',
  'admin.publish',
  'runtime.component',
  'runtime.loop',
  'runtime.readiness',
  'waku.handler_error',
  'error',
] as const;

/**
 * Allow-list: event class, status, timing and safe aggregate counters only.
 * `loop` (runtime loop name) and `method` (HTTP verb) are enum-valued call-site
 * extensions. Free text, paths, URLs and error messages are never logged.
 */
export const ALLOWED_LOG_FIELDS = new Set([
  'event',
  'ts',
  'component',
  'status',
  'ok',
  'code',
  'count',
  'durationMs',
  'generation',
  'timing',
  'loop',
  'method',
]);

const FORBIDDEN_KEY_PATTERN =
  /invoice|memo|attr|uri|destination|credential|private|secret|key|proof|spending|payment|buyer|orderid|amount|wrapped/i;

/** Enum-like identifier: no spaces, slashes or free-text messages. */
export const LOG_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_VALUE_PATTERN = /secret|passw|mnemonic|ufvk|spending|private|token/i;
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && LOG_CODE_PATTERN.test(value) && !FORBIDDEN_VALUE_PATTERN.test(value)
    ? value
    : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Per-field value typing; undefined means the field is dropped. */
function sanitizeValue(key: string, value: unknown): string | number | boolean | undefined {
  switch (key) {
    case 'ok':
      return typeof value === 'boolean' ? value : undefined;
    case 'code':
    case 'count':
    case 'status':
      return safeNumber(value) ?? safeIdentifier(value);
    case 'durationMs':
    case 'generation':
    case 'timing':
      return safeNumber(value);
    case 'component':
    case 'loop':
      return safeIdentifier(value);
    case 'method':
      return typeof value === 'string' && HTTP_METHODS.has(value) ? value : undefined;
    default:
      return undefined;
  }
}

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
    const safe = sanitizeValue(key, value);
    if (safe !== undefined) out[key] = safe;
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
