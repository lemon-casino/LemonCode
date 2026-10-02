import { settleSessionStoreDependentCloseWork } from "./methods/session-store-dependent-close-work.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { isTerminalRuntimeTask } from "../runtime-task/registry.js";
import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
import { retainSessionStoreDependentCloseWork as retainRuntimeCloseWork } from "./methods/session-store-dependent-close-work.js";

interface AgentRuntimeCloseContext extends AgentRuntimeInternal {
  browserSessionClosed: boolean;
  nodeReplSessionDisposed: boolean;
  browserSessionCloseTimeoutMs: number;
  shutdownStarted: boolean;
  beginShutdown(): void;
}

export async function closeBrowserSession(this: AgentRuntimeCloseContext): Promise<void> {
  this.beginShutdown();
  if (!this.nodeReplSessionDisposed) {
    disposeNodeReplSession(this.sessionId);
    this.nodeReplSessionDisposed = true;
  }
  let failoverReleaseFailure: { error: unknown } | undefined;
  if (
    this.executionFailoverScopeLifetime === "runtime" &&
    this.executionFailoverScopeRetained &&
    this.executionFailoverScope
  ) {
    const release = this.executionFailoverPolicyPort.release(
      this.executionFailoverScope,
      this.rootTraceContext,
    );
    // release 会写父 session 的 failover event；必须在第一次 await 前登记，
    // 否则 facade 的资源 deadline 可能先到并在它迟到落库前关闭 store。
    retainRuntimeCloseWork(this as unknown as AgentRuntimeInternal, release);
    try {
      await release;
      this.executionFailoverScopeRetained = false;
    } catch (error) {
      // actor runtime 的 target 属于父 policy；先保留 retained 标记并继续收口独立资源，
      // 最后再把失败交还所有者。吞掉错误会让 driver 删除唯一的 runtime 重试句柄。
      failoverReleaseFailure = { error };
      this.logger?.warn("Execution failover runtime scope release failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "model.failover.runtime_scope_release_failed",
        module: "core.runtime",
      });
    }
  }
  if (!this.browserSessionClosed) {
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() =>
          this.browserControlPort?.closeSession?.({
            sessionId: this.sessionId,
            traceContext: this.rootTraceContext,
          }),
        )
        .then(
          () => ({ type: "completed" as const }),
          (error: unknown) => ({ error, type: "failed" as const }),
        ),
      new Promise<{ type: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ type: "timed_out" }), this.browserSessionCloseTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // browser backend 是有界的 ephemeral 清理；它不能把仍需父 store 的 actor dispose 永久卡住。
    this.browserSessionClosed = true;
    if (outcome.type !== "completed") {
      this.logger?.warn("Browser session cleanup failed", {
        error:
          outcome.type === "failed"
            ? outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
            : "Browser session cleanup timed out",
        event: "browser.session_cleanup.failed",
      });
    }
  }
  await settleSessionStoreDependentCloseWork(this as unknown as AgentRuntimeInternal);
  if (failoverReleaseFailure) throw failoverReleaseFailure.error;
}

export function retainSessionStoreDependentCloseWork(
  this: AgentRuntimeCloseContext,
  work: Promise<unknown>,
): void {
  retainRuntimeCloseWork(
    this as unknown as AgentRuntimeInternal,
    work.then(() => undefined),
  );
}

export async function drainSessionStoreDependentCloseWork(
  this: AgentRuntimeCloseContext,
): Promise<void> {
  await settleSessionStoreDependentCloseWork(this as unknown as AgentRuntimeInternal);
}

export function beginShutdown(this: AgentRuntimeCloseContext): void {
  if (this.shutdownStarted) return;
  this.shutdownStarted = true;
  // ExecutionPort.close() 会把后台 Bash 收口为 cancelled；若允许
  // teardown terminal event 再唤醒模型，并与随后关闭的 session store 竞态。
  this.shuttingDown = true;
  for (const task of Object.values(this.runtimeTaskRegistry.all())) {
    if (task.type !== "local_agent" || isTerminalRuntimeTask(task)) continue;
    const stop = this.subagentPort?.stopTask?.(task.taskId);
    if (!stop) continue;
    // beginShutdown 必须同步登记 stop owner；否则 facade 的 stable drain 可能在 stop 创建
    // terminal policy cleanup 前误判为空，并提前关闭 session store。
    retainRuntimeCloseWork(
      this as unknown as AgentRuntimeInternal,
      stop.then(() => undefined),
    );
  }
  // 关闭单个 session 后进程仍存活，
  // 因此必须先终止该 runtime 的 Extraction，不能只在超时后放弃等待。
  this.memoryExtractionScheduler?.shutdown();
}
