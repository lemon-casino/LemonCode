import {
  providerCheckinDay,
  providerCheckinReplySchema,
  type ProviderAccountCheckinResult,
} from "@lcode/shared";
import type { AuthDriver, AuthDriverContext } from "@lcode/provider-node";
import type { StoredAccount } from "./providerAccountStoreSchema.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

interface CheckinHost {
  read(): Promise<StoredAccount[]>;
  mutate(update: (accounts: StoredAccount[]) => void): Promise<void>;
  driver(account: StoredAccount): Promise<AuthDriver>;
  supportsCheckin(channelId: string): Promise<boolean>;
  context(
    account: StoredAccount,
    signal: AbortSignal,
  ): AuthDriverContext & { isCurrent(current: StoredAccount): boolean };
  track(id: string): AbortController;
  untrack(id: string, controller: AbortController): void;
  withAccountLock<T>(account: StoredAccount, operation: () => Promise<T>): Promise<T>;
  closed(): boolean;
  publish(): Promise<unknown>;
  activityChanged(): void;
  invalidateQuota(id: string): void;
}
const EVERY = 30 * 60_000,
  START_AFTER = 2 * 60_000,
  TIMEOUT = 30_000;
const log = createServiceLogger("provider-account-checkin");

/** Host 唯一调度 owner；账号事实和自动设置仍由原账号存储持有。 */
export class ProviderAccountCheckins {
  private readonly flights = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; automatic: boolean }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly now: () => number;
  constructor(
    private readonly host: CheckinHost,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }
  isRunning(id: string): boolean {
    return this.flights.has(id);
  }
  start(): void {
    this.schedule(START_AFTER);
  }
  private schedule(delay: number): void {
    if (this.disposed || this.host.closed()) return;
    this.timer = setTimeout(() => {
      void this.runAutomatic()
        .catch(() => {
          log.warn(undefined, "Automatic check-in batch could not be read");
        })
        .finally(() => this.schedule(EVERY));
    }, delay);
    this.timer.unref?.();
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const flight of this.flights.values()) flight.controller.abort();
  }
  invalidate(id: string): void {
    this.flights.get(id)?.controller.abort();
  }
  async setAutomatic(id: string, automatic: boolean): Promise<void> {
    if (typeof automatic !== "boolean") throw new Error("Invalid automatic check-in setting");
    const account = (await this.host.read()).find((a) => a.connectionId === id);
    if (!account || !(await this.host.supportsCheckin(account.channelId)))
      throw new Error("Check-in unavailable");
    await this.host.mutate((accounts) => {
      const account = accounts.find((a) => a.connectionId === id);
      if (!account) throw new Error("Unknown account");
      account.checkin = { ...account.checkin, automatic };
    });
    if (!automatic && this.flights.get(id)?.automatic) this.invalidate(id);
  }
  async runAll(channelId?: string): Promise<void> {
    const accounts = await this.host.read();
    for (const account of accounts) {
      if (this.disposed || this.host.closed()) break;
      if (
        account.enabled &&
        account.authorizationStatus !== "expired" &&
        (!channelId || account.channelId === channelId)
      ) {
        try {
          if (await this.host.supportsCheckin(account.channelId))
            await this.run(account.connectionId);
        } catch {
          log.warn(undefined, "Check-in batch account unavailable", {
            channelId: account.channelId,
          });
        }
      }
    }
  }
  async runAutomatic(): Promise<void> {
    const accounts = await this.host.read();
    for (const account of accounts) {
      if (this.disposed || this.host.closed()) break;
      if (
        account.enabled &&
        account.checkin?.automatic &&
        account.authorizationStatus !== "expired"
      )
        await this.run(account.connectionId, true);
    }
  }
  async run(id: string, automatic = false): Promise<void> {
    if (!id || typeof id !== "string") throw new Error("Invalid check-in account");
    if (this.disposed || this.host.closed()) throw new Error("Check-in service closed");
    const account = (await this.host.read()).find((a) => a.connectionId === id);
    if (this.disposed || this.host.closed()) throw new Error("Check-in service closed");
    if (!account?.enabled || account.authorizationStatus === "expired") return;
    const existing = this.flights.get(id);
    if (existing) return existing.promise;
    const controller = this.host.track(id);
    const flight = { controller, automatic, promise: Promise.resolve() };
    this.flights.set(id, flight);
    this.host.activityChanged();
    flight.promise = this.perform(account, controller, automatic).finally(async () => {
      if (this.flights.get(id) === flight) {
        this.flights.delete(id);
        this.host.activityChanged();
      }
      this.host.untrack(id, controller);
      if (!this.disposed && !this.host.closed()) await this.host.publish();
    });
    // 发布视图期间 operation 也可能结束；立即接住拒绝，原调用者仍收到同一 promise 的错误。
    void flight.promise.catch(() => {});
    await this.host.publish();
    return flight.promise;
  }
  private settled(account: StoredAccount, automatic: boolean): boolean {
    const last = account.checkin?.result;
    if (!last || last.day !== providerCheckinDay(this.now())) return false;
    if (last.validUntil && Date.parse(last.validUntil) <= this.now()) return false;
    const age = this.now() - Date.parse(last.at);
    if (age < 0) return false;
    if (last.outcome === "failed") return automatic && age < EVERY;
    if (["qoder", "qoder-cn"].includes(account.channelId)) return automatic && age < EVERY;
    return true;
  }
  private async perform(
    account: StoredAccount,
    controller: AbortController,
    automatic: boolean,
  ): Promise<void> {
    let timedOut = false;
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        timedOut = true;
        controller.abort();
      }
    }, TIMEOUT);
    timer.unref?.();
    try {
      await this.host.withAccountLock(account, async () => {
        controller.signal.throwIfAborted();
        const current = (await this.host.read()).find(
          (a) => a.connectionId === account.connectionId,
        );
        if (
          !current?.enabled ||
          current.generation !== account.generation ||
          (automatic && !current.checkin?.automatic)
        )
          return;
        // 跨窗口去重在原账号文件锁内重读；不能只靠当前 Host 的 flight 判断已领取。
        if (this.settled(current, automatic)) return;
        const context = this.host.context(current, controller.signal);
        let reply;
        try {
          const driver = await this.host.driver(current);
          reply = providerCheckinReplySchema.parse(
            driver.checkin ? await driver.checkin(context) : { outcome: "unsupported" },
          );
        } catch {
          reply = { outcome: "failed" as const, error: "request_failed" as const };
        }
        if (this.disposed || this.host.closed() || (controller.signal.aborted && !timedOut)) return;
        if (timedOut) reply = { outcome: "failed" as const, error: "request_failed" as const };
        const result: ProviderAccountCheckinResult = {
          ...reply,
          at: new Date(this.now()).toISOString(),
          day: providerCheckinDay(this.now()),
        };
        let committed = false;
        await this.host.mutate((accounts) => {
          const latest = accounts.find((a) => a.connectionId === account.connectionId);
          // 自身刷新可推进代次；删除、禁用或重新授权不能被迟到签到结果覆盖。
          if (
            this.disposed ||
            (controller.signal.aborted && !timedOut) ||
            !latest?.enabled ||
            !context.isCurrent(latest)
          )
            return;
          latest.checkin = { automatic: latest.checkin?.automatic ?? false, result };
          committed = true;
        });
        if (!committed) return;
        if (
          reply.outcome === "claimed" ||
          reply.outcome === "done" ||
          (reply.error === "partial" && (reply.credit ?? 0) > 0)
        )
          this.host.invalidateQuota(account.connectionId);
        const details = {
          connectionId: account.connectionId,
          channelId: account.channelId,
          outcome: reply.outcome,
          automatic,
          ...(reply.error ? { errorCode: reply.error } : {}),
        };
        if (reply.outcome === "failed") log.warn(undefined, "Check-in failed", details);
        else log.info(undefined, "Check-in completed", details);
      });
    } catch {
      if (!controller.signal.aborted && !this.disposed)
        log.warn(undefined, "Check-in admission failed", { channelId: account.channelId });
    } finally {
      clearTimeout(timer);
    }
  }
}
