import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { QuotaState, QuotaWindow } from '../../provider-core/src/index.ts';

class UsageError extends Error {}

const cache = new Map<string, { until: number; value: QuotaState }>();
const windows = [
  ['five_hour', 'Claude 五小时额度', 300, 'Claude'],
  ['seven_day', 'Claude 每周额度', 10080, 'Claude'],
  ['seven_day_opus', 'Opus 每周额度', 10080, 'Opus'],
  ['seven_day_sonnet', 'Sonnet 每周额度', 10080, 'Sonnet'],
  ['seven_day_oauth_apps', 'OAuth 应用每周额度', 10080, 'OAuth apps'],
  ['seven_day_cowork', 'Cowork 每周额度', 10080, 'Cowork'],
] as const;

/** Subscription percentages from the official Claude Code OAuth usage endpoint. */
export function parseClaudeQuota(data: unknown, now = Date.now()): QuotaState {
  if (!data || typeof data !== 'object') throw new Error('Invalid usage');
  const result: QuotaWindow[] = [];
  for (const [key, name, minutes, scope] of windows) {
    const value = (data as Record<string, any>)[key];
    if (
      !value ||
      typeof value.utilization !== 'number' ||
      !Number.isFinite(value.utilization) ||
      value.utilization < 0 ||
      value.utilization > 100
    )
      continue;
    const reset = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN;
    result.push({
      name,
      scope,
      windowDurationMins: minutes,
      usedPercent: Number.isFinite(reset) && reset <= now ? null : value.utilization,
      resetsAt: Number.isFinite(reset) ? reset / 1000 : null,
    });
  }
  if (!result.length) throw new Error('No recognized usage windows');
  return { windows: result, credits: null, stale: false, updatedAt: new Date(now).toISOString() };
}

export async function claudeQuota(home: string, request: typeof fetch = fetch): Promise<QuotaState> {
  const empty = (unavailableReason: string): QuotaState => ({
    windows: [],
    credits: null,
    stale: true,
    updatedAt: new Date().toISOString(),
    unavailableReason,
  });
  let token: string;
  try {
    // Same isolated CLAUDE_CONFIG_DIR as the CLI. Never fall back to another user's credentials.
    const credentials = JSON.parse(await readFile(join(home, '.claude/.credentials.json'), 'utf8'));
    token = credentials.claudeAiOauth?.accessToken;
    if (typeof token !== 'string' || !token.trim()) throw new Error('Missing OAuth token');
  } catch {
    return empty('未找到此 Claude 账号的订阅登录凭据，请重新登录；不会读取其他账号的凭据。');
  }
  const key = home + ':' + createHash('sha256').update(token).digest('hex');
  const previous = cache.get(key);
  if (previous && previous.until > Date.now()) return previous.value;
  let value: QuotaState;
  try {
    const response = await request('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UsageError(
        response.status === 401
          ? 'Claude 额度授权已过期，请在 Claude Code 刷新登录或重新登录此账号。'
          : response.status === 403
            ? 'Claude 额度接口返回 403，可能是账号权限或网络限制，不代表订阅额度已用完。'
            : response.status === 429
              ? 'Claude 额度查询过于频繁，请稍后刷新。'
              : `Claude 额度查询暂不可用（HTTP ${response.status}）。`,
      );
    }
    // Bound the response and never surface server error bodies or credential values.
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 256 * 1024) throw new Error();
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel();
    }
    value = parseClaudeQuota(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    const message =
      error instanceof UsageError
        ? error.message
        : 'Claude 额度查询失败：网络超时或返回格式不兼容，请稍后刷新。';
    value = previous?.value.windows.length
      ? { ...previous.value, stale: true, unavailableReason: message }
      : empty(message);
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: Date.now() + 30_000, value });
  return value;
}
