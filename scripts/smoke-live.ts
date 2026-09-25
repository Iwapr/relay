/** Opt-in, real Codex → Agent → Gateway verification. No mock provider is used. */
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { buildAgent } from '../apps/agent/src/server.ts';
import { AgentConfigSchema } from '../apps/agent/src/config.ts';
import { buildGateway } from '../apps/gateway/src/server.ts';
import { hashPassword } from '../apps/gateway/src/auth.ts';
import type { Run, Interaction, WorkbenchEvent } from '../packages/contracts/src/index.ts';
import type { ModelInfo } from '../packages/provider-core/src/index.ts';
import { codexExecutable } from './codex-executable.ts';

if (!process.argv.includes('--run')) {
  process.stdout.write(
    'Pass --run to execute two real ChatGPT-authenticated Codex tasks in an isolated temporary project. No login or configuration changes are made.\n',
  );
  process.exit(0);
}
const base = await mkdtemp(join(tmpdir(), 'relay-live-'));
const project = join(base, 'project');
const agentState = join(base, 'agent');
await mkdir(project, { mode: 0o700 });
await mkdir(agentState, { mode: 0o700 });
const tokenFile = join(agentState, 'token');
await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const socketPath = join(agentState, 'agent.sock');
const reserve = createServer();
await new Promise<void>((done, reject) => {
  reserve.once('error', reject);
  reserve.listen(0, '127.0.0.1', done);
});
const port = (reserve.address() as { port: number }).port;
await new Promise<void>((done) => reserve.close(() => done()));
const origin = `http://127.0.0.1:${port}`;
const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  noFake: true,
  transport: 'private Unix socket → loopback Gateway HTTP',
  publicDeployment: false,
  steps: [],
};
const steps = report.steps as Array<Record<string, unknown>>;
let agent: Awaited<ReturnType<typeof buildAgent>> | undefined;
let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
const controllers = new Set<AbortController>();
let cookie = '',
  csrf = '';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function log(stage: string) {
  process.stderr.write(`[live smoke] ${stage}\n`);
}
function minimalPdf(version: number): string {
  const stream = `BT /F1 18 Tf 40 80 Td (Remote Workbench Version ${version}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return text;
}
async function request(path: string, body?: unknown, extra: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie,
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
}
async function json<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, body);
  const result = (await response.json()) as T;
  if (!response.ok) throw new Error(`Gateway ${response.status} ${path}: ${JSON.stringify(result)}`);
  return result;
}
const prefix = '/api/connections/live';
async function snapshot() {
  return json<{
    seq: number;
    runs: Run[];
    interactions: Interaction[];
    messages: Array<{ text: string }>;
    identity: { agentId: string };
  }>(`${prefix}/snapshot`);
}
async function waitRun(id: string, terminal: boolean) {
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    const state = await snapshot();
    const run = state.runs.find((run) => run.id === id);
    const pending = state.interactions.filter(
      (interaction) => interaction.runId === id && interaction.status === 'pending',
    );
    if (pending.length) {
      // The test authorizes only in-sandbox apply_patch. An escalation is not automatically granted.
      for (const interaction of pending)
        if (interaction.kind === 'approval')
          await json(`${prefix}/interactions/${interaction.id}/answer`, {
            clientRequestId: randomUUID(),
            decision: 'decline',
          });
      throw new Error(
        'The real task requested an unexpected approval/input; no expanded permission was granted.',
      );
    }
    if (run && ['completed', 'failed', 'cancelled', 'interrupted', 'uncertain'].includes(run.state)) {
      if (run.state !== 'completed') throw new Error(`Real task ${run.state}: ${run.error}`);
      return run;
    }
    if (run && !terminal && run.state === 'running') return run;
    await sleep(350);
  }
  throw new Error('Timed out awaiting the real Agent task');
}
async function openEvents(afterSeq: number) {
  const controller = new AbortController();
  controllers.add(controller);
  const response = await fetch(`${origin}${prefix}/events?afterSeq=${afterSeq}`, {
    headers: { cookie, origin, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  return { controller, reader: response.body!.getReader() };
}
async function readEvents(stream: Awaited<ReturnType<typeof openEvents>>, target: number) {
  let pending = '';
  const events: WorkbenchEvent[] = [];
  const timer = setTimeout(() => stream.controller.abort(), 15000);
  try {
    while (true) {
      const chunk = await stream.reader.read();
      if (chunk.done) break;
      pending += new TextDecoder().decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as WorkbenchEvent);
      }
      if (events.some((event) => event.seq >= target)) return events;
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}
try {
  log('starting private Agent and loopback Gateway');
  agent = await buildAgent(
    AgentConfigSchema.parse({
      stateDir: agentState,
      socketPath,
      tokenFile,
      roots: [project],
      codexExecutable: await codexExecutable({ configured: true }),
    }),
  );
  await agent.app.listen({ path: socketPath });
  await chmod(socketPath, 0o600);
  const password = randomBytes(24).toString('base64url');
  gateway = await buildGateway({
    publicOrigin: origin,
    stateDir: join(base, 'gateway'),
    owner: { id: 'owner', username: 'smoke-owner', passwordHash: await hashPassword(password) },
    profiles: [
      {
        id: 'live',
        ownerId: 'owner',
        label: 'Isolated real Codex smoke',
        tokenFile,
        expectedIdentity: {
          uid: agent.identity.uid,
          username: agent.identity.username,
          home: agent.identity.home,
          agentId: agent.identity.agentId,
          machineId: agent.identity.machineId,
        },
        transport: { kind: 'unix', socketPath },
      },
    ],
    secureCookies: false,
    port,
    host: '127.0.0.1',
  });
  await gateway.listen({ host: '127.0.0.1', port });
  const login = await request('/api/login', { username: 'smoke-owner', password });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
  await json(`${prefix}/connect`, {});
  const account = await json(`${prefix}/providers/codex/account`);
  assert.equal(account.authMode, 'chatgpt');
  assert.equal(account.authenticated, true);
  report.account = {
    authMode: account.authMode,
    planType: account.planType,
    identifierVerified: Boolean(account.identifier),
  };
  const { models } = await json<{ models: ModelInfo[] }>(`${prefix}/providers/codex/models`);
  const model = models.find((model) => model.isDefault) ?? models[0];
  assert.ok(model);
  report.model = { id: model.id, reasoningEffort: model.defaultReasoningEffort };
  const { workspace } = await json(`${prefix}/workspaces/open`, { path: project });
  const { conversation } = await json(`${prefix}/workspaces/${workspace.id}/conversations`, {
    title: 'Real document / PDF smoke',
  });
  const workspacePath = `${prefix}/workspaces/${workspace.id}`;
  const before = await snapshot();
  const stream = await openEvents(0);
  await readEvents(stream, before.seq);
  const firstText = `This is an authorized integration test in the current isolated temporary project. Create only document.md and document.pdf. Use apply_patch only, do not execute shell commands or access network, and do not read or modify anything outside the current directory. document.md must contain exactly:\n\n# Remote Workbench Version 1\n\nInline math: $x^2 + y^2 = z^2$.\n\nDisplay math:\n$$E = mc^2$$\n\nThe PDF must be the following exact ASCII file, preserving line endings and the spaces in xref records. It is a valid one-page PDF. Do not create any other files.\n\n--- BEGIN document.pdf ---\n${minimalPdf(1)}--- END document.pdf ---\n\nAfter creating both files, reply briefly.`;
  log('submitting real Markdown + PDF creation task');
  const body = {
    clientRequestId: randomUUID(),
    text: firstText,
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort,
    permissionMode: 'workspace-write',
  };
  const { run: first } = await json(`${prefix}/conversations/${conversation.id}/runs`, body);
  const repeated = await json(`${prefix}/conversations/${conversation.id}/runs`, body);
  assert.equal(repeated.run.id, first.id);
  await waitRun(first.id, false);
  stream.controller.abort();
  controllers.delete(stream.controller);
  await stream.reader.cancel().catch(() => {});
  log('SSE disconnected while the remote task continues');
  await waitRun(first.id, true);
  const completed = await snapshot();
  const replayStream = await openEvents(before.seq);
  const events = await readEvents(replayStream, completed.seq);
  replayStream.controller.abort();
  controllers.delete(replayStream.controller);
  await replayStream.reader.cancel().catch(() => {});
  assert.ok(events.some((event) => event.runId === first.id && event.type === 'run.completed'));
  assert.ok(events.some((event) => event.runId === first.id && event.type === 'message.delta'));
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq));
  const md1 = await json(`${workspacePath}/metadata?path=document.md`);
  const pdf1 = await json(`${workspacePath}/metadata?path=document.pdf`);
  const mdResponse1 = await request(
    `${workspacePath}/file?path=document.md&version=${encodeURIComponent(md1.version)}`,
  );
  const markdown1 = await mdResponse1.text();
  assert.match(markdown1, /Version 1/);
  assert.match(markdown1, /\$\$E = mc\^2\$\$/);
  const pdfRange1 = await request(
    `${workspacePath}/file?path=document.pdf&version=${encodeURIComponent(pdf1.version)}`,
    undefined,
    { range: 'bytes=0-7' },
  );
  assert.equal(pdfRange1.status, 206);
  assert.equal(await pdfRange1.text(), '%PDF-1.4');
  assert.equal(pdfRange1.headers.get('accept-ranges'), 'bytes');
  const pdfAll1 = Buffer.from(
    await (
      await request(`${workspacePath}/file?path=document.pdf&version=${encodeURIComponent(pdf1.version)}`)
    ).arrayBuffer(),
  );
  const { stdout: pdfInfo1 } = await promisify(execFile)('pdfinfo', [join(project, 'document.pdf')]);
  assert.match(pdfInfo1, /Pages:\s+1\b/);
  steps.push({
    phase: 'create',
    state: 'completed',
    idempotentSubmission: true,
    disconnectedWhileRunning: true,
    replayedEvents: events.length,
    streaming: true,
    markdownMathVerified: true,
    pdfRange: 206,
    pdfPages: 1,
    pdfSha256: createHash('sha256').update(pdfAll1).digest('hex'),
  });
  log('submitting follow-up that updates Markdown and the PDF');
  const { run: second } = await json(`${prefix}/conversations/${conversation.id}/runs`, {
    clientRequestId: randomUUID(),
    text: 'In the same two files document.md and document.pdf, replace the exact ASCII text "Version 1" with "Version 2". Use apply_patch only. The replacement has the same byte length, so PDF xref offsets must remain unchanged. Preserve the Markdown math. Do not touch any other files, do not use shell commands or network, and do not read outside the project. Reply briefly when finished.',
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort,
    permissionMode: 'workspace-write',
  });
  await waitRun(second.id, true);
  const md2 = await json(`${workspacePath}/metadata?path=document.md`);
  const pdf2 = await json(`${workspacePath}/metadata?path=document.pdf`);
  assert.notEqual(md2.version, md1.version);
  assert.notEqual(pdf2.version, pdf1.version);
  const markdown2 = await (
    await request(`${workspacePath}/file?path=document.md&version=${encodeURIComponent(md2.version)}`)
  ).text();
  assert.match(markdown2, /Version 2/);
  assert.match(markdown2, /\$\$E = mc\^2\$\$/);
  const oldPdf = Buffer.from(
    await (
      await request(`${workspacePath}/file?path=document.pdf&version=${encodeURIComponent(pdf1.version)}`)
    ).arrayBuffer(),
  );
  assert.deepEqual(oldPdf, pdfAll1);
  const pdfAll2 = Buffer.from(
    await (
      await request(`${workspacePath}/file?path=document.pdf&version=${encodeURIComponent(pdf2.version)}`)
    ).arrayBuffer(),
  );
  assert.match(pdfAll2.toString('ascii'), /Version 2/);
  assert.notDeepEqual(pdfAll2, pdfAll1);
  const { stdout: pdfInfo2 } = await promisify(execFile)('pdfinfo', [join(project, 'document.pdf')]);
  assert.match(pdfInfo2, /Pages:\s+1\b/);
  const changes = await json(`${workspacePath}/changes`);
  steps.push({
    phase: 'followup',
    state: 'completed',
    newMarkdownVersion: true,
    newPdfVersion: true,
    oldPdfSnapshotImmutable: true,
    pdfPages: 1,
    nonGitProject: changes.git === false,
    changeTrackingAvailable: true,
    pdfSha256: createHash('sha256').update(pdfAll2).digest('hex'),
  });
  report.ok = true;
  log('real end-to-end document loop passed');
} catch (error) {
  report.ok = false;
  report.error = (error as Error).message;
  process.exitCode = 1;
  log(`failed: ${(error as Error).message}`);
} finally {
  for (const controller of controllers) controller.abort();
  await gateway?.close();
  await agent?.app.close();
  await rm(base, { recursive: true, force: true });
  await mkdir(resolve('.runtime/probe'), { recursive: true, mode: 0o700 });
  await writeFile(resolve('.runtime/probe/vertical-report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
