# Task 0: Integrate and harden the base (serial, orchestrator plus user)

## 0.1 Integrate `feat/live-mvp-integration` and re-baseline

- **Owner:** orchestrator. **Status: done 2026-09-26** (fast-forward, no merge commit; see Ledger). Timebox 45 min.
- **Why:** main (`9670032`) lacks the scanner, live adapters and runtime (the branch is 9 commits ahead). Public work must branch from the integrated tree.
- [ ] `git -C <worktree> status --short`: only `pnpm-lock.yaml` and `pnpm-workspace.yaml` are untracked. Delete neither; add both to `.gitignore` in 0.2.
- [ ] With the grant: `git checkout main && git merge --no-ff feat/live-mvp-integration -m "feat: integrate live mvp (regtest L)"`. Then create the branch `feat/public-testnet` and worktree `.worktrees/public-testnet`.
- [ ] Baseline in the new worktree: `npm ci`; `npx vitest run > .runtime/diag/P0-vitest.log`; `npm run typecheck`; `npm run build`; `npm run test:browser`; `(cd services/scanner && cargo test --locked)`. Ledger the counts.
- **Verify:** `git log --oneline -1` on `feat/public-testnet` equals the merge commit; the suite counts are ledgered.
- **Blocked-exit:** no merge grant means working on a branch cut from `feat/live-mvp-integration` HEAD and ledgering "not merged".

## 0.2 Deploy secret hygiene (must land before any host or spike work)

- **Owner:** subagent. Owns: `.gitignore`, `deploy/.gitignore` (new), `tests/unit/deploy-hygiene.test.ts` (new). Timebox 30 min.
- **Produces:** ignore rules for `deploy/secrets/`, `demo/**/.wrangler/`, `cloudflared` credential `*.json` under `deploy/secrets/`, `deploy/*.env`, `*.ufvk`, `spikes/**/state/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`; a unit test enforcing them.
- [ ] RED `tests/unit/deploy-hygiene.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const ignored = (p: string) => { try { execFileSync('git', ['check-ignore', '-q', p]); return true; } catch { return false; } };
describe('deploy hygiene', () => {
  it.each(['deploy/secrets/admin.token', 'deploy/prod.env', 'seller.ufvk', 'spikes/scanner-testnet/state/x', 'pnpm-lock.yaml', '.runtime/x'])('%s is ignored', (p) => {
    expect(ignored(p)).toBe(true);
  });
  it('deploy templates are tracked', () => { expect(ignored('deploy/compose.yaml')).toBe(false); });
});
```

- [ ] Run it and see FAIL. Add the rules. Run it and see PASS.
- **Done:** test green; `git status --short` shows no pnpm files.
