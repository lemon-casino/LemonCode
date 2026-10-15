import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { waitForNetworkResult } from "../../network-request-lifecycle.js";
import { followLocal, saveLocalCodex } from "./local.js";
import type { LocalIO } from "./local-io.js";
import { joinedSignal, requireGrant, jwt, number } from "./common.js";

const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_EARLY_MS = 300_000;

/** 原 OpenAI 账号 driver 的刷新 owner；业务 wait 与轮换收尾有不同取消边界。 */
export class OpenAIRefresh {
  private flight?: Promise<AuthGrant>;
  private connectionId?: string;
  constructor(
    private readonly lifetime: AbortSignal,
    private readonly localIO: LocalIO,
    private readonly exchange: (grant: AuthGrant, signal: AbortSignal) => Promise<AuthGrant>,
  ) {}

  async fresh(context: AuthDriverContext, force = false): Promise<AuthGrant> {
    context.signal?.throwIfAborted();
    this.lifetime.throwIfAborted();
    if (context.connectionId) {
      if (this.connectionId && this.connectionId !== context.connectionId)
        throw new Error("OpenAI driver cannot be shared between accounts");
      this.connectionId = context.connectionId;
    }
    if (this.flight) return this.join(context);
    const grant = await followLocal(
      await requireGrant(context),
      this.localIO,
      joinedSignal(context.signal, this.lifetime),
    );
    if (this.flight) return this.join(context);
    const expiry = grant.expires ?? (number(jwt(grant.access ?? "").exp) ?? 0) * 1000;
    if (!force && grant.access && expiry > Date.now() + REFRESH_EARLY_MS) return grant;
    if (!grant.refresh) throw new Error("ChatGPT sign-in has expired; sign in again");
    context.signal?.throwIfAborted();
    const signal = joinedSignal(
      this.lifetime,
      AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      context.captureRefreshCommit ? undefined : context.signal,
    );
    const commit = context.captureRefreshCommit?.() ?? context.write.bind(context);
    const operation = (async () => {
      const next = await waitForNetworkResult(this.exchange(grant, signal), signal);
      signal.throwIfAborted();
      await commit(next);
      await saveLocalCodex(grant, next, this.localIO);
      return next;
    })();
    this.flight = operation;
    const settled = () => {
      if (this.flight === operation) this.flight = undefined;
    };
    void operation.then(settled, settled);
    context.retainRefreshCompletion?.(operation);
    return waitForNetworkResult(operation, context.signal ?? this.lifetime);
  }

  private async join(context: AuthDriverContext): Promise<AuthGrant> {
    await waitForNetworkResult(this.flight!, context.signal ?? this.lifetime);
    // 刷新写回推进了 Host generation；加入者重新读取才能使用新的 CAS 版本。
    return requireGrant(context);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.flight ? [this.flight] : []);
  }
}
