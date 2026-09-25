import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { QuotaState, QuotaWindow } from '../../provider-core/src/index.ts';

const entry = z.object({ usedRatio: z.number().finite().nonnegative(), resetAt: z.string().optional() });
const resultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    quota: z.object({
      usages: z.object({
        limit5h: entry.optional(),
        limit7d: entry.optional(),
        monthTotal: entry.optional(),
        monthCode: entry.optional(),
      }),
      extraUsage: z
        .object({
          balanceCents: z.number().int(),
          totalCents: z.number().int(),
          monthlyChargeLimitEnabled: z.boolean(),
          monthlyChargeLimitCents: z.number().int(),
          monthlyUsedCents: z.number().int(),
          currency: z.string(),
        })
        .nullable(),
    }),
  }),
  z.object({ kind: z.literal('error'), status: z.number().optional(), message: z.string() }),
]);

export function unavailableQuota(reason: string): QuotaState {
  return {
    windows: [],
    updatedAt: new Date().toISOString(),
    stale: true,
    credits: null,
    unavailableReason: reason,
  };
}

export function mapKimiQuota(data: unknown): QuotaState {
  const result = resultSchema.parse(data);
  if (result.kind === 'error') {
    // Never forward arbitrary CLI errors, which can contain credentials or local paths.
    const reason =
      result.status === 401 || /no token|unauthorized|authenticate/i.test(result.message)
        ? 'Kimi 登录已失效，请重新登录后查询额度。'
        : result.status === 403
          ? 'Kimi 未允许查询此账号的额度，请检查账号权益。'
          : 'Kimi 额度暂时查询失败，请稍后刷新；也可在 Kimi Code 控制台查看。';
    return unavailableQuota(reason);
  }
  const windows: QuotaWindow[] = [];
  for (const [key, name, minutes] of [
    ['limit5h', '5 小时额度', 300],
    ['limit7d', '每周额度', 10080],
    ['monthTotal', '月度总额度', null],
    ['monthCode', '月度代码额度', null],
  ] as const) {
    const value = result.quota.usages[key];
    if (!value) continue;
    const reset = value.resetAt ? Date.parse(value.resetAt) : NaN;
    windows.push({
      name,
      usedPercent: Math.min(100, value.usedRatio * 100),
      windowDurationMins: minutes,
      resetsAt: Number.isFinite(reset) ? reset / 1000 : null,
      scope: null,
    });
  }
  return {
    windows,
    updatedAt: new Date().toISOString(),
    stale: false,
    credits: null,
    extraUsage: result.quota.extraUsage ?? undefined,
    ...(!windows.length ? { unavailableReason: 'Kimi 未返回此账号的订阅额度数据，请检查账号权益。' } : {}),
  };
}

/** Use the official CLI's authenticated local API. OAuth secrets and refresh stay inside Kimi.
 * The temporary server binds loopback on an OS-assigned port and keeps bearer auth enabled.
 */
export async function readKimiQuota(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
): Promise<QuotaState> {
  const url = await new Promise<URL>((resolve, reject) => {
    let buffer = '';
    const finish = (error?: Error, value?: URL) => {
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      signal.removeEventListener('abort', onAbort);
      child.stdout.resume();
      error ? reject(error) : resolve(value!);
    };
    const onError = () => finish(new Error('Kimi quota process failed'));
    const onExit = () => finish(new Error('Kimi quota process exited'));
    const onAbort = () => finish(new Error('Kimi quota query cancelled'));
    const onData = (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) return onError();
      let offset: number;
      while ((offset = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 1);
        const match = /^Kimi server: (http:\/\/127\.0\.0\.1:\d+\/#token=[^\s]+)\r?$/.exec(line);
        if (match) return finish(undefined, new URL(match[1]));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.resume();
    child.on('error', onError);
    child.once('exit', onExit);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (!token) throw new Error('Missing local API token');
  const response = await fetch(new URL('/api/v1/oauth/usage?provider=managed%3Akimi-code', url.origin), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Kimi local quota API failed');
  const envelope = (await response.json()) as { code?: number; data?: unknown };
  if (envelope.code !== 0) throw new Error('Invalid Kimi quota response');
  return mapKimiQuota(envelope.data);
}
