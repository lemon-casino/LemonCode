import {
  lcodePluginsCancelOperationParamsSchema,
  lcodeWorkspaceCancelGenerateTextParamsSchema,
} from "@lcode/shared";

import type { LCodeProtocolRequest } from "@lcode/shared";

import { ProtocolRequestError, parseParams } from "./server-types.js";

function getPluginOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

function getOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

export interface ProtocolOperationState {
  pluginOperationControllers: Map<string, AbortController>;
  workspaceGenerateTextControllers: Map<string, AbortController>;
}

export async function withPluginOperationSignal<T>(
  host: ProtocolOperationState,
  request: LCodeProtocolRequest,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const operationId = getPluginOperationId(request.params);
  if (!operationId) return await run();

  const controller = new AbortController();
  host.pluginOperationControllers.set(operationId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (host.pluginOperationControllers.get(operationId) === controller) {
      host.pluginOperationControllers.delete(operationId);
    }
  }
}

export function cancelPluginOperation(host: ProtocolOperationState, rawParams: unknown) {
  const params = parseParams(lcodePluginsCancelOperationParamsSchema, rawParams);
  const controller = host.pluginOperationControllers.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  // 插件同步的可取消能力必须保留在 V4 server；仅按 operationId 中止对应链路。
  controller.abort();
  host.pluginOperationControllers.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}

export async function withWorkspaceGenerateTextSignal<T>(
  host: ProtocolOperationState,
  request: LCodeProtocolRequest,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const operationId = getOperationId(request.params);
  if (!operationId) return await run();

  if (host.workspaceGenerateTextControllers.has(operationId)) {
    // 重复 operationId 会覆盖首个请求的 AbortController，导致首个请求失去取消能力。
    // 活跃 operationId 必须保持唯一；请求结束后 finally 会释放，之后才允许复用。
    throw new ProtocolRequestError(
      -32600,
      `Workspace generate operation is already active: ${operationId}`,
    );
  }

  const controller = new AbortController();
  host.workspaceGenerateTextControllers.set(operationId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (host.workspaceGenerateTextControllers.get(operationId) === controller) {
      host.workspaceGenerateTextControllers.delete(operationId);
    }
  }
}

export function cancelWorkspaceGenerateText(host: ProtocolOperationState, rawParams: unknown) {
  const params = parseParams(lcodeWorkspaceCancelGenerateTextParamsSchema, rawParams);
  const controller = host.workspaceGenerateTextControllers.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
  host.workspaceGenerateTextControllers.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}
