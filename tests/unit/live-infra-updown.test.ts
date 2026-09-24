import { describe, expect, it } from 'vitest';
import { UP_ORDER, runStages, finalStatusLine, doctorRowLines } from '../../scripts/live-infra/up.ts';
import { DOWN_ORDER, leftoverChecks, isLeftover } from '../../scripts/live-infra/down.ts';

describe('live-infra up/down', () => {
  it('UP_ORDER and DOWN_ORDER are fixed', () => {
    expect([...UP_ORDER]).toEqual(['zcash', 'logos', 'waku']);
    expect([...DOWN_ORDER]).toEqual(['logos', 'zcash']);
  });

  it('leftoverChecks targets only owned resources', () => {
    const checks = leftoverChecks();
    const joined = checks.map((c) => c.argv.join(' ')).join('\n');
    expect(joined).toContain('tsz-ssf-live');
    expect(joined).toContain('logos/node-');
    expect(joined).toContain('ths start --name ssf-live');
    expect(joined).not.toMatch(/ssf-task1|ssf-task3-live|p-happy|\bdefault\b/);
    for (const c of checks) expect(c.kind).not.toBe('');
  });

  it('isLeftover ignores the checking process and its parent', () => {
    expect(isLeftover('', [])).toEqual([]);
    expect(isLeftover('123\n456\n', [456])).toEqual(['123']);
    expect(isLeftover('456\n', [456])).toEqual([]);
  });

  it('runStages stops on the first nonzero exit', async () => {
    const calls: string[] = [];
    const fake = async (stage: string) => {
      calls.push(stage);
      return { code: stage === 'logos' ? 1 : 0, statusLine: `${stage}=x`, logPath: `/diag/up-${stage}.log` };
    };
    const res = await runStages(UP_ORDER, fake);
    expect(calls).toEqual(['zcash', 'logos']);
    expect(res).toEqual({ ok: false, failed: 'logos', logPath: '/diag/up-logos.log', lines: ['zcash=x'] });
  });

  it('runStages runs every stage when all succeed', async () => {
    const calls: string[] = [];
    const res = await runStages(UP_ORDER, async (s) => { calls.push(s); return { code: 0, statusLine: `${s}=ok`, logPath: '' }; });
    expect(calls).toEqual(['zcash', 'logos', 'waku']);
    expect(res.ok).toBe(true);
    expect(res.lines).toEqual(['zcash=ok', 'logos=ok', 'waku=ok']);
  });

  it('finalStatusLine returns the last non-empty line', () => {
    expect(finalStatusLine('a\nb\n\n')).toBe('b');
    expect(finalStatusLine('')).toBe('');
  });

  it('doctorRowLines keeps only row status lines', () => {
    const out = 'noise\nzcash PASS ok\nscanner FAIL down\nwaku SKIP x\nlogos-replication PASS m\nfoo PASS\n';
    expect(doctorRowLines(out)).toEqual(['zcash PASS ok', 'scanner FAIL down', 'waku SKIP x', 'logos-replication PASS m']);
  });
});
