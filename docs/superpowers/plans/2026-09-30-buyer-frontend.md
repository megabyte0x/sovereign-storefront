# Buyer Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the buyer flow with React and shadcn/ui while preserving purchase behavior and browser contracts.

**Architecture:** `app.ts` continues to own data, payment, and event orchestration. A browser-only React renderer supplies the production presentation through a small interface. The existing render helpers remain as compatibility surfaces for direct tests.

**Tech Stack:** React, Vite, Tailwind CSS, shadcn/ui, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-buyer-frontend-design.md`

## Global Constraints

- Keep routes `/`, `/checkout.html`, and `/p/:version` and the current browser-facing IDs and data attributes.
- Preserve exact ZIP-321 URI/QR data and never show a wallet request before persistence or after expiry.
- Preserve service-unavailable gating, payment state distinctions, and backup bearer-secret guidance.
- Keep all browser assets local under the seller's strict CSP.

---

### Task 1: React and shadcn foundation

**Files:** `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.build.json`, `components.json`, `assets/app.css`, `src/components/ui/*`, `src/lib/utils.ts`

**Interfaces:** Provides the React runtime, Vite JSX compilation, semantic theme tokens, and shadcn components for later tasks.

- [x] Check the pre-migration TypeScript and unit baseline.
- [x] Add React, React DOM, Tailwind Vite integration, and TypeScript types.
- [x] Initialize shadcn for the existing Vite project; add Button, Badge, Alert, Separator, Skeleton, and Empty through its CLI.
- [x] Keep generated UI files out of the service build; verify browser and service builds.

### Task 2: React view layer and controller adapter

**Files:** `src/browser/app.ts`, `src/browser/main.tsx`, `src/browser/ui.tsx`, `index.html`, `checkout.html`, `tests/browser/purchase.spec.ts`

**Interfaces:** `BrowserViewRenderer` accepts the same inputs as current render helpers and renders product, catalogue, checkout, status, purchases, and missing-product views.

- [x] Add a browser test that checks the production React renderer exposes the existing semantic controls and the new page shell; verify it fails first.
- [x] Add the renderer interface to `app.ts` and route controller transitions through it.
- [x] Implement React views with shadcn controls and preserve required IDs, data attributes, exact URI, and copy.
- [x] Point HTML entries to `main.tsx`; run focused browser and unit tests.

### Task 3: Visual polish and responsive verification

**Files:** `assets/app.css`, `src/browser/ui.tsx`, `tests/browser/purchase.spec.ts`

**Interfaces:** Responsive buyer pages with loading, empty, unavailable, expired, and error states.

- [x] Capture product, checkout, and recovery screens at desktop and mobile widths for visual inspection.
- [x] Apply the approved high-contrast visual system, page hierarchy, spacing, focus states, and reduced-motion rules.
- [x] Inspect desktop and mobile renderings and repair repetition, CTA order, and clipped purchase IDs.
- [x] Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:browser`; inspect the final diff.
