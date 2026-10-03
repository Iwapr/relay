import type { Run, RunUsage } from '../../../packages/contracts/src/index.ts';
const format = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
export function TaskUsage({ usage }: { usage?: RunUsage }) {
  if (!usage) return null;
  const fields = [
    ['inputTokens', '输入'],
    ['outputTokens', '输出'],
    ['cacheReadTokens', '缓存读取'],
    ['cacheCreationTokens', '缓存写入'],
    ['thinkingTokens', '思考'],
  ] as const;
  return (
    <details className="task-usage">
      <summary>
        本次用量
        {usage.factoryCredits !== undefined
          ? ` · ${format(usage.factoryCredits)} credits`
          : ' · credits 未返回'}
      </summary>
      <p>
        {fields
          .filter(([key]) => usage[key] !== undefined)
          .map(([key, label]) => `${label} ${format(usage[key]!)} tokens`)
          .join(' · ')}
      </p>
      <small>官方返回的任务消耗；不是账号剩余额度。思考 token 可能包含在输出统计内，不重复相加。</small>
    </details>
  );
}
export function FactoryUsage({ runs, credits }: { runs: Run[]; credits: unknown }) {
  const recorded = runs.filter((r) => r.usage);
  const metered = recorded.filter((r) => r.usage?.factoryCredits !== undefined);
  const balance = (credits as { balanceCents?: unknown } | null)?.balanceCents;
  return (
    <section aria-label="Droid Usage">
      {typeof balance === 'number' && (
        <p>
          额外用量余额：<strong>{(balance / 100).toFixed(2)} USD</strong>
        </p>
      )}
      <h4>Relay 已记录用量（当前账号）</h4>
      {recorded.length ? (
        <>
          <p>
            {metered.length ? (
              <strong>{format(metered.reduce((n, r) => n + r.usage!.factoryCredits!, 0))} credits</strong>
            ) : (
              '官方未返回 credits，无法计算消耗额度。'
            )}
          </p>
          <p>
            已记录 {recorded.length} 次任务；其中 {metered.length} 次返回 credits。
          </p>
          <p>
            {(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const)
              .map((key, i) => {
                const values = recorded.flatMap((r) => (r.usage?.[key] === undefined ? [] : [r.usage[key]!]));
                return values.length
                  ? `${['输入', '输出', '缓存读取', '缓存写入'][i]} ${format(values.reduce((a, b) => a + b, 0))} tokens`
                  : null;
              })
              .filter(Boolean)
              .join(' · ')}
          </p>
        </>
      ) : (
        <p>尚无用量记录。新任务结束后，显示 Droid 返回的实际消耗。</p>
      )}
      <small>
        仅统计此账号在 Relay
        中保留且返回用量的任务，包含失败和取消任务的已返回消耗。旧记录和其他客户端的用量不计入；不代表套餐周期总用量或余额。
      </small>
      <p>
        <a href="https://app.factory.ai/settings/usage" target="_blank" rel="noreferrer">
          查看 Factory 官方 Usage
        </a>
      </p>
    </section>
  );
}
