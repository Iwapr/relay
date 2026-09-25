import { randomUUID } from 'node:crypto';
import type {
  AIProviderAdapter,
  AccountState,
  CreateSessionInput,
  InteractionAnswer,
  ModelInfo,
  NativeSessionHistory,
  ProviderEvent,
  ProviderRunRef,
  ProviderSessionRef,
  QuotaState,
  StartRunInput,
} from '../../packages/provider-core/src/index.ts';

/** A deterministic contract fixture. This is never registered in production. */
export class MockProvider implements AIProviderAdapter {
  readonly id = 'contract-mock';
  readonly generation = randomUUID();
  readonly listeners = new Set<(event: ProviderEvent) => void>();
  readonly starts: StartRunInput[] = [];
  readonly interrupts: ProviderRunRef[] = [];
  readonly answers: InteractionAnswer[] = [];
  readonly steers: Array<{ ref: ProviderRunRef; text: string; clientRequestId: string }> = [];
  readonly sessions = new Set<string>();
  readonly nativeSessions = new Map<string, NativeSessionHistory>();
  readonly nativeListCalls: (string | undefined)[] = [];
  readonly resumes: ProviderSessionRef[] = [];
  readonly releases: string[] = [];
  disposeAfterRun = false;
  persistNativeHistory = false;
  closes = 0;
  nativeSessionPageSize = 100;
  nativeHistoryError?: Error;
  refs: ProviderRunRef[] = [];
  accountBarrier?: Promise<void>;
  sessionBarrier?: Promise<void>;
  startError?: Error;
  account: AccountState = {
    authenticated: true,
    authMode: 'chatgpt',
    identifier: 'fixture@example.invalid',
    planType: 'fixture',
    requiresOpenaiAuth: true,
  };
  constructor(readonly cwd: string) {}
  capabilities() {
    return {
      sessions: true,
      resume: true,
      models: true,
      reasoning: true,
      quota: true,
      approvals: true,
      userInput: true,
      cancel: true,
      attachments: false,
    };
  }
  async getAccount() {
    await this.accountBarrier;
    return this.account;
  }
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'fixture-model',
        displayName: 'Fixture only',
        description: '',
        isDefault: true,
        reasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      },
    ];
  }
  async getQuota(): Promise<QuotaState | null> {
    return null;
  }
  async createSession(input: CreateSessionInput): Promise<ProviderSessionRef> {
    if (input.cwd !== this.cwd) throw new Error('Fixture cwd mismatch');
    await this.sessionBarrier;
    const id = randomUUID();
    this.sessions.add(id);
    if (this.persistNativeHistory)
      this.nativeSessions.set(id, {
        id,
        cwd: this.cwd,
        title: 'Fixture',
        updatedAt: new Date().toISOString(),
        turns: [],
      });
    return { id };
  }
  async forkSession(id: string, lastTurnId: string, input: CreateSessionInput) {
    const history = await this.readNativeSession(id);
    const index = history.turns.findIndex((t) => t.id === lastTurnId);
    if (index < 0) throw new Error('Fixture turn not found');
    const branch = await this.createSession(input);
    this.nativeSessions.set(branch.id, {
      ...history,
      id: branch.id,
      turns: history.turns.slice(0, index + 1),
    });
    return branch;
  }
  async resumeSession(ref: ProviderSessionRef, input: CreateSessionInput) {
    if (input.cwd !== this.cwd) throw new Error('Fixture cwd mismatch');
    this.resumes.push({ ...ref });
    this.sessions.add(ref.id);
    return ref;
  }
  async listNativeSessions(cursor?: string, scope: 'workspace' | 'all' = 'workspace') {
    this.nativeListCalls.push(cursor);
    const sessions = [...this.nativeSessions.values()].filter(
      (session) => scope === 'all' || session.cwd === this.cwd,
    );
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid fixture cursor');
    const next = offset + this.nativeSessionPageSize;
    return {
      sessions: sessions
        .slice(offset, next)
        .map(({ turns: _, truncated: __, ...summary }) => ({ ...summary })),
      nextCursor: next < sessions.length ? String(next) : null,
    };
  }
  async readNativeSession(id: string) {
    if (this.nativeHistoryError) throw this.nativeHistoryError;
    const session = this.nativeSessions.get(id);
    if (!session) throw new Error('Native fixture session not found');
    return structuredClone(session);
  }
  async readNativeSessionMetadata(id: string) {
    const { turns: _, truncated: __, ...summary } = await this.readNativeSession(id);
    return summary;
  }
  async releaseSession(id: string) {
    this.releases.push(id);
  }
  async startRun(input: StartRunInput): Promise<ProviderRunRef> {
    if (!this.sessions.has(input.sessionId)) throw new Error('Session must be created or resumed');
    this.starts.push(input);
    if (this.startError) throw this.startError;
    const ref = { sessionId: input.sessionId, turnId: randomUUID() };
    this.refs.push(ref);
    if (this.persistNativeHistory)
      this.nativeSessions
        .get(input.sessionId)
        ?.turns.push({ id: ref.turnId, state: 'running', userText: input.text, messages: [] });
    this.emit('run.started', { state: 'running' }, ref);
    return ref;
  }
  async interruptRun(ref: ProviderRunRef) {
    this.interrupts.push(ref);
  }
  async steerRun(ref: ProviderRunRef, text: string, clientRequestId: string) {
    this.steers.push({ ref, text, clientRequestId });
  }
  async answerInteraction(input: InteractionAnswer) {
    if (input.generation !== this.generation) throw new Error('Expired fixture generation');
    this.answers.push(input);
  }
  subscribeEvents(listener: (event: ProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(type: string, payload: Record<string, unknown>, ref = this.refs.at(-1)) {
    const event: ProviderEvent = {
      type,
      payload,
      generation: this.generation,
      sessionId: ref?.sessionId,
      turnId: ref?.turnId,
    };
    for (const listener of this.listeners) listener(event);
  }
  complete(state = 'completed', ref = this.refs.at(-1)) {
    const turn = ref && this.nativeSessions.get(ref.sessionId)?.turns.find((t) => t.id === ref.turnId);
    if (turn) turn.state = state as typeof turn.state;
    this.emit('run.completed', { state }, ref);
  }
  async close() {
    this.closes++;
  }
}

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export async function until<T>(read: () => T | undefined | false, timeout = 6_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for test state');
}
