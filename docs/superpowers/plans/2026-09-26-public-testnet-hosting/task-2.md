# Task 2: Frozen contracts (serial gate before Wave 3)

## 2.1 Public-testnet mode, network profile, catalogue, embed and size contracts

- **Owner:** one subagent. Timebox 2 h. Review: 1 reviewer before Wave 3 starts.
- **Owns:** `src/contracts/public.ts` (new), `src/config.ts`, `src/contracts/validation.ts`, `src/contracts/live.ts`, `tests/unit/config-public.test.ts` (new), `tests/unit/contracts-public.test.ts` (new), `docs/live-runtime-config.md`.
- **Why serial:** every Wave-3 task imports these names. No Wave-3 worker may edit these files. Needs go through `deviations`.

**Produces (exact names; Wave 3 relies on them):**

```ts
// src/contracts/public.ts
export type AppMode = 'fixture' | 'real-demo' | 'public-testnet';           // re-exported by src/config.ts
export type NetworkProfile = {
  network: 'test' | 'regtest';
  uaPrefix: 'utest1' | 'uregtest1';
  ufvkPrefix: 'uviewtest' | 'uviewregtest';
  minConfirmationsFloor: number;          // TESTNET_PROFILE: 3 (D8=b); REGTEST_PROFILE: 10
  explorerTxUrl?: string;                 // testnet only, display only, never fetched by the app
};
export const TESTNET_PROFILE: NetworkProfile;
export const REGTEST_PROFILE: NetworkProfile;
export function profileFor(network: 'test' | 'regtest'): NetworkProfile;

export const PUBLIC_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;   // D5(a)
export type ProductSummary = { version: string; title: string; description: string; amountZat: string;
  network: 'test' | 'regtest'; sizeBytes: number; mediaType: string; available: boolean };
export type EmbedConfig = { storefrontOrigin: string; allowedEmbedOrigins: string[] | '*' };
export type CheckoutResult = { type: 'ssf:checkout'; version: string; requestId: string; state: 'invoiced' | 'paid' | 'delivered' | 'cancelled' };
export function validateProductSummary(x: unknown): ProductSummary;   // throws ValidationError
export function validateCheckoutResult(x: unknown): CheckoutResult;
```

**Config rules for `SSF_MODE=public-testnet` (in `loadConfig`):**

- Requires `SSF_NETWORK=test`; rejects `regtest` and `main`.
- Requires `SSF_PUBLIC_ORIGIN` as `https://<host>` (no path). Stored as `config.publicOrigin`.
- `SSF_MAX_PLAINTEXT_BYTES` ≤ `PUBLIC_MAX_PLAINTEXT_BYTES`; the ciphertext cap is derived as plaintext + 32 (`SSF1` magic, 12-byte nonce, 16-byte tag), not free-set.
- `SSF_MIN_CONFIRMATIONS` ≥ `TESTNET_PROFILE.minConfirmationsFloor` (= 3, D8=b). `real-demo` keeps `REAL_DEMO_MIN_CONFIRMATIONS` = 10 unchanged.
- `SSF_PUBLIC_ORIGIN` for this deployment is `https://store.agentmascot.app`; the test helper uses `https://store.example.org`.
- `SSF_MAX_HEALTH_AGE_MS` ≤ 300000 (testnet blocks are slower than regtest).
- `SSF_EMBED_ORIGINS`: a comma list of `https://` origins, or the literal `*`. Parsed into `EmbedConfig`.
- Messaging and abuse keys (parsed here so that 3.4 does not edit `config.ts`): `SSF_WAKU_CLUSTER_ID` (optional int) and `SSF_WAKU_SHARDS` (optional comma list of ints) go to `config.live.waku.network?: { clusterId: number; shards: number[] }`; `SSF_MAX_OPEN_INVOICES_PER_BUYER` (default 3) and `SSF_MAX_INVOICES_PER_MINUTE` (default 30) go to `config.limits.{openInvoicesPerBuyer, invoicesPerMinute}`. The limits apply in every mode.
- Frozen gateway signature (implemented by 3.2, wired by 3.3): `export type ServeCiphertextOptions = { maxBytes: number; digest: string }` in `src/contracts/public.ts`.
- Same secret-file rules as real-demo (`SSF_ADMIN_TOKEN_FILE` 0600; inline token rejected). Same live keys (`SSF_SCANNER_*`, `SSF_WAKU_*`, `WAKU_BOOTSTRAP_PEERS`).
- Real-demo behaviour stays unchanged. Existing `config.test.ts` must stay green.

- [ ] **RED** `tests/unit/config-public.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config.ts';
import { publicEnv } from './helpers/public-env.ts'; // creates 0600 token + scanner.json in a tmp dir; returns a valid env
describe('public-testnet config', () => {
  it('accepts a complete testnet env', () => {
    const c = loadConfig(publicEnv());
    expect(c.mode).toBe('public-testnet'); expect(c.productNetwork).toBe('test');
    expect(c.publicOrigin).toBe('https://store.example.org');
  });
  it('rejects regtest', () => expect(() => loadConfig(publicEnv({ SSF_NETWORK: 'regtest' }))).toThrow(ConfigError));
  it('rejects http origin', () => expect(() => loadConfig(publicEnv({ SSF_PUBLIC_ORIGIN: 'http://x.org' }))).toThrow(/SSF_PUBLIC_ORIGIN/));
  it('rejects plaintext cap above 8 MiB', () => expect(() => loadConfig(publicEnv({ SSF_MAX_PLAINTEXT_BYTES: String(8 * 1024 * 1024 + 1) }))).toThrow(/plaintext/));
  it('derives ciphertext cap', () => expect(loadConfig(publicEnv({ SSF_MAX_PLAINTEXT_BYTES: '1000' })).maxCiphertextBytes).toBe(1032));
  it('rejects confirmations below floor', () => expect(() => loadConfig(publicEnv({ SSF_MIN_CONFIRMATIONS: '2' }))).toThrow(/minConfirmations/));
  it('accepts 3 confirmations on testnet', () => expect(loadConfig(publicEnv({ SSF_MIN_CONFIRMATIONS: '3' })).minConfirmations).toBe(3));
  it('rejects inline admin token', () => expect(() => loadConfig(publicEnv({ SSF_ADMIN_TOKEN: 'x' }))).toThrow(/SSF_ADMIN_TOKEN/));
  it('still forbids mainnet', () => expect(() => loadConfig(publicEnv({ SSF_NETWORK: 'main' }))).toThrow(/mainnet/));
  it('parses embed origins', () => expect(loadConfig(publicEnv({ SSF_EMBED_ORIGINS: 'https://a.org,https://b.org' })).embed.allowedEmbedOrigins).toEqual(['https://a.org', 'https://b.org']));
});
```

  (`tests/unit/helpers/public-env.ts` is new and owned here. Derive it from the scanner-config fixture used in `tests/unit/config.test.ts`, with `chain.network: "test"`.)
- [ ] **RED** `tests/unit/contracts-public.test.ts`: `profileFor('test').uaPrefix === 'utest1'`; `validateProductSummary` rejects a negative `sizeBytes`, a non-digit `amountZat`, and an unknown extra key; `validateCheckoutResult` rejects a `type` other than `ssf:checkout`.
- [ ] Run both and see FAIL. Implement. Run both, plus `npx vitest run tests/unit/config.test.ts`, and see all PASS.
- [ ] `docs/live-runtime-config.md`: add a "public-testnet keys" table listing exactly the keys above.
- **Verify (orchestrator):** full `npx vitest run`, `npm run typecheck`, `git diff --check`.
- **Done:** contracts file exists with every name above; both new suites green; the old suite count has not dropped.
