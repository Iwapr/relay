export function DeepSeekBalance({ credits }: { credits: unknown }) {
  const value = credits as {
    is_available?: boolean;
    balance_infos?: Array<{ currency: string; total_balance: string }>;
  } | null;
  const balances = Array.isArray(value?.balance_infos)
    ? value.balance_infos.filter(
        (b) =>
          typeof b.currency === 'string' &&
          typeof b.total_balance === 'string' &&
          Number.isFinite(Number(b.total_balance)),
      )
    : [];
  return (
    <>
      {balances.map((balance, i) => (
        <div className="quota-window" key={i}>
          <div>
            <span>API 余额</span>
            <strong>
              {balance.total_balance} {balance.currency}
            </strong>
          </div>
        </div>
      ))}
      {value?.is_available === false && <p className="muted">余额不足，请到 DeepSeek 官方平台充值。</p>}
      {!balances.length && <p className="muted">暂无 API 余额数据。</p>}
    </>
  );
}
