import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../contracts/src/index.ts';
import { CodexRpc } from './protocol.ts';
import type { GetAccountResponse } from '../../../generated/codex/v2/GetAccountResponse.ts';
import type { LoginAccountResponse } from '../../../generated/codex/v2/LoginAccountResponse.ts';
import type { ChatgptAuthTokensRefreshResponse } from '../../../generated/codex/v2/ChatgptAuthTokensRefreshResponse.ts';

/** One official managed-auth process per Relay profile. Never uses the shared home's auth cache. */
export class CodexAuthBroker {
  private rpc: CodexRpc;
  private ready?: Promise<void>;
  private refresh?: Promise<void>;
  private needsLogin = false;
  private listeners = new Set<(message: Record<string, unknown>) => void>();
  constructor(private options: { home: string; executable: string }) {
    this.rpc = this.createRpc();
  }
  private createRpc() {
    const options = this.options;
    const rpc = new CodexRpc(
      {
        cwd: options.home,
        codexHome: options.home,
        executable: options.executable,
        isolatedAuth: true,
        isolatedState: true,
        taskUmask: '0022',
        args: [
          '-c',
          'cli_auth_credentials_store="file"',
          '-c',
          'features.apps=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.memories=false',
          '-c',
          'memories.generate_memories=false',
          '-c',
          'memories.use_memories=false',
        ],
      },
      (message) => {
        if (
          message.method === 'account/login/completed' &&
          (message.params as { success?: boolean })?.success
        )
          this.needsLogin = false;
        if (!('id' in message)) for (const listener of this.listeners) listener(message);
      },
      () => {
        if (this.rpc === rpc) {
          this.ready = undefined;
          for (const listener of this.listeners)
            listener({
              method: 'account/login/completed',
              params: {
                loginId: null,
                success: false,
                error: '授权进程已退出，请重新开始官方登录。',
              },
            });
        }
      },
    );
    return rpc;
  }
  subscribe(listener: (message: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private async connect() {
    this.ready ??= (async () => {
      await this.rpc.close();
      this.rpc = this.createRpc();
      await this.rpc.open();
      await this.rpc.request(
        'initialize',
        {
          clientInfo: { name: 'relay_auth_broker', title: 'Relay account authorization', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        'v1/InitializeResponse',
      );
      this.rpc.send({ method: 'initialized' });
    })().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
  async account(refreshToken = false): Promise<GetAccountResponse> {
    await this.connect();
    if (this.needsLogin && !refreshToken) return { account: null, requiresOpenaiAuth: true };
    return this.rpc.request('account/read', { refreshToken }, 'v2/GetAccountResponse');
  }
  async login(): Promise<LoginAccountResponse> {
    await this.connect();
    return this.rpc.request('account/login/start', { type: 'chatgptDeviceCode' }, 'v2/LoginAccountResponse');
  }
  async cancel(loginId: string) {
    await this.connect();
    return this.rpc.request('account/login/cancel', { loginId }, 'v2/CancelLoginAccountResponse');
  }
  private async cache(): Promise<{ value: ChatgptAuthTokensRefreshResponse; expires: number }> {
    const file = await open(join(this.options.home, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 1024 * 1024)
        throw new Error('Unsafe credential cache');
      const data = JSON.parse(await file.readFile('utf8'));
      const tokens = data.tokens;
      if (
        data.auth_mode !== 'chatgpt' ||
        typeof tokens?.access_token !== 'string' ||
        typeof tokens?.account_id !== 'string'
      )
        throw new Error('Missing ChatGPT credentials');
      const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
      if (claims['https://api.openai.com/auth']?.chatgpt_account_id !== tokens.account_id)
        throw new Error('Credential account mismatch');
      return {
        value: {
          accessToken: tokens.access_token,
          chatgptAccountId: tokens.account_id,
          chatgptPlanType: claims['https://api.openai.com/auth']?.chatgpt_plan_type ?? null,
        },
        expires: claims.exp ?? 0,
      };
    } finally {
      await file.close();
    }
  }
  async tokens(force = false, previousAccountId?: string | null): Promise<ChatgptAuthTokensRefreshResponse> {
    try {
      const account = await this.account();
      if (account.account?.type !== 'chatgpt') throw new Error('Login required');
      let cached = await this.cache();
      // Reject identity changes before refreshing or supplying any credential to a worker.
      if (previousAccountId && cached.value.chatgptAccountId !== previousAccountId)
        throw new AppError('ACCOUNT_CHANGED', '所选账号身份已变化，请重新选择账号。', 409);
      if (force || cached.expires < Date.now() / 1000 + 60) {
        this.refresh ??= this.account(true)
          .then(() => {})
          .finally(() => {
            this.refresh = undefined;
          });
        await this.refresh;
        cached = await this.cache();
      }
      if (
        cached.expires <= Date.now() / 1000 ||
        (previousAccountId && cached.value.chatgptAccountId !== previousAccountId)
      )
        throw new Error('Invalid refreshed credentials');
      return cached.value;
    } catch (error) {
      if (error instanceof AppError && error.code === 'ACCOUNT_CHANGED') throw error;
      this.needsLogin = true;
      throw new AppError(
        'CHATGPT_LOGIN_REQUIRED',
        '此账号授权不可用，请在该账号配置中重新完成官方登录。',
        409,
      );
    }
  }
  async close() {
    await this.rpc.close();
    this.listeners.clear();
  }
}
