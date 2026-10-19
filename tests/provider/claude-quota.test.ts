import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeQuota, parseClaudeQuota } from '../../packages/provider-claude/src/quota.ts';
const now = Date.parse('2030-01-01T00:00:00Z');
const data = {
  five_hour: { utilization: 25, resets_at: '2030-01-01T05:00:00Z' },
  seven_day: { utilization: 60, resets_at: '2030-01-07T00:00:00Z' },
  seven_day_sonnet: { utilization: 100, resets_at: null },
  seven_day_opus: null,
};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'relay-claude-quota-'));
  await mkdir(join(home, '.claude'));
  const save = (token: string) =>
    writeFile(
      join(home, '.claude/.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      { mode: 0o600 },
    );
  await save('fixture-token');
  return { home, save, close: () => rm(home, { recursive: true, force: true }) };
}

test('Claude usage retains separate subscription and model windows, not dollar or token balances', () => {
  const q = parseClaudeQuota({ ...data, extra_usage: { used_credits: 900 } }, now);
  assert.deepEqual(
    q.windows.map((w) => w.usedPercent),
    [25, 60, 100],
  );
  assert.deepEqual(
    q.windows.map((w) => w.scope),
    ['Claude', 'Claude', 'Sonnet'],
  );
  assert.equal(q.windows[0].resetsAt, Date.parse(data.five_hour.resets_at) / 1000);
  assert.equal(q.credits, null);
  assert.equal(parseClaudeQuota(data, now + 86400000).windows[0].usedPercent, null);
  for (const utilization of [null, '50', -1, 101, NaN])
    assert.throws(() => parseClaudeQuota({ five_hour: { utilization } }, now));
  assert.throws(() => parseClaudeQuota({ error: 'private' }, now));
});

test('Claude query uses private OAuth, caches per credential and retains stale data after failure', async (t) => {
  const f = await fixture();
  let time = now;
  t.mock.method(Date, 'now', () => time);
  let calls = 0;
  const request = (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('anthropic-beta'), 'oauth-2025-04-20');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    return Response.json(data);
  }) as typeof fetch;
  try {
    assert.equal((await claudeQuota(f.home, request)).stale, false);
    await claudeQuota(f.home, request);
    assert.equal(calls, 1);
    time += 31000;
    const stale = await claudeQuota(
      f.home,
      (async () => new Response('private credential body', { status: 403 })) as typeof fetch,
    );
    assert.equal(stale.stale, true);
    assert.equal(stale.windows.length, 3);
    assert.match(stale.unavailableReason!, /403/);
    assert.equal(stale.updatedAt, new Date(now).toISOString());
    await f.save('other-token');
    const rotated = await claudeQuota(
      f.home,
      (async () => new Response('', { status: 401 })) as typeof fetch,
    );
    assert.equal(rotated.windows.length, 0);
    assert.match(rotated.unavailableReason!, /过期/);
    assert.doesNotMatch(JSON.stringify(rotated), /other-token|fixture-token|private/);
  } finally {
    await f.close();
  }
});

test('Claude missing credentials never query and network errors never disclose secrets', async () => {
  const f = await fixture();
  try {
    await rm(join(f.home, '.claude/.credentials.json'));
    let calls = 0;
    const request = (async () => {
      calls++;
      throw new Error('Claude 额度查询 private-token');
    }) as typeof fetch;
    assert.match((await claudeQuota(f.home, request)).unavailableReason!, /登录凭据/);
    assert.equal(calls, 0);
    await f.save('new-token');
    const value = await claudeQuota(f.home, request);
    assert.equal(calls, 1);
    assert.equal(value.stale, true);
    assert.doesNotMatch(JSON.stringify(value), /private-token|new-token/);
  } finally {
    await f.close();
  }
});
