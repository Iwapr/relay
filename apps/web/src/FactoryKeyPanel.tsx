import { useState } from 'react';
import { api, base } from './api';
export function FactoryKeyPanel({
  connection,
  online,
  configured,
  onSaved,
}: {
  connection: string;
  online: boolean;
  configured: boolean;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const save = async (apiKey: string) => {
    setBusy(true);
    setMessage('');
    try {
      await api(base(connection) + '/providers/factory/credentials', { apiKey });
      setKey('');
      setMessage(apiKey ? 'API Key 已保存，尚未验证；发送任务时由官方 Droid 校验。' : 'API Key 已移除。');
      onSaved();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="account-section">
      <h3>Factory API Key</h3>
      <p className="account-help">
        在{' '}
        <a href="https://app.factory.ai/settings/api-keys" target="_blank" rel="noreferrer">
          Factory 官方平台
        </a>
        创建密钥。保存后不回显；发送任务时由官方 Droid 验证密钥与模型权限。使用量与费用以 Factory
        账号套餐为准。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim() && !busy) void save(key.trim());
        }}
      >
        <label>
          Factory API Key
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={configured ? '已配置；输入新密钥可替换' : '输入官方 API Key'}
            disabled={!online || busy}
          />
        </label>
        <button className="primary" disabled={!online || busy || !key.trim()}>
          {busy ? '正在处理…' : '保存 API Key'}
        </button>
        {configured && (
          <button type="button" disabled={!online || busy} onClick={() => void save('')}>
            移除 API Key
          </button>
        )}
      </form>
      <p role="status">{message}</p>
    </section>
  );
}
