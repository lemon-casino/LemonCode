import type { DynamicWorkflowRunPort } from "@lcode/contracts";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service-types.js";

export type RoutedWorkflowOperation = "resume" | "getTask" | "waitForTask" | "cancel";
export interface WorkflowRunOwnerRequest {
  parentSessionId: string;
  runId: string;
  operation: RoutedWorkflowOperation;
}
export type WithWorkflowRunOwner = <T>(
  request: WorkflowRunOwnerRequest,
  operation: (port: DynamicWorkflowRunPort) => Promise<T>,
) => Promise<T>;

export class WorkflowRunOwnerUnavailableError extends Error {
  constructor() {
    super(
      "Workflow execution owner is unavailable; open the original conversation and retry after its owner is available.",
    );
    this.name = "WorkflowRunOwnerUnavailableError";
  }
}

/** 原 parent 是执行权威；只委托窄端口，不缓存第二张 run/owner 路由表。 */
export function routeWorkflowRunOwners<T extends DynamicWorkflowRunPort>(
  service: T,
  deps: Pick<
    DynamicWorkflowRunServiceDeps,
    "journal" | "parentSessionId" | "executionOwner" | "withWorkflowRunOwner"
  >,
  assertOpen: () => void,
): T {
  // 无 durable lease 的瞬态内存装配没有跨进程执行权，不凭缺省 parent 把其本地读面误判成跨会话。
  if (!deps.executionOwner && !deps.withWorkflowRunOwner) return service;
  return new Proxy(service, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver);
      if (key !== "resume" && key !== "getTask" && key !== "waitForTask" && key !== "cancel")
        return member;
      if (typeof member !== "function") return member;
      return async (runId: string, ...args: unknown[]) => {
        const record = deps.journal.getRun(runId);
        if (!record || record.parentSessionId === deps.parentSessionId)
          return member.call(target, runId, ...args);
        if (key === "resume" || key === "cancel") assertOpen();
        try {
          if (!record.parentSessionId || !deps.withWorkflowRunOwner)
            throw new WorkflowRunOwnerUnavailableError();
          deps.executionOwner?.assertOwned();
          return await deps.withWorkflowRunOwner(
            { parentSessionId: record.parentSessionId, runId, operation: key },
            async (owner) => {
              // 宿主可能等待冷恢复；源 App 在等待中关闭后不能再代发新执行。
              if (key === "resume" || key === "cancel") {
                assertOpen();
                deps.executionOwner?.assertOwned();
              }
              const method = owner[key];
              if (typeof method !== "function") throw new WorkflowRunOwnerUnavailableError();
              return Reflect.apply(method, owner, [runId, ...args]) as Promise<unknown>;
            },
          );
        } catch (error) {
          if (!(error instanceof WorkflowRunOwnerUnavailableError)) throw error;
          // 缺原 owner 不能先回 ok 再让 parent fence 在后台报错，也不能用 B 的 lease 绕过。
          if (key === "resume")
            return { ok: false, reason: "owner_unavailable", message: error.message };
          if (key === "cancel") return false;
          throw error;
        }
      };
    },
  });
}
