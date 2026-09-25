import type {
  AIProviderAdapter,
  AccountState,
  ModelInfo,
  QuotaState,
} from '../../../packages/provider-core/src/index.ts';

type PublicAccount = { account: AccountState; models: ModelInfo[]; quota: QuotaState | null };
type Snapshot = { [K in keyof PublicAccount]: PromiseSettledResult<PublicAccount[K]> };

/** Refresh through an independent official process, including keyring-backed auth.
 * Never read credentials ourselves or recycle an execution/login process for the UI.
 */
export class AccountReader {
  private pending?: Promise<Snapshot>;
  private cached?: Snapshot;
  private expires = 0;
  private revision = 0;
  private closed = false;
  private adapter?: AIProviderAdapter;

  constructor(
    private factory: () => AIProviderAdapter,
    private now = Date.now,
  ) {}

  invalidate() {
    this.revision++;
    this.expires = 0;
  }

  async read<K extends keyof PublicAccount>(key: K): Promise<PublicAccount[K]> {
    if (this.closed) throw new Error('Account reader is closed');
    if (!this.pending && (!this.cached || this.now() >= this.expires)) {
      const revision = this.revision;
      // Concurrent account/models/quota requests share a process and login snapshot.
      this.pending = this.refresh()
        .then((snapshot) => {
          this.cached = snapshot;
          this.expires = revision === this.revision ? this.now() + 10_000 : 0;
          return snapshot;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    const snapshot = this.pending ? await this.pending : this.cached!;
    const result = snapshot[key];
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }

  private async refresh(): Promise<Snapshot> {
    const adapter = this.factory();
    this.adapter = adapter;
    try {
      // A logged-out account must never inherit the previous account's quota.
      const [account] = await Promise.allSettled([adapter.getAccount()]);
      const [models, quota] = await Promise.allSettled([
        adapter.listModels(),
        account.status === 'fulfilled' && account.value.authenticated
          ? adapter.getQuota()
          : Promise.resolve(null),
      ]);
      return { account, models, quota };
    } finally {
      await adapter.close();
      if (this.adapter === adapter) this.adapter = undefined;
    }
  }

  async close() {
    this.closed = true;
    await this.adapter?.close();
    await this.pending?.catch(() => {});
  }
}
