import { RemoteManagement } from './RemoteManagement';
import { Terminal } from './Terminal';
import { PreviewDivider } from './PreviewDivider';
import { mergeEvent } from './snapshot-events';
import { ProjectPicker } from './ProjectPicker';
import './account-management.css';
import { observeWorkbenchViewport } from './viewport';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Activity,
  BookOpen,
  ChevronDown,
  Code2,
  Layers,
  LogOut,
  MessageSquare,
  Server,
  Settings2,
  X,
  CheckCircle2,
  WifiOff,
  Folder,
  ExternalLink,
  Menu,
  TerminalSquare,
} from 'lucide-react';
import {
  api,
  ApiError,
  base,
  setCsrf,
  save,
  saved,
  stateName,
  isActive,
  type Connection,
  type Snapshot,
  type Workspace,
  type Run,
  type WorkbenchEvent,
  type Conversation,
} from './api';
import type { AccountState, ModelInfo, QuotaState } from '../../../packages/provider-core/src/index.ts';
import { Chat, InteractionCard } from './Chat';
import { sessionTasks } from './session-tasks';
import { FileBrowser, FolderPicker } from './FileBrowser';
import { Preview, type Reference } from './Preview';

function Login({ onLogin }: { onLogin: (user: any) => void }) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-screen">
      <div className="login-brand">
        <div className="brand-icon">
          <Layers size={25} />
        </div>
        <span>
          relay<span className="brand-period">.</span>
        </span>
      </div>
      <div className="login-card">
        <div className="eyebrow">YOUR REMOTE WORKBENCH</div>
        <h1>
          工作空间，
          <br />
          随你而行。
        </h1>
        <p>
          连接远端电脑，让文档、项目和 Codex
          <br />
          在一个安静的工作台里相遇。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void api('/login', { username, password })
              .then((result) => {
                setCsrf(result.csrfToken);
                onLogin(result.user);
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            账号
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="primary login-submit" disabled={busy}>
            {busy ? '正在登录…' : '进入工作台'}
            <ArrowRight size={17} />
          </button>
        </form>
        <div className="login-note">
          <span className="status-dot" />
          你的服务器 · 你的项目 · 你的工作节奏
        </div>
      </div>
      <div className="login-copyright">Relay / 自托管远程工作台</div>
    </main>
  );
}
export default function App() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [user, setUser] = useState<any>(null),
    [checking, setChecking] = useState(true),
    [connections, setConnections] = useState<Connection[]>([]),
    [connection, setConnection] = useState(''),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [workspaceId, setWorkspaceId] = useState(''),
    [chatOpenVersion, setChatOpenVersion] = useState(0),
    [online, setOnline] = useState(false),
    [error, setError] = useState(''),
    [folderOpen, setFolderOpen] = useState(false),
    [projectOpen, setProjectOpen] = useState(false),
    [navigationOpen, setNavigationOpen] = useState(false),
    [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false),
    [remoteManagementOpen, setRemoteManagementOpen] = useState(false),
    [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null),
    [accountOpen, setAccountOpen] = useState(false),
    [accountTab, setAccountTab] = useState<'ai' | 'server'>('ai'),
    [deleteConfirm, setDeleteConfirm] = useState(false),
    [accountError, setAccountError] = useState(''),
    [newAccountLabel, setNewAccountLabel] = useState(''),
    [newAccountProvider, setNewAccountProvider] = useState<'codex' | 'kimi' | 'claude'>('codex'),
    [accountBusy, setAccountBusy] = useState(false),
    [account, setAccount] = useState<AccountState | null>(null),
    [models, setModels] = useState<ModelInfo[]>([]),
    [quota, setQuota] = useState<QuotaState | null>(null),
    [tab, setTab] = useState('chat'),
    [file, setFile] = useState(''),
    [revisions, setRevisions] = useState<Record<string, number>>({}),
    [references, setReferences] = useState<Reference[]>([]),
    [refresh, setRefresh] = useState(0),
    [diagnostics, setDiagnostics] = useState<any>(null),
    [loginChallenge, setLoginChallenge] = useState<any>(null),
    [tasks, setTasks] = useState<{ connection: Connection; snapshot: Snapshot | null; online: boolean }[]>(
      [],
    );
  const savedSnapshots = useRef(new Map<string, Snapshot>()),
    connectionRef = useRef(connection),
    loadedConnection = useRef(''),
    pendingAccountThread = useRef<{ connection: string; threadId?: string; path?: string } | null>(null),
    navigationControl = useRef<HTMLDivElement>(null),
    workspaceControl = useRef<HTMLDivElement>(null),
    accountOpenRef = useRef(accountOpen);
  const selectedProvider = connections.find((c) => c.id === connection)?.provider ?? 'codex';
  const providerName =
    selectedProvider === 'claude' ? 'Claude' : selectedProvider === 'kimi' ? 'Kimi Code' : 'ChatGPT';
  const providerAuthenticated =
    account?.authenticated &&
    account.authMode ===
      (selectedProvider === 'claude' ? 'claude-code' : selectedProvider === 'kimi' ? 'kimi-code' : 'chatgpt');
  const accountReady = online && providerAuthenticated;
  const accountStatus = !online
    ? '连接不可用'
    : !account
      ? '账号状态未确认'
      : providerAuthenticated
        ? providerName + ' 已登录'
        : '账号未登录';
  const openAccountManagement = () => {
    setAccountTab('ai');
    setAccountError('');
    setDeleteConfirm(false);
    setAccountOpen(true);
  };
  const accountDialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!accountOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    accountDialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setAccountOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(accountDialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]',
        ) ?? []),
      ].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = controls[0],
        last = controls.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === accountDialog.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      previous?.focus();
    };
  }, [accountOpen]);
  accountOpenRef.current = accountOpen;
  connectionRef.current = connection;
  useEffect(observeWorkbenchViewport, []);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!navigationControl.current?.contains(event.target as Node)) setNavigationOpen(false);
      if (!workspaceControl.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (navigationOpen) navigationControl.current?.querySelector('button')?.focus();
      setNavigationOpen(false);
      if (workspaceMenuOpen) workspaceControl.current?.querySelector('button')?.focus();
      setWorkspaceMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [navigationOpen, workspaceMenuOpen]);
  useEffect(() => {
    void api('/me')
      .then((result) => {
        setCsrf(result.csrfToken);
        setUser(result.user);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    void api('/connections')
      .then(async (result: { connections: Connection[] }) => {
        const groups = await Promise.all(
          result.connections.map(async (root) => {
            const original = { ...root, provider: 'codex' as const, accountLabel: '跟随 Codex' };
            try {
              const { accounts } = await api<{
                accounts: Array<{
                  id: string;
                  label: string;
                  provider?: 'codex' | 'kimi' | 'claude';
                  account?: AccountState;
                }>;
              }>(base(root.id) + '/providers/codex/accounts');
              return accounts.map((profile): Connection =>
                profile.id === 'default'
                  ? { ...original, accountIdentifier: profile.account?.identifier }
                  : {
                      ...root,
                      id: root.id + '~' + profile.id,
                      parentId: root.id,
                      label: root.label + ' / ' + profile.label,
                      accountLabel: profile.label,
                      provider: profile.provider ?? 'codex',
                      accountIdentifier: profile.account?.identifier,
                    },
              );
            } catch {
              return [original];
            }
          }),
        );
        const available = groups.flat();
        setConnections(available);
        setConnection((current) => {
          const preferred = current || saved('connection', '');
          return available.some((c) => c.id === preferred) ? preferred : (available[0]?.id ?? '');
        });
      })
      .catch((e) => setError(e.message));
  }, [user]);
  const refreshSnapshot = useCallback(() => {
    const c = connection;
    void api<Snapshot>(base(c) + '/snapshot?view=summary')
      .then((s) => {
        if (connectionRef.current === c) {
          setSnapshot((old) =>
            old && old.identity.agentId === s.identity.agentId && old.seq > s.seq
              ? old
              : { ...s, messages: old?.identity.agentId === s.identity.agentId ? old.messages : [] },
          );
          savedSnapshots.current.set(c, s);
        }
      })
      .catch((e) => setError(e.message));
  }, [connection]);
  useEffect(() => {
    if (projectOpen && connection) refreshSnapshot();
  }, [projectOpen, connection, refreshSnapshot]);
  useEffect(() => {
    if (!connection || !user) return;
    let disposed = false;
    const abort = new AbortController();
    let events: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const reconnect = () => {
      if (disposed || reconnectTimer) return;
      events?.close();
      reconnectTimer = setTimeout(() => {
        if (!disposed) setRefresh((r) => r + 1);
      }, 2000);
    };
    let batch: WorkbenchEvent[] = [];
    setOnline(false);
    setAccount(null);
    setQuota(null);
    setModels([]);
    setError('');
    if (loadedConnection.current !== connection) {
      loadedConnection.current = connection;
      setSnapshot(savedSnapshots.current.get(connection) ?? null);
      setWorkspaceId(saved(connection + ':workspace', ''));
    }
    let accountLoading = false;
    let lastAccountLoad = 0;
    const loadAccount = () => {
      if (accountLoading || disposed) return;
      accountLoading = true;
      lastAccountLoad = Date.now();
      void Promise.allSettled([
        api<AccountState>(
          base(connection) + `/providers/${selectedProvider}/account`,
          undefined,
          abort.signal,
        ),
        api<{ models: ModelInfo[] }>(
          base(connection) + `/providers/${selectedProvider}/models`,
          undefined,
          abort.signal,
        ),
        api<{ quota: QuotaState | null }>(
          base(connection) + `/providers/${selectedProvider}/quota`,
          undefined,
          abort.signal,
        ),
      ])
        .then((results) => {
          if (disposed) return;
          const [a, m, q] = results;
          if (a.status === 'fulfilled') {
            setAccount(a.value);
            setConnections((items) =>
              items.some((c) => c.id === connection && c.accountIdentifier !== a.value.identifier)
                ? items.map((c) =>
                    c.id === connection ? { ...c, accountIdentifier: a.value.identifier } : c,
                  )
                : items,
            );
            if (
              a.value.authenticated &&
              a.value.authMode ===
                (selectedProvider === 'claude'
                  ? 'claude-code'
                  : selectedProvider === 'kimi'
                    ? 'kimi-code'
                    : 'chatgpt')
            )
              setLoginChallenge((current: any) => (current?.connectionId === connection ? null : current));
          }
          if (a.status === 'rejected') {
            setAccount(null);
            setConnections((items) =>
              items.map((c) => (c.id === connection ? { ...c, accountIdentifier: null } : c)),
            );
          }
          setModels(m.status === 'fulfilled' ? m.value.models : []);
          setQuota(
            a.status === 'fulfilled' && a.value.authenticated && q.status === 'fulfilled'
              ? q.value.quota
              : null,
          );
        })
        .finally(() => {
          accountLoading = false;
        });
    };
    void Promise.resolve()
      .then(async () => {
        const pending = pendingAccountThread.current;
        if (pending?.connection === connection) {
          try {
            if (pending.threadId) {
              const result = await api<{ conversation: Conversation; workspace: Workspace }>(
                base(connection) + '/providers/codex/sessions/import',
                { threadId: pending.threadId },
                abort.signal,
              );
              if (disposed) return;
              save(connection + ':workspace', result.workspace.id);
              save(connection + ':' + result.workspace.id + ':conversation', result.conversation.id);
              setWorkspaceId(result.workspace.id);
            } else if (pending.path) {
              const result = await api<{ workspace: Workspace }>(
                base(connection) + '/workspaces/open',
                { path: pending.path },
                abort.signal,
              );
              if (disposed) return;
              save(connection + ':workspace', result.workspace.id);
              setWorkspaceId(result.workspace.id);
            }
          } catch (e) {
            if (!disposed) setError('账号已切换，当前对话未能打开：' + (e as Error).message);
          }
          if (!disposed) pendingAccountThread.current = null;
        }
        return api<Snapshot>(base(connection) + '/snapshot?view=summary', undefined, abort.signal);
      })
      .then((s) => {
        if (disposed || !s) return;
        setSnapshot((old) => ({
          ...s,
          messages: old?.identity.agentId === s.identity.agentId ? old.messages : [],
        }));
        savedSnapshots.current.set(connection, s);
        setOnline(true);
        setRevisions((old) => {
          const next = { ...old };
          for (const w of s.workspaces) next[w.id] = (next[w.id] ?? 0) + 1;
          return next;
        });
        setWorkspaceId((id) =>
          s.workspaces.some((w) => w.id === id) ? id : (s.workspaces.at(-1)?.id ?? ''),
        );
        loadAccount();
        events = new EventSource(
          '/api' +
            base(connection) +
            '/events?' +
            new URLSearchParams({ afterSeq: String(s.seq), agentId: s.identity.agentId }),
        );
        events.onopen = () => {
          if (!disposed) {
            setOnline(true);
          }
        };
        events.onerror = () => {
          if (!disposed) {
            setOnline(false);
            reconnect();
          }
        };
        events.onmessage = (e) => {
          try {
            const event: WorkbenchEvent = JSON.parse(e.data);
            batch.push(event);
            if (timer) return;
            timer = setTimeout(() => {
              const incoming = batch;
              batch = [];
              timer = undefined;
              if (disposed) return;
              setSnapshot((current) => {
                if (!current) return current;
                const updated = incoming.reduce(mergeEvent, current);
                savedSnapshots.current.set(connection, updated);
                return updated;
              });
              for (const event of incoming) {
                if (event.type === 'files.changed' && event.workspaceId)
                  setRevisions((r) => ({ ...r, [event.workspaceId!]: (r[event.workspaceId!] ?? 0) + 1 }));
                if (event.type === 'account.updated' || event.type === 'quota.updated') loadAccount();
                if (event.type === 'account.updated' && event.payload.loginCompleted) {
                  setLoginChallenge((current: any) =>
                    current?.connectionId === connection ? null : current,
                  );
                  if (event.payload.success === false) setError(providerName + ' 授权未完成，请重新登录');
                }
              }
            }, 80);
          } catch {
            setError('事件数据无效，请重新连接');
          }
        };
      })
      .catch((e) => {
        if (!disposed) {
          setOnline(false);
          setError(e.message);
          reconnect();
        }
      });
    const refreshVisibleState = () => {
      if (document.visibilityState !== 'visible') return;
      loadAccount();
      refreshSnapshot();
    };
    const accountPoll = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        (accountOpenRef.current || Date.now() - lastAccountLoad >= 15_000)
      )
        loadAccount();
    }, 5000);
    window.addEventListener('focus', refreshVisibleState);
    document.addEventListener('visibilitychange', refreshVisibleState);
    return () => {
      window.removeEventListener('focus', refreshVisibleState);
      document.removeEventListener('visibilitychange', refreshVisibleState);
      clearInterval(accountPoll);
      disposed = true;
      abort.abort();
      events?.close();
      clearTimeout(timer);
      clearTimeout(reconnectTimer);
    };
  }, [connection, user, refresh, selectedProvider, refreshSnapshot]);
  const workspace = snapshot?.workspaces.find((w) => w.id === workspaceId);
  useEffect(() => {
    if (!connection || !workspace?.id) return;
    const key = connection + ':project-visits';
    save(key, { ...saved<Record<string, number>>(key, {}), [workspace.id]: Date.now() });
  }, [connection, workspace?.id]);
  useEffect(() => {
    const key = connection + ':' + workspaceId;
    setFile(saved(key + ':file', ''));
    setReferences(saved<Reference[]>(key + ':references', []));
  }, [connection, workspaceId]);
  const selectWorkspace = (w: Workspace) => {
    setSnapshot((s) => s && { ...s, workspaces: [...s.workspaces.filter((item) => item.id !== w.id), w] });
    setWorkspaceId(w.id);
    save(connection + ':workspace', w.id);
    refreshSnapshot();
  };
  const selectNativeSession = (w: Workspace, conversation: Conversation) => {
    save(connection + ':workspace', w.id);
    save(connection + ':' + w.id + ':conversation', conversation.id);
    setSnapshot(
      (s) =>
        s && {
          ...s,
          workspaces: [...s.workspaces.filter((item) => item.id !== w.id), w],
          conversations: [...s.conversations.filter((item) => item.id !== conversation.id), conversation],
        },
    );
    setWorkspaceId(w.id);
    setTab('chat');
    refreshSnapshot();
  };
  const openFile = (path: string) => {
    setFile(path);
    save(connection + ':' + workspaceId + ':file', path);
    setTab('preview');
  };
  const updateReferences = (r: Reference[]) => {
    setReferences(r);
    save(connection + ':' + workspaceId + ':references', r);
  };
  useEffect(() => {
    if (tab !== 'tasks' || !user) return;
    let dead = false;
    const load = () =>
      void Promise.all(
        connections.map(async (c) => {
          try {
            const s = await api<Snapshot>(base(c.id) + '/snapshot?view=summary');
            savedSnapshots.current.set(c.id, s);
            return { connection: c, snapshot: s, online: true };
          } catch {
            return { connection: c, snapshot: savedSnapshots.current.get(c.id) ?? null, online: false };
          }
        }),
      ).then((result) => {
        if (!dead) setTasks(result);
      });
    load();
    const t = setInterval(load, 6000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [tab, connections, user]);
  const switchAccount = (
    id: string,
    targetProvider = connections.find((c) => c.id === id)?.provider ?? 'codex',
  ) => {
    if (id === connection) return;
    setDeleteConfirm(false);
    setAccountError('');
    if (id.split('~')[0] === connection.split('~')[0]) {
      const selectedId = saved(connection + ':' + workspaceId + ':conversation', '');
      const selected = snapshot?.conversations.find((c) => c.id === selectedId);
      const workspace = snapshot?.workspaces.find((w) => w.id === workspaceId);
      pendingAccountThread.current = {
        connection: id,
        threadId:
          selectedProvider === 'codex' && targetProvider === 'codex'
            ? (selected?.providerSessionId ?? undefined)
            : undefined,
        path: workspace?.canonicalRoot,
      };
    } else pendingAccountThread.current = null;
    setOnline(false);
    setAccount(null);
    setModels([]);
    setQuota(null);
    setDiagnostics(null);
    setFolderOpen(false);
    setProjectOpen(false);
    setConnection(id);
    save('connection', id);
  };
  const rootId = connection.split('~')[0];
  const serverConnections = connections.filter((c) => !c.parentId);
  const accountConnections = connections.filter((c) => c.id === rootId || c.parentId === rootId);
  const accountPicker = (label: string) => (
    <label className="connection-switch account-switch">
      <span>AI 账号</span>
      <select
        disabled={accountBusy}
        aria-label={label}
        value={connection}
        onChange={(e) => switchAccount(e.target.value)}
      >
        {accountConnections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.accountLabel ?? '跟随 Codex'}
          </option>
        ))}
      </select>
    </label>
  );
  const addAccount = async () => {
    if (!newAccountLabel.trim() || accountBusy) return;
    const root = connections.find((c) => c.id === rootId);
    if (!root) return;
    setAccountBusy(true);
    setAccountError('');
    try {
      const result = await api<{
        account: { id: string; label: string; provider: 'codex' | 'kimi' | 'claude' };
      }>(base(rootId) + '/providers/codex/accounts', {
        label: newAccountLabel,
        provider: newAccountProvider,
      });
      const next: Connection = {
        ...root,
        id: rootId + '~' + result.account.id,
        parentId: rootId,
        label: root.label + ' / ' + result.account.label,
        accountLabel: result.account.label,
        provider: result.account.provider,
        accountIdentifier: null,
      };
      setConnections((items) => [...items, next]);
      setNewAccountLabel('');
      switchAccount(next.id, next.provider);
    } catch (e) {
      setAccountError((e as Error).message);
    } finally {
      setAccountBusy(false);
    }
  };
  const deleteAccount = async () => {
    if (accountBusy || !connection.includes('~')) return;
    const target = connection;
    const [parent, id] = target.split('~');
    setAccountBusy(true);
    setAccountError('');
    try {
      await api(base(parent) + '/providers/codex/accounts/' + id + '/delete', {});
      savedSnapshots.current.delete(target);
      try {
        for (const storage of [localStorage, sessionStorage]) {
          for (const key of Object.keys(storage))
            if (key.startsWith('relay:' + target + ':')) storage.removeItem(key);
        }
      } catch {
        /* Browser storage may be disabled; server deletion already succeeded. */
      }
      setTasks((items) => items.filter((item) => item.connection.id !== target));
      setConnections((items) => items.filter((item) => item.id !== target));
      setLoginChallenge((current: any) => (current?.connectionId === target ? null : current));
      pendingAccountThread.current = null;
      setConnection(parent);
      save('connection', parent);
      setOnline(false);
      setAccount(null);
      setModels([]);
      setQuota(null);
      setDeleteConfirm(false);
    } catch (e) {
      setAccountError((e as Error).message);
    } finally {
      setAccountBusy(false);
    }
  };
  if (checking)
    return (
      <div className="loading-screen">
        <Layers size={32} />
        <span>正在打开工作台…</span>
      </div>
    );
  if (!user) return <Login onLogin={setUser} />;
  const currentConnection = connections.find((c) => c.id === connection),
    activeCount = new Set(snapshot?.runs.filter((r) => isActive(r.state)).map((r) => r.conversationId)).size;
  return (
    <div className={'workbench mobile-' + tab}>
      <header className="topbar" aria-label="工作台工具栏">
        <div className="topbar-leading">
          <div className="navigation-control" ref={navigationControl}>
            <button
              className="view-menu-trigger"
              aria-label="切换视图"
              aria-expanded={navigationOpen}
              aria-controls="workspace-navigation"
              onClick={() => setNavigationOpen((open) => !open)}
              title={tab === 'chat' ? '对话' : tab === 'files' ? '文件' : tab === 'preview' ? '预览' : '任务'}
            >
              {tab === 'chat' ? (
                <MessageSquare size={19} />
              ) : tab === 'files' ? (
                <Folder size={19} />
              ) : tab === 'preview' ? (
                <BookOpen size={19} />
              ) : (
                <Activity size={19} />
              )}
              <ChevronDown size={10} />
            </button>
            <nav
              id="workspace-navigation"
              className={'mobile-nav workspace-nav ' + (navigationOpen ? 'is-open' : '')}
              aria-label="工作台视图"
            >
              {[
                ['chat', MessageSquare, '对话'],
                ['files', Folder, '文件'],
                ['preview', BookOpen, '预览'],
                ['tasks', Activity, '任务'],
              ].map(([id, Icon, label]) => {
                const I = Icon as typeof MessageSquare;
                return (
                  <button
                    key={id as string}
                    className={(tab === id ? 'active ' : '') + (id === 'files' ? 'files-view-button' : '')}
                    aria-label={label as string}
                    aria-current={tab === id ? 'page' : undefined}
                    title={label as string}
                    onClick={() => {
                      setTab(id as string);
                      setNavigationOpen(false);
                    }}
                  >
                    <I size={17} />
                    <span>{label as string}</span>
                    {id === 'tasks' && activeCount > 0 && (
                      <span className="count task-count" aria-label={`${activeCount} 个进行中的任务`}>
                        {activeCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>
          <button
            className="project-switch"
            aria-label="当前项目"
            title={workspace?.canonicalRoot ?? '打开远程文件夹'}
            onClick={() => setProjectOpen(true)}
          >
            <span>{workspace?.canonicalRoot.split('/').pop() || '打开项目'}</span>
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="chat-toolbar-slot" ref={setToolbarTarget} />
        <div className="current-view-title">
          {tab === 'files'
            ? workspace?.canonicalRoot.split('/').pop() || '项目文件'
            : tab === 'preview'
              ? file.split('/').pop() || '文档预览'
              : '任务'}
        </div>
        <div className="workspace-controls" ref={workspaceControl}>
          <button
            className="workspace-menu-trigger"
            aria-label="工作区菜单"
            title="项目、连接与账号"
            aria-expanded={workspaceMenuOpen}
            aria-controls="workspace-menu"
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
          >
            <Menu size={19} />
            <span
              className={'status-dot ' + (accountReady ? '' : 'unknown')}
              role="img"
              aria-label={accountStatus}
              title={accountStatus}
            />
          </button>
          {workspaceMenuOpen && (
            <div id="workspace-menu" className="workspace-menu">
              <button
                aria-label="打开终端"
                disabled={!workspace || !online}
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  workspaceControl.current
                    ?.querySelector<HTMLButtonElement>('.workspace-menu-trigger')
                    ?.focus();
                  setTerminalOpen(true);
                }}
              >
                <TerminalSquare size={17} />
                终端
              </button>
              {serverConnections.length > 1 && (
                <label className="connection-switch">
                  <span>服务器与用户</span>
                  <select
                    aria-label="服务器和 Linux 用户"
                    value={rootId}
                    onChange={(e) => switchAccount(e.target.value)}
                  >
                    {serverConnections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} · {c.username}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {accountPicker('切换 AI 账号')}
              <button
                aria-label="账号管理"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  openAccountManagement();
                  void api(base(connection) + '/status')
                    .then(setDiagnostics)
                    .catch((e) => setError(e.message));
                }}
              >
                <Settings2 size={17} />
                账号管理
              </button>
              <button
                aria-label="远程管理"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  workspaceControl.current
                    ?.querySelector<HTMLButtonElement>('.workspace-menu-trigger')
                    ?.focus();
                  setRemoteManagementOpen(true);
                }}
              >
                <Server size={17} />
                远程管理
              </button>
              <div className="connection-summary">
                <span className={'status-dot ' + (accountReady ? '' : 'unknown')} aria-hidden="true" />
                {selectedProvider === 'claude'
                  ? 'Claude'
                  : selectedProvider === 'kimi'
                    ? 'Kimi Code'
                    : 'Codex'}{' '}
                · {accountStatus}
              </div>
            </div>
          )}
        </div>
      </header>
      {remoteManagementOpen && <RemoteManagement onClose={() => setRemoteManagementOpen(false)} />}
      {error && (
        <div className="global-error" role="alert">
          <WifiOff size={15} />
          <span>{error}</span>
          <button onClick={() => setRefresh((r) => r + 1)}>重新连接</button>
          <button aria-label="关闭提示" onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {connections.length === 0 ? (
        <div className="empty-state">
          <Server size={32} />
          <h2>添加你的第一台服务器</h2>
          <p>请在网关配置中预置经过验证的 SSH 连接，然后重启网关。</p>
        </div>
      ) : (
        <>
          {tab === 'tasks' && (
            <main className="tasks-page">
              <div className="page-title">
                <h1>任务</h1>
              </div>
              {tasks.map((t) => (
                <section className="task-group" key={t.connection.id}>
                  <h3>
                    <Server size={16} />
                    {t.connection.label} · {t.connection.username}
                    <span className={'status-dot ' + (t.online ? '' : 'unknown')} />
                    <small>{t.online ? '实时连接' : '最后已知状态'}</small>
                  </h3>
                  {sessionTasks(t.snapshot)
                    .slice(0, 50)
                    .map((session) => (
                      <div
                        className="task-card"
                        key={session.conversation.id}
                        data-session-id={session.conversation.id}
                      >
                        <div className="task-line">
                          <div>
                            <strong>{session.title}</strong>
                            <p className="task-session-project">{session.project ?? '项目不可用'}</p>
                            {session.latest && <p className="task-session-summary">{session.latest.text}</p>}
                            <p>{new Date(session.updatedAt).toLocaleString()}</p>
                          </div>
                          <span className={'run-status ' + (session.statusRun?.state ?? '')}>
                            {session.statusRun
                              ? stateName[session.statusRun.state]
                              : session.conversation.providerSessionId
                                ? '已同步'
                                : '未开始'}
                          </span>
                          <button
                            onClick={() => {
                              setConnection(t.connection.id);
                              setWorkspaceId(session.conversation.workspaceId);
                              save(t.connection.id + ':workspace', session.conversation.workspaceId);
                              save(
                                t.connection.id + ':' + session.conversation.workspaceId + ':conversation',
                                session.conversation.id,
                              );
                              // Chat stays mounted behind the task page. Reopen it with the
                              // explicitly saved selection even when the project has not changed.
                              if (t.connection.id !== connection) {
                                if (t.snapshot) setSnapshot(t.snapshot);
                              } else {
                                setSnapshot((current) =>
                                  current
                                    ? {
                                        ...current,
                                        workspaces: [
                                          ...new Map(
                                            [...(t.snapshot?.workspaces ?? []), ...current.workspaces].map(
                                              (w) => [w.id, w],
                                            ),
                                          ).values(),
                                        ],
                                        conversations: [
                                          ...new Map(
                                            [session.conversation, ...current.conversations].map((c) => [
                                              c.id,
                                              c,
                                            ]),
                                          ).values(),
                                        ],
                                      }
                                    : t.snapshot,
                                );
                              }
                              setChatOpenVersion((version) => version + 1);
                              setTab('chat');
                            }}
                          >
                            打开
                          </button>
                        </div>
                        {session.pending.map((i) => (
                          <InteractionCard
                            key={i.id}
                            connection={t.connection.id}
                            interaction={i}
                            onError={setError}
                          />
                        ))}
                      </div>
                    ))}
                  {!t.snapshot?.conversations.length && <p className="muted">暂无会话</p>}
                </section>
              ))}
            </main>
          )}
          <main
            style={tab === 'tasks' ? { display: 'none' } : undefined}
            className={'workspace-grid ' + (tab === 'preview' ? 'preview-active' : '')}
          >
            <FileBrowser
              connection={connection}
              workspace={workspace}
              selected={file}
              onOpen={openFile}
              onFolder={() => setFolderOpen(true)}
              revision={revisions[workspaceId] ?? 0}
            />
            <Chat
              provider={selectedProvider}
              key={'chat:' + connection + ':' + workspaceId + ':' + chatOpenVersion}
              connection={connection}
              workspace={workspace}
              conversations={snapshot?.conversations.filter((c) => c.workspaceId === workspaceId) ?? []}
              runs={snapshot?.runs.filter((r) => r.workspaceId === workspaceId) ?? []}
              messages={snapshot?.messages ?? []}
              interactions={snapshot?.interactions ?? []}
              models={models}
              account={account}
              online={online}
              references={references}
              setReferences={updateReferences}
              onRefresh={refreshSnapshot}
              onOpen={openFile}
              toolbarTarget={toolbarTarget}
              onShowChat={() => setTab('chat')}
              onSelectNativeSession={selectNativeSession}
            />
            <PreviewDivider />
            <Preview
              key={'preview:' + connection + ':' + workspaceId}
              connection={connection}
              workspace={workspaceId}
              root={workspace?.canonicalRoot}
              path={file}
              revision={revisions[workspaceId] ?? 0}
              onOpen={openFile}
            />
          </main>
        </>
      )}
      {terminalOpen && workspace && (
        <Terminal
          key={connection + ':' + workspace.id}
          connection={connection}
          workspace={workspace.id}
          root={workspace.canonicalRoot}
          onClose={() => setTerminalOpen(false)}
        />
      )}
      {projectOpen && (
        <ProjectPicker
          key={connection}
          connection={connection}
          accountConnections={accountConnections.map((item) => item.id)}
          projects={snapshot?.workspaces ?? []}
          currentId={workspaceId}
          runs={snapshot?.runs ?? []}
          online={online}
          onClose={() => setProjectOpen(false)}
          onSelect={async (selected) => {
            const targetConnection = connection;
            let local = snapshot?.workspaces.find((item) => item.canonicalRoot === selected.canonicalRoot);
            if (!local) {
              const result = await api<{ workspace: Workspace }>(base(connection) + '/workspaces/open', {
                path: selected.canonicalRoot,
              });
              local = result.workspace;
            }
            if (connectionRef.current !== targetConnection) return;
            selectWorkspace(local);
            setProjectOpen(false);
            setTab('chat');
          }}
          onAdd={() => {
            setProjectOpen(false);
            setTab('chat');
            setFolderOpen(true);
          }}
        />
      )}
      {folderOpen && (
        <FolderPicker
          connection={connection}
          recent={snapshot?.workspaces ?? []}
          currentWorkspace={workspace}
          onClose={() => setFolderOpen(false)}
          onSelect={selectWorkspace}
        />
      )}{' '}
      {accountOpen && (
        <div className="modal-backdrop">
          <section
            className="modal account-modal"
            ref={accountDialog}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
          >
            <div className="modal-title">
              <div>
                <h2 id="account-title">账号管理</h2>
                <p>管理模型账号，查看服务器连接与远端身份</p>
              </div>
              <button aria-label="关闭" onClick={() => setAccountOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <div
              className="account-tabs"
              role="tablist"
              aria-label="账号管理分类"
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const next =
                  e.key === 'Home'
                    ? 'ai'
                    : e.key === 'End'
                      ? 'server'
                      : accountTab === 'ai'
                        ? 'server'
                        : 'ai';
                setAccountTab(next);
                e.currentTarget
                  .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next === 'ai' ? 0 : 1]?.focus();
              }}
            >
              <button
                id="ai-accounts-tab"
                role="tab"
                tabIndex={accountTab === 'ai' ? 0 : -1}
                aria-selected={accountTab === 'ai'}
                aria-controls="ai-accounts-panel"
                onClick={() => setAccountTab('ai')}
              >
                AI 账号 <span>{accountConnections.length}</span>
              </button>
              <button
                id="server-identity-tab"
                role="tab"
                tabIndex={accountTab === 'server' ? 0 : -1}
                aria-selected={accountTab === 'server'}
                aria-controls="server-identity-panel"
                onClick={() => setAccountTab('server')}
              >
                服务器身份
              </button>
            </div>
            {accountError && (
              <div className="error account-error" role="alert">
                {accountError}
              </div>
            )}
            {accountTab === 'ai' ? (
              <div
                id="ai-accounts-panel"
                role="tabpanel"
                aria-labelledby="ai-accounts-tab"
                className="account-ai-layout"
              >
                <aside className="account-catalog">
                  <div className="account-section-heading">
                    <h3>我的 AI 账号</h3>
                    <small>选择账号以管理登录和额度</small>
                  </div>
                  <div className="account-profile-list">
                    {accountConnections.map((c) => (
                      <button
                        key={c.id}
                        className={'account-profile-card' + (c.id === connection ? ' selected' : '')}
                        aria-pressed={c.id === connection}
                        disabled={accountBusy}
                        onClick={() => switchAccount(c.id)}
                      >
                        <span className={'account-provider-icon ' + (c.provider ?? 'codex')}>
                          {c.provider === 'claude' ? 'C' : c.provider === 'kimi' ? 'K' : '✳'}
                        </span>
                        <span className="account-profile-text">
                          <strong>{c.accountLabel ?? '跟随 Codex'}</strong>
                          <small>
                            {c.provider === 'claude'
                              ? 'Claude'
                              : c.provider === 'kimi'
                                ? 'Kimi Code'
                                : 'ChatGPT'}
                            {c.accountIdentifier ? ' · ' + c.accountIdentifier : ''}
                          </small>
                        </span>
                        {c.id === connection && <CheckCircle2 size={16} />}
                      </button>
                    ))}
                  </div>
                  <details className="account-create" open>
                    <summary>添加 AI 账号</summary>
                    <form
                      className="account-add"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void addAccount();
                      }}
                    >
                      <select
                        aria-label="新账号类型"
                        value={newAccountProvider}
                        onChange={(e) => setNewAccountProvider(e.target.value as 'codex' | 'kimi' | 'claude')}
                      >
                        <option value="codex">ChatGPT</option>
                        <option value="kimi">Kimi Code</option>
                        <option value="claude">Claude</option>
                      </select>
                      <input
                        aria-label="新账号名称"
                        placeholder="账号名称，例如：工作账号"
                        maxLength={60}
                        value={newAccountLabel}
                        onChange={(e) => setNewAccountLabel(e.target.value)}
                      />
                      <button type="submit" disabled={accountBusy || !newAccountLabel.trim()}>
                        {accountBusy ? '正在添加…' : '添加账号'}
                      </button>
                    </form>
                    <p className="account-help">ChatGPT、Kimi Code 与 Claude 各可添加 8 个独立账号。</p>
                  </details>
                </aside>
                <div className="account-detail">
                  <div className="account-section">
                    <div className="account-detail-heading">
                      <div>
                        <span className="account-eyebrow">{providerName}</span>
                        <h3>{currentConnection?.accountLabel ?? '跟随 Codex'}</h3>
                      </div>
                      <span className={'account-auth-badge' + (providerAuthenticated ? ' ready' : '')}>
                        {providerAuthenticated ? '已登录' : '待登录'}
                      </span>
                    </div>
                    {accountPicker('当前 AI 账号')}
                    <p className="account-help">
                      {selectedProvider !== 'codex'
                        ? '授权与会话按账号独立保存。切换账号后，已提交任务仍由原账号执行。'
                        : 'ChatGPT 账号共享 Codex 历史。“跟随 Codex”使用远端当前登录；其他账号独立授权。'}
                    </p>
                    <dl>
                      <dt>认证方式</dt>
                      <dd>{account?.authMode ?? '未知'}</dd>
                      <dt>账号</dt>
                      <dd>{account?.identifier ?? '暂无数据'}</dd>
                      <dt>订阅</dt>
                      <dd>{account?.planType ?? '暂无数据'}</dd>
                    </dl>
                    {!providerAuthenticated && loginChallenge?.connectionId !== connection && (
                      <button
                        className="primary"
                        disabled={!online || accountBusy}
                        onClick={() => {
                          setAccountBusy(true);
                          const target = connection;
                          void api(base(target) + `/providers/${selectedProvider}/login`, {})
                            .then((challenge) => setLoginChallenge({ ...challenge, connectionId: target }))
                            .catch((e) => setAccountError(e.message))
                            .finally(() => setAccountBusy(false));
                        }}
                      >
                        {selectedProvider === 'claude'
                          ? '登录 Claude 订阅账号'
                          : `通过设备码登录 ${providerName}`}
                      </button>
                    )}
                    {loginChallenge?.connectionId === connection && (
                      <div className="login-challenge">
                        <a href={loginChallenge.verificationUrl} target="_blank" rel="noreferrer">
                          打开官方授权页 <ExternalLink size={13} />
                        </a>
                        {loginChallenge.codeRequired ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const form = e.currentTarget;
                              const code = String(new FormData(form).get('code') ?? '').trim();
                              if (!code || accountBusy) return;
                              setAccountBusy(true);
                              setAccountError('');
                              void api(base(connection) + '/providers/claude/login/code', {
                                code,
                                loginId: loginChallenge.loginId,
                              })
                                .then(() => {
                                  form.reset();
                                  setLoginChallenge((current: any) =>
                                    current ? { ...current, submitted: true } : current,
                                  );
                                })
                                .catch((e) => setAccountError(e.message))
                                .finally(() => setAccountBusy(false));
                            }}
                          >
                            <p>在官方页面登录订阅账号。如果页面显示授权码，请粘贴到这里完成登录。</p>
                            <label>
                              Claude 授权码
                              <input
                                name="code"
                                type="password"
                                autoComplete="off"
                                maxLength={4096}
                                required
                                disabled={accountBusy || loginChallenge.submitted}
                              />
                            </label>
                            <button type="submit" disabled={accountBusy || loginChallenge.submitted}>
                              {loginChallenge.submitted ? '正在验证授权' : '完成登录'}
                            </button>
                          </form>
                        ) : (
                          <strong>{loginChallenge.userCode}</strong>
                        )}
                        <small>在官方页面确认要使用的 {providerName} 账号，授权完成后会自动更新。</small>
                        <button
                          disabled={accountBusy}
                          onClick={() => {
                            setRefresh((r) => r + 1);
                            setLoginChallenge(null);
                          }}
                        >
                          刷新状态
                        </button>
                        <button
                          disabled={accountBusy}
                          onClick={() => {
                            setAccountBusy(true);
                            void api(base(connection) + `/providers/${selectedProvider}/login/cancel`, {})
                              .then(() => setLoginChallenge(null))
                              .catch((e) => setAccountError(e.message))
                              .finally(() => setAccountBusy(false));
                          }}
                        >
                          取消授权
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="account-section">
                    <div className="account-section-heading">
                      <h3>账号额度</h3>
                      <small>当前选中账号 · {providerName}</small>
                    </div>
                    {quota?.windows.length ? (
                      quota.windows.map((w, i) => (
                        <div className="quota-window" key={i}>
                          <div>
                            <span>
                              {w.name}
                              {w.scope ? ' · ' + w.scope : ''}
                            </span>
                            <strong>
                              {w.usedPercent === null
                                ? '未知'
                                : `剩余 ${Math.round(Math.max(0, Math.min(100, 100 - w.usedPercent)) * 10) / 10}%`}
                            </strong>
                          </div>
                          {w.usedPercent !== null && (
                            <progress
                              aria-label="剩余额度"
                              max="100"
                              value={Math.max(0, Math.min(100, 100 - w.usedPercent))}
                            />
                          )}
                          <small>
                            {w.windowDurationMins !== null
                              ? `窗口 ${w.windowDurationMins} 分钟`
                              : '按账号订阅周期计算'}
                            {w.resetsAt ? ' · 重置 ' + new Date(w.resetsAt * 1000).toLocaleString() : ''}
                          </small>
                        </div>
                      ))
                    ) : (
                      <p className="muted">
                        {quota?.unavailableReason ?? '暂无额度数据，无法推算剩余次数。'}
                      </p>
                    )}
                    {quota && (
                      <small>
                        {quota.stale ? '最近查询于 ' : '更新于 '}
                        {new Date(quota.updatedAt).toLocaleString()}
                      </small>
                    )}
                    {quota?.extraUsage && (
                      <div className="quota-window">
                        <div>
                          <span>加油包余额</span>
                          <strong>
                            {(quota.extraUsage.balanceCents / 100).toFixed(2)} {quota.extraUsage.currency}
                          </strong>
                        </div>
                        <small>
                          本月已用 {(quota.extraUsage.monthlyUsedCents / 100).toFixed(2)}{' '}
                          {quota.extraUsage.currency}
                          {quota.extraUsage.monthlyChargeLimitEnabled
                            ? ` · 月消费上限 ${(quota.extraUsage.monthlyChargeLimitCents / 100).toFixed(2)} ${quota.extraUsage.currency}`
                            : ' · 未设置月消费上限'}
                        </small>
                      </div>
                    )}
                    {quota?.credits != null && (
                      <details>
                        <summary>Credits 信息</summary>
                        <pre>{JSON.stringify(quota.credits, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                  <div className="account-danger-zone">
                    {connection.includes('~') ? (
                      <>
                        <div>
                          <h3>删除此 AI 账号</h3>
                          <p>
                            移除登录、此账号的 Relay 记录及独立 Kimi / Claude 会话。项目文件与共享 Codex
                            历史保留。
                          </p>
                        </div>
                        {deleteConfirm ? (
                          <div className="account-delete-confirm" role="group" aria-label="确认删除账号">
                            <strong>确认删除“{currentConnection?.accountLabel}”？</strong>
                            <p>此操作无法撤销。有活动任务的账号不能删除。</p>
                            <div>
                              <button disabled={accountBusy} onClick={() => setDeleteConfirm(false)}>
                                保留账号
                              </button>
                              <button
                                className="danger"
                                disabled={accountBusy}
                                onClick={() => void deleteAccount()}
                              >
                                {accountBusy ? '正在删除…' : '确认删除账号'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className="danger"
                            disabled={accountBusy}
                            onClick={() => setDeleteConfirm(true)}
                          >
                            删除 AI 账号
                          </button>
                        )}
                      </>
                    ) : (
                      <p>“跟随 Codex”是服务器的默认账号入口，无法删除。可在远端 Codex 中管理它的登录。</p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div
                id="server-identity-panel"
                role="tabpanel"
                aria-labelledby="server-identity-tab"
                className="account-server-layout"
              >
                <div className="account-section">
                  <h3>服务器远端</h3>
                  <dl>
                    <dt>服务器</dt>
                    <dd>{connections.find((c) => c.id === rootId)?.label}</dd>
                    <dt>工作台用户</dt>
                    <dd>{user.username}</dd>
                    <dt>Linux 用户</dt>
                    <dd>
                      {snapshot?.identity.username} · UID {snapshot?.identity.uid}
                    </dd>
                    <dt>HOME</dt>
                    <dd>{snapshot?.identity.home}</dd>
                    <dt>CODEX_HOME</dt>
                    <dd>{snapshot?.identity.codexHome}</dd>
                    <dt>项目</dt>
                    <dd>{workspace?.canonicalRoot ?? '未选择'}</dd>
                  </dl>
                </div>
                <div className="account-section">
                  <h3>连接诊断</h3>
                  <div className="diagnostic-row">
                    <CheckCircle2 size={15} />
                    浏览器 → Gateway：已登录
                  </div>
                  <div className="diagnostic-row">
                    {online ? <CheckCircle2 size={15} /> : <WifiOff size={15} />}Gateway → Agent：
                    {online ? '在线' : '当前不可达'}
                  </div>
                  <div className="diagnostic-row">
                    {providerName}：{account ? '协议连接正常' : '未就绪'}
                  </div>
                  {diagnostics?.diagnostics && <pre>{JSON.stringify(diagnostics.diagnostics, null, 2)}</pre>}
                </div>
              </div>
            )}
            <div className="modal-footer">
              <button
                onClick={() => {
                  setRefresh((r) => r + 1);
                }}
              >
                {accountTab === 'ai' ? '刷新账号与额度' : '刷新连接'}
              </button>
              <button
                onClick={() =>
                  void api('/logout', {})
                    .then(() => {
                      setUser(null);
                      setSnapshot(null);
                      setConnections([]);
                      savedSnapshots.current.clear();
                      sessionStorage.clear();
                    })
                    .catch((e) => setAccountError(e.message))
                }
              >
                <LogOut size={15} />
                退出工作台
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
