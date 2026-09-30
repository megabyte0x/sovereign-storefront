# Buyer frontend redesign

## Intent

Migrate the buyer-facing catalogue, product, checkout, status, and purchase recovery screens to React and shadcn/ui. Keep the existing URLs, payment rules, seller transport, test hooks, and buyer data ownership.

## Visual direction

Reading this as a trust-first checkout for digital buyers. Use a light, high-contrast page, one deep-blue accent, restrained motion, and clear type. Design dials: variance 4, motion 2, density 5. Keep the testnet network and confirmation policy legible. Product, payment, and recovery each get a distinct composition. Avoid decorative crypto motifs and claims that a wallet payment has been verified before the seller confirms it.

## Architecture

Keep `src/browser/app.ts` as the purchase and transport controller. Add a renderer interface so the existing direct render helpers remain available to tests while the production browser entry mounts React views. Put the React presentation and shadcn components in a browser-only module outside the service TypeScript build. Configure Vite, Tailwind, and shadcn for the existing project rather than replacing its build pipeline. Keep all assets local for the seller's strict CSP.

## Screens and behavior

- Catalogue: list available products with title, format, price, and testnet context. Keep `/p/:version` links.
- Product: present description, fixed price, file details, seller identity, availability, and Buy. Buy remains disabled when dependencies are down.
- Checkout: show persisted invoice, exact QR and ZIP-321 URI, copy and wallet-link alternatives. Loading and expired states never expose a new wallet request.
- Status: distinguish payment, delivery, and scanner verification. Keep exceptions visible.
- Purchases: show existing purchases, export/import backup actions, and the bearer-secret warning. Provide an empty state.

Keep element IDs and data attributes used by the purchase flow and browser tests. Preserve the backup warning and wallet-verification disclosures. Use semantic headings, keyboard-visible focus, accessible controls, and responsive layouts from mobile to desktop.

## Verification

Run TypeScript checks, Vite/service builds, unit tests, and browser purchase tests. Inspect the rendered catalogue, checkout, and purchases screens at desktop and mobile sizes. Confirm the strict CSP still serves the production bundle and no third-party browser asset is introduced.
