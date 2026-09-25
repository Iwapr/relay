/** Isolated browser fixture. Production entry points never import this provider. */
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { AgentConfigSchema } from '../../apps/agent/src/config.ts';
import { buildAgent } from '../../apps/agent/src/server.ts';
import { buildGateway } from '../../apps/gateway/src/server.ts';
import { hashPassword } from '../../apps/gateway/src/auth.ts';
import { claudeExecutable } from '../helpers/claude-process.ts';
import { kimiExecutable } from '../helpers/kimi-process.ts';
import { MockProvider } from '../helpers/mock-provider.ts';
import type {
  InteractionAnswer,
  NativeSessionHistory,
  ProviderRunRef,
  StartRunInput,
} from '../../packages/provider-core/src/index.ts';

class BrowserFixtureProvider extends MockProvider {
  onLogin?: () => void;
  private loginPending = false;
  async beginLogin() {
    if (!this.loginPending) {
      this.loginPending = true;
      this.later(() => {
        if (!this.loginPending) return;
        this.loginPending = false;
        this.account = {
          authenticated: true,
          authMode: 'chatgpt',
          identifier: 'second@example.test',
          planType: 'pro',
          requiresOpenaiAuth: true,
        };
        this.onLogin?.();
        this.emit('account.updated', { loginCompleted: true, success: true });
      }, 1500);
    }
    return {
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-1234',
      loginId: 'fixture-login',
    };
  }
  async cancelLogin() {
    this.loginPending = false;
  }

  override persistNativeHistory = true;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private later(callback: () => void, ms = 100) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
  }
  override async startRun(input: StartRunInput) {
    const ref = await super.startRun(input);
    if (process.env.RELAY_RECORD_MEDIA === '1' && input.text === '请总结项目说明，并列出下一步。') {
      this.later(() => {
        this.emit(
          'message.completed',
          {
            itemId: 'demo-response',
            text: '## 项目进展\n\n资料整理和第一版文档已经完成。先完成图表和公式检查，再导出报告。\n\n### 接下来\n\n1. 打开右侧 **README.md**，核对本周计划。\n2. 检查公式与代码示例的显示。\n3. 导出报告，交给协作者审阅。\n\n> 这是隔离演示数据，不读取真实账号或项目。',
          },
          ref,
        );
        this.complete('completed', ref);
      });
      return ref;
    }

    if (input.text === '文件回滚测试') await writeFile(join(this.cwd, 'rollback.txt'), 'changed by fixture');
    this.later(() => {
      this.emit(
        'message.delta',
        { itemId: 'response', delta: '这是仅用于浏览器自动化验收的测试响应。' },
        ref,
      );
      if (input.images?.length) {
        if (!input.images.every((image) => image.url.startsWith('data:image/')))
          throw new Error('Expected image bytes');
        this.emit(
          'message.completed',
          { itemId: 'response', text: `测试提供方收到了 ${input.images.length} 张图片内容。` },
          ref,
        );
        this.complete('completed', ref);
        return;
      }
      if (input.text === '文件链接预览测试') {
        this.emit(
          'message.completed',
          {
            itemId: 'response',
            text: [
              `[绝对路径图片](<${this.cwd}/figure.png>)`,
              '[相对路径文档](README.md)',
              `[绝对路径 PDF](<${this.cwd}/paper.pdf>)`,
              `[项目外截图](<${previewDirectory}/figure.png>)`,
              `[项目外 PDF](<${previewDirectory}/paper.pdf>)`,
              `[项目外文档](<${previewDirectory}/guide.md>)`,
              `[已清理截图](<${previewDirectory}/missing.png>)`,
              '[范围外文件](/etc/hosts)',
            ].join('\n\n'),
          },
          ref,
        );
        this.complete('completed', ref);
        return;
      }
      if (input.text.startsWith('复制选择测试')) {
        this.emit(
          'message.completed',
          {
            itemId: 'response',
            text: '## 稳定的标题\n\n```bash\necho "保持选区"\nprintf "second"\n```\n\n[项目文件](README.md)',
          },
          ref,
        );
        this.later(
          () =>
            this.emit(
              'message.completed',
              {
                itemId: 'response',
                text: '## 稳定的标题\n\n```bash\necho "保持选区，流式新增"\nprintf "second"\n```\n\n[项目文件](README.md)',
              },
              ref,
            ),
          8000,
        );
        return;
      }
      if (input.text === '异步问题测试') {
        this.emit(
          'message.completed',
          {
            itemId: 'question',
            text: '选择方案',
            questions: [{ title: '选择方案', options: ['方案 A', '方案 B'] }],
          },
          ref,
        );
        return;
      }
      if (input.text.includes('审批'))
        this.emit(
          'interaction.required',
          {
            requestId: ref.turnId,
            kind: 'approval',
            command: 'printf "browser-fixture"',
            reason: '测试审批交互；不执行真实命令',
          },
          ref,
        );
      else this.complete('completed', ref);
    });
    return ref;
  }
  override async steerRun(ref: ProviderRunRef, text: string, clientRequestId: string) {
    await super.steerRun(ref, text, clientRequestId);
    this.later(() => this.complete('completed', ref));
  }
  override async answerInteraction(input: InteractionAnswer) {
    await super.answerInteraction(input);
    const ref = this.refs.at(-1)!;
    this.later(() => {
      this.emit('interaction.resolved', { requestId: input.requestId }, ref);
      this.emit(
        'message.completed',
        {
          itemId: 'response',
          text: input.decision === 'accept' ? '测试审批已收到，任务结束。' : '测试审批被拒绝，未执行命令。',
        },
        ref,
      );
      this.complete(input.decision === 'cancel' ? 'cancelled' : 'completed', ref);
    });
  }
  override async interruptRun(ref: ProviderRunRef) {
    await super.interruptRun(ref);
    this.later(() => this.complete('cancelled', ref));
  }
  override async close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
function samplePdf(): Buffer {
  const content =
    'BT /F1 20 Tf 50 740 Td (Relay document preview) Tj 0 -30 Td (Page one - selectable text) Tj ET';
  const content2 = 'BT /F1 20 Tf 50 740 Td (Second page) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  }
  // Keep real PDF objects valid while requiring non-contiguous range loading.
  pdf += '%' + 'padding'.repeat(300_000) + '\n';
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'relay-browser-'));
const claudeFixtureExecutable = await claudeExecutable(directory);
const kimiFixtureExecutable = await kimiExecutable(directory);
const projects = join(directory, 'projects');
const previewDirectory = join(directory, 'preview-only');
await mkdir(previewDirectory);
await writeFile(
  join(previewDirectory, 'guide.md'),
  '# 临时文档预览\n\n![临时图片](figure.png)\n\n[临时 PDF](paper.pdf)',
);
const primary = join(projects, '论文 项目');
const secondary = join(projects, '第二项目');
const browsing = join(projects, '目录 点击测试');
const nested = join(browsing, '嵌套 资料');
const tasks = { desktop: join(projects, '桌面任务项目'), mobile: join(projects, '手机任务项目') };
const shared = {
  desktop: { path: join(projects, '桌面共享会话'), threadId: randomUUID() },
  mobile: { path: join(projects, '手机共享会话'), threadId: randomUUID() },
};
const nativeFixtures: NativeSessionHistory[] = Object.values(shared).flatMap(({ path, threadId }) => [
  {
    id: threadId,
    cwd: path,
    title: 'IDE 中的共享测试会话',
    updatedAt: new Date().toISOString(),
    model: 'fixture-model',
    source: 'vscode',
    status: 'idle',
    turns: [
      {
        id: randomUUID(),
        state: 'completed',
        userText: '这是在 IDE 中写入的测试提问。',
        messages: [{ id: randomUUID(), kind: 'assistant', text: '这是 IDE 原有的测试回复。' }],
      },
    ],
  },
  {
    id: randomUUID(),
    cwd: path,
    title: '更早的共享测试会话',
    updatedAt: new Date().toISOString(),
    source: 'vscode',
    status: 'idle',
    turns: [],
  },
]);
for (const path of [
  projects,
  primary,
  secondary,
  nested,
  ...Object.values(tasks),
  ...Object.values(shared).map((item) => item.path),
  resolve('.runtime/e2e'),
])
  await mkdir(path, { recursive: true, mode: 0o700 });
for (const path of [projects, browsing, nested])
  await writeFile(join(path, '普通 文件.txt'), '这是普通文件，不应出现在目录选择器中。');
await writeFile(join(nested, 'README.md'), '# 点击目录打开成功\n\n中文与空格路径均正确。\n');
const markdown =
  '# 移动文档工作台\n\n远端文件读取，保持专注。\n\n## 数学公式\n\n$E=mc^2$\n\n$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$\n\n![项目图片](figure.png)\n\n![外部追踪](https://untrusted.invalid/track.png)\n\n[打开说明](notes.txt)\n\n<script>window.__relayXss=1</script>\n\n<img src=x onerror="window.__relayXss=2">\n\n[危险链接](javascript:window.__relayXss=3)\n';
for (const path of [primary, secondary, previewDirectory]) {
  await writeFile(join(path, 'README.md'), markdown);
  await writeFile(join(path, 'notes.txt'), '远端中文文件 · plain text');
  await writeFile(join(path, 'paper.pdf'), samplePdf());
  await writeFile(
    join(path, 'figure.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9KkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
}
const agents: (Awaited<ReturnType<typeof buildAgent>> & {
  id: string;
  stateDir: string;
  tokenFile: string;
  socketPath: string;
})[] = [];
const authorizedHomes = new Set<string>();
for (const id of ['a', 'b']) {
  const stateDir = join(directory, 'agent-' + id);
  const tokenFile = join(directory, id + '.token');
  const socketPath = join(directory, id + '.sock');
  await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const agent = await buildAgent(
    AgentConfigSchema.parse({
      stateDir,
      socketPath,
      tokenFile,
      roots: [projects],
      codexExecutable: '/not-used-by-test-fixture',
      kimiExecutable: kimiFixtureExecutable,
      claudeExecutable: claudeFixtureExecutable,
      codexHome: join(directory, 'shared-codex-' + id),
      maxProviders: 4,
      maxPreviewBytes: 5 * 1024 * 1024,
      allowRoot: false,
    }),
    (cwd, home, authHome) => {
      const provider = new BrowserFixtureProvider(cwd);
      provider.nativeSessionPageSize = 1;
      for (const session of nativeFixtures) provider.nativeSessions.set(session.id, session);
      if (authHome?.includes('/accounts/')) {
        provider.account = authorizedHomes.has(authHome)
          ? {
              authenticated: true,
              authMode: 'chatgpt',
              identifier: 'second@example.test',
              planType: 'pro',
              requiresOpenaiAuth: true,
            }
          : {
              authenticated: false,
              authMode: null,
              identifier: null,
              planType: null,
              requiresOpenaiAuth: true,
            };
        provider.onLogin = () => authorizedHomes.add(authHome);
      }
      if (id === 'b')
        provider.account = {
          authenticated: true,
          authMode: 'apikey',
          identifier: null,
          planType: null,
          requiresOpenaiAuth: false,
        };
      return provider;
    },
  );
  await agent.app.listen({ path: socketPath });
  await chmod(socketPath, 0o600);
  agents.push({ ...agent, id, stateDir, tokenFile, socketPath });
}
const gateway = await buildGateway({
  publicOrigin: 'http://127.0.0.1:4399',
  port: 4399,
  stateDir: join(directory, 'gateway'),
  secureCookies: false,
  staticDir: resolve('apps/web/dist'),
  owner: { id: 'owner', username: 'owner', passwordHash: await hashPassword('browser-fixture-password') },
  profiles: agents.map((a) => ({
    id: a.id,
    ownerId: 'owner',
    label: a.id === 'a' ? '测试连接 A' : '测试连接 B',
    tokenFile: a.tokenFile,
    expectedIdentity: {
      uid: a.identity.uid,
      username: a.identity.username,
      home: a.identity.home,
      agentId: a.identity.agentId,
      machineId: a.identity.machineId,
    },
    transport: { kind: 'unix' as const, socketPath: a.socketPath },
  })),
});
const login = await gateway.inject({
  method: 'POST',
  url: '/api/login',
  headers: { host: '127.0.0.1:4399', origin: 'http://127.0.0.1:4399' },
  payload: { username: 'owner', password: 'browser-fixture-password' },
});
if (login.statusCode !== 200) throw new Error('Browser fixture login failed: ' + login.body);
const cookies = login.cookies.map(({ name, value }) => ({
  name,
  value,
  url: 'http://127.0.0.1:4399',
  httpOnly: true,
  sameSite: 'Strict',
}));
await writeFile(
  resolve('.runtime/e2e/fixture.json'),
  JSON.stringify({ primary, secondary, projects, browsing, nested, tasks, shared, cookies }),
  { mode: 0o600 },
);
await chmod(resolve('.runtime/e2e/fixture.json'), 0o600);
await gateway.listen({ port: 4399, host: '127.0.0.1' });
console.log('Browser fixture ready (test provider only).');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await gateway.close();
  await Promise.all(agents.map((a) => a.app.close()));
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
