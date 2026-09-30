import { createRoot } from 'react-dom/client';
import { startBrowserApp, type BrowserViewRenderer, type RenderRoot } from './app.ts';
import { CatalogueView, CheckoutErrorView, CheckoutView, LoadingView, MissingView, ProductView, PurchasesView, StatusView } from './ui.tsx';

const doc = (globalThis as { document?: { getElementById(id: string): RenderRoot | null } }).document;
const host = doc?.getElementById('app');

if (host) {
  const reactRoot = createRoot(host as never);
  reactRoot.render(<LoadingView />);
  const renderer: BrowserViewRenderer = {
    product(_root: RenderRoot, input) { reactRoot.render(<ProductView {...input} />); },
    catalogue(_root: RenderRoot, input) { reactRoot.render(<CatalogueView {...input} />); },
    checkout(_root: RenderRoot, input) { reactRoot.render(<CheckoutView {...input} />); },
    status(_root: RenderRoot, status) { reactRoot.render(<StatusView status={status} />); },
    purchases(_root: RenderRoot, input) { reactRoot.render(<PurchasesView {...input} />); },
    missing() { reactRoot.render(<MissingView />); },
    error() { reactRoot.render(<CheckoutErrorView />); },
  };
  void startBrowserApp(host, { renderer });
}
