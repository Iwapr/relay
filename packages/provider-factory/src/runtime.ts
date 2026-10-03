import { RunUsageSchema } from '../../contracts/src/index.ts';
import * as sdk from '@factory/droid-sdk/node';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { PermissionMode } from '../../contracts/src/index.ts';
import type { InteractionAnswer } from '../../provider-core/src/index.ts';

type Json = Record<string, any>;
export interface FactoryRequest {
  operation: 'models' | 'run';
  apiKey: string;
  executable: string;
  cwd: string;
  sessionFile?: string;
  model?: string;
  reasoningEffort?: string | null;
  permissionMode?: PermissionMode;
  text?: string;
  images?: Array<{ url: string }>;
}
export interface FactoryBridge {
  emit: (type: string, payload: Json) => void;
  ask: (id: string, payload: Json) => Promise<InteractionAnswer>;
  signal: AbortSignal;
}
export function factoryError(value: unknown): string {
  const text =
    value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value);
  if (/\b403\b/.test(text))
    return 'Factory 拒绝请求（403），请检查服务器网络入口和账号权限；此状态不能单独证明 API Key 无效';
  if (/401|unauth|authentication|api.key|invalid.key/i.test(text))
    return 'Factory 授权不可用，请检查 API Key 和账号权限';
  if (/autonomy|permission.policy/i.test(text))
    return '所选权限被 Factory 账号策略禁止，请选择工具审批或规划模式';
  if (/429|rate.limit|quota|credit|balance|billing|usage.exhausted/i.test(text))
    return 'Factory 额度不足或请求受限，请在官方账号中查看额度';
  if (/ENOENT|ELOOP|executable|not found/i.test(text))
    return 'Droid 未正确安装，请运行 npm run install:factory';
  if (/timeout|timed.out|超时/i.test(text)) return 'Factory 请求超时，请检查网络和已有任务结果';
  return 'Factory Droid 未完成任务，请检查账号、模型及工具结果';
}
/** Runs only in an account-isolated worker; driver injection keeps protocol adaptation testable. */
export async function runFactory(
  request: FactoryRequest,
  bridge: FactoryBridge,
  driver: Pick<typeof sdk, 'listModels' | 'createSession' | 'resumeSession'> = sdk,
) {
  const common = { apiKey: request.apiKey, execPath: request.executable, abortSignal: bridge.signal };
  if (request.operation === 'models') {
    const models = await driver.listModels({
      apiKey: request.apiKey,
      execPath: request.executable,
      cwd: request.cwd,
    });
    return {
      models: models
        .filter((m) => !m.disabled && !m.isCustom)
        .map((m, i) => ({
          id: m.id,
          displayName: m.displayName,
          description: 'Factory Droid · ' + m.modelProvider,
          isDefault: i === 0,
          supportsImages: m.noImageSupport !== true,
          reasoningEfforts: m.supportedReasoningEfforts,
          defaultReasoningEffort: m.defaultReasoningEffort,
        })),
    };
  }
  const permissionHandler: NonNullable<sdk.CreateSessionOptions['permissionHandler']> = async (params) => {
    if (bridge.signal.aborted) return sdk.ToolConfirmationOutcome.Cancel;
    const allowed = params.options.some((o) => o.value === sdk.ToolConfirmationOutcome.ProceedOnce);
    if (request.permissionMode === 'full-access' && allowed) return sdk.ToolConfirmationOutcome.ProceedOnce;
    const id = randomUUID();
    const plan = params.toolUses.some((u) => u.details.type === 'exit_spec_mode');
    const answer = await bridge.ask(id, {
      requestId: id,
      kind: 'approval',
      reason: plan ? 'Droid 请求批准计划并继续执行' : 'Droid 请求工具审批',
      command: JSON.stringify(
        params.toolUses.map((u) => ({ name: u.toolUse.name, input: u.toolUse.input, details: u.details })),
      ),
      cwd: request.cwd,
    });
    return answer.decision === 'accept' && allowed
      ? sdk.ToolConfirmationOutcome.ProceedOnce
      : sdk.ToolConfirmationOutcome.Cancel;
  };
  const askUserHandler: NonNullable<sdk.CreateSessionOptions['askUserHandler']> = async (params) => {
    if (bridge.signal.aborted) return { cancelled: true, answers: [] };
    const id = randomUUID();
    const answer = await bridge.ask(id, {
      requestId: id,
      kind: 'input',
      reason: 'Droid 需要补充信息',
      questions: params.questions.map((q) => ({
        id: String(q.index),
        question: q.question,
        options: q.options.map((label) => ({ label })),
        multiSelect: q.multiSelect ?? false,
      })),
    });
    if (!answer.answers) return { cancelled: true, answers: [] };
    return {
      answers: params.questions.map((q) => ({
        index: q.index,
        question: q.question,
        answer: (answer.answers?.[String(q.index)] ?? []).join(', '),
      })),
    };
  };
  const settings = {
    modelId: request.model!,
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort as sdk.ReasoningEffort } : {}),
    interactionMode:
      request.permissionMode === 'read-only' ? sdk.DroidInteractionMode.Spec : sdk.DroidInteractionMode.Auto,
    autonomyLevel: request.permissionMode === 'full-access' ? sdk.AutonomyLevel.High : sdk.AutonomyLevel.Off,
  };
  const options = { ...common, permissionHandler, askUserHandler };
  const record = JSON.parse(await readFile(request.sessionFile!, 'utf8'));
  if (record.cwd !== resolve(request.cwd)) throw new Error('Session workspace mismatch');
  let session: sdk.DroidSession | undefined;
  try {
    session = record.nativeId
      ? await driver.resumeSession(record.nativeId, options)
      : await driver.createSession({ ...options, ...settings, cwd: request.cwd });
    if (resolve(session.cwd ?? '') !== resolve(request.cwd)) throw new Error('Session workspace mismatch');
    if (record.nativeId && session.id !== record.nativeId) throw new Error('Session identity mismatch');
    if (!record.nativeId) {
      const temp = request.sessionFile! + '.' + randomUUID();
      await writeFile(temp, JSON.stringify({ ...record, nativeId: session.id }), { mode: 0o600 });
      await rename(temp, request.sessionFile!);
    }
    const allowedLevels = session.settings.availableAutonomyLevels;
    if (allowedLevels && !allowedLevels.includes(settings.autonomyLevel))
      throw new Error('Factory autonomy level denied by permission policy');
    await session.updateSettings(settings);
    bridge.emit('ready', {});
    bridge.emit('run.settings', {
      model: session.settings.modelId,
      reasoningEffort: session.settings.reasoningEffort ?? null,
    });
    const images = request.images?.map(({ url }) => {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (!match) throw new Error('Invalid image');
      return {
        type: 'base64' as const,
        mediaType: match[1] as 'image/png' | 'image/jpeg' | 'image/webp',
        data: match[2],
      };
    });
    let outcome: { state: string; error?: string } | undefined;
    for await (const event of session.stream(request.text!, {
      includePartialMessages: true,
      abortSignal: bridge.signal,
      ...(images?.length ? { images } : {}),
    })) {
      switch (event.type) {
        case 'assistant_text_delta':
          bridge.emit('message.delta', { itemId: event.messageId, delta: event.text });
          break;
        case 'assistant':
          bridge.emit('message.completed', { itemId: event.message.id, text: event.text });
          break;
        case 'assistant_message_retracted':
          bridge.emit('message.completed', { itemId: event.messageId, text: '' });
          break;
        case 'tool_call':
          bridge.emit('tool.started', {
            itemId: event.toolUseId,
            name: event.name,
            title: event.name,
            arguments: event.input,
          });
          break;
        case 'tool_result':
          bridge.emit('tool.completed', {
            itemId: event.toolUseId,
            status: event.isError ? 'failed' : 'completed',
            text: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
          });
          break;
        case 'tool_progress':
          bridge.emit('tool.output', { itemId: event.toolUseId, output: event.content });
          break;
        case 'result': {
          const usage = RunUsageSchema.safeParse(event.tokenUsage);
          if (usage.success) bridge.emit('usage.updated', { usage: usage.data });
          outcome = event.success
            ? { state: 'completed' }
            : event.subtype === 'interrupted'
              ? { state: 'cancelled' }
              : { state: 'failed', error: factoryError(event.error) };
          break;
        }
      }
    }
    return bridge.signal.aborted
      ? { state: 'cancelled' }
      : (outcome ?? { state: 'failed', error: 'Droid 未返回任务结束状态，请检查已有结果' });
  } finally {
    await session?.close();
  }
}
