import { providerAccountQuotaSchema, type ProviderAccountQuota } from "@lcode/shared";
import type { AuthDriver, AuthDriverContext } from "@lcode/provider-node";
import type { StoredAccount } from "./providerAccountStoreSchema.js";
import { normalizeProviderAccountQuota } from "./providerAccountQuotaNormalization.js";

interface QuotaHost {
  read(): Promise<StoredAccount[]>;
  driver(account: StoredAccount): Promise<AuthDriver>;
  context(account: StoredAccount, signal: AbortSignal): AuthDriverContext;
  track(id: string): AbortController;
  untrack(id: string, controller: AbortController): void;
  withAccountLock<T>(account: StoredAccount, operation: () => Promise<T>): Promise<T>;
  closed(): boolean;
}
interface CachedQuota {
  routingEpoch: number;
  revision: number;
  generation: number;
  expiresAt: number;
  value: ProviderAccountQuota;
}
interface Flight {
  generation: number;
  promise: Promise<ProviderAccountQuota>;
  controller: AbortController;
}
const TTL = 60_000;
const TIMEOUT = 30_000;

function lastSuccessfulReading(previous?: ProviderAccountQuota): Partial<ProviderAccountQuota> {
  if (!previous?.checkedAt) return {};
  // 失败只能回显同一账号上一份成功事实，账期和部分成功标记须与其窗口一起保留。
  const { windows, checkedAt, plan, balance, partial, planExpiresAt, renewal } = previous;
  return {
    windows,
    checkedAt,
    stale: true,
    ...(plan ? { plan } : {}),
    ...(balance ? { balance } : {}),
    ...(partial ? { partial } : {}),
    ...(planExpiresAt ? { planExpiresAt } : {}),
    ...(renewal ? { renewal } : {}),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Quota read cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Host-owned transient cache. Credentials and last-success readings never leave their account. */
export class ProviderAccountQuotas {
  #revision = 0;
  readonly #cache = new Map<string, CachedQuota>();
  readonly #flights = new Map<string, Flight>();
  constructor(
    private readonly host: QuotaHost,
    private readonly now = Date.now,
  ) {}

  peek(
    connectionId: string,
    generation: number,
    routingEpoch?: number,
  ): { revision: number; value: ProviderAccountQuota } | undefined {
    const cached = this.#cache.get(connectionId);
    // token 轮换不是新额度；只有授权身份代次相同才允许调度投影继续使用旧读数。
    if (
      !cached ||
      (routingEpoch !== undefined
        ? cached.routingEpoch !== routingEpoch
        : cached.generation !== generation)
    )
      return undefined;
    return {
      revision: cached.revision,
      value: { ...cached.value, stale: cached.value.stale || cached.expiresAt <= this.now() },
    };
  }

  invalidate(connectionId: string): void {
    this.#flights.get(connectionId)?.controller.abort();
    this.#flights.delete(connectionId);
    this.#cache.delete(connectionId);
  }
  dispose(): void {
    for (const id of this.#flights.keys()) this.invalidate(id);
    this.#cache.clear();
  }
  #empty(
    connectionId: string,
    status: ProviderAccountQuota["status"],
    channelId?: string,
  ): ProviderAccountQuota {
    return {
      connectionId,
      ...(channelId ? { channelId } : {}),
      source: "upstream",
      status,
      windows: [],
      stale: false,
    };
  }
  async get(connectionId: string, force = false): Promise<ProviderAccountQuota> {
    if (!connectionId || typeof connectionId !== "string" || typeof force !== "boolean")
      throw new Error("Invalid quota request");
    if (this.host.closed())
      return { ...this.#empty(connectionId, "error"), error: "service_closed" };
    const account = (await this.host.read()).find((a) => a.connectionId === connectionId);
    if (!account || !account.enabled) {
      this.invalidate(connectionId);
      return this.#empty(connectionId, account ? "disabled" : "removed", account?.channelId);
    }
    const cached = this.#cache.get(connectionId);
    if (!force && cached?.generation === account.generation && cached.expiresAt > this.now())
      return structuredClone(cached.value);
    const existing = this.#flights.get(connectionId);
    if (existing?.generation === account.generation) return structuredClone(await existing.promise);
    // 外部窗口已推进凭据版本时，旧读取即使忽略取消，也没有写缓存的资格。
    existing?.controller.abort();
    const controller = this.host.track(connectionId);
    const flight = { generation: account.generation, controller } as Flight;
    const previous = cached?.generation === account.generation ? cached.value : undefined;
    flight.promise = this.#read(account, flight, previous)
      .catch(() => ({
        ...this.#empty(connectionId, "error", account.channelId),
        error: "request_failed" as const,
        attemptedAt: new Date(this.now()).toISOString(),
        ...lastSuccessfulReading(previous),
      }))
      .finally(() => {
        // 最终本地复读或DTO校验也可能失败；所有终态都须释放flight，避免手动刷新永久复用拒绝结果。
        if (this.#flights.get(connectionId) === flight) this.#flights.delete(connectionId);
      });
    this.#flights.set(connectionId, flight);
    return structuredClone(await flight.promise);
  }
  async #read(
    account: StoredAccount,
    flight: Flight,
    previous?: ProviderAccountQuota,
  ): Promise<ProviderAccountQuota> {
    const { connectionId, channelId } = account,
      { controller } = flight;
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    let generation = account.generation;
    let reading: ReturnType<typeof normalizeProviderAccountQuota>;
    let changed = false;
    const current = async () =>
      (await this.host.read()).find((a) => a.connectionId === connectionId);
    const assertCurrent = async () => {
      controller.signal.throwIfAborted();
      const latest = await current();
      if (!latest?.enabled || latest.generation !== generation || latest.channelId !== channelId) {
        changed = true;
        throw new Error("Stale quota read");
      }
      return latest;
    };
    try {
      const operation = this.host.withAccountLock(account, async () => {
        const latest = await assertCurrent();
        const driver = await this.host.driver(latest);
        if (!driver.quota) return { status: "unsupported" };
        const context = this.host.context(latest, controller.signal);
        return driver.quota({
          ...context,
          read: async () => {
            await assertCurrent();
            return context.read();
          },
          write: async (grant) => {
            await assertCurrent();
            await context.write(grant);
            // 当前quota自行刷新token是同一读取；只有这次CAS成功可接受下一代凭据。
            generation++;
            flight.generation = generation;
          },
        });
      });
      const raw = await abortable(operation, controller.signal);
      await assertCurrent();
      reading = normalizeProviderAccountQuota(channelId, raw, this.now());
    } catch {
      reading = {
        status: "error",
        windows: [],
        error: changed ? "account_changed" : "request_failed",
      };
    } finally {
      clearTimeout(timer);
      this.host.untrack(connectionId, controller);
    }
    const latest = await current();
    if (this.host.closed() || !latest || !latest.enabled) {
      return this.host.closed()
        ? { ...this.#empty(connectionId, "error", channelId), error: "service_closed" }
        : this.#empty(connectionId, latest ? "disabled" : "removed", channelId);
    }
    if (
      latest.generation !== generation ||
      latest.channelId !== channelId ||
      this.#flights.get(connectionId) !== flight
    ) {
      return { ...this.#empty(connectionId, "error", channelId), error: "account_changed" };
    }
    const attemptedAt = new Date(this.now()).toISOString();
    const value = providerAccountQuotaSchema.parse({
      ...this.#empty(connectionId, reading.status, channelId),
      ...reading,
      attemptedAt,
      ...(reading.status === "ready" ? { checkedAt: attemptedAt } : {}),
      ...(reading.status === "error" ? lastSuccessfulReading(previous) : {}),
    });
    this.#cache.set(connectionId, {
      routingEpoch: latest.routingEpoch ?? 0,
      revision: ++this.#revision,
      generation,
      expiresAt: this.now() + TTL,
      value,
    });
    return value;
  }
}
