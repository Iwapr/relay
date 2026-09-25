import type { PermissionMode } from '../../contracts/src/index.ts';
export interface AccountState {
  authenticated: boolean;
  authMode: string | null;
  identifier: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
}
export interface ModelInfo {
  supportsImages?: boolean;
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}
export interface QuotaWindow {
  name: string;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  scope: string | null;
}
export interface QuotaState {
  windows: QuotaWindow[];
  updatedAt: string;
  stale: boolean;
  credits: unknown | null;
  extraUsage?: {
    balanceCents: number;
    totalCents: number;
    monthlyChargeLimitEnabled: boolean;
    monthlyChargeLimitCents: number;
    monthlyUsedCents: number;
    currency: string;
  };
  unavailableReason?: string;
}
export interface ProviderCapabilities {
  sessions: boolean;
  resume: boolean;
  models: boolean;
  reasoning: boolean;
  quota: boolean;
  approvals: boolean;
  userInput: boolean;
  cancel: boolean;
  attachments: boolean;
}
export interface ProviderSessionRef {
  id: string;
  model?: string;
}
export interface NativeSessionSummary {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  model?: string;
  source?: string;
  status?: string;
}
export interface AsyncQuestion {
  title: string;
  options: string[] | null;
}
export interface NativeSessionTurn {
  id: string;
  /** Unknown means a history snapshot cannot establish the other client's current execution state. */
  state: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'running' | 'unknown';
  userText: string;
  messages: Array<{ id: string; kind: 'assistant' | 'tool'; text: string; questions?: AsyncQuestion[] }>;
  createdAt?: string;
}
export interface NativeSessionHistory extends NativeSessionSummary {
  hasOlderTurns?: boolean;
  turns: NativeSessionTurn[];
  truncated?: boolean;
}
export interface ProviderRunRef {
  sessionId: string;
  turnId: string;
}
export interface ProviderEvent {
  type: string;
  sessionId?: string;
  turnId?: string;
  generation: string;
  payload: Record<string, unknown>;
}
export interface CreateSessionInput {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
}
export interface StartRunInput {
  images?: Array<{ url: string }>;
  sessionId: string;
  text: string;
  model: string;
  reasoningEffort?: string | null;
  permissionMode: PermissionMode;
  cwd: string;
}
export interface InteractionAnswer {
  requestId: string | number;
  generation: string;
  decision?: 'accept' | 'decline' | 'cancel';
  answers?: Record<string, string[]>;
}
export interface AIProviderAdapter {
  readonly id: string;
  readonly generation: string;
  /** Release the process after a turn so another local client can resume its persisted thread. */
  readonly disposeAfterRun?: boolean;
  capabilities(): ProviderCapabilities;
  getAccount(): Promise<AccountState>;
  listModels(): Promise<ModelInfo[]>;
  getQuota(): Promise<QuotaState | null>;
  cancelLogin?(): Promise<void>;
  completeLogin?(code: string, loginId: string): Promise<void>;
  beginLogin?(): Promise<{
    verificationUrl: string;
    userCode: string;
    loginId: string;
    codeRequired?: boolean;
  }>;
  createSession(input: CreateSessionInput): Promise<ProviderSessionRef>;
  resumeSession(ref: ProviderSessionRef, input: CreateSessionInput): Promise<ProviderSessionRef>;
  forkSession?(id: string, lastTurnId: string, input: CreateSessionInput): Promise<ProviderSessionRef>;
  startRun(input: StartRunInput): Promise<ProviderRunRef>;
  interruptRun(ref: ProviderRunRef): Promise<void>;
  steerRun?(ref: ProviderRunRef, text: string, clientRequestId: string): Promise<void>;
  answerInteraction(input: InteractionAnswer): Promise<void>;
  subscribeEvents(handler: (event: ProviderEvent) => void): () => void;
  readSession?(id: string): Promise<unknown>;
  listNativeSessions?(
    cursor?: string,
    scope?: 'workspace' | 'all',
  ): Promise<{ sessions: NativeSessionSummary[]; nextCursor: string | null }>;
  /** Discovery metadata only; callers must validate its cwd before exposing or importing it. */
  readNativeSessionMetadata?(id: string): Promise<NativeSessionSummary>;
  /** Impact inspection only: includes subagents, never used to import or resume them. */
  readSessionOwnerMetadata?(id: string): Promise<NativeSessionSummary>;
  readNativeSession?(id: string, options?: { limit?: number }): Promise<NativeSessionHistory>;
  releaseSession?(id: string): Promise<void>;
  inspectSessionOwner?(id: string): Promise<{ fingerprint: string; sessions: string[] }>;
  stopSessionOwner?(id: string, fingerprint: string): Promise<void>;
  close(): Promise<void>;
}
