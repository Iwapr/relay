import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeepSeekAdapter, deepseekExecutable } from '../../packages/provider-deepseek/src/index.ts';
import type { ProviderEvent } from '../../packages/provider-core/src/index.ts';
import { until } from '../helpers/mock-provider.ts';

test(
  'installed official dsh ACP executes and resumes against an isolated Messages fixture',
  { skip: !existsSync(deepseekExecutable()), timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'relay-dsh-real-'));
    const home = join(root, 'home'),
      project = join(root, 'project');
    await mkdir(home);
    await mkdir(project);
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      assert.equal(req.url, '/anthropic/v1/messages');
      assert.equal(req.headers['x-api-key'], 'test-deepseek-runtime');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', {
        message: {
          id: 'msg-' + requests.length,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      });
      if (requests.length === 1 || requests.length === 4) {
        send('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: 'real-bash', name: 'bash', input: {} },
        });
        send('content_block_delta', {
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              command:
                requests.length === 1
                  ? 'printf full-access-verified > ../outside-workspace.txt'
                  : 'sleep 1.5; printf leaked > ../cancel-leaked.txt',
              description: 'Write the isolated full access fixture file',
            }),
          },
        });
        send('content_block_stop', { index: 0 });
        send('message_delta', {
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 10 },
        });
        send('message_stop', {});
        res.end();
        return;
      }
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'official runtime response ' + requests.length },
      });
      send('content_block_stop', { index: 0 });
      send('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      send('message_stop', {});
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const wrapper = join(root, 'dsh');
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await writeFile(
      wrapper,
      `#!/bin/sh\nexport DEEPSEEK_BASE_URL=${quote(`http://127.0.0.1:${port}/anthropic`)}\nexec ${quote(deepseekExecutable())} "$@" 2>${quote(join(root, 'stderr'))}\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(home, 'relay-credential.json'),
      JSON.stringify({ apiKey: 'test-deepseek-runtime' }),
      { mode: 0o600 },
    );
    const options = { home, cwd: project, executable: wrapper };
    const input = { cwd: project, model: 'deepseek-flash', permissionMode: 'full-access' as const };
    let adapter = new DeepSeekAdapter(options);
    try {
      const session = await adapter.createSession(input);
      for (const text of ['first prompt', 'second prompt']) {
        const events: ProviderEvent[] = [];
        adapter.subscribeEvents((e) => events.push(e));
        await adapter.startRun({ ...input, sessionId: session.id, text });
        await until(() => events.some((e) => e.type === 'run.completed' || e.type === 'run.failed'), 15000);
        assert.equal(
          events.at(-1)?.payload.state,
          'completed',
          JSON.stringify(events) + '\n' + (await readFile(join(root, 'stderr'), 'utf8')),
        );
        assert.match(
          events
            .filter((e) => e.type === 'message.delta')
            .map((e) => e.payload.delta)
            .join(''),
          /official runtime response/,
        );
        await adapter.close();
        if (text === 'first prompt') {
          adapter = new DeepSeekAdapter(options);
          await adapter.resumeSession(session, input);
        }
      }
      assert.equal(requests.length, 3);
      assert.equal(await readFile(join(root, 'outside-workspace.txt'), 'utf8'), 'full-access-verified');
      assert.match(JSON.stringify(requests[2].messages), /first prompt/);
      assert.match(JSON.stringify(requests[2].messages), /official runtime response 2/);
      assert.ok(!JSON.stringify(requests).includes('dsh_session_log'));
      const toolNames = requests[0].tools.map((t: any) => t.name);
      assert.ok(toolNames.includes('bash') && toolNames.includes('write'), toolNames.join(','));
      assert.ok(!toolNames.includes('ask_user_question'));
      adapter = new DeepSeekAdapter(options);
      await adapter.resumeSession(session, input);
      const cancelled: ProviderEvent[] = [];
      adapter.subscribeEvents((e) => cancelled.push(e));
      const ref = await adapter.startRun({
        ...input,
        sessionId: session.id,
        text: 'cancel a real shell task',
      });
      await until(() => cancelled.some((e) => e.type === 'tool.started'), 10000);
      await new Promise((r) => setTimeout(r, 200));
      await adapter.interruptRun(ref);
      assert.equal(cancelled.at(-1)?.payload.state, 'cancelled');
      await adapter.close();
      await new Promise((r) => setTimeout(r, 1700));
      assert.equal(
        existsSync(join(root, 'cancel-leaked.txt')),
        false,
        'cancel must stop tool execution before releasing the task',
      );
    } finally {
      await adapter.close();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
