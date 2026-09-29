import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const ignored = (p: string) => { try { execFileSync('git', ['check-ignore', '-q', p]); return true; } catch { return false; } };
describe('deploy hygiene', () => {
  it.each(['deploy/secrets/admin.token', 'deploy/prod.env', 'seller.ufvk', 'spikes/scanner-testnet/state/x', 'pnpm-lock.yaml', '.runtime/x'])('%s is ignored', (p) => {
    expect(ignored(p)).toBe(true);
  });
  it('deploy templates are tracked', () => { expect(ignored('deploy/compose.yaml')).toBe(false); });
});
