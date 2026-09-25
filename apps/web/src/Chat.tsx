import { mergeHistoryMessages } from './history-messages';
import { deduplicateRecoveredQuestions } from './question-messages';
import { questionBody } from '../../../packages/provider-core/src/questions.ts';
import { MessageTime, UserText } from './MessageMeta';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Takeover } from './Takeover';
import {
  ArrowUp,
  Square,
  Plus,
  History,
  ShieldCheck,
  X,
  FileText,
  LoaderCircle,
  ImagePlus,
} from 'lucide-react';
import {
  api,
  base,
  requestId,
  save,
  saved,
  isActive,
  type Workspace,
  type Conversation,
  type Run,
  type Interaction,
  type Message,
} from './api';
import type {
  ModelInfo,
  AccountState,
  NativeSessionHistory,
} from '../../../packages/provider-core/src/index.ts';
import { Markdown } from './Markdown';
import { SharedSessions, NativeTurn } from './SharedSessions';
import type { Reference } from './Preview';
import './chat-layout.css';
import { TurnActions } from './TurnActions';
import { ReplyPanel } from './ReplyPanel';
import { ToolHistory } from './ToolHistory';
import { ImageDrafts, MessageImages, useImageAttachments } from './ImageAttachments';
import { QuestionCard } from './QuestionCard';
import type { AsyncQuestion } from '../../../packages/provider-core/src/index.ts';
interface ConversationHistory {
  nextBefore?: string | null;
  seq?: number;
  takeoverAvailable?: boolean;
  conversationId: string;
  runs: Run[];
  messages: Message[];
  nativeHistory?: NativeSessionHistory;
  nativeHistoryError?: string;
}
export function InteractionCard({
  interaction,
  connection,
  onError,
}: {
  interaction: Interaction;
  connection: string;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [answers, setAnswers] = useState<Record<string, string[]>>({});
  const id = useRef<{ fingerprint: string; id: string } | null>(null);
  const p = interaction.payload as any;
  const questions = p.questions ?? p.params?.questions ?? [];
  const answer = async (decision?: 'accept' | 'decline' | 'cancel') => {
    if (busy) return;
    setBusy(true);
    const value = decision ? { decision } : { answers },
      fingerprint = JSON.stringify(value);
    if (id.current?.fingerprint !== fingerprint) id.current = { fingerprint, id: requestId() };
    try {
      await api(base(connection) + `/interactions/${interaction.id}/answer`, {
        clientRequestId: id.current.id,
        ...value,
      });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="interaction">
      <div className="interaction-title">
        <ShieldCheck size={17} />
        {interaction.kind === 'input' ? '模型需要你的回答' : '需要你的确认'}
      </div>
      {p.reason && <p>{String(p.reason)}</p>}
      {(p.command || p.params?.command) && <pre>{String(p.command ?? p.params.command)}</pre>}
      {p.cwd && <small>目录：{String(p.cwd)}</small>}
      {!p.command && !questions.length && <pre>{JSON.stringify(p, null, 2)}</pre>}
      {questions.map((q: any) => (
        <div className="question" key={q.id}>
          <label>{q.question ?? q.header}</label>
          {q.options?.map((o: any) => (
            <button
              className={answers[q.id]?.[0] === o.label ? 'selected' : ''}
              key={o.label}
              onClick={() => setAnswers((a) => ({ ...a, [q.id]: [o.label] }))}
            >
              {o.label}
              <small>{o.description}</small>
            </button>
          ))}
          <input
            aria-label={q.question ?? q.header}
            readOnly={p.choiceOnly === true}
            placeholder={p.choiceOnly ? '请选择上方选项' : '输入你的回答'}
            value={answers[q.id]?.[0] ?? ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: [e.target.value] }))}
          />
        </div>
      ))}
      <div className="interaction-actions">
        {interaction.kind === 'approval' ? (
          <>
            <button disabled={busy} onClick={() => void answer('decline')}>
              拒绝
            </button>
            <button disabled={busy} onClick={() => void answer('cancel')}>
              取消操作
            </button>
            <button className="primary" disabled={busy} onClick={() => void answer('accept')}>
              允许本次
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={busy || questions.some((q: any) => !answers[q.id]?.[0])}
            onClick={() => void answer()}
          >
            提交回答
          </button>
        )}
      </div>
    </div>
  );
}
export function Chat({
  provider = 'codex',
  connection,
  workspace,
  conversations,
  runs,
  messages,
  interactions,
  models,
  account,
  online,
  references,
  setReferences,
  onRefresh,
  onOpen,
  onSelectNativeSession,
  toolbarTarget,
  onShowChat,
  toolbarVisible = true,
}: {
  provider?: 'codex' | 'kimi' | 'claude';
  connection: string;
  workspace?: Workspace;
  conversations: Conversation[];
  runs: Run[];
  messages: Message[];
  interactions: Interaction[];
  models: ModelInfo[];
  account: AccountState | null;
  online: boolean;
  references: Reference[];
  setReferences: (r: Reference[]) => void;
  onRefresh: () => void;
  onOpen: (path: string) => void;
  onSelectNativeSession?: (workspace: Workspace, conversation: Conversation) => void;
  toolbarTarget?: HTMLElement | null;
  onShowChat?: () => void;
  toolbarVisible?: boolean;
}) {
  const accountReady =
    account?.authenticated === true &&
    account.authMode ===
      (provider === 'claude' ? 'claude-code' : provider === 'kimi' ? 'kimi-code' : 'chatgpt');
  const key = connection + ':' + (workspace?.id ?? 'none');
  const [conversation, setConversation] = useState(() => saved(key + ':conversation', '')),
    [draft, setDraft] = useState(''),
    [model, setModel] = useState(''),
    [effort, setEffort] = useState(''),
    [mode, setMode] = useState<Run['permissionMode']>('read-only'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [visible, setVisible] = useState(40),
    [history, setHistory] = useState<ConversationHistory | null>(null),
    [historyRevision, setHistoryRevision] = useState(0),
    [historyLoading, setHistoryLoading] = useState(false),
    [olderLoading, setOlderLoading] = useState(false),
    [nativeLoading, setNativeLoading] = useState(false),
    [nativeLimit, setNativeLimit] = useState(6),
    [historyError, setHistoryError] = useState(''),
    [sharedOpen, setSharedOpen] = useState(false),
    [attachedConversations, setAttachedConversations] = useState<Conversation[]>([]);
  const pending = useRef<{ fingerprint: string; id: string; conversationId: string } | null>(null),
    mounted = useRef(true),
    composition = useRef(false),
    viewKey = useRef(key),
    conversationRef = useRef(conversation),
    scroll = useRef<HTMLDivElement>(null),
    timelineContent = useRef<HTMLDivElement>(null),
    followLatest = useRef(true),
    lastScrollTop = useRef(0),
    input = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const attachments = useImageAttachments(key, connection, workspace?.id, setError);
  viewKey.current = key;
  conversationRef.current = conversation;
  const availableConversations = useMemo(
    () => [...new Map([...attachedConversations, ...conversations].map((c) => [c.id, c])).values()],
    [attachedConversations, conversations],
  );
  const currentConversation = availableConversations.find((c) => c.id === conversation);
  const hasNativeSession =
    provider === 'codex' &&
    (!!currentConversation?.providerSessionId ||
      runs.some((run) => run.conversationId === conversation && !!run.providerTurnId));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setConversation(saved(key + ':conversation', ''));
    setDraft(saved(key + ':draft', ''));
    setModel(saved(key + ':model', ''));
    setEffort(saved(key + ':effort', ''));
    const storedMode = saved<string>(key + ':mode', 'read-only');
    setMode(storedMode === 'workspace-write' || storedMode === 'full-access' ? storedMode : 'read-only');
    setError('');
    setHistory(null);
    setHistoryError('');
    setSharedOpen(false);
    setAttachedConversations([]);
    setBusy(false);
    pending.current = saved(key + ':pending', null);
  }, [key]);
  useEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(144, Math.max(64, textarea.scrollHeight)) + 'px';
  }, [draft]);
  useEffect(() => {
    if (models.length && !models.some((m) => m.id === model))
      setModel(models.find((m) => m.isDefault)?.id ?? models[0].id);
  }, [models, model]);
  useEffect(() => {
    // An explicitly selected blank draft must survive refreshes and incoming snapshots.
    const selected = saved<string | null>(key + ':conversation', null);
    if (!conversation && selected === '') return;
    if (availableConversations.length && !availableConversations.some((c) => c.id === conversation)) {
      const activity = (c: Conversation) =>
        runs
          .filter((r) => r.conversationId === c.id)
          .reduce((latest, r) => (r.createdAt > latest ? r.createdAt : latest), c.createdAt);
      // A project can finish loading after this component mounts. Honor its
      // saved selection before falling back to the latest conversation.
      const latest =
        availableConversations.find((c) => c.id === selected) ??
        [...availableConversations].sort((a, b) => activity(b).localeCompare(activity(a)))[0];
      setConversation(latest.id);
      save(key + ':conversation', latest.id);
    }
  }, [availableConversations, conversation, key, runs]);
  useEffect(() => {
    if (!conversation) {
      setHistory(null);
      setHistoryLoading(false);
      return;
    }
    const abort = new AbortController();
    setHistoryLoading(true);
    setHistoryError('');
    setOlderLoading(false);
    void api<Omit<ConversationHistory, 'conversationId'>>(
      base(connection) + `/conversations/${conversation}?view=page`,
      undefined,
      abort.signal,
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        setHistory((old) => {
          const previous = old?.conversationId === conversation ? old : null;
          return {
            ...previous,
            ...result,
            conversationId: conversation,
            nextBefore:
              previous?.nextBefore !== undefined &&
              result.runs.some((run) => previous.runs.some((oldRun) => oldRun.id === run.id))
                ? previous.nextBefore
                : result.nextBefore,
            runs: [...new Map([...(previous?.runs ?? []), ...result.runs].map((r) => [r.id, r])).values()],
            messages: mergeHistoryMessages(
              previous?.messages ?? [],
              result.messages.map((m) => ({ ...m, eventSeq: result.seq })),
            ),
          };
        });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setHistoryError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setHistoryLoading(false);
      });
    return () => abort.abort();
  }, [connection, conversation, historyRevision, online]);
  useEffect(() => {
    setNativeLimit(6);
  }, [connection, conversation]);
  // Native/IDE history may require starting Codex. It must not delay local messages or files.
  useEffect(() => {
    if (!conversation || !hasNativeSession) {
      setNativeLoading(false);
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setNativeLoading(true);
    const read = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        const result = await api<
          Pick<ConversationHistory, 'nativeHistory' | 'nativeHistoryError' | 'takeoverAvailable'>
        >(
          base(connection) + `/conversations/${conversation}?view=native&limit=${nativeLimit}`,
          undefined,
          abort.signal,
        );
        if (!abort.signal.aborted)
          setHistory((old) => ({
            ...(old?.conversationId === conversation
              ? old
              : { conversationId: conversation, runs: [], messages: [] }),
            ...result,
            nativeHistoryError: result.nativeHistoryError,
          }));
      } catch (e) {
        if (!abort.signal.aborted)
          setHistory((old) => ({
            ...(old?.conversationId === conversation
              ? old
              : { conversationId: conversation, runs: [], messages: [] }),
            nativeHistoryError: (e as Error).message,
          }));
      } finally {
        if (!abort.signal.aborted) {
          setNativeLoading(false);
          if (online) timer = setTimeout(() => void read(), 5000);
        }
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [connection, conversation, historyRevision, hasNativeSession, online, nativeLimit]);
  const loadOlder = async () => {
    if (olderLoading || !history?.nextBefore || history.conversationId !== conversation) return;
    const targetKey = key,
      targetConversation = conversation;
    setOlderLoading(true);
    try {
      const result = await api<ConversationHistory>(
        base(connection) +
          `/conversations/${conversation}?` +
          new URLSearchParams({ view: 'page', before: history.nextBefore }),
      );
      if (!mounted.current || viewKey.current !== targetKey || conversationRef.current !== targetConversation)
        return;
      setHistory((old) =>
        old?.conversationId !== targetConversation
          ? old
          : {
              ...old,
              nextBefore: result.nextBefore,
              runs: [...new Map([...result.runs, ...old.runs].map((r) => [r.id, r])).values()],
              messages: mergeHistoryMessages(
                old.messages,
                result.messages.map((m) => ({ ...m, eventSeq: result.seq })),
              ),
            },
      );
      followLatest.current = false;
      setVisible((n) => n + result.runs.length);
    } catch (e) {
      if (mounted.current && viewKey.current === targetKey && conversationRef.current === targetConversation)
        setHistoryError((e as Error).message);
    } finally {
      if (mounted.current && viewKey.current === targetKey && conversationRef.current === targetConversation)
        setOlderLoading(false);
    }
  };
  useEffect(() => {
    if (!conversation) return;
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastRefresh < 1000) return;
      lastRefresh = Date.now();
      setHistoryRevision((revision) => revision + 1);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [conversation]);
  const selectedModel = models.find((m) => m.id === model);
  const historical = history?.conversationId === conversation ? history : null;
  const runsById = new Map(runs.map((r) => [r.id, r]));
  for (const run of historical?.runs ?? []) {
    const current = runsById.get(run.id);
    if (!current || run.updatedAt >= current.updatedAt) runsById.set(run.id, run);
  }
  const mergedRuns = [...runsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mergedMessages = mergeHistoryMessages(historical?.messages ?? [], messages);
  const conversationRuns = mergedRuns.filter((r) => r.conversationId === conversation);
  const loadedRuns = new Set(historical?.runs.map((r) => r.id));
  const newestLoaded = historical?.runs.reduce((date, r) => (r.createdAt > date ? r.createdAt : date), '');
  const activeRuns = conversationRuns.filter(
    (r) =>
      historical?.nextBefore === null ||
      loadedRuns.has(r.id) ||
      isActive(r.state) ||
      (!!newestLoaded && r.createdAt > newestLoaded),
  );
  const last = conversationRuns.at(-1),
    running = last && isActive(last.state);
  const contextUsageLabel = last?.contextUsage
    ? `上下文 ${last.contextUsage.contextTokens.toLocaleString()}${last.contextUsage.contextWindow ? ' / ' + last.contextUsage.contextWindow.toLocaleString() : ''} tokens · 会话累计 ${last.contextUsage.totalTokens.toLocaleString()} tokens（非账单）`
    : undefined;
  const currentMessages = mergedMessages.filter((m) => m.conversationId === conversation);
  const nativeHistory = historical?.nativeHistory;
  // Snapshot events may arrive after history was read. Exclude newly linked Relay turns too.
  const relayTurnIds = new Set(conversationRuns.map((run) => run.providerTurnId).filter(Boolean));
  const timeline = [
    ...(nativeHistory?.turns ?? [])
      .filter((turn) => !relayTurnIds.has(turn.id))
      .map((turn) => ({
        kind: 'native' as const,
        turn,
        createdAt: turn.createdAt ?? '',
      })),
    ...activeRuns.map((run) => ({ kind: 'relay' as const, run, createdAt: run.createdAt })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  useEffect(() => {
    followLatest.current = true;
    lastScrollTop.current = 0;
    const element = scroll.current;
    const content = timelineContent.current;
    if (!element || !content) return;
    const bottom = () => {
      if (followLatest.current && element.clientHeight > 0) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
        lastScrollTop.current = element.scrollTop;
      }
    };
    bottom();
    const observer = new ResizeObserver(bottom);
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, [conversation, key]);
  const chooseConversation = (id: string, preservePending = false) => {
    if (!preservePending) {
      attachments.clear();
      pending.current = null;
      save(key + ':pending', null);
    }
    setConversation(id);
    save(key + ':conversation', id);
    setVisible(40);
  };
  const attachConversation = (created: Conversation, preservePending = false) => {
    setAttachedConversations((previous) => [...previous.filter((item) => item.id !== created.id), created]);
    chooseConversation(created.id, preservePending);
  };
  const selectBranch = (created: Conversation, restoredDraft?: string) => {
    if (!mounted.current || created.workspaceId !== workspace?.id) return;
    attachConversation(created);
    if (restoredDraft !== undefined) {
      setDraft(restoredDraft);
      save(key + ':draft', restoredDraft);
    }
    onRefresh();
  };
  const workspaceBusy = runs.some((r) => r.workspaceId === workspace?.id && isActive(r.state));
  const latestWorkspaceRun = runs.filter((r) => r.workspaceId === workspace?.id).at(-1)?.id;
  const newConversation = () => {
    if (!workspace || busy) return;
    onShowChat?.();
    chooseConversation('');
    setDraft('');
    save(key + ':draft', '');
    setReferences([]);
    setError('');
    input.current?.focus();
  };
  const replyToQuestions = async (text: string, clientRequestId: string) => {
    const result = await api(base(connection) + `/conversations/${conversation}/reply`, {
      clientRequestId,
      text,
      model,
      reasoningEffort: effort || null,
      permissionMode: mode,
    });
    onRefresh();
    return result;
  };
  const send = async () => {
    if (
      busy ||
      attachments.pending ||
      (attachments.ids.length > 0 && selectedModel?.supportsImages === false) ||
      (!draft.trim() && !attachments.ids.length) ||
      composition.current ||
      !workspace ||
      !online ||
      !model ||
      !accountReady
    )
      return;
    setBusy(true);
    setError('');
    // Capture target and content before any async operation; switching views cannot reroute it.
    const target = connection,
      workspaceId = workspace.id,
      text =
        draft.trim() +
        (references.length
          ? '\n\n用户选择的上下文引用（只提供以下文本）：\n' +
            references
              .map(
                (r) =>
                  `[${r.path} · 版本 ${r.version}${r.page ? ' · 页 ' + r.page : r.line ? ' · 行 ' + r.line : ''}]\n${r.text}`,
              )
              .join('\n\n')
          : ''),
      targetModel = model;
    const imageIds = [...attachments.ids];
    const fingerprint = JSON.stringify({
      target,
      workspaceId,
      text,
      model,
      effort,
      mode,
      ...(imageIds.length ? { imageIds } : {}),
    });
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, id: requestId(), conversationId: conversation };
    const operation = pending.current,
      clientRequestId = operation.id;
    save(key + ':pending', operation);
    try {
      let id = operation.conversationId;
      if (!id) {
        const result = await api(base(target) + `/workspaces/${workspaceId}/conversations`, {
          title: draft.trim().slice(0, 80) || '图片对话',
        });
        id = result.conversation.id;
        operation.conversationId = id;
        save(key + ':pending', operation);
        if (mounted.current && viewKey.current === key) attachConversation(result.conversation, true);
      }
      await api(base(target) + `/conversations/${id}/runs`, {
        clientRequestId,
        text,
        model: targetModel,
        reasoningEffort: effort || selectedModel?.defaultReasoningEffort || null,
        permissionMode: mode,
        ...(imageIds.length ? { imageIds } : {}),
      });
      save(key + ':draft', '');
      save(key + ':pending', null);
      save(key + ':images', []);
      if (!mounted.current || viewKey.current !== key) return;
      setDraft('');
      attachments.clear();
      setReferences([]);
      pending.current = null;
      onRefresh();
      setTimeout(() => {
        scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
      }, 100);
    } catch (e) {
      if (mounted.current && viewKey.current === key)
        setError((e as Error).message + '。未自动重发；请确认目标与任务列表。');
    } finally {
      if (mounted.current && viewKey.current === key) setBusy(false);
    }
  };
  const toolbar = (
    <div className="chat-toolbar" aria-label="对话工具栏">
      <button
        className="chat-toolbar-button"
        title="历史对话"
        aria-label={provider === 'claude' ? 'Claude 会话' : provider === 'kimi' ? 'Kimi 会话' : 'Codex 会话'}
        disabled={!online}
        onClick={() => {
          onShowChat?.();
          if (!conversation) save(key + ':conversation', '');
          setSharedOpen(true);
        }}
      >
        <History size={18} />
      </button>
      <button
        className="chat-toolbar-button"
        title="新对话"
        aria-label="新对话"
        disabled={!workspace || !online || busy}
        onClick={newConversation}
      >
        <Plus size={18} />
      </button>
    </div>
  );
  return (
    <section className="chat-panel" data-conversation-id={conversation}>
      {toolbarVisible &&
        (toolbarTarget ? (
          createPortal(toolbar, toolbarTarget)
        ) : (
          <div className="chat-toolbar-inline">{toolbar}</div>
        ))}
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) followLatest.current = true;
          else if (el.scrollTop < lastScrollTop.current - 1) followLatest.current = false;
          lastScrollTop.current = el.scrollTop;
        }}
      >
        <div ref={timelineContent} className="chat-timeline">
          {(historyError || historical?.nativeHistoryError) && (
            <div className="error shared-history-error" role="alert">
              会话记录暂时无法读取：{historyError || historical?.nativeHistoryError}
              <button
                disabled={historyLoading || !online}
                onClick={() => setHistoryRevision((revision) => revision + 1)}
              >
                重试读取记录
              </button>
            </div>
          )}
          {(historyLoading || nativeLoading) && (
            <p className="subtle" role="status">
              正在读取会话记录…
            </p>
          )}
          {nativeHistory?.truncated && (
            <p className="subtle">共享记录较长，当前仅显示最近部分；完整记录保留在 Codex 中。</p>
          )}
          {timeline.length === 0 && !historyLoading ? (
            <div className="chat-empty" aria-label="新对话" />
          ) : (
            <>
              {(timeline.length > visible ||
                historical?.nextBefore ||
                ((nativeHistory?.hasOlderTurns ?? nativeHistory?.truncated) && nativeLimit < 100)) && (
                <button
                  className="more"
                  disabled={
                    olderLoading || (!historical?.nextBefore && timeline.length <= visible && nativeLoading)
                  }
                  onClick={() => {
                    if (timeline.length > visible) setVisible((n) => n + 40);
                    else if (historical?.nextBefore) void loadOlder();
                    else {
                      setNativeLimit((n) => Math.min(100, n + 10));
                      setVisible((n) => n + 10);
                    }
                  }}
                >
                  加载较早记录
                </button>
              )}
              {timeline.slice(-visible).map((entry) => {
                if (entry.kind === 'native')
                  return (
                    <div key={'native:' + entry.turn.id}>
                      <NativeTurn
                        turn={entry.turn}
                        connection={connection}
                        workspaceId={workspace?.id}
                        root={workspace?.canonicalRoot}
                        onOpen={onOpen}
                        onReply={replyToQuestions}
                        replyDisabled={!online || !workspace || !model || !accountReady}
                        replyKey={key + ':' + conversation}
                      />
                      <TurnActions
                        connection={connection}
                        conversationId={conversation}
                        turnId={entry.turn.id}
                        model={model}
                        disabled={
                          !online ||
                          workspaceBusy ||
                          entry.turn.state === 'running' ||
                          entry.turn.state === 'unknown'
                        }
                        onSelect={selectBranch}
                        onError={setError}
                      />
                    </div>
                  );
                const run = entry.run;
                const runMessages = deduplicateRecoveredQuestions(
                  currentMessages.filter((m) => m.runId === run.id),
                ).slice(-100);
                return (
                  <div className="turn" key={run.id}>
                    <div className="user-message">
                      <UserText text={run.text} />
                      <MessageTime value={run.createdAt} label="已发送" />
                    </div>
                    {run.accountLabel && <small className="muted">执行账号：{run.accountLabel}</small>}
                    <MessageImages images={run.images} connection={connection} workspace={run.workspaceId} />
                    {!isActive(run.state) && (
                      <TurnActions
                        connection={connection}
                        conversationId={conversation}
                        turnId={provider !== 'codex' ? null : run.providerTurnId}
                        model={model}
                        run={run}
                        latest={latestWorkspaceRun === run.id}
                        disabled={!online || workspaceBusy}
                        onSelect={selectBranch}
                        onError={setError}
                      />
                    )}
                    <ReplyPanel
                      providerName={provider === 'claude' ? 'Claude' : provider === 'kimi' ? 'Kimi' : 'Codex'}
                      state={run.state}
                      model={run.model}
                    >
                      <ToolHistory
                        records={runMessages
                          .filter((m) => m.kind === 'tool')
                          .map((message) => ({
                            id: message.id,
                            title: String(
                              message.payload.command ?? message.payload.title ?? '工具执行',
                            ).slice(0, 100),
                            text: message.text || JSON.stringify(message.payload, null, 2),
                            truncated:
                              message.payload.truncated === true
                                ? '输出已截断，仅保留前 256 KiB。'
                                : undefined,
                          }))}
                      />
                      {runMessages
                        .filter((m) => m.kind !== 'tool')
                        .map((message) =>
                          message.kind === 'user' ? (
                            <div key={message.id} className="user-message">
                              <UserText text={message.text} />
                              <MessageTime value={message.createdAt} label="已发送" />
                            </div>
                          ) : (
                            <div key={message.id} className="assistant-message markdown">
                              <Markdown
                                text={questionBody(
                                  message.text,
                                  message.payload.questions as AsyncQuestion[] | undefined,
                                )}
                                connection={connection}
                                workspace={workspace?.id}
                                root={workspace?.canonicalRoot}
                                onOpen={onOpen}
                              />
                              {Array.isArray(message.payload.questions) &&
                                message.payload.questions.length > 0 && (
                                  <QuestionCard
                                    questions={message.payload.questions as AsyncQuestion[]}
                                    storageKey={key + ':' + conversation + ':' + message.id}
                                    disabled={!online || !workspace || !model || !accountReady}
                                    onReply={replyToQuestions}
                                  />
                                )}
                              <MessageTime value={message.createdAt} label="已接收" />
                              {message.payload.truncated === true && (
                                <small>输出已截断，仅保留前 256 KiB。</small>
                              )}
                            </div>
                          ),
                        )}
                      {interactions
                        .filter((i) => i.runId === run.id && i.status === 'pending')
                        .map((i) => (
                          <InteractionCard
                            key={i.id}
                            interaction={i}
                            connection={connection}
                            onError={setError}
                          />
                        ))}
                      {run.error && <div className="error">{run.error}</div>}
                    </ReplyPanel>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
      <div className="composer-area">
        {!online && <div className="offline-note">连接不可用 · 显示最后已知状态，远端任务可能仍在运行</div>}
        {error && (
          <div className="error" role="alert">
            {error}
            <button aria-label="清除错误" onClick={() => setError('')}>
              <X size={12} />
            </button>
          </div>
        )}
        {hasNativeSession &&
          conversation &&
          online &&
          !workspaceBusy &&
          history?.conversationId === conversation &&
          history.takeoverAvailable === true && (
            <Takeover
              key={`${key}:${conversation}`}
              connection={connection}
              conversationId={conversation}
              disabled={!online || busy || workspaceBusy}
              onReleased={() => {
                setHistory((previous) => (previous ? { ...previous, takeoverAvailable: false } : previous));
                setHistoryRevision((revision) => revision + 1);
                if (
                  !draft.trim() &&
                  last?.state === 'failed' &&
                  /其他窗口|in use by another app/.test(last.error ?? '')
                ) {
                  setDraft(last.text);
                  save(key + ':draft', last.text);
                }
                onRefresh();
                input.current?.focus();
              }}
            />
          )}
        {references.map((r, i) => (
          <div className="reference-chip" key={i}>
            <FileText size={12} />
            {r.path}
            {r.page ? ' · 页 ' + r.page : ''}
            <button aria-label="移除引用" onClick={() => setReferences(references.filter((_, j) => j !== i))}>
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="composer">
          <ImageDrafts items={attachments.items} disabled={busy} onRemove={attachments.remove} />
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            aria-label="图片附件"
            onChange={(event) => {
              if (!busy && selectedModel?.supportsImages !== false)
                void attachments.add(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <div className="composer-input">
            {last?.contextUsage && (
              <span
                className="composer-context"
                id={`context-usage-${key}`}
                aria-label={contextUsageLabel}
                title={contextUsageLabel}
              >
                {new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
                  last.contextUsage.contextTokens,
                )}{' '}
                上下文
              </span>
            )}
            <textarea
              ref={input}
              aria-label="任务指令"
              aria-describedby={last?.contextUsage ? `context-usage-${key}` : undefined}
              value={draft}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files).filter((file) =>
                  file.type.startsWith('image/'),
                );
                if (!files.length) return;
                if (!event.clipboardData.getData('text/plain')) event.preventDefault();
                if (busy) return;
                if (selectedModel?.supportsImages === false) {
                  setError('所选模型不支持图片，请切换模型。');
                  return;
                }
                void attachments.add(files);
              }}
              onChange={(e) => {
                setDraft(e.target.value);
                save(key + ':draft', e.target.value);
              }}
              onCompositionStart={() => {
                composition.current = true;
              }}
              onCompositionEnd={() => {
                composition.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.repeat &&
                  !composition.current &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229 &&
                  (event.ctrlKey ||
                    event.metaKey ||
                    window.matchMedia('(hover: hover) and (pointer: fine)').matches)
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="描述你想完成的工作，也可以粘贴截图…"
              title={['电脑：Enter 发送，Shift+Enter 换行', contextUsageLabel].filter(Boolean).join('\n')}
              rows={2}
            />
          </div>
          <div className="composer-bottom">
            <div className="composer-controls" aria-label="任务设置">
              <select
                className="chat-model-select"
                disabled={models.length === 0}
                aria-label="模型"
                title={selectedModel?.displayName ?? '模型未就绪'}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  save(key + ':model', e.target.value);
                  setEffort('');
                  save(key + ':effort', '');
                }}
              >
                {models.length === 0 && (
                  <option value="" disabled>
                    模型未就绪
                  </option>
                )}
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName.replace(/^GPT-(6|5\.6)[\s-]+/i, '$1 ')}
                  </option>
                ))}
              </select>
              {!!selectedModel?.reasoningEfforts.length && (
                <label>
                  <select
                    aria-label="推理强度"
                    value={effort}
                    onChange={(e) => {
                      setEffort(e.target.value);
                      save(key + ':effort', e.target.value);
                    }}
                  >
                    <option value="">默认</option>
                    {selectedModel.reasoningEfforts.map((item) => (
                      <option key={item} value={item}>
                        {(
                          {
                            minimal: '最低',
                            low: '低',
                            medium: '中',
                            high: '高',
                            xhigh: '极高',
                            ultra: '超高',
                          } as Record<string, string>
                        )[item] ?? item}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <select
                  aria-label="权限模式"
                  value={mode}
                  onChange={(e) => {
                    const value = e.target.value as typeof mode;
                    setMode(value);
                    save(key + ':mode', value);
                  }}
                >
                  <option value="read-only">{provider !== 'codex' ? '规划（Plan）' : '只读'}</option>
                  <option value="workspace-write">{provider !== 'codex' ? '工具审批' : '可编辑'}</option>
                  <option value="full-access">完全访问</option>
                </select>
              </label>
            </div>
            {provider !== 'codex' && (
              <small className="chat-settings-note">
                {provider === 'claude' ? 'Claude' : 'Kimi'}{' '}
                使用自身的规划与工具审批模式，无项目文件沙箱；完全访问会自动批准工具操作。
              </small>
            )}
            <div className="actions">
              {workspaceBusy && <small className="queue-hint">发送后排队</small>}
              <button
                className="attach-image-button"
                aria-label="添加图片"
                title="添加图片或粘贴截图，每条最多 4 张"
                disabled={
                  busy ||
                  !online ||
                  !workspace ||
                  selectedModel?.supportsImages === false ||
                  attachments.items.length >= 4
                }
                onClick={() => imageInput.current?.click()}
              >
                <ImagePlus size={18} />
              </button>
              {running && (
                <button
                  className="cancel-button"
                  aria-label="取消任务"
                  onClick={() =>
                    void api(base(connection) + `/runs/${last.id}/cancel`, { clientRequestId: requestId() })
                      .then(onRefresh)
                      .catch((e) => setError(e.message))
                  }
                >
                  <Square size={13} />
                </button>
              )}
              <button
                className="send-button"
                aria-label="发送任务"
                title={workspaceBusy ? '加入队列，前面的任务结束后自动发送' : '发送任务'}
                onClick={() => void send()}
                disabled={
                  busy ||
                  attachments.pending ||
                  (!draft.trim() && !attachments.ids.length) ||
                  (attachments.ids.length > 0 && selectedModel?.supportsImages === false) ||
                  !online ||
                  !workspace ||
                  !model ||
                  !accountReady
                }
              >
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
      {sharedOpen && (
        <SharedSessions
          provider={provider}
          connection={connection}
          workspaceId={workspace?.id}
          onRenamed={(updated) => {
            if (!mounted.current || viewKey.current !== key) return;
            if (updated.workspaceId !== workspace?.id) {
              onRefresh();
              return;
            }
            setAttachedConversations((items) => [...items.filter((item) => item.id !== updated.id), updated]);
            onRefresh();
          }}
          onClose={() => setSharedOpen(false)}
          onSelect={(selected, selectedWorkspace) => {
            if (selectedWorkspace.id === workspace?.id) attachConversation(selected);
            else onSelectNativeSession?.(selectedWorkspace, selected);
            setSharedOpen(false);
            setHistoryRevision((revision) => revision + 1);
            onRefresh();
          }}
        />
      )}
    </section>
  );
}
