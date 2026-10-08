import { useRef } from "react";
import type { WorktreeIntegrateRequest, WorktreeIntegration } from "@lcode/services";

export function useWorktreeIntegrationRequest(scope: string) {
  const request = useRef<{ key: string; params: WorktreeIntegrateRequest } | null>(null);
  return (
    params: Omit<WorktreeIntegrateRequest, "requestId">,
    operation: WorktreeIntegration | null,
  ) => {
    const key = JSON.stringify([scope, params]);
    const discarded =
      operation &&
      ["cancelled", "failed"].includes(operation.status) &&
      operation.requestId === request.current?.params.requestId;
    // 响应丢失后复用 admission；此 ref 只关联当前请求，不成为第二份已接受操作或队列。
    if (request.current?.key !== key || discarded)
      request.current = { key, params: { ...params, requestId: crypto.randomUUID() } };
    return request.current.params;
  };
}
