import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFactoryQuota, factoryQuota } from '../../packages/provider-factory/src/quota.ts';
import { writeFactoryKey } from '../../packages/provider-factory/src/credentials.ts';
import { RunUsageSchema } from '../../packages/contracts/src/index.ts';

test('Droid billing limits preserve separate pools, resets and real zero balances; expired windows stay unknown', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  const parsed = parseFactoryQuota(
    {
      limits: {
        standard: {
          fiveHour: { usedPercent: 23.5, windowEnd: '2026-10-02T05:00:00Z' },
          weekly: { usedPercent: 105, windowEnd: '2026-10-08T00:00:00Z' },
          monthly: { usedPercent: 88, windowEnd: '2026-10-01T00:00:00Z' },
        },
        core: { fiveHour: { usedPercent: 0, windowEnd: null } },
      },
      extraUsageBalanceCents: 0,
    },
    now,
  );
  assert.deepEqual(
    parsed.windows.map((w) => [w.scope, w.usedPercent]),
    [
      ['standard', 23.5],
      ['standard', 105],
      ['standard', null],
      ['core', 0],
    ],
  );
  assert.equal(parsed.windows[0].resetsAt, Date.parse('2026-10-02T05:00:00Z') / 1000);
  assert.deepEqual(parsed.credits, { balanceCents: 0, currency: 'USD' });
  assert.throws(() => parseFactoryQuota({ limits: { standard: { fiveHour: { usedPercent: '30' } } } }));
  assert.throws(() => parseFactoryQuota({ limits: { standard: { fiveHour: { usedPercent: NaN } } } }));
});

test('quota lookup is nonfatal, cached and isolated by account and key; does not send secrets outside Factory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = join(root, 'other');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, 'https://api.factory.ai/api/billing/limits');
    assert.equal(init.redirect, 'error');
    const key = (init.headers as Record<string, string>).Authorization;
    if (key === 'Bearer test-one') return new Response('secret-rejected', { status: 403 });
    return Response.json({
      limits: { standard: { fiveHour: { usedPercent: 10, windowEnd: null } } },
      extraUsageBalanceCents: 1234,
    });
  });
  assert.match((await factoryQuota(root)).unavailableReason!, /保存/);
  assert.equal(calls, 0);
  await writeFactoryKey(root, 'test-one');
  const failed = await factoryQuota(root);
  assert.equal(failed.stale, true);
  assert.equal(failed.credits, null);
  assert.equal(failed.windows.length, 0);
  assert.match(failed.unavailableReason!, /403/);
  assert.ok(!JSON.stringify(failed).includes('secret-rejected'));
  await factoryQuota(root);
  assert.equal(calls, 1);
  await writeFactoryKey(other, 'test-two');
  assert.equal((await factoryQuota(other)).windows[0].usedPercent, 10);
  await writeFactoryKey(root, 'test-new');
  assert.equal((await factoryQuota(root)).windows[0].usedPercent, 10);
  assert.equal(calls, 3);
});

test('task usage accepts reported zero but rejects empty, negative and nonfinite values', () => {
  assert.equal(RunUsageSchema.safeParse({}).success, false);
  assert.equal(RunUsageSchema.safeParse({ factoryCredits: 0 }).success, true);
  assert.equal(RunUsageSchema.safeParse({ factoryCredits: -1 }).success, false);
  assert.equal(RunUsageSchema.safeParse({ inputTokens: Infinity }).success, false);
  assert.deepEqual(RunUsageSchema.parse({ factoryCredits: 4, secret: 'omit' }), { factoryCredits: 4 });
});
