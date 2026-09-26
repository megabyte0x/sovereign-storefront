import { describe, expect, it } from 'vitest';
import { runLogosNode, runWithRestore, type LogosNodeDeps } from '../../scripts/live-infra/logos-node.ts';

const DIR_A = '/abs/.runtime/live/logos/node-a';
const DIR_B = '/abs/.runtime/live/logos/node-b';
const LOGOSCTL = '/abs/.runtime/live/logos/bin/logosctl-aarch64.AppImage';

type Call = { cmd: string; args: string[] };

function harness(opts: {
  statuses?: Array<{ code: number; stdout: string }>;
  cmdline?: string[] | undefined;
  state?: string | undefined;
  env?: Record<string, string | undefined>;
} = {}) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const lines: string[] = [];
  const bringUps: Array<{ logosctl: string; node: { dir: string; listenPort: number; discPort: number } }> = [];
  const statuses = [...(opts.statuses ?? [{ code: 0, stdout: '{"daemon":{"status":"running"}}' }])];
  const files: Record<string, string> = {
    [`${DIR_A}/daemon/state.json`]: opts.state ?? JSON.stringify({ pid: 4242, started_at: '2026-09-26T00:00:00Z' }),
    [`${DIR_A}/storage-init.json`]: JSON.stringify({ 'listen-port': 18091, 'disc-port': 18090, 'data-dir': `${DIR_A}/storage-data` }),
  };
  if (opts.cmdline !== undefined) files['/proc/4242/cmdline'] = `${opts.cmdline.join('\0')}\0`;
  const deps: LogosNodeDeps = {
    env: opts.env ?? { LOGOSCTL, LOGOS_NODE_A: DIR_A, LOGOS_NODE_B: DIR_B },
    execFile: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes('status')) {
        const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
        return { code: next.code, stdout: next.stdout, stderr: '' };
      }
      return { code: 0, stdout: '{"status":"ok"}', stderr: '' };
    },
    readFile: (p) => {
      reads.push(p);
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return v;
    },
    bringUpNode: async (logosctl, node) => {
      bringUps.push({ logosctl, node });
      return { peerId: '16Uiu2HAmTEST' };
    },
    sleep: async () => {},
    out: (l) => lines.push(l),
  };
  return { deps, calls, reads, lines, bringUps };
}

const GOOD_CMDLINE = ['/tmp/appimage_extracted_x/usr/bin/logosctl', '--config-dir', DIR_A, 'daemon', 'run'];

function touchedB(h: ReturnType<typeof harness>): boolean {
  return h.calls.some((c) => c.args.some((a) => a.includes('node-b')))
    || h.reads.some((r) => r.includes('node-b'))
    || h.bringUps.some((b) => b.node.dir.includes('node-b'));
}

describe('logos-node (single-node helper, node A only)', () => {
  it('stop --node a resolves node A from LOGOS_NODE_A, checks /proc cmdline, and runs the stop sequence scoped to A', async () => {
    const h = harness({
      statuses: [
        { code: 0, stdout: '{"daemon":{"status":"running"}}' },
        { code: 1, stdout: '{"daemon":{"status":"stopped"}}' },
      ],
      cmdline: GOOD_CMDLINE,
    });
    await runLogosNode(['stop', '--node', 'a'], h.deps);
    expect(h.reads).toContain('/proc/4242/cmdline');
    for (const c of h.calls) {
      expect(c.cmd).toBe(LOGOSCTL);
      expect(c.args.slice(0, 3)).toEqual(['--config-dir', DIR_A, '--json']);
    }
    const verbs = h.calls.map((c) => c.args.slice(3).join(' '));
    expect(verbs).toContain('daemon stop');
    const stopIdx = verbs.indexOf('daemon stop');
    expect(verbs.indexOf('call storage_module stop')).toBeLessThan(stopIdx);
    expect(verbs.indexOf('call storage_module destroy')).toBeLessThan(stopIdx);
    expect(verbs.indexOf('call storage_module stop')).toBeGreaterThanOrEqual(0);
    expect(h.lines).toEqual(['node-a stopped']);
    expect(touchedB(h)).toBe(false);
  });

  it('stop refuses when /proc/<pid>/cmdline does not contain the node-a path', async () => {
    const h = harness({ cmdline: ['/tmp/x/usr/bin/logosctl', '--config-dir', DIR_B, 'daemon', 'run'] });
    await expect(runLogosNode(['stop', '--node', 'a'], h.deps)).rejects.toThrow(/refus/i);
    expect(h.calls.map((c) => c.args.slice(3).join(' '))).not.toContain('daemon stop');
    expect(h.calls.some((c) => c.args.includes('storage_module'))).toBe(false);
    expect(h.lines).toEqual([]);
  });

  it('stop refuses when /proc/<pid>/cmdline has the path but no logos binary', async () => {
    const h = harness({ cmdline: ['/usr/bin/python3', '--config-dir', DIR_A] });
    await expect(runLogosNode(['stop', '--node', 'a'], h.deps)).rejects.toThrow(/refus/i);
    expect(h.calls.map((c) => c.args.slice(3).join(' '))).not.toContain('daemon stop');
  });

  it('stop refuses a prefix-only path match (node-a2 is not node-a)', async () => {
    const h = harness({ cmdline: ['/tmp/x/usr/bin/logosctl', '--config-dir', `${DIR_A}2`] });
    await expect(runLogosNode(['stop', '--node', 'a'], h.deps)).rejects.toThrow(/refus/i);
    expect(h.calls.map((c) => c.args.slice(3).join(' '))).not.toContain('daemon stop');
  });

  it('stop refuses when the daemon pid cannot be read (no state.json / no /proc entry)', async () => {
    const noProc = harness({ cmdline: undefined });
    await expect(runLogosNode(['stop', '--node', 'a'], noProc.deps)).rejects.toThrow(/refus/i);
    const badState = harness({ state: 'not json', cmdline: GOOD_CMDLINE });
    await expect(runLogosNode(['stop', '--node', 'a'], badState.deps)).rejects.toThrow(/refus/i);
    for (const h of [noProc, badState]) {
      expect(h.calls.map((c) => c.args.slice(3).join(' '))).not.toContain('daemon stop');
    }
  });

  it('stop on a not_running node A (the real post-stop daemon status) is a no-op', async () => {
    const h = harness({ statuses: [{ code: 1, stdout: '{"daemon":{"status":"not_running"}}' }] });
    await runLogosNode(['stop', '--node', 'a'], h.deps);
    expect(h.calls.map((c) => c.args.slice(3).join(' '))).toEqual(['daemon status']);
    expect(h.lines).toEqual(['node-a stopped']);
  });

  it('stop on an already-stopped node A is a no-op that prints node-a stopped', async () => {
    const h = harness({ statuses: [{ code: 1, stdout: '{"daemon":{"status":"stopped"}}' }] });
    await runLogosNode(['stop', '--node', 'a'], h.deps);
    expect(h.calls.map((c) => c.args.slice(3).join(' '))).toEqual(['daemon status']);
    expect(h.lines).toEqual(['node-a stopped']);
  });

  it('stop on a not_configured node A is a no-op that prints node-a stopped', async () => {
    const h = harness({ statuses: [{ code: 1, stdout: '{"daemon":{"status":"not_configured"}}' }] });
    await runLogosNode(['stop', '--node', 'a'], h.deps);
    expect(h.calls.map((c) => c.args.slice(3).join(' '))).toEqual(['daemon status']);
    expect(h.lines).toEqual(['node-a stopped']);
  });

  it('stop on a degraded node A with a live owned pid runs the ownership-checked stop sequence', async () => {
    const h = harness({
      statuses: [
        { code: 1, stdout: '{"daemon":{"status":"degraded"}}' },
        { code: 1, stdout: '{"daemon":{"status":"stopped"}}' },
      ],
      cmdline: GOOD_CMDLINE,
    });
    await runLogosNode(['stop', '--node', 'a'], h.deps);
    expect(h.reads).toContain('/proc/4242/cmdline');
    const verbs = h.calls.map((c) => c.args.slice(3).join(' '));
    expect(verbs).toEqual([
      'daemon status',
      'call storage_module stop',
      'call storage_module destroy',
      'daemon stop',
      'daemon status',
    ]);
    expect(h.lines).toEqual(['node-a stopped']);
    expect(touchedB(h)).toBe(false);
  });

  it('stop on a degraded node A whose pid is not owned refuses without stopping or printing stopped', async () => {
    const h = harness({
      statuses: [{ code: 1, stdout: '{"daemon":{"status":"degraded"}}' }],
      cmdline: ['/tmp/x/usr/bin/logosctl', '--config-dir', DIR_B, 'daemon', 'run'],
    });
    await expect(runLogosNode(['stop', '--node', 'a'], h.deps)).rejects.toThrow(/refus/i);
    expect(h.calls.map((c) => c.args.slice(3).join(' '))).toEqual(['daemon status']);
    expect(h.lines).toEqual([]);
  });

  it('stop fails if a degraded node A never reaches a stopped status after daemon stop', async () => {
    const h = harness({ statuses: [{ code: 1, stdout: '{"daemon":{"status":"degraded"}}' }], cmdline: GOOD_CMDLINE });
    await expect(runLogosNode(['stop', '--node', 'a'], h.deps)).rejects.toThrow(/still running|not stopped/);
    expect(h.lines).toEqual([]);
  });

  it('stop fails if node A is still running after daemon stop', async () => {
    const h = harness({ statuses: [{ code: 0, stdout: '{"daemon":{"status":"running"}}' }], cmdline: GOOD_CMDLINE });
    await expect(runLogosNode(['stop', '--node', 'a'], h.deps)).rejects.toThrow(/still running/);
    expect(h.lines).toEqual([]);
  });

  it('start --node a reuses logos-up bringUpNode with ports from node A storage-init.json', async () => {
    const h = harness();
    await runLogosNode(['start', '--node', 'a'], h.deps);
    expect(h.bringUps).toEqual([{ logosctl: LOGOSCTL, node: { dir: DIR_A, listenPort: 18091, discPort: 18090 } }]);
    expect(h.lines).toEqual(['node-a started']);
    expect(touchedB(h)).toBe(false);
  });

  it('start refuses when storage-init.json has no valid ports', async () => {
    const h = harness();
    h.deps.readFile = () => JSON.stringify({ 'listen-port': 'x' });
    await expect(runLogosNode(['start', '--node', 'a'], h.deps)).rejects.toThrow(/port/);
    expect(h.bringUps).toEqual([]);
  });

  it('status --node a treats `daemon status` exit 1 with JSON as valid (logosctl quirk)', async () => {
    const stopped = harness({ statuses: [{ code: 1, stdout: '{"daemon":{"status":"not_configured"}}\n' }] });
    await runLogosNode(['status', '--node', 'a'], stopped.deps);
    expect(stopped.lines).toEqual(['node-a stopped']);
    const running = harness({ statuses: [{ code: 1, stdout: '{"daemon":{"status":"running"}}' }] });
    await runLogosNode(['status', '--node', 'a'], running.deps);
    expect(running.lines).toEqual(['node-a running']);
    const garbage = harness({ statuses: [{ code: 1, stdout: 'boom' }] });
    await expect(runLogosNode(['status', '--node', 'a'], garbage.deps)).rejects.toThrow(/status/);
    expect(garbage.lines).toEqual([]);
    for (const h of [stopped, running]) {
      expect(h.calls).toEqual([{ cmd: LOGOSCTL, args: ['--config-dir', DIR_A, '--json', 'daemon', 'status'] }]);
    }
  });

  it('never touches node B: --node b and unknown nodes/commands are rejected before any call', async () => {
    for (const argv of [['stop', '--node', 'b'], ['start', '--node', 'b'], ['status', '--node', 'b'], ['stop'], ['restart', '--node', 'a'], ['stop', '--node', 'a', '--node', 'b']]) {
      const h = harness({ cmdline: GOOD_CMDLINE });
      await expect(runLogosNode(argv, h.deps)).rejects.toThrow(/usage|only node a/i);
      expect(h.calls).toEqual([]);
      expect(h.bringUps).toEqual([]);
      expect(h.lines).toEqual([]);
    }
  });

  it('resolves node A only from LOGOS_NODE_A (absolute, basename node-a) and requires LOGOSCTL', async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { LOGOSCTL, LOGOS_NODE_B: DIR_B },
      { LOGOSCTL, LOGOS_NODE_A: 'relative/node-a', LOGOS_NODE_B: DIR_B },
      { LOGOSCTL, LOGOS_NODE_A: DIR_B, LOGOS_NODE_B: DIR_B },
      { LOGOS_NODE_A: DIR_A },
    ];
    for (const env of cases) {
      const h = harness({ env, cmdline: GOOD_CMDLINE });
      await expect(runLogosNode(['status', '--node', 'a'], h.deps)).rejects.toThrow(/LOGOS_NODE_A|LOGOSCTL/);
      expect(h.calls).toEqual([]);
    }
  });
});

describe('runWithRestore (origin-stop finally semantics)', () => {
  it('runs restore after a successful body and returns the body value', async () => {
    const order: string[] = [];
    const v = await runWithRestore(async () => { order.push('body'); return 7; }, async () => { order.push('restore'); });
    expect(v).toBe(7);
    expect(order).toEqual(['body', 'restore']);
  });

  it('rethrows the original body error when restore succeeds', async () => {
    const bodyErr = new Error('assertion: hash mismatch');
    let restored = false;
    await expect(runWithRestore(async () => { throw bodyErr; }, async () => { restored = true; })).rejects.toBe(bodyErr);
    expect(restored).toBe(true);
  });

  it('throws the restore error when only restore fails', async () => {
    const cleanupErr = new Error('logos-node start failed');
    await expect(runWithRestore(async () => 1, async () => { throw cleanupErr; })).rejects.toBe(cleanupErr);
  });

  it('keeps both errors in an AggregateError([bodyErr, cleanupErr]) when body and restore both fail', async () => {
    const bodyErr = new Error('assertion: hash mismatch');
    const cleanupErr = new Error('strict doctor did not reach 6 PASS');
    const caught = await runWithRestore(async () => { throw bodyErr; }, async () => { throw cleanupErr; }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([bodyErr, cleanupErr]);
    expect((caught as AggregateError).message).toMatch(/hash mismatch/);
    expect((caught as AggregateError).message).toMatch(/6 PASS/);
  });
});
