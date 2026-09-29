import { expect, test } from 'vitest';
import { acceptMessage, buildCheckoutUrl } from '../../src/browser/embed.ts';

const ORIGIN = 'https://store.example.org';
const VALID = {
  type: 'ssf:checkout',
  version: 'v1',
  requestId: 'req-1',
  state: 'invoiced',
};

function element() {
  const events: Event[] = [];
  return {
    events,
    dispatchEvent(event: Event) {
      events.push(event);
      return true;
    },
  };
}

test('buildCheckoutUrl opens the storefront popup path', () => {
  expect(buildCheckoutUrl(ORIGIN, 'v1')).toBe(`${ORIGIN}/p/v1?embed=1`);
  expect(buildCheckoutUrl(`${ORIGIN}/`, 'v2')).toBe(`${ORIGIN}/p/v2?embed=1`);
});

test('acceptMessage drops a wrong origin and a malformed result', () => {
  const wrong = element();
  expect(acceptMessage({ origin: 'https://evil.example', data: VALID }, ORIGIN, wrong)).toBe(false);
  expect(wrong.events).toEqual([]);

  const malformed = element();
  expect(acceptMessage({ origin: ORIGIN, data: { type: 'ssf:checkout', version: 'v1' } }, ORIGIN, malformed)).toBe(false);
  expect(malformed.events).toEqual([]);
});

test('acceptMessage fires ssf:checkout for a valid result', () => {
  const target = element();
  expect(acceptMessage({ origin: ORIGIN, data: VALID }, ORIGIN, target)).toBe(true);
  expect(target.events).toHaveLength(1);
  const event = target.events[0] as CustomEvent;
  expect(event.type).toBe('ssf:checkout');
  expect(event.detail).toEqual(VALID);
});
