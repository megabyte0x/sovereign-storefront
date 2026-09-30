import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Check, Copy, Download, ExternalLink, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx';
import { Badge } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { Separator } from '../components/ui/separator.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { allowNewCheckout, type BrowserPurchase, type OrderStatus, type ServiceAvailability } from '../contracts/types.ts';
import { profileFor, type ProductSummary } from '../contracts/public.ts';
import { qrSvgMarkup } from './payment-request.ts';
import { BEARER_SECRET_WARNING } from './purchases.ts';
import { buyerVisibleStatus, confirmationNotice, encodeZip321, formatZec, networkBadgeText, type ProductViewModel } from './app.ts';
import { paymentInstructions } from './checkout.ts';

function PageFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`ssf-page ${className}`}>{children}</div>;
}

function Intro({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="ssf-intro">
      <p className="ssf-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {description && <p className="ssf-lede">{description}</p>}
    </div>
  );
}

function PurchasesButton() {
  return <Button id="nav-purchases" type="button" variant="outline">My purchases</Button>;
}

function NetworkContext({ network, minConfirmations, withIds = true }: { network: 'test' | 'regtest'; minConfirmations: number; withIds?: boolean }) {
  return (
    <div className="ssf-network">
      <Badge id={withIds ? 'testnet-badge' : undefined} role="status" variant="outline">{networkBadgeText(network)}</Badge>
      <p id={withIds ? 'confirmation-floor' : undefined}>{confirmationNotice(network, minConfirmations)}</p>
    </div>
  );
}

export function LoadingView() {
  return (
    <PageFrame>
      <div className="ssf-loading" aria-label="Loading storefront" role="status">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="mt-10 h-64 w-full" />
      </div>
    </PageFrame>
  );
}

export function ProductView({ product, availability, sellerKeyId, minConfirmations }: {
  product: ProductViewModel;
  availability: ServiceAvailability;
  sellerKeyId: string;
  minConfirmations?: number;
}) {
  const allowed = allowNewCheckout(availability);
  const floor = minConfirmations ?? profileFor(product.network).minConfirmationsFloor;
  const size = product.fileSize == null ? 'unknown size' : `${product.fileSize} bytes`;
  const format = product.fileFormatVersion ?? 'unknown format';
  return (
    <PageFrame>
      <section id="view-product" className="ssf-product">
        <Intro eyebrow="Purchase details" title={product.description} description="A private checkout for a digital download. No account or email required." />
        <div className="ssf-product-grid">
          <div className="ssf-product-information">
            <div className="ssf-product-symbol" aria-hidden="true"><BookOpen /></div>
            <h2>Digital delivery, kept yours.</h2>
            <p>Your purchase is saved in this browser. Keep a backup if you want to restore it elsewhere.</p>
            <Separator />
            <dl className="ssf-facts">
              <div><dt>File</dt><dd id="file-details">{format} · {size}</dd></div>
              <div><dt>Seller identity</dt><dd id="seller-identity">{sellerKeyId || 'Unavailable'}</dd></div>
            </dl>
          </div>
          <div className="ssf-purchase-panel">
            <span className="ssf-panel-label">One-time price</span>
            <p id="product-price" className="ssf-price">{formatZec(product.amountZat)}</p>
            <NetworkContext network={product.network} minConfirmations={floor} />
            <Separator />
            <p className="ssf-panel-note"><ShieldCheck aria-hidden="true" /> The seller confirms payment before delivery.</p>
            <div className="ssf-actions">
              <Button id="buy" type="button" size="lg" disabled={!allowed}>Buy</Button>
              <PurchasesButton />
            </div>
            {!allowed && <Alert id="checkout-unavailable"><AlertTitle>Checkout unavailable</AlertTitle><AlertDescription>New checkout is unavailable while a required service is down. Existing purchases can still be recovered.</AlertDescription></Alert>}
          </div>
        </div>
      </section>
    </PageFrame>
  );
}

export function CatalogueView({ items, product, availability, sellerKeyId, minConfirmations }: {
  items: ProductSummary[];
  product: ProductViewModel;
  availability: ServiceAvailability;
  sellerKeyId: string;
  minConfirmations: number;
}) {
  return (
    <>
      <PageFrame>
        <section id="view-catalogue" className="ssf-catalogue">
          <Intro eyebrow="Catalogue" title="Independent digital goods." description="Browse the collection, then check out privately with shielded Zcash." />
          <div className="ssf-catalogue-network"><NetworkContext network={items[0]?.network ?? 'test'} minConfirmations={minConfirmations} withIds={items.length > 1} /></div>
          <ul className="ssf-catalogue-list">
            {items.map((item, index) => (
              <li key={item.version}>
                <span className="ssf-item-number">{String(index + 1).padStart(2, '0')}</span>
                <div className="ssf-item-copy">
                  <a href={`/p/${encodeURIComponent(item.version)}`}>{item.title}<ExternalLink aria-hidden="true" /></a>
                  <p>{item.description}</p>
                  <span>{item.mediaType}</span>
                </div>
                <div className="ssf-item-meta"><strong>{formatZec(item.amountZat)}</strong><span>{networkBadgeText(item.network)}</span></div>
              </li>
            ))}
          </ul>
          {items.length > 1 && <div className="ssf-catalogue-actions"><PurchasesButton /></div>}
        </section>
      </PageFrame>
      {items.length === 1 && <ProductView product={product} availability={availability} sellerKeyId={sellerKeyId} minConfirmations={minConfirmations} />}
    </>
  );
}

export function CheckoutView({ purchase, now, persisted, minConfirmations }: {
  purchase: BrowserPurchase;
  now: number;
  persisted: boolean;
  minConfirmations?: number;
}) {
  const [clock, setClock] = useState(now);
  useEffect(() => {
    if (!persisted || !purchase.invoice) return;
    const remaining = purchase.invoice.expiresAt - Date.now();
    if (remaining <= 0) {
      if (clock < purchase.invoice.expiresAt) setClock(Date.now());
      return;
    }
    const timeout = setTimeout(() => setClock(Date.now()), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [persisted, purchase.invoice?.expiresAt, clock]);
  const network = purchase.network ?? purchase.invoice?.network ?? 'test';
  const floor = minConfirmations ?? profileFor(network).minConfirmationsFloor;
  const invoice = persisted ? paymentInstructions(purchase, Math.max(now, clock)) : null;
  if (!persisted || !purchase.invoice) {
    return <PageFrame><section id="view-checkout"><Intro eyebrow="Secure checkout" title="Preparing your purchase." description="Saving this purchase locally before any wallet request." /><NetworkContext network={network} minConfirmations={floor} /><div id="payment" data-wallet-request="blocked" /><div className="ssf-actions"><PurchasesButton /></div></section></PageFrame>;
  }
  if (!invoice) {
    return (
      <PageFrame><section id="view-checkout"><Intro eyebrow="Secure checkout" title="Invoice expired." /><p id="confirmation-floor">{confirmationNotice(network, floor)}</p><Alert id="payment" data-payment="blocked" variant="destructive"><AlertTitle>Payment window closed</AlertTitle><AlertDescription>This invoice is expired and unpaid. Start a new checkout with a new request ID. Existing terms are kept for late-payment monitoring.</AlertDescription></Alert><div className="ssf-actions"><PurchasesButton /></div></section></PageFrame>
    );
  }
  const uri = encodeZip321(invoice);
  return (
    <PageFrame>
      <section id="view-checkout" className="ssf-checkout">
        <Intro eyebrow="Secure checkout" title="Pay with your wallet." description={`Pay ${formatZec(invoice.amountZat)} on ${network === 'test' ? 'testnet' : 'regtest'}.`} />
        <div className="ssf-checkout-grid">
          <div className="ssf-qr-panel">
            <div data-zip321-qr="true" data-zip321-uri={uri} role="img" aria-label="Payment request QR" dangerouslySetInnerHTML={{ __html: qrSvgMarkup(uri) }} />
            <p>Scan with a shielded Zcash wallet</p>
          </div>
          <div className="ssf-payment-details">
            <NetworkContext network={network} minConfirmations={floor} />
            <p className="ssf-panel-label">Exact wallet request</p>
            <pre id="zip321-uri">{uri}</pre>
            <div className="ssf-actions">
              <Button id="copy-uri" type="button" size="lg"><Copy data-icon="inline-start" aria-hidden="true" />Copy payment URI</Button>
              <Button asChild variant="outline" size="lg"><a id="open-uri" href={uri} data-wallet-request="ready"><ExternalLink data-icon="inline-start" aria-hidden="true" />Open payment URI</a></Button>
            </div>
            <Alert><AlertTitle>Verify in your wallet</AlertTitle><AlertDescription>Payment URI is shown exactly. Wallet memo and receiver preservation has not been verified in this browser.</AlertDescription></Alert>
            <PurchasesButton />
          </div>
        </div>
      </section>
    </PageFrame>
  );
}

export function StatusView({ status }: { status: OrderStatus }) {
  const visible = buyerVisibleStatus(status);
  return (
    <PageFrame>
      <section id="view-status">
        <Intro eyebrow="Your order" title="Purchase status." description="Payment and delivery update independently as the seller verifies your order." />
        <div className="ssf-status-list">
          <div><span>Payment</span><strong id="payment-label">{visible.paymentLabel}</strong></div>
          <div><span>Delivery</span><strong id="delivery-label">{visible.deliveryLabel}</strong></div>
          <div><span>Verification</span><strong id="verification-label" data-verification={status.verification}>{visible.verificationLabel}</strong></div>
        </div>
        <p role="note" className="ssf-caption">This status is informational until confirmed by a seller-authenticated response.</p>
        {visible.exceptions.length > 0 && <Alert variant="destructive"><AlertTitle>Needs attention</AlertTitle><AlertDescription><ul id="status-exceptions">{visible.exceptions.map((code) => <li key={code}>{code}</li>)}</ul></AlertDescription></Alert>}
        <div className="ssf-actions"><PurchasesButton /></div>
      </section>
    </PageFrame>
  );
}

export function PurchasesView({ purchases, notice }: { purchases: BrowserPurchase[]; notice?: string }) {
  return (
    <PageFrame>
      <section id="view-purchases">
        <Intro eyebrow="Your library" title="My purchases." description="Your purchase records stay in this browser until you export a backup." />
        <Alert className="ssf-backup-alert"><LockKeyhole aria-hidden="true" /><AlertTitle>Keep your backup private</AlertTitle><AlertDescription><p id="backup-warning" data-backup-kind="bearer-secret">{BEARER_SECRET_WARNING} Password protection is optional and not required.</p></AlertDescription></Alert>
        <div className="ssf-backup-actions">
          <Button id="export-backup" type="button" variant="outline"><Download data-icon="inline-start" aria-hidden="true" />Export backup</Button>
          <div className="ssf-import"><Label htmlFor="import-backup">Import backup</Label><Input type="file" id="import-backup" accept=".backup" aria-describedby="backup-warning" /></div>
        </div>
        {notice && <Alert id="import-status" role="status"><Check aria-hidden="true" /><AlertTitle>{notice}</AlertTitle></Alert>}
        {purchases.length === 0 ? (
          <Empty className="ssf-empty"><EmptyHeader><EmptyMedia variant="icon"><BookOpen aria-hidden="true" /></EmptyMedia><EmptyTitle>No purchases yet</EmptyTitle><EmptyDescription>Purchases made in this browser will appear here.</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <ul className="ssf-purchase-list">{purchases.map((item) => <li key={item.requestId}><span>Digital purchase</span><Button type="button" variant="link" data-request-id={item.requestId} title={item.requestId} aria-label={`Open purchase ${item.requestId}`}>{item.requestId.length > 16 ? `${item.requestId.slice(0, 8)}…${item.requestId.slice(-6)}` : item.requestId}</Button></li>)}</ul>
        )}
      </section>
    </PageFrame>
  );
}

export function MissingView() {
  return <PageFrame><section id="view-missing"><Intro eyebrow="Catalogue" title="Product not found." description="This product link is unavailable." /><div className="ssf-actions"><PurchasesButton /></div></section></PageFrame>;
}

export function CheckoutErrorView() {
  return <PageFrame><section id="view-error"><Intro eyebrow="Secure checkout" title="Your checkout is paused." /><Alert variant="destructive"><AlertTitle>Checkout could not start</AlertTitle><AlertDescription>Your purchase record may still be in this browser. Open My purchases to inspect it.</AlertDescription></Alert><div className="ssf-actions"><PurchasesButton /></div></section></PageFrame>;
}
