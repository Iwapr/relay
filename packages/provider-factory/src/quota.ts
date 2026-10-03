import { createHash } from 'node:crypto';
import type { QuotaState, QuotaWindow } from '../../provider-core/src/index.ts';
import { readFactoryKey } from './credentials.ts';
const cache = new Map<string, { expires: number; value: QuotaState }>();
const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
/** Shape used by the pinned official Droid /limits command. Never infer a token allowance. */
export function parseFactoryQuota(data: any, now = Date.now()): QuotaState {
  const windows: QuotaWindow[] = [];
  for (const [pool, label] of [
    ['standard', 'Standard'],
    ['core', 'Droid Core'],
  ]) {
    for (const [key, name, minutes] of [
      ['fiveHour', '5 小时', 300],
      ['weekly', '每周', 10080],
      ['monthly', '每月', null],
    ] as const) {
      const value = data?.limits?.[pool]?.[key];
      if (!value || !number(value.usedPercent)) continue;
      const date = typeof value.windowEnd === 'string' ? Date.parse(value.windowEnd) : NaN;
      windows.push({
        name: `${label} · ${name}`,
        scope: pool,
        usedPercent: Number.isFinite(date) && date <= now ? null : value.usedPercent,
        windowDurationMins: minutes,
        resetsAt: Number.isFinite(date) ? date / 1000 : null,
      });
    }
  }
  const balance = data?.extraUsageBalanceCents;
  if (!windows.length && !number(balance)) throw new Error('Invalid billing limits response');
  return {
    windows,
    credits: number(balance) ? { balanceCents: balance, currency: 'USD' } : null,
    stale: false,
    updatedAt: new Date(now).toISOString(),
  };
}
export async function factoryQuota(home: string): Promise<QuotaState> {
  const key = await readFactoryKey(home);
  const empty = (reason: string): QuotaState => ({
    windows: [],
    credits: null,
    stale: true,
    updatedAt: new Date().toISOString(),
    unavailableReason: reason,
  });
  if (!key) return empty('请先保存 Factory API Key');
  const id = home + ':' + createHash('sha256').update(key).digest('hex');
  const prior = cache.get(id);
  if (prior && prior.expires > Date.now()) return prior.value;
  let value: QuotaState;
  try {
    const response = await fetch('https://api.factory.ai/api/billing/limits', {
      headers: { Authorization: `Bearer ${key}`, 'X-Factory-Client': 'cli', 'X-Client-Version': '0.232.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      value = empty(
        response.status === 403
          ? 'Factory 额度接口返回 403，当前无法读取账号额度；可能是网络入口或账号权限限制，不影响尝试发送任务。'
          : `Factory 额度查询暂不可用（HTTP ${response.status}），不影响发送任务。`,
      );
    } else value = parseFactoryQuota(await response.json());
  } catch {
    value = empty('Factory 额度查询超时、网络异常或返回格式不兼容；不影响发送任务。');
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(id, { expires: Date.now() + 60000, value });
  return value;
}
