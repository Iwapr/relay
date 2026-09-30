import { useEffect, useState } from 'react';
import { api, base } from './api';
import type { GeminiSettings } from '../../../packages/provider-gemini/src/settings';

export function GeminiSettingsPanel({ connection, online }: { connection: string; online: boolean }) {
  const [settings, setSettings] = useState<GeminiSettings | null>(null),
    [allow, setAllow] = useState(''),
    [deny, setDeny] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setSettings(null);
    if (online)
      void api<GeminiSettings>(
        base(connection) + '/providers/antigravity/settings',
        undefined,
        controller.signal,
      )
        .then((s) => {
          if (!controller.signal.aborted) {
            setSettings(s);
            setAllow(s.allowedCommands.join('\n'));
            setDeny(s.deniedCommands.join('\n'));
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    return () => controller.abort();
  }, [connection, online, reload]);
  const lines = (text: string) =>
    text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  return (
    <section className="account-section">
      <h3>Gemini（测试）命令权限</h3>
      <p className="account-help">
        每行一个命令前缀，例如 python -m
        pytest，允许其后带参数。禁止规则优先；其他需要审批的操作会被拒绝。保存后从下一次任务生效，当前账号有任务时不能保存。
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!settings || busy) return;
          setBusy(true);
          setError('');
          setSaved(false);
          try {
            const result = await api<GeminiSettings>(base(connection) + '/providers/antigravity/settings', {
              revision: settings.revision,
              allowedCommands: lines(allow),
              deniedCommands: lines(deny),
            });
            setSettings(result);
            setSaved(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          允许的命令
          <textarea
            aria-label="Gemini 允许的命令"
            value={allow}
            onChange={(e) => {
              setAllow(e.target.value);
              setSaved(false);
            }}
            rows={6}
            maxLength={24000}
            disabled={!settings || busy}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
        <label>
          禁止的命令
          <textarea
            aria-label="Gemini 禁止的命令"
            value={deny}
            onChange={(e) => {
              setDeny(e.target.value);
              setSaved(false);
            }}
            rows={3}
            maxLength={24000}
            disabled={!settings || busy}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </label>
        {!!settings?.additionalRules && (
          <p className="account-help">保留了 {settings.additionalRules} 条本地高级规则，仍会参与权限判断。</p>
        )}
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">权限规则已保存，下次任务生效。</p>}
        <button type="submit" disabled={!online || !settings || busy}>
          {busy ? '正在保存…' : '保存命令权限'}
        </button>{' '}
        <button
          type="button"
          disabled={busy || !online}
          onClick={() => {
            setSaved(false);
            setReload((v) => v + 1);
          }}
        >
          重新加载权限
        </button>
      </form>
    </section>
  );
}
