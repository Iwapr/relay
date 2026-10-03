import { uploadInput } from '../apps/agent/src/transfers.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { runInput, cancelInput, answerInput, imageUploadInput } from '../packages/contracts/src/index.ts';
const schemas: Record<string, unknown> = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
  AgentIdentity: {
    type: 'object',
    required: ['agentId', 'protocolVersion', 'uid', 'username', 'home', 'machineId'],
    properties: {
      agentId: { type: 'string' },
      protocolVersion: { type: 'integer' },
      version: { type: 'string' },
      uid: { type: 'integer' },
      username: { type: 'string' },
      home: { type: 'string' },
      codexHome: { type: 'string' },
      machineId: { type: 'string' },
    },
  },
  Event: {
    type: 'object',
    required: ['agentId', 'seq', 'type', 'payload', 'version', 'createdAt'],
    properties: {
      agentId: { type: 'string' },
      seq: { type: 'integer' },
      type: { type: 'string' },
      payload: { type: 'object' },
      version: { const: 1 },
      workspaceId: { type: 'string' },
      conversationId: { type: 'string' },
      runId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  RunInput: {
    ...z.toJSONSchema(runInput),
    anyOf: [
      { properties: { text: { minLength: 1 } } },
      { required: ['imageIds'], properties: { imageIds: { minItems: 1 } } },
    ],
  },
  ImageUploadInput: z.toJSONSchema(imageUploadInput),
  CancelInput: z.toJSONSchema(cancelInput),
  AnswerInput: z.toJSONSchema(answerInput),
};
const paths: Record<string, any> = {};
function route(
  method: string,
  path: string,
  summary: string,
  options: { request?: any; schema?: string; response?: any; anonymous?: boolean; query?: any[] } = {},
) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  if (method === 'post' && path !== '/api/login')
    parameters.push({ name: 'x-csrf-token', in: 'header', required: true, schema: { type: 'string' } });
  if (method === 'post')
    parameters.push({ name: 'Origin', in: 'header', required: true, schema: { type: 'string' } });
  const op: any = {
    summary,
    operationId: method + '_' + path.replace(/[^a-zA-Z0-9]+/g, '_'),
    security: options.anonymous ? [] : [{ cookieAuth: [] }],
    parameters: [...parameters, ...(options.query ?? [])],
    ...(options.request || options.schema
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: options.schema ? { $ref: `#/components/schemas/${options.schema}` } : options.request,
              },
            },
          },
        }
      : {}),
    responses: {
      '200': {
        description: 'Successful response',
        content: { 'application/json': { schema: options.response ?? { type: 'object' } } },
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 429, 503].map((s) => [
          String(s),
          {
            description: (
              {
                400: 'invalid_request',
                401: 'auth_required',
                403: 'permission_denied / path_outside_workspace',
                404: 'not_found',
                409: 'run_conflict / stale_interaction / uncertain_operation / file_changed / snapshot_required',
                429: 'rate_limited',
                503: 'connection_offline / unsupported_feature',
              } as any
            )[s],
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        ]),
      ),
    },
  };
  (paths[path] ??= {})[method] = op;
  return op;
}
const obj = (properties: any, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = { type: 'string' };
const q = (name: string, schema: any = str, required = false) => ({ name, in: 'query', schema, required });
route('post', '/api/login', '登录网站账号', {
  anonymous: true,
  request: obj({ username: str, password: str }),
});
route('post', '/api/logout', '撤销当前会话', { request: obj({}) });
route('get', '/api/me', '读取当前网站身份与 CSRF token');
route('get', '/api/connections', '列出当前 owner 的预置连接');
route('post', '/api/connections', '启用一个管理员预置连接', { request: obj({ profileId: str }) });
const c = '/api/connections/{c}';
route('post', c + '/connect', '建立传输并验证 Agent 身份', { request: obj({}) });
route('get', c + '/identity', '核验并读取实际 Agent 身份', {
  response: { $ref: '#/components/schemas/AgentIdentity' },
});
route('get', c + '/status', '连接状态与诊断');
route('get', c + '/fs/roots', '管理员允许的远端目录根');
route('get', c + '/fs/directories', '逐级选择远端文件夹', {
  query: [
    q('path'),
    q('cursor'),
    q('limit', { type: 'integer', minimum: 1, maximum: 200 }),
    q('hidden', { type: 'boolean' }),
  ],
});
route('get', c + '/workspaces', '最近打开的工作区');
route('post', c + '/fs/directories', '在允许的远端目录下新建项目文件夹（同名返回 409）', {
  request: obj({ parent: str, name: str }, ['parent', 'name']),
});
route('post', c + '/workspaces/open', '打开项目并绑定真实目录身份', {
  request: obj({ path: str }, ['path']),
});
route('post', c + '/workspaces/{w}/images', '上传当前项目的私有图片附件（PNG/JPEG，最大 700 KiB）', {
  schema: 'ImageUploadInput',
});
const imageRead = route('get', c + '/workspaces/{w}/images/{id}', '读取当前用户的项目图片附件');
imageRead.responses['200'].content = Object.fromEntries(
  ['image/png', 'image/jpeg'].map((mime) => [mime, { schema: { type: 'string', format: 'binary' } }]),
);
route(
  'post',
  c + '/workspaces/{w}/uploads',
  '分块上传文件（start/chunk/finish/cancel）；完成时持有项目锁，不覆盖已有文件',
  {
    request: z.toJSONSchema(uploadInput),
  },
);
route(
  'post',
  c + '/workspaces/{w}/files/manage',
  '新建、重命名、移动、复制或删除项目文件；持有项目锁且不覆盖目标',
  {
    request: obj(
      {
        action: { type: 'string', enum: ['file', 'directory', 'rename', 'move', 'copy', 'delete'] },
        path: str,
        target: str,
      },
      ['action'],
    ),
  },
);
route('post', c + '/workspaces/{w}/downloads', '准备单文件或 ZIP 下载，返回有效期 5 分钟的项目内下载 ID', {
  request: obj({
    paths: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', maxLength: 4096 } },
    archive: { type: 'boolean' },
  }),
});
const transferRead = route(
  'get',
  c + '/workspaces/{w}/downloads/{id}',
  '下载临时文件副本，需要当前连接和账号授权',
);
transferRead.responses['200'].content = Object.fromEntries(
  ['application/octet-stream', 'application/zip'].map((mime) => [
    mime,
    { schema: { type: 'string', format: 'binary' } },
  ]),
);
route('get', c + '/workspaces/{w}/tree', '项目只读文件树', {
  query: [q('path'), q('cursor'), q('limit', { type: 'integer' }), q('hidden', { type: 'boolean' })],
});
route('post', c + '/workspaces/{w}/watch', '续期或释放当前目录/预览文件的监听；停止续期后自动过期', {
  request: {
    oneOf: [
      {
        type: 'object',
        required: ['action', 'id'],
        additionalProperties: false,
        properties: { action: { const: 'release' }, id: { type: 'string', format: 'uuid' } },
      },
      {
        type: 'object',
        required: ['action', 'id', 'kind', 'path'],
        additionalProperties: false,
        properties: {
          action: { const: 'renew' },
          id: { type: 'string', format: 'uuid' },
          kind: { enum: ['directory', 'file'] },
          path: { type: 'string', maxLength: 4096 },
        },
      },
    ],
  },
});
route('get', c + '/workspaces/{w}/metadata', '创建固定版本预览快照并读取元数据', {
  query: [q('path', str, true)],
});
const file = route('get', c + '/workspaces/{w}/file', '读取固定版本文件字节，支持单段 Range', {
  query: [q('path', str, true), q('version')],
});
file.parameters.push({ name: 'Range', in: 'header', schema: { type: 'string', example: 'bytes=0-65535' } });
file.responses['200'] = {
  description: 'Full file bytes',
  content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  headers: { 'X-File-Version': { schema: str }, ETag: { schema: str } },
};
file.responses['206'] = {
  description: 'Partial immutable file bytes',
  headers: { 'Content-Range': { schema: str }, 'Accept-Ranges': { schema: { const: 'bytes' } } },
  content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
};
file.responses['416'] = {
  description: 'Requested range is not satisfiable',
  headers: { 'Content-Range': { schema: str } },
};
route('get', c + '/workspaces/{w}/changes', 'Git 差异和非 Git 文件观察记录');
route('get', c + '/workspaces/{w}/conversations', '工作区会话');
route('post', c + '/workspaces/{w}/conversations', '创建工作台自有会话', {
  request: obj({ title: { type: 'string', maxLength: 200 } }, []),
});
route('get', c + '/providers/codex/sessions', '列出共享 Codex 数据目录中所有可访问项目的会话历史', {
  query: [q('cursor', { type: 'string', maxLength: 4096 })],
});
route(
  'post',
  c + '/providers/codex/sessions/import',
  '按原生会话的真实目录打开所属项目并关联会话；返回 workspace 和 conversation',
  {
    request: obj({ threadId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' } }),
  },
);
route('get', c + '/workspaces/{w}/native-sessions', '列出原生 Codex 会话，scope=all 时发现所有可访问项目', {
  query: [
    q('cursor', { type: 'string', maxLength: 4096 }),
    q('scope', { type: 'string', enum: ['workspace', 'all'] }),
  ],
});
route(
  'post',
  c + '/workspaces/{w}/native-sessions/import',
  '关联已有 Codex 会话；保留原生会话 ID，重复打开幂等',
  {
    request: obj(
      {
        threadId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' },
        scope: { type: 'string', enum: ['workspace', 'all'] },
      },
      ['threadId'],
    ),
  },
);
route(
  'get',
  c + '/conversations/{id}',
  '会话状态、消息与分页事件；包含去重后的实时原生历史或可恢复的读取错误',
  {
    query: [q('afterSeq', { type: 'integer' }), q('limit', { type: 'integer', maximum: 1000 })],
  },
);
route('post', c + '/conversations/{id}/reply', '幂等回答问题：运行中追加输入，空闲时提交新任务', {
  schema: 'RunInput',
});
route('post', c + '/conversations/{id}/takeover/preview', '预览占用进程影响的全部会话；确认令牌两分钟有效', {
  request: obj({}),
});
route(
  'post',
  c + '/conversations/{id}/takeover',
  '确认结束占用进程；重新核对进程身份及全部受影响会话，不自动发送任务',
  {
    request: obj({
      token: { type: 'string', format: 'uuid' },
      clientRequestId: { type: 'string', format: 'uuid' },
      confirmed: { const: true },
    }),
  },
);
route('post', c + '/conversations/{id}/runs', '提交幂等任务；ID 相同但负载不同返回409', {
  schema: 'RunInput',
});
route('post', c + '/runs/{id}/rollback/preview', '预览项目最近一轮的文件恢复计划；拒绝后续冲突', {
  request: obj({}),
});
route('post', c + '/runs/{id}/rollback', '按预览恢复项目工作文件并新建执行前的对话分支；原对话保留', {
  request: obj(
    {
      clientRequestId: { type: 'string', format: 'uuid' },
      token: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
    ['clientRequestId', 'token'],
  ),
});
route('post', c + '/conversations/{id}/fork', '从指定已结束轮次创建原生对话分支；不改变文件', {
  request: obj({ turnId: { type: 'string' }, model: { type: 'string' } }, ['turnId', 'model']),
});
route('post', c + '/runs/{id}/cancel', '请求取消，等待上游终态确认', { schema: 'CancelInput' });
route('post', c + '/interactions/{id}/answer', '回应当前进程代际的审批或问题', { schema: 'AnswerInput' });
route('get', c + '/providers', '实际探测可用 Provider');
for (const name of ['account', 'models', 'quota'])
  route('get', c + '/providers/codex/' + name, '读取 Codex ' + name);
route('post', c + '/providers/codex/login', '启动官方设备码登录；活动任务期间拒绝', { request: obj({}) });
route('get', c + '/snapshot', '从 Agent 获取一致状态快照及事件序号');
const events = route('get', c + '/events', 'SSE 持久事件回放；早于保留边界须重新获取快照', {
  query: [q('afterSeq', { type: 'integer', minimum: 0 }), q('agentId')],
});
events.parameters.push({
  name: 'Last-Event-ID',
  in: 'header',
  schema: { type: 'string', example: 'agent-uuid:123' },
});
events.responses['200'] = {
  description: 'Persistent normalized events',
  content: { 'text/event-stream': { schema: { type: 'string' } } },
};
// Account-scoped variants use the same contracts and owner/CSRF protection.
for (const [path, operations] of Object.entries({ ...paths })) {
  if (!path.startsWith(c + '/')) continue;
  const scoped = c + '/accounts/{accountId}' + path.slice(c.length);
  const copy = structuredClone(operations);
  for (const [method, operation] of Object.entries(copy) as Array<[string, any]>) {
    operation.operationId = method + '_' + scoped.replace(/[^a-zA-Z0-9]+/g, '_');
    operation.summary += '（指定 AI 账号；原生会话接口仅适用于 Codex）';
    operation.parameters.push({
      name: 'accountId',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  }
  paths[scoped] = copy;
}
route('get', c + '/providers/codex/accounts', '列出当前连接的 AI 账号档案');
route(
  'post',
  c + '/providers/codex/accounts',
  '添加独立 AI 账号；授权方式由提供方决定，每个提供方最多 8 个账号',
  {
    request: obj(
      {
        label: { type: 'string', minLength: 1, maxLength: 60 },
        provider: {
          type: 'string',
          enum: ['codex', 'kimi', 'claude', 'antigravity', 'deepseek', 'factory'],
          default: 'codex',
        },
      },
      ['label'],
    ),
  },
);
route(
  'post',
  c + '/providers/codex/accounts/{accountId}/delete',
  '删除命名 AI 账号及其独立授权和本地记录；活动任务拒绝删除，共享 Codex 历史与项目文件保留',
  { request: obj({}) },
);
route('post', c + '/providers/codex/login/cancel', '取消当前账号的设备码授权', { request: obj({}) });
route('post', c + '/accounts/{accountId}/providers/codex/login/cancel', '取消指定账号的设备码授权', {
  request: obj({}),
});
for (const name of ['account', 'models', 'quota'])
  route('get', c + '/accounts/{accountId}/providers/kimi/' + name, '读取指定 Kimi Code 账号的 ' + name);
for (const name of ['login', 'login/cancel'])
  route('post', c + '/accounts/{accountId}/providers/kimi/' + name, 'Kimi Code 官方设备码授权：' + name, {
    request: obj({}),
  });
for (const name of ['account', 'models', 'quota'])
  route('get', c + '/accounts/{accountId}/providers/claude/' + name, '读取指定 Claude 订阅账号的 ' + name);
for (const name of ['login', 'login/cancel'])
  route('post', c + '/accounts/{accountId}/providers/claude/' + name, 'Claude 官方订阅授权：' + name, {
    request: obj({}),
  });
route(
  'post',
  c + '/accounts/{accountId}/providers/claude/login/code',
  '将一次性授权码交给此账号的官方 Claude CLI；不保存或回显授权码',
  {
    request: obj(
      {
        code: { type: 'string', minLength: 1, maxLength: 4096, writeOnly: true },
        loginId: { type: 'string', format: 'uuid' },
      },
      ['code', 'loginId'],
    ),
  },
);
for (const name of ['account', 'models', 'quota'])
  route(
    'get',
    c + '/accounts/{accountId}/providers/deepseek/' + name,
    '读取指定 DeepSeek API 账号的 ' + name,
  );
route(
  'post',
  c + '/accounts/{accountId}/providers/deepseek/credentials',
  '验证并保存 DeepSeek 官方 API Key；空字符串移除密钥；活动任务期间拒绝修改，不回显密钥',
  {
    request: obj({ apiKey: { type: 'string', maxLength: 4096, writeOnly: true } }, ['apiKey']),
  },
);
for (const name of ['account', 'models', 'quota'])
  route(
    'get',
    c + '/accounts/{accountId}/providers/factory/' + name,
    '读取指定 Factory Droid API 账号的 ' + name,
  );
route(
  'post',
  c + '/accounts/{accountId}/providers/factory/credentials',
  '保存 Factory 官方 API Key；发送任务时由官方 Droid 验证授权；空字符串移除密钥；活动任务期间拒绝修改，不回显密钥',
  {
    request: obj({ apiKey: { type: 'string', maxLength: 4096, writeOnly: true } }, ['apiKey']),
  },
);
await mkdir('docs', { recursive: true });
await writeFile(
  'docs/openapi.json',
  JSON.stringify(
    {
      openapi: '3.1.0',
      info: {
        title: 'Relay Remote Workbench',
        version: '0.1.0',
        description: '本项目业务接口；不是 OpenAI API。所有远端资源均绑定已授权连接与真实 Agent 身份。',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: '__Host-relay_session',
            description: '仅回环开发模式使用 relay_session',
          },
        },
        schemas,
      },
      paths,
    },
    null,
    2,
  ) + '\n',
);
console.log('Generated docs/openapi.json');
