import { randomUUID } from "node:crypto";
import type {
  BrowserCleanupPending,
  BrowserCommandResult,
  BrowserTurnCleanupResult,
  TraceContext,
} from "@lcode/contracts";
import { lcodeBrowserExecuteResultSchema, lcodeProtocolMethods } from "@lcode/shared";
import {
  protocolTraceFromTraceContext,
  ProtocolRequestError,
  type LCodeProtocolAgentServerContext,
} from "./server-types.js";

export const BROWSER_LIFECYCLE_ACK_TIMEOUT_MS = 5_000;
export type BrowserRequestRoute = {
  requestId: string;
  sessionId: string;
  turnId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  sessionContext: "live";
};
export interface BrowserCleanupTarget {
  browserId: string;
  browserGeneration: number;
  route: BrowserRequestRoute;
}
export interface BrowserCleanupJob {
  target: BrowserCleanupTarget;
  command: { method: "closeSession" } | { method: "turnEnded"; turnId?: string };
  outcome: BrowserTurnCleanupResult;
  run(): Promise<BrowserTurnCleanupResult>;
}
type RequestHost = Pick<LCodeProtocolAgentServerContext, "requestClient">;

/** job 留在原 scope entry，只有原 ACK 能确认释放；未知远端动作不重发。 */
export function createBrowserCleanupJob(input: {
  host: RequestHost;
  target: BrowserCleanupTarget;
  command: BrowserCleanupJob["command"];
  traceContext?: TraceContext;
  timeoutMs: number;
  confirmed(): void;
}): BrowserCleanupJob {
  let inFlight: Promise<BrowserTurnCleanupResult> | undefined;
  let unknown = false;
  const controller = new AbortController();
  const job: BrowserCleanupJob = {
    target: input.target,
    command: input.command,
    outcome: { phase: "cleanup_pending", reason: "ack_timeout" },
    run() {
      if (inFlight) return inFlight;
      if (unknown || job.outcome.phase === "completed") return Promise.resolve(job.outcome);
      unknown = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const accept = (result: BrowserCommandResult): BrowserTurnCleanupResult => {
        if (result.ok) {
          job.outcome = { phase: "completed" };
          unknown = false;
          input.confirmed();
        } else {
          unknown = false;
          job.outcome = { phase: "cleanup_pending", reason: "backend_cleanup_failed" };
        }
        return job.outcome;
      };
      const fail = (error: unknown): BrowserCleanupPending => {
        const code = error instanceof ProtocolRequestError ? error.code : undefined;
        if (code === -32020) unknown = false; // 尚未发送；后续仍可由同一 owner 清理。
        job.outcome = {
          phase: "cleanup_pending",
          reason: code === -32022 ? "ack_timeout" : "transport_unavailable",
        };
        return job.outcome;
      };
      const { browserId, browserGeneration, route } = input.target;
      const send = () =>
        input.host.requestClient(
          lcodeProtocolMethods.interactionBrowserExecute,
          {
            ...route,
            requestId: randomUUID(),
            browserId,
            browserGeneration,
            command: input.command,
            ...(input.command.method === "turnEnded" && input.command.turnId
              ? { turnId: input.command.turnId }
              : {}),
          },
          lcodeBrowserExecuteResultSchema,
          {
            timeoutMs: input.timeoutMs,
            purpose: "resource_cleanup",
            signal: controller.signal,
            ...(input.traceContext
              ? { trace: protocolTraceFromTraceContext(input.traceContext) }
              : {}),
            onLateResponse: (response) => {
              if ("result" in response)
                accept(lcodeBrowserExecuteResultSchema.parse(response.result));
              else fail(response.error);
            },
          },
        );
      let response: Promise<BrowserCommandResult>;
      try {
        response = send();
      } catch (error) {
        response = Promise.reject(error);
      }
      const waiting = response.then(accept, fail);
      // 自定义端口也必须有界，迟到应答仍落同一 job，而不是另一条资源释放链。
      inFlight = Promise.race([
        waiting,
        new Promise<BrowserCleanupPending>((resolve) => {
          timer = setTimeout(
            () => resolve((job.outcome = { phase: "cleanup_pending", reason: "ack_timeout" })),
            input.timeoutMs,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        inFlight = undefined;
      });
      return inFlight;
    },
  };
  return job;
}

/** cancelRequest 只针对原 requestId，等待有界，不保留无关的迟到应答登记。 */
export function cancelBrowserRequest(
  host: RequestHost,
  target: BrowserCleanupTarget,
  requestId: string,
  traceContext?: TraceContext,
): void {
  const controller = new AbortController();
  const { browserId, browserGeneration, route } = target;
  void Promise.resolve()
    .then(() =>
      host.requestClient(
        lcodeProtocolMethods.interactionBrowserExecute,
        {
          ...route,
          requestId: randomUUID(),
          browserId,
          browserGeneration,
          command: { method: "cancelRequest", requestId },
        },
        lcodeBrowserExecuteResultSchema,
        {
          timeoutMs: BROWSER_LIFECYCLE_ACK_TIMEOUT_MS,
          signal: controller.signal,
          ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
        },
      ),
    )
    .catch(() => undefined);
}
