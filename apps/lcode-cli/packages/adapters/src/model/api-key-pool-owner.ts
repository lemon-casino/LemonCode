import {
  RoutingError,
  RoutingRecovery,
  RateLimitWindow,
  readRateLimitHint,
  waitForRateLimitDelay,
  type ProviderApiKey,
  type ProviderRoutingPolicy,
  type RoutingRequest,
  // lease 拆分后 usage 回调仍使用 provider 的公开类型，必须保留导入以通过类型检查。
  type RoutingFinish,
} from "@lcode/provider";
import { readApiKeySharedDiagnostics } from "./api-key-routing-diagnostics.js";
import { ApiKeyCooldownQueue } from "./api-key-cooldown-queue.js";
import { ApiKeyRouting } from "./api-key-routing.js";
import type { ApiKeyQuotaSnapshot } from "@lcode/shared";
import type { ApiKeySharedQuotaClient } from "./api-key-shared-client.js";
import type { ApiKeyLease } from "./api-key-lease.js";

export interface ApiKeyFailoverState {
  readonly failedKeyIds: Set<string>;
  nextIndex: number;
  pool?: ApiKeyPool;
}

/** 只拥有冻结 catalog 的调度；HTTP、业务预算和持久化均由既有 owner 管理。 */
export class ApiKeyPool {
  private readonly keys: readonly ProviderApiKey[];
  private readonly next: Int32Array;
  private readonly previous: Int32Array;
  private readonly available: Uint8Array;
  private readonly positions = new Map<string, number>();
  private readonly failures: Set<string>;
  private cursor = 0;
  private count: number;
  private leases = 0;
  private disposed = false;
  private readonly closing = new AbortController();
  private readonly cooling = new ApiKeyCooldownQueue();
  private readonly routing: ApiKeyRouting;
  private readonly recovery = new RoutingRecovery();
  private readonly ids: readonly string[];

  constructor(
    readonly sourceKeys: readonly ProviderApiKey[],
    private readonly state?: ApiKeyFailoverState,
    private readonly shared = new RateLimitWindow(),
    private readonly quota?: { providerId: string; client: ApiKeySharedQuotaClient },
    private readonly recoveryNow: () => number = Date.now,
  ) {
    this.routing = new ApiKeyRouting(Boolean(quota), this.recoveryNow);
    this.keys = sourceKeys.filter((key) => key.enabled !== false && key.apiKey.trim().length > 0);
    this.ids = this.keys.map((key) => key.id);
    if (!this.keys.length) throw new Error("No enabled API key is configured");
    const length = this.keys.length;
    this.count = length;
    this.failures = state?.failedKeyIds ?? new Set();
    this.next = new Int32Array(length);
    this.previous = new Int32Array(length);
    this.available = new Uint8Array(length).fill(1);
    for (let index = 0; index < length; index++) {
      const id = this.keys[index]!.id;
      if (this.positions.has(id)) throw new Error("API key IDs must be unique");
      this.positions.set(id, index);
      this.next[index] = (index + 1) % length;
      this.previous[index] = (index + length - 1) % length;
    }
    this.cursor = (state?.nextIndex ?? 0) % length;
    for (const id of this.failures) this.remove(id);
  }

  get activeLeaseCount(): number {
    return this.leases;
  }
  get routingEnabled(): boolean {
    return this.routing.enabled;
  }
  get availableCount(): number {
    this.restoreExpired();
    return this.count;
  }
  get coolingKeyCount(): number {
    this.restoreExpired();
    return this.cooling.size;
  }

  async acquire(
    signal?: AbortSignal,
    outsideTicket: (wait: () => Promise<void>, signal?: AbortSignal) => Promise<void> = (wait) =>
      wait(),
    context?: RoutingRequest,
  ): Promise<ApiKeyLease> {
    const combined = AbortSignal.any([
      this.closing.signal,
      this.shared.signal,
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    // owner 关闭也要取消冷却结束后的 admission 排队，不能只传 caller signal。
    if (this.waitMs() > 0)
      await outsideTicket(async () => {
        for (;;) {
          combined.throwIfAborted();
          const delay = this.waitMs();
          if (delay === 0) return;
          await waitForRateLimitDelay(delay, combined);
        }
      }, combined);
    combined.throwIfAborted();
    // reacquire admission 期间可能有并发 429；重新判定，不把冷却等待计为 HTTP。
    if (this.waitMs() > 0) return this.acquire(signal, outsideTicket, context);
    const lease = this.reserve(context);
    if (!this.quota || !lease.sharedQuotaInput) return lease;
    try {
      let prepared!: ApiKeyLease;
      await outsideTicket(async () => {
        prepared = await this.quota!.client.prepare(this.quota!.providerId, lease, combined);
      }, combined);
      return prepared;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  configureRouting(policy?: ProviderRoutingPolicy | null, keys = this.sourceKeys): void {
    this.routing.configure(policy, keys);
  }

  async observeSharedQuota(
    snapshot: ApiKeyQuotaSnapshot,
    coversThroughSeq?: number,
  ): Promise<void> {
    if (!this.quota || !snapshot.poolId) throw new RoutingError("routing-capability-required");
    this.routing.observeQuota(snapshot);
    await this.quota.client.coordinator.observe(
      this.quota.providerId,
      snapshot.poolId,
      this.routing.sharedWindows(snapshot.poolId),
      coversThroughSeq,
    );
  }
  observeRoutingQuota(snapshot: ApiKeyQuotaSnapshot): void {
    this.routing.observeQuota(snapshot);
  }
  readRoutingDiagnostics(input?: { offset?: number; limit?: number; revision?: number }) {
    const result = this.routing.readDiagnostics(input);
    return {
      ...result,
      coordination: this.quota ? ("filesystem" as const) : ("local-only" as const),
      items: result.items.map((item) => ({
        ...item,
        authenticationFailed: this.failures.has(item.keyId),
        cooling: !this.available[this.positions.get(item.keyId)!] && !this.failures.has(item.keyId),
      })),
    };
  }

  async readRuntimeDiagnostics(input?: { offset?: number; limit?: number; revision?: number }) {
    const localPreview = this.readRoutingDiagnostics(input);
    const sharedPools = await readApiKeySharedDiagnostics(
      this.quota?.providerId ?? "",
      localPreview.items.flatMap((item) => (item.quotaPoolId ? [item.quotaPoolId] : [])),
      this.quota?.client.coordinator,
    );
    return {
      asOf: this.recoveryNow(),
      localPreview,
      sharedPools,
      owner: this.routing.readRuntimeDiagnostics(),
      recovery: this.recovery.inspect(this.recoveryNow()),
      feedback: this.quota?.client.diagnostics(),
    };
  }

  reserve(context?: RoutingRequest): ApiKeyLease {
    if (this.disposed) throw new Error("API key pool has been disposed");
    if (this.waitMs() > 0)
      throw new Error("API keys are cooling; acquire must wait before sending");
    while (this.count && this.failures.has(this.keys[this.cursor]!.id))
      this.remove(this.keys[this.cursor]!.id);
    const probe = this.count === 0;
    const reservation = this.routing.reserve(
      this.ids,
      (id, modelKey) =>
        !this.available[this.positions.get(id)!] ||
        !this.recovery.available(
          this.routing.recoveryResources(id, modelKey).all,
          this.recoveryNow(),
        ),
      context,
      (id, modelKey) => this.recovery.retryAt(this.routing.recoveryResources(id, modelKey).all),
    );
    const index = reservation
      ? this.positions.get(reservation.routeId)!
      : probe
        ? this.keys.length - 1
        : this.cursor;
    const key = this.keys[index]!;
    const resources = this.routing.recoveryResources(key.id, context?.modelKey);
    const permit = reservation
      ? this.recovery.reserve(resources.all, String(reservation.sequence), this.recoveryNow())
      : undefined;
    if (permit?.probes.length) this.routing.touch(key.id);
    // 原实现收到响应才推进游标，多个并发会命中首 Key；在首个 await 前同步 reserve。
    if (!probe) this.cursor = this.next[index]!;
    if (this.state) this.state.nextIndex = this.cursor;
    this.leases++;
    let statusCode: number | undefined;
    let rejected = false;
    let released = false;
    let rateObserved = false;
    let started = false,
      ended = false;
    const canRotate = () =>
      rejected &&
      !probe &&
      !this.disposed &&
      this.availableCount > 0 &&
      this.shared.remainingMs() === 0;
    return {
      key,
      ...(reservation?.sharedQuotaInput
        ? {
            sharedQuotaInput: reservation.sharedQuotaInput,
            sharedQuotaWindows: reservation.sharedQuotaWindows,
          }
        : {}),
      ...(reservation
        ? {
            observeUsage: (usage: RoutingFinish) => {
              if (permit) this.recovery.observe(permit, usage.outcome, this.recoveryNow());
              reservation.observeUsage(usage);
            },
            begin: () => {
              if (permit) this.recovery.dispatch(permit, this.recoveryNow());
              try {
                const accepted = reservation.dispatch();
                if (accepted) started = true;
                return accepted;
              } catch (error) {
                if (permit) this.recovery.rollbackUnsent(permit);
                throw error;
              }
            },
            end: (success: boolean) => {
              if (ended) return;
              ended = true;
              if (
                permit &&
                started &&
                !success &&
                statusCode === undefined &&
                !context?.signal?.aborted &&
                !this.closing.signal.aborted &&
                !reservation.sharedQuotaInput
              )
                this.recovery.fail(permit, [resources.model], this.recoveryNow() + 1000);
              if (permit)
                this.recovery.finish(
                  permit,
                  context?.signal?.aborted || this.closing.signal.aborted
                    ? "cancelled"
                    : success
                      ? "unknown"
                      : "failed",
                  this.recoveryNow(),
                );
              reservation.finish({
                statusCode,
                outcome:
                  context?.signal?.aborted || this.closing.signal.aborted
                    ? "cancelled"
                    : success
                      ? "unknown"
                      : "failed",
              });
            },
          }
        : {}),
      get canRotate() {
        return canRotate();
      },
      observe: (status, headers = new Headers()) => {
        if (released || this.disposed) return;
        statusCode = status;
        if (reservation) reservation.observeHeaders(headers);
        else this.routing.observe(key.id, headers);
        if (permit && (status === 429 || (status >= 500 && status <= 599))) {
          if (rateObserved) return;
          rateObserved = true;
          const hint = readRateLimitHint(headers);
          const affected =
            status === 429
              ? hint.scope === "shared"
                ? resources.shared
                : resources.key
              : resources.model;
          if (affected && !reservation?.sharedQuotaInput)
            this.recovery.fail(permit, [affected], this.recoveryNow() + hint.delayMs);
          rejected = status === 429 && hint.scope !== "shared";
          this.routing.touch(key.id);
          return;
        }
        if (status === 429 && !rateObserved) {
          rateObserved = true;
          const hint = readRateLimitHint(headers);
          if (hint.scope === "shared") {
            this.shared.extend(hint.delayMs);
            return;
          }
          rejected = true;
          this.cooling.extend(index, this.shared.now() + hint.delayMs);
          this.remove(key.id);
          return;
        }
        if (status !== 401 && status !== 403) return;
        rejected = true;
        this.failures.add(key.id);
        this.remove(key.id);
      },
      release: () => {
        if (released) return;
        released = true;
        if (reservation && !started) {
          if (permit) this.recovery.cancel(permit);
          reservation.cancel();
          if (permit?.probes.length) this.routing.touch(key.id);
        }
        this.leases--;
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.closing.abort(new DOMException("API key pool disposed", "AbortError"));
    this.cooling.clear();
    this.failures.clear();
    this.positions.clear();
    this.routing.dispose();
    this.recovery.clear();
  }

  private waitMs(): number {
    this.restoreExpired();
    return Math.max(
      this.shared.remainingMs(),
      this.count === 0 && this.cooling.nextDeadline !== undefined
        ? Math.max(0, this.cooling.nextDeadline - this.shared.now())
        : 0,
    );
  }
  private restoreExpired(): void {
    let index: number | undefined;
    while ((index = this.cooling.popDue(this.shared.now())) !== undefined) {
      if (this.failures.has(this.keys[index]!.id) || this.available[index]) continue;
      if (this.count === 0) {
        this.next[index] = index;
        this.previous[index] = index;
        this.cursor = index;
      } else {
        const tail = this.previous[this.cursor]!;
        this.next[tail] = index;
        this.previous[index] = tail;
        this.next[index] = this.cursor;
        this.previous[this.cursor] = index;
      }
      this.available[index] = 1;
      this.routing.touch(this.keys[index]!.id);
      this.count++;
    }
  }

  private remove(id: string): void {
    const index = this.positions.get(id);
    if (index === undefined || !this.available[index]) return;
    this.available[index] = 0;
    this.routing.touch(id);
    this.count--;
    const next = this.next[index]!;
    const previous = this.previous[index]!;
    this.next[previous] = next;
    this.previous[next] = previous;
    if (this.cursor === index) this.cursor = next;
  }
}
