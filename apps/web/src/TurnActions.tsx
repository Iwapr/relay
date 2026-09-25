import { useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, Undo2 } from 'lucide-react';
import { api, base, requestId, type Conversation, type Run } from './api';

export function TurnActions({
  connection,
  conversationId,
  turnId,
  model,
  run,
  latest,
  disabled,
  onSelect,
  onError,
}: {
  connection: string;
  conversationId: string;
  turnId?: string | null;
  model: string;
  run?: Run;
  latest?: boolean;
  disabled: boolean;
  onSelect: (conversation: Conversation, draft?: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{
    token: string;
    files: { path: string; action: string }[];
    request: string;
  } | null>(null);
  async function fork() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api(base(connection) + `/conversations/${conversationId}/fork`, { turnId, model });
      onSelect(result.conversation);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    if (busy || !run) return;
    setBusy(true);
    try {
      const result = await api(base(connection) + `/runs/${run.id}/rollback/preview`, {});
      setPlan({ ...result, request: requestId() });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (busy || !run || !plan) return;
    setBusy(true);
    try {
      const result = await api(base(connection) + `/runs/${run.id}/rollback`, {
        token: plan.token,
        clientRequestId: plan.request,
      });
      setPlan(null);
      onSelect(result.conversation, run.text);
    } catch (e) {
      onError((e as Error).message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }
  const reason =
    run?.restorePoint?.state === 'restored'
      ? '本轮已回滚'
      : (run?.restorePoint?.reason ??
        (run?.restorePoint?.state === 'preparing' ? '正在保存文件恢复点' : '旧记录没有文件恢复点'));
  return (
    <>
      <div className="turn-actions">
        {turnId && (
          <button
            disabled={disabled || busy || !model}
            onClick={() => void fork()}
            title="复制截至本轮的对话，文件保持当前状态"
          >
            <GitBranch size={14} />
            从这里分支
          </button>
        )}
        {run && latest && (
          <button
            disabled={disabled || busy || run.restorePoint?.state !== 'ready'}
            title={run.restorePoint?.state === 'ready' ? '将项目文件和对话恢复至本轮执行前' : reason}
            onClick={() => void preview()}
          >
            <Undo2 size={14} />
            {run.restorePoint?.state === 'restored' ? '已回滚' : '回滚本轮（含文件）'}
          </button>
        )}
        {run && latest && run.restorePoint?.state !== 'ready' && <small>{reason}</small>}
      </div>
      {plan &&
        createPortal(
          <div className="rollback-backdrop">
            <section
              className="rollback-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="rollback-title"
            >
              <h3 id="rollback-title">回滚本轮对话和文件</h3>
              <p>项目文件恢复到本轮开始前，对话从此前位置新建分支。原对话保留，本轮提问放回输入框。</p>
              <p>仅恢复项目工作文件，不恢复 Git 提交、项目外文件或外部服务。</p>
              <p>
                {plan.files.length ? `将处理 ${plan.files.length} 个路径：` : '本轮没有需要恢复的项目文件。'}
              </p>
              <ul>
                {plan.files.map((file) => (
                  <li key={file.path}>
                    <span>
                      {
                        ({ remove: '删除', restore: '恢复', recreate: '重建' } as Record<string, string>)[
                          file.action
                        ]
                      }
                    </span>
                    <code>{file.path}</code>
                  </li>
                ))}
              </ul>
              <div className="rollback-buttons">
                <button disabled={busy} onClick={() => setPlan(null)}>
                  取消
                </button>
                <button autoFocus disabled={busy || disabled} onClick={() => void restore()}>
                  {busy ? '正在恢复…' : '确认回滚文件和对话'}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
