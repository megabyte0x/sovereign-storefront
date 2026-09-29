# Add a Buy button to your site

The embed adds a `<ssf-buy>` button to your product page. Clicking it opens checkout on the storefront origin in a popup; if that popup is blocked, the embed tries a normal new tab. The buyer's purchase records live on the storefront origin, not on your website. **Tell buyers to bookmark the storefront origin** so they can return to My purchases and recover their purchases.

This is a testnet integration. Testnet TAZ has no real value; do not use it to sell for real money.

## Add the script and product button

Use the script URL and integrity hash supplied by the seller. For this storefront:

```html
<script
  src="https://store.agentmascot.app/embed.js"
  integrity="sha384-iaajWPse8DU/1ANONUP/fYVv4ASyfpuXS+gZINUa+850BbZY7JR03RFKyUIdQYsJ"
  crossorigin="anonymous"
  async></script>

<ssf-buy product="YOUR_PRODUCT_VERSION"></ssf-buy>
```

Replace `YOUR_PRODUCT_VERSION` with the product version provided by the seller. Keep the `integrity` value paired with the exact script release it came from; ask the seller for the current hash when updating the embed. You may render one element per product, with that product's version in its `product` attribute.

## Checkout events

Listen for the bubbling `ssf:checkout` custom event on your page. Its `detail` is:

```ts
type CheckoutResult = {
  type: 'ssf:checkout';
  version: string;
  requestId: string;
  state: 'invoiced' | 'paid' | 'delivered' | 'cancelled';
};
```

Example:

```html
<script>
  document.addEventListener('ssf:checkout', (event) => {
    const { version, state } = event.detail;
    if (state === 'invoiced') {
      console.info(`Checkout opened for ${version}`);
    }
  });
</script>
```

Treat this event as a UI notification only—not proof that a payment settled or that delivery completed. The event is emitted by the checkout page and is not a substitute for the seller's scanner-verified order status.

## Popup blockers and origin

The button first requests a popup and falls back to `_blank` if that attempt is blocked. A strict browser policy can block both; in that case the buyer must allow popups for your site and try again. Checkout is intentionally hosted on the seller's storefront origin rather than framed in your page. Purchases and recovery data belong to that origin, so remind buyers to bookmark it.

The embed script executes in the buyer's browser and is served by the storefront. Use the seller-provided Subresource Integrity hash and review the hosting trust notes in [Public testnet self-hosting](public-testnet.md). This integration is for testnet only.
