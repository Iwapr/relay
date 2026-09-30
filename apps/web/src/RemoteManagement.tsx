import { useEffect, useRef, useState } from 'react';
import { X, Globe, RefreshCw, Copy } from 'lucide-react';
import { api } from './api';
import type { CloudRelay, RelayGuide, RemoteStatus } from '../../../packages/contracts/src/remote-access';
import './remote-management.css';

function Command({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLTextAreaElement>(null);
  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(children);
      else {
        code.current!.focus();
        code.current!.select();
        if (!document.execCommand('copy')) return;
      }
      setCopied(true);
    } catch {
      code.current?.select();
    }
  }
  return (
    <div className="remote-command">
      <button type="button" onClick={() => void copy()}>
        <Copy size={14} />
        {copied ? '已复制' : '复制代码'}
      </button>
      <textarea
        ref={code}
        aria-label="部署代码"
        readOnly
        value={children}
        rows={Math.min(16, children.split('\n').length + 1)}
        spellCheck={false}
      />
    </div>
  );
}
export function RemoteManagement({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<RemoteStatus>();
  const [enabled, setEnabled] = useState(false);
  const [relayEnabled, setRelayEnabled] = useState(false);
  const [relay, setRelay] = useState<CloudRelay>({
    cloudIp: '',
    domain: '',
    port: 443,
    cloudTailscaleIp: '',
  });
  const [guide, setGuide] = useState<RelayGuide>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    const abort = new AbortController();
    void api<RemoteStatus>('/remote-access', undefined, abort.signal)
      .then((value) => {
        setStatus(value);
        setEnabled(value.enabled);
        setRelayEnabled(Boolean(value.relay));
        if (value.relay) setRelay(value.relay);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  function field<K extends keyof CloudRelay>(key: K, value: CloudRelay[K]) {
    setRelay((previous) => ({ ...previous, [key]: value }));
    setGuide(undefined);
    setMessage('');
  }
  return (
    <dialog ref={dialog} className="remote-modal" aria-labelledby="remote-title" onCancel={onClose}>
      <div className="modal-title">
        <div>
          <h2 id="remote-title">
            <Globe size={21} />
            远程管理
          </h2>
          <p>从局域网开始，按需开启远程访问。</p>
        </div>
        <button aria-label="关闭远程管理" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="remote-success" role="status">
          {message}
        </p>
      )}
      {!status ? (
        <p role="status">正在检测服务器配置…</p>
      ) : (
        <>
          <div className="remote-summary">
            <strong>{status.enabled ? '远程入口已启用' : '仅本机 / 局域网访问'}</strong>
            <p>局域网入口：{status.localOrigin}</p>
            {status.remoteOrigin && <p>Tailscale 入口：{status.remoteOrigin}</p>}
            {status.proxyOrigin && <p>已配置云端入口：{status.proxyOrigin}（请另行验证云端部署）</p>}
          </div>
          {!status.manageable && <p role="status">{status.reason}</p>}
          <section>
            <h3>1. Tailscale 远程访问</h3>
            <p>远程设备加入同一个 Tailscale 网络后，使用原网站账号密码登录。局域网入口继续可用。</p>
            <p>
              {status.tailscale.message}{' '}
              {status.tailscale.ip && <code>{`http://${status.tailscale.ip}:${status.gatewayPort}`}</code>}
            </p>
            <button
              disabled={busy}
              onClick={() => void run(async () => setStatus(await api('/remote-access')))}
            >
              <RefreshCw size={14} />
              刷新检测
            </button>
            <details open={status.tailscale.state !== 'ready'}>
              <summary>首次安装与登录（在部署 Relay 的服务器执行）</summary>
              <p>
                Linux
                管理员在服务器终端执行以下命令，打开命令返回的官方授权链接完成登录，再刷新检测。网页不会代替你执行
                sudo，也不接收 Tailscale 密钥。
              </p>
              <Command>
                {
                  'curl -fsSL https://tailscale.com/install.sh -o /tmp/relay-tailscale-install.sh\nsudo sh /tmp/relay-tailscale-install.sh\nsudo tailscale up\ntailscale status'
                }
              </Command>
            </details>
          </section>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await api<RemoteStatus>('/remote-access', {
                  enabled,
                  ...(enabled && relayEnabled ? { relay } : {}),
                });
                setStatus(result);
                setMessage(
                  enabled
                    ? '已保存并应用，局域网入口保持可用。'
                    : '已关闭本项目远程入口；系统 Tailscale 及其他应用不受影响。',
                );
              });
            }}
          >
            <fieldset disabled={busy || !status.manageable}>
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.target.checked);
                    setGuide(undefined);
                    setMessage('');
                  }}
                />
                启用 Tailscale 远程访问
              </label>
              {enabled && (
                <section>
                  <h3>2. 云服务器中转（可选）</h3>
                  <p>
                    通过云服务器的 HTTPS 地址访问，访问者无需安装 Tailscale。部署 Relay
                    的服务器和云服务器仍通过 Tailscale 加密连接。
                  </p>
                  <label className="remote-toggle">
                    <input
                      type="checkbox"
                      checked={relayEnabled}
                      onChange={(e) => {
                        setRelayEnabled(e.target.checked);
                        setGuide(undefined);
                        setMessage('');
                      }}
                    />
                    使用云服务器中转
                  </label>
                  {relayEnabled && (
                    <>
                      <p>
                        本向导使用 Nginx + Certbot 管理 HTTPS
                        证书，需要已解析到云服务器的域名。先在云服务器安装并登录 Tailscale（命令同上），执行{' '}
                        <code>tailscale ip -4</code> 获取其内网地址。
                      </p>
                      <div className="remote-fields">
                        <label>
                          云服务器公网 IPv4
                          <input
                            required
                            value={relay.cloudIp}
                            placeholder="203.0.113.10"
                            onChange={(e) => field('cloudIp', e.target.value.trim())}
                          />
                        </label>
                        <label>
                          访问域名
                          <input
                            required
                            value={relay.domain}
                            placeholder="relay.example.com"
                            onChange={(e) => field('domain', e.target.value.trim().toLowerCase())}
                          />
                        </label>
                        <label>
                          HTTPS 端口
                          <input
                            required
                            type="number"
                            min={1}
                            max={65535}
                            value={relay.port || ''}
                            onChange={(e) => field('port', Number(e.target.value))}
                          />
                        </label>
                        <label>
                          云服务器 Tailscale IPv4
                          <input
                            required
                            value={relay.cloudTailscaleIp}
                            placeholder="100.64.0.2"
                            onChange={(e) => field('cloudTailscaleIp', e.target.value.trim())}
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () => setGuide(await api('/remote-access/guide', relay)))
                        }
                      >
                        生成云服务器部署步骤
                      </button>
                    </>
                  )}
                </section>
              )}
              <div className="remote-actions">
                <button className="primary" type="submit">
                  {busy ? '处理中…' : '保存并应用'}
                </button>
                <span>配置仅作用于当前 Relay 实例。</span>
              </div>
            </fieldset>
          </form>
          {guide && enabled && relayEnabled && (
            <section className="remote-guide">
              <h3>云服务器部署步骤</h3>
              <p>目标入口：{guide.origin}</p>
              {guide.steps.map((step) => (
                <div key={step.title}>
                  <h4>{step.title}</h4>
                  <p>{step.text}</p>
                  {step.code && <Command>{step.code}</Command>}
                </div>
              ))}
            </section>
          )}
          <p className="remote-note">
            局域网 HTTP 仅用于可信网络。远程访问保留网站登录；请在 Tailscale
            控制台收紧访问规则。关闭远程入口会断开远程浏览器连接，不会停止 Agent 任务。
          </p>
        </>
      )}
    </dialog>
  );
}
