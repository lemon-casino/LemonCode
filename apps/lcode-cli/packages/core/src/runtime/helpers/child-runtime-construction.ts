import type { Logger, SessionId, TraceContext } from "@lcode/contracts";
import type { ClientFacingPorts } from "./child-client-ports.js";

/** 构造前的 scope 由本事务持有，成功移交 runtime；失败清理由父 residency 和 broker 共同收尾。 */
export function constructChildRuntimeWithPorts<T>(input: {
  sessionId: SessionId;
  createPorts(): ClientFacingPorts;
  construct(ports: ClientFacingPorts): T;
  trackCleanup(work: Promise<void>): Promise<void>;
  logger?: Logger;
  traceContext?: TraceContext;
}): T {
  const ports = input.createPorts();
  try {
    return input.construct(ports);
  } catch (cause) {
    // 端口先于构造器分配，构造抛错曾漏关 child scope；不能等返回 runtime 后才装 finally。
    const cleanup = Promise.resolve().then(async () => {
      await ports.browserControlPort?.closeSession?.({
        sessionId: input.sessionId,
        traceContext: input.traceContext,
      });
    });
    void input.trackCleanup(cleanup).catch((error: unknown) => {
      input.logger?.warn?.("Child runtime construction cleanup failed", {
        event: "runtime.child.construction_cleanup_failed",
        sessionId: input.sessionId,
        traceId: input.traceContext?.traceId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
    throw cause;
  }
}
