import { RenameConversation } from './RenameConversation';
import { sessionHistory } from './session-history';
import { questionBody } from '../../../packages/provider-core/src/questions.ts';
import { MessageTime, UserText } from './MessageMeta';
import { useEffect, useRef, useState } from 'react';
import { Folder, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { NativeSessionSummary, NativeSessionTurn } from '../../../packages/provider-core/src/index.ts';
import { api, base, type Conversation, type Workspace, type Snapshot } from './api';
import { Markdown } from './Markdown';
import './shared-sessions.css';
import { ReplyPanel } from './ReplyPanel';
import { ToolHistory } from './ToolHistory';
import { QuestionCard } from './QuestionCard';

const sessionStateName: Record<string, string> = {
  active: '进行中',
  running: '进行中',
  idle: '空闲',
  notLoaded: '未打开',
  systemError: '状态异常',
};

export function SharedSessions({
  provider = 'codex',
  connection,
  workspaceId,
  onSelect,
  onRenamed,
  onClose,
}: {
  provider?: 'codex' | 'kimi' | 'claude' | 'antigravity' | 'deepseek';
  connection: string;
  workspaceId?: string;
  onSelect: (conversation: Conversation, workspace: Workspace) => void;
  onClose: () => void;
  onRenamed: (conversation: Conversation) => void;
}) {
  const title =
    provider === 'deepseek'
      ? 'DeepSeek（测试）会话'
      : provider === 'antigravity'
        ? 'Gemini（测试）会话'
        : provider === 'claude'
          ? 'Claude 会话'
          : provider === 'kimi'
            ? 'Kimi 会话'
            : 'Codex 会话';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sessions, setSessions] = useState<NativeSessionSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [opening, setOpening] = useState(''),
    [error, setError] = useState(''),
    [scope, setScope] = useState<'all' | 'workspace'>(workspaceId ? 'workspace' : 'all');
  const dialog = useRef<HTMLDivElement>(null),
    listRequest = useRef<AbortController | null>(null),
    importRequest = useRef<AbortController | null>(null),
    close = useRef(onClose);
  close.current = onClose;
  const endpoint =
    base(connection) +
    (provider !== 'codex' && provider !== 'antigravity'
      ? '/snapshot?view=summary'
      : workspaceId
        ? `/workspaces/${workspaceId}/native-sessions`
        : `/providers/${provider}/sessions`);

  const load = async (nextCursor?: string) => {
    listRequest.current?.abort();
    const abort = new AbortController();
    listRequest.current = abort;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams();
      if (nextCursor) query.set('cursor', nextCursor);
      if (workspaceId && scope === 'all') query.set('scope', 'all');
      const [local, native] = await Promise.allSettled([
        api<Snapshot>(base(connection) + '/snapshot?view=summary', undefined, abort.signal),
        provider !== 'codex' && provider !== 'antigravity'
          ? Promise.resolve({ sessions: [] as NativeSessionSummary[], nextCursor: null })
          : api<{ sessions: NativeSessionSummary[]; nextCursor: string | null }>(
              endpoint + (query.size ? '?' + query : ''),
              undefined,
              abort.signal,
            ),
      ]);
      if (abort.signal.aborted) return;
      if (local.status === 'fulfilled') setSnapshot(local.value);
      if (native.status === 'fulfilled') {
        setSessions((previous) => [
          ...new Map(
            [...(nextCursor ? previous : []), ...native.value.sessions].map((s) => [s.id, s]),
          ).values(),
        ]);
        setCursor(native.value.nextCursor);
      }
      const failures = [local, native].filter((result) => result.status === 'rejected');
      if (failures.length) setError(failures.map((result) => (result.reason as Error).message).join('；'));
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ) ?? [],
      );
      const first = controls[0],
        last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (!dialog.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      document.removeEventListener('keydown', trapFocus);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    setSessions([]);
    setSnapshot(null);
    setCursor(null);
    setOpening('');
    void load();
    return () => {
      listRequest.current?.abort();
      importRequest.current?.abort();
    };
  }, [endpoint, scope]);

  const history = sessionHistory(
    sessions,
    snapshot,
    provider,
    scope === 'workspace' ? workspaceId : undefined,
  );
  const open = async (threadId: string) => {
    const record = history.find((entry) => entry.id === threadId);
    if (record?.conversation && record.workspace) {
      onSelect(record.conversation, record.workspace);
      return;
    }
    if (importRequest.current && !importRequest.current.signal.aborted) return;
    const abort = new AbortController();
    importRequest.current = abort;
    setOpening(threadId);
    setError('');
    try {
      const result = await api<{ conversation: Conversation; workspace: Workspace }>(
        endpoint + '/import',
        { threadId, ...(workspaceId && scope === 'all' ? { scope: 'all' } : {}) },
        abort.signal,
      );
      if (!abort.signal.aborted) onSelect(result.conversation, result.workspace);
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (!abort.signal.aborted) {
        importRequest.current = null;
        setOpening('');
      }
    }
  };

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="modal shared-sessions"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialog}
      >
        <div className="modal-title">
          <div>
            <h2 id="shared-sessions-title">{title}</h2>
          </div>
          <button aria-label={'关闭 ' + title} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="shared-session-toolbar">
          <div className="shared-session-scopes" aria-label="会话范围">
            <button aria-pressed={scope === 'all'} disabled={!!opening} onClick={() => setScope('all')}>
              全部项目
            </button>
            {workspaceId && (
              <button
                aria-pressed={scope === 'workspace'}
                disabled={!!opening}
                onClick={() => setScope('workspace')}
              >
                当前项目
              </button>
            )}
          </div>
          <button disabled={loading || !!opening} onClick={() => void load()} aria-label={'刷新 ' + title}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} /> 刷新
          </button>
        </div>
        {provider === 'antigravity' && (
          <p className="muted">原生会话可接续；旧消息暂不能完整展示。这里只列出当前账号目录中的会话。</p>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {loading && (
          <p className="subtle" role="status">
            正在读取{title}…
          </p>
        )}
        {!loading && !error && history.length === 0 && !cursor && (
          <p className="shared-session-empty">
            {provider !== 'codex' && provider !== 'antigravity'
              ? '此范围内还没有当前账号的对话。'
              : scope === 'all'
                ? '暂时没有可访问的 Codex 会话。如需查看其他入口的会话，请确认使用同一台机器、同一系统用户和相同的 Codex 数据目录（CODEX_HOME）。'
                : '当前项目还没有会话。切换到“全部项目”查看其他项目的 Codex 历史。'}
          </p>
        )}
        {!loading && !error && history.length === 0 && cursor && (
          <p className="shared-session-empty">本页没有可访问的记录，请加载更多会话继续查看。</p>
        )}
        <ul
          className="shared-session-list"
          aria-label={scope === 'all' ? '全部项目的 ' + title : '当前文件夹的 ' + title}
        >
          {history.map((session) => (
            <li key={session.id} data-conversation-id={session.conversation?.id}>
              <div>
                <strong>{session.title || '未命名会话'}</strong>
                <div className="shared-session-project" title={session.cwd}>
                  <Folder size={12} />
                  <span>{session.cwd}</span>
                </div>
                <div className="shared-session-meta">
                  {session.status && <span>{sessionStateName[session.status] ?? session.status}</span>}
                  <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleString()}</time>
                </div>
              </div>
              <RenameConversation
                connection={connection}
                conversation={{
                  id: session.conversation?.id ?? session.id,
                  title: session.title || '未命名会话',
                }}
                disabled={!!opening || loading}
                onRename={async (title) => {
                  const record = session.conversation
                    ? { conversation: session.conversation }
                    : await api<{ conversation: Conversation }>(endpoint + '/import', {
                        threadId: session.id,
                        ...(workspaceId && scope === 'all' ? { scope: 'all' } : {}),
                      });
                  return (
                    await api<{ conversation: Conversation }>(
                      base(connection) + `/conversations/${record.conversation.id}/title`,
                      { title },
                    )
                  ).conversation;
                }}
                onSaved={(updated) => {
                  setSessions((items) =>
                    items.map((item) => (item.id === session.id ? { ...item, title: updated.title } : item)),
                  );
                  setSnapshot((current) =>
                    current
                      ? {
                          ...current,
                          conversations: [
                            ...current.conversations.filter((item) => item.id !== updated.id),
                            updated,
                          ],
                        }
                      : current,
                  );
                  onRenamed(updated);
                }}
              />
              <button
                className="shared-session-open"
                title="打开会话"
                disabled={!!opening}
                aria-label={`打开会话：${session.title || '未命名会话'}`}
                onClick={() => void open(session.id)}
              >
                {opening === session.id ? <LoaderCircle size={14} className="spin" /> : '打开'}
              </button>
            </li>
          ))}
        </ul>
        {cursor && (
          <button className="more" disabled={loading || !!opening} onClick={() => void load(cursor)}>
            加载更多会话
          </button>
        )}
      </div>
    </div>
  );
}

const historyTextLimit = 64 * 1024;
export function NativeTurn({
  turn,
  connection,
  workspaceId,
  root,
  onOpen,
  onReply,
  replyDisabled = true,
  replyKey = 'native',
}: {
  turn: NativeSessionTurn;
  provider?: 'codex' | 'kimi' | 'claude' | 'antigravity' | 'deepseek';
  connection: string;
  workspaceId?: string;
  root?: string;
  onOpen: (path: string) => void;
  onReply?: (text: string, id: string) => Promise<{ delivery: string }>;
  replyDisabled?: boolean;
  replyKey?: string;
}) {
  return (
    <div className="turn native-turn">
      {turn.userText && (
        <div className="user-message">
          <UserText text={turn.userText.slice(0, historyTextLimit)} />
          {turn.userText.length > historyTextLimit && '…（记录已截断）'}
          <MessageTime value={turn.createdAt} label="开始于" />
        </div>
      )}
      <ReplyPanel state={turn.state} shared>
        <ToolHistory
          records={turn.messages
            .slice(-100)
            .filter((m) => m.kind === 'tool')
            .map((message) => ({
              id: message.id,
              title: '工具记录',
              text: message.text.slice(0, historyTextLimit),
              truncated: message.text.length > historyTextLimit ? '记录过长，已截断显示。' : undefined,
            }))}
        />
        {turn.messages
          .slice(-100)
          .filter((m) => m.kind !== 'tool')
          .map((message) => (
            <div key={message.id} className="assistant-message markdown">
              <Markdown
                text={questionBody(message.text, message.questions).slice(0, historyTextLimit)}
                connection={connection}
                workspace={workspaceId}
                root={root}
                onOpen={onOpen}
              />
              {message.questions?.length && onReply ? (
                <QuestionCard
                  questions={message.questions}
                  storageKey={replyKey + ':' + message.id}
                  disabled={replyDisabled}
                  onReply={onReply}
                />
              ) : null}
              <MessageTime label="已接收" />
              {message.text.length > historyTextLimit && <small>记录过长，已截断显示。</small>}
            </div>
          ))}
        {turn.messages.length > 100 && <p className="subtle">此轮仅显示最近 100 条记录。</p>}
      </ReplyPanel>
    </div>
  );
}
