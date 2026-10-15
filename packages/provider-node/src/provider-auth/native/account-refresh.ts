import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { waitForNetworkResult } from "../../network-request-lifecycle.js";
import { followLocal } from "./local.js";
import type { LocalIO } from "./local-io.js";
import { joinedSignal, requireGrant } from "./common.js";

const REFRESH_TIMEOUT_MS = 30_000;

/** 原 driver 内的账号刷新 owner；协议字段/有效期与后置保存由各供应商提供。 */
export class NativeAccountRefresh {
  private flight?: Promise<AuthGrant>;
  private account?: string;
  private readonly completions = new Set<Promise<AuthGrant>>();
  constructor(
    private readonly options: {
      lifetime: AbortSignal;
      localIO: LocalIO;
      isFresh(grant: AuthGrant): boolean;
      missingRefreshMessage: string;
      exchange(grant: AuthGrant, signal: AbortSignal): Promise<AuthGrant>;
      afterCommit?(previous: AuthGrant, next: AuthGrant): Promise<void>;
    },
  ) {}

  async fresh(context: AuthDriverContext, force = false): Promise<AuthGrant> {
    const caller = joinedSignal(context.signal, this.options.lifetime);
    caller.throwIfAborted();
    const bound = Boolean(context.connectionId);
    if (context.connectionId) {
      if (this.account && this.account !== context.connectionId)
        throw new Error("Refresh driver cannot be shared between accounts");
      this.account = context.connectionId;
    }
    const join = async () => {
      await waitForNetworkResult(this.flight!, caller);
      const current = await requireGrant(context);
      caller.throwIfAborted();
      return current;
    };
    if (bound && this.flight) return join();
    const grant = await followLocal(await requireGrant(context), this.options.localIO, caller);
    caller.throwIfAborted();
    if (bound && this.flight) return join();
    if (!force && this.options.isFresh(grant)) return grant;
    if (!grant.refresh) throw new Error(this.options.missingRefreshMessage);
    // 只有原 Host 同时授予固定 CAS 和物理收尾登记，才允许轮换脱离 caller。
    const detached = Boolean(context.captureRefreshCommit && context.retainRefreshCompletion);
    const admission = new AbortController();
    const signal = joinedSignal(
      this.options.lifetime,
      admission.signal,
      AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      detached ? undefined : context.signal,
    );
    const commit = detached ? context.captureRefreshCommit!() : context.write.bind(context);
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const next = await this.options.exchange(grant, signal);
      signal.throwIfAborted();
      await commit(next);
      await this.options.afterCommit?.(grant, next);
      return next;
    });
    this.completions.add(operation);
    if (bound) this.flight = operation;
    const settled = () => {
      this.completions.delete(operation);
      if (this.flight === operation) this.flight = undefined;
    };
    void operation.then(settled, settled);
    try {
      context.retainRefreshCompletion?.(operation);
    } catch (error) {
      admission.abort(error);
      throw error;
    }
    // 业务可立即取消；原 operation 保留到真实交换/持久化结束，不能提前释放刷新锁。
    return waitForNetworkResult(operation, caller);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.completions);
  }
}
