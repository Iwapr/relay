import { z } from 'zod';
export const PROTOCOL_VERSION = 1;
export const runStates = [
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'waiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'uncertain',
] as const;
export type RunState = (typeof runStates)[number];
export const terminalStates: RunState[] = ['completed', 'failed', 'cancelled', 'interrupted', 'uncertain'];
export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access';
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export interface AgentIdentity {
  agentId: string;
  protocolVersion: number;
  version: string;
  uid: number;
  username: string;
  home: string;
  codexHome: string;
  machineId: string;
}
export interface Workspace {
  id: string;
  agentId: string;
  canonicalRoot: string;
  directoryIdentity: string;
  writable: boolean;
  createdAt: string;
}
export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  titleCustomized?: boolean;
  providerId: string;
  providerSessionId: string | null;
  createdAt: string;
}
export interface Run {
  accountProfile?: string;
  accountLabel?: string;
  images?: ImageAttachment[];
  restorePoint?: { state: 'preparing' | 'ready' | 'unavailable' | 'restored'; reason?: string };
  id: string;
  workspaceId: string;
  conversationId: string;
  state: RunState;
  text: string;
  model: string;
  reasoningEffort: string | null;
  contextUsage?: {
    totalTokens: number;
    contextTokens: number;
    contextWindow: number | null;
    updatedAt: string;
  };
  requestedModel?: string;
  requestedReasoningEffort?: string | null;
  permissionMode: PermissionMode;
  providerTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
export interface Interaction {
  id: string;
  workspaceId: string;
  conversationId: string;
  runId: string;
  generation: string;
  providerRequestId: string | number;
  kind: 'approval' | 'input';
  status: 'pending' | 'resolved' | 'expired';
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface WorkbenchEvent {
  agentId: string;
  seq: number;
  version: 1;
  type: string;
  workspaceId?: string;
  conversationId?: string;
  runId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface FileEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  modifiedAt: number;
}
export interface FileMetadata {
  path: string;
  version: string;
  size: number;
  mime: string;
  etag: string;
  modifiedAt: number;
  expiresAt: number;
  preview: 'pdf' | 'image' | 'markdown' | 'text' | 'download';
}
export const requestId = z.string().uuid();
// Base64 plus metadata stays below the installed reverse proxy's 1 MiB body limit.
export const MAX_IMAGE_BYTES = 700 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_UPLOAD_BODY_LIMIT = 1024 * 1024;
export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  size: number;
  width: number;
  height: number;
}
export const imageUploadInput = z
  .object({
    clientRequestId: requestId,
    name: z.string().trim().min(1).max(200),
    dataUrl: z
      .string()
      .max(IMAGE_UPLOAD_BODY_LIMIT - 1024)
      .regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export const runInput = z
  .object({
    clientRequestId: requestId,
    text: z.string().trim().max(100000),
    imageIds: z.array(requestId).max(MAX_IMAGES).optional(),
    model: z.string().min(1).max(200),
    reasoningEffort: z.string().max(30).nullable().optional(),
    permissionMode: z.enum(['read-only', 'workspace-write', 'full-access']).default('read-only'),
  })
  .strict()
  .refine((input) => !!input.text || !!input.imageIds?.length, '请输入文字或添加图片');
export const cancelInput = z.object({ clientRequestId: requestId }).strict();
export const answerInput = z
  .object({
    clientRequestId: requestId,
    decision: z.enum(['accept', 'decline', 'cancel']).optional(),
    answers: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict();
