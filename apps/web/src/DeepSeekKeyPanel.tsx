import { useState } from 'react';
import { api, base } from './api';
export function DeepSeekKeyPanel({
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
      await api(base(connection) + '/providers/deepseek/credentials', { apiKey });
      setKey('');
      setMessage(apiKey ? 'API Key 已验证并保存。' : 'API Key 已移除。');
      onSaved();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="account-section">
      <h3>DeepSeek API Key</h3>
      <p className="account-help">
        在{' '}
        <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
          DeepSeek 官方平台
        </a>
        创建密钥。保存前验证，保存后不回显。API 使用按量计费。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim() && !busy) void save(key.trim());
        }}
      >
        <label>
          DeepSeek API Key
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
          {busy ? '正在处理…' : '验证并保存 API Key'}
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
