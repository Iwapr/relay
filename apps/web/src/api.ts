import type {
  AgentIdentity,
  Conversation,
  Run,
  Interaction,
  Workspace,
  WorkbenchEvent,
} from '../../../packages/contracts/src/index.ts';
export type { AgentIdentity, Conversation, Run, Interaction, Workspace, WorkbenchEvent };
export interface Connection {
  provider?: 'codex' | 'kimi' | 'claude' | 'antigravity' | 'deepseek';
  parentId?: string;
  accountLabel?: string;
  accountIdentifier?: string | null;
  id: string;
  label: string;
  status: string;
  username: string;
}
export interface Message {
  id: string;
  runId: string;
  conversationId: string;
  workspaceId: string;
  kind: string;
  text: string;
  payload: Record<string, unknown>;
  createdAt: string;
  eventSeq?: number;
  pendingDeltas?: Array<{ seq: number; text: string }>;
}
export interface Snapshot {
  identity: AgentIdentity;
  seq: number;
  workspaces: Workspace[];
  conversations: Conversation[];
  runs: Run[];
  interactions: Interaction[];
  messages: Message[];
}
export interface Metadata {
  path: string;
  version: string;
  size: number;
  mime: string;
  preview: 'pdf' | 'image' | 'markdown' | 'text' | 'download';
}
export let csrf = '';
export const setCsrf = (value: string) => {
  csrf = value;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const json = await response.json();
  if (!response.ok)
    throw new ApiError(json.error?.message ?? '请求失败', json.error?.code ?? 'unknown', response.status);
  return json;
}
export const base = (connection: string) => {
  const [parent, account] = connection.split('~');
  return (
    '/connections/' + encodeURIComponent(parent) + (account ? '/accounts/' + encodeURIComponent(account) : '')
  );
};
export const fileUrl = (c: string, w: string, path: string, version?: string) =>
  '/api' +
  base(c) +
  '/workspaces/' +
  encodeURIComponent(w) +
  '/file?' +
  new URLSearchParams({ path, ...(version ? { version } : {}) });
export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Private LAN HTTP origins lack randomUUID, but still expose getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const stateName: Record<string, string> = {
  queued: '排队中',
  starting: '启动中',
  running: '正在执行',
  waiting_approval: '等待确认',
  waiting_input: '等待回答',
  cancelling: '正在取消',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  uncertain: '结果待核实',
};
export const isActive = (s: string) =>
  ['queued', 'starting', 'running', 'waiting_approval', 'waiting_input', 'cancelling'].includes(s);
export function saved<T>(key: string, fallback: T): T {
  const persistent = persistentPreference(key);
  try {
    const value = JSON.parse(sessionStorage.getItem('relay:' + key) ?? 'null');
    if (value !== null) {
      if (persistent) {
        try {
          localStorage.setItem('relay:' + key, JSON.stringify(value));
        } catch {}
      }
      return value;
    }
  } catch {}
  if (persistent) {
    try {
      return JSON.parse(localStorage.getItem('relay:' + key) ?? 'null') ?? fallback;
    } catch {}
  }
  return fallback;
}
// Persist preferences only; drafts, pending requests and conversation contents stay tab-local.
function persistentPreference(key: string) {
  return key === 'connection' || /:(workspace|conversation|mode|model|effort)$/.test(key);
}
export function save(key: string, value: unknown) {
  try {
    sessionStorage.setItem('relay:' + key, JSON.stringify(value));
  } catch {}
  if (persistentPreference(key)) {
    try {
      localStorage.setItem('relay:' + key, JSON.stringify(value));
    } catch {}
  }
}
