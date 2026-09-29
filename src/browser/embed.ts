import { validateCheckoutResult, type CheckoutResult } from '../contracts/public.ts';

export type CheckoutMessage = { origin: string; data: unknown };

export type CheckoutTarget = { dispatchEvent(event: Event): boolean };

export function buildCheckoutUrl(origin: string, version: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/p/${encodeURIComponent(version)}?embed=1`;
}

export function acceptMessage(event: CheckoutMessage, storefrontOrigin: string, target: CheckoutTarget): boolean {
  if (event.origin !== storefrontOrigin) return false;
  let result: CheckoutResult;
  try {
    result = validateCheckoutResult(event.data);
  } catch {
    return false;
  }
  const Ctor = (globalThis as {
    CustomEvent?: new (type: string, init: { detail: CheckoutResult; bubbles: boolean; composed: boolean }) => Event;
  }).CustomEvent;
  if (!Ctor) return false;
  target.dispatchEvent(new Ctor('ssf:checkout', { detail: result, bubbles: true, composed: true }));
  return true;
}

type Popup = { postMessage(data: unknown, origin: string): void; closed: boolean };

type BuyButton = {
  type: string;
  textContent: string;
  addEventListener(type: string, listener: () => void): void;
};

type ShadowRootLike = { append(node: BuyButton): void };

type BuyHost = {
  shadowRoot: ShadowRootLike | null;
  attachShadow(init: { mode: 'open' }): ShadowRootLike;
  getAttribute(name: string): string | null;
  dispatchEvent(event: Event): boolean;
};

type BrowserSurface = {
  document: {
    currentScript: { src?: string } | null;
    createElement(tag: string): BuyButton;
  };
  location: { origin: string };
  open(url: string, name: string, features?: string): Popup | null;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  addEventListener(type: string, listener: (event: CheckoutMessage) => void): void;
  HTMLElement: new () => BuyHost;
  customElements: { get(name: string): unknown; define(name: string, ctor: new () => BuyHost): void };
};

function browserGlobals(): BrowserSurface | null {
  const g = globalThis as {
    document?: BrowserSurface['document'];
    location?: { origin: string };
    window?: {
      open: BrowserSurface['open'];
      setInterval: BrowserSurface['setInterval'];
      clearInterval: BrowserSurface['clearInterval'];
      addEventListener: BrowserSurface['addEventListener'];
    };
    HTMLElement?: BrowserSurface['HTMLElement'];
    customElements?: BrowserSurface['customElements'];
  };
  if (!g.document || !g.location || !g.window || !g.HTMLElement || !g.customElements) return null;
  const view = g.window;
  return {
    document: g.document,
    location: g.location,
    open: (url, name, features) => view.open(url, name, features),
    setInterval: (fn, ms) => view.setInterval(fn, ms),
    clearInterval: (id) => view.clearInterval(id),
    addEventListener: (type, listener) => view.addEventListener(type, listener),
    HTMLElement: g.HTMLElement,
    customElements: g.customElements,
  };
}

function installEmbed(surface: BrowserSurface): void {
  const src = surface.document.currentScript?.src;
  let origin = surface.location.origin;
  if (src) {
    try {
      origin = new URL(src).origin;
    } catch {
      origin = surface.location.origin;
    }
  }
  if (surface.customElements.get('ssf-buy')) return;
  const Base = surface.HTMLElement;
  class SsfBuy extends Base {
    connectedCallback(): void {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      const button = surface.document.createElement('button');
      button.type = 'button';
      button.textContent = 'Buy';
      button.addEventListener('click', () => {
        const version = this.getAttribute('product') ?? '';
        if (version.length === 0) return;
        const url = buildCheckoutUrl(origin, version);
        const popup = surface.open(url, 'ssf-checkout', 'popup,width=480,height=760') ?? surface.open(url, '_blank');
        if (!popup) return;
        let tries = 0;
        const timer = surface.setInterval(() => {
          tries += 1;
          try {
            popup.postMessage({ type: 'ssf:hello' }, origin);
          } catch {
            surface.clearInterval(timer);
            return;
          }
          if (popup.closed || tries >= 40) surface.clearInterval(timer);
        }, 100);
      });
      root.append(button);
      surface.addEventListener('message', (event) => {
        const version = this.getAttribute('product') ?? '';
        try {
          if (validateCheckoutResult(event.data).version !== version) return;
        } catch {
          acceptMessage(event, origin, this);
          return;
        }
        acceptMessage(event, origin, this);
      });
    }
  }
  surface.customElements.define('ssf-buy', SsfBuy);
}

const surface = browserGlobals();
if (surface) installEmbed(surface);
