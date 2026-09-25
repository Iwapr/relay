import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountReader } from '../../apps/agent/src/account-reader.ts';
import { MockProvider, barrier } from '../helpers/mock-provider.ts';

test('external login changes refresh identity, models and quota together without reusing a process', async () => {
  let now = 0;
  let login: string | null = 'first';
  let quotaFails = false;
  const providers: MockProvider[] = [];
  const reader = new AccountReader(
    () => {
      const p = new MockProvider('/unused');
      const captured = login;
      p.account = {
        ...p.account,
        authenticated: !!captured,
        identifier: captured,
        authMode: captured ? 'chatgpt' : null,
      };
      p.listModels = async () => [
        {
          id: captured ?? 'none',
          displayName: 'Model',
          description: '',
          isDefault: true,
          reasoningEfforts: [],
          defaultReasoningEffort: null,
        },
      ];
      p.getQuota = async () => {
        if (quotaFails) throw new Error('unavailable');
        return { windows: [], credits: { account: captured }, updatedAt: String(now), stale: false };
      };
      providers.push(p);
      return p;
    },
    () => now,
  );
  try {
    const [account, models, quota] = await Promise.all([
      reader.read('account'),
      reader.read('models'),
      reader.read('quota'),
    ]);
    assert.equal(account.identifier, 'first');
    assert.equal(models[0].id, 'first');
    assert.deepEqual(quota?.credits, { account: 'first' });
    assert.equal(providers.length, 1);
    assert.equal(providers[0].closes, 1);
    login = 'second';
    now = 10_001;
    assert.equal((await reader.read('account')).identifier, 'second');
    assert.equal((await reader.read('models'))[0].id, 'second');
    assert.deepEqual((await reader.read('quota'))?.credits, { account: 'second' });
    assert.equal(providers.length, 2);
    quotaFails = true;
    login = 'third';
    now += 10_001;
    assert.equal((await reader.read('account')).identifier, 'third');
    await assert.rejects(reader.read('quota'), /unavailable/);
    login = null;
    now += 10_001;
    assert.equal((await reader.read('account')).authenticated, false);
    assert.equal(await reader.read('quota'), null);
  } finally {
    await reader.close();
  }
});

test('invalidation during a query does not launch overlapping probes or cache an old login', async () => {
  const gate = barrier();
  let calls = 0;
  const reader = new AccountReader(() => {
    const p = new MockProvider('/unused');
    calls++;
    if (calls === 1) p.accountBarrier = gate.promise;
    return p;
  });
  try {
    const first = reader.read('account');
    reader.invalidate();
    const second = reader.read('models');
    assert.equal(calls, 1);
    gate.release();
    await Promise.all([first, second]);
    await reader.read('account');
    assert.equal(calls, 2);
  } finally {
    await reader.close();
  }
});
