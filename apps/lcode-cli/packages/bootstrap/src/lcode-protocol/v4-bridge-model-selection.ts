import type { CollaborationMode, ModelSelection } from "@lcode/contracts";

import type { LCodeProtocolSessionRecord } from "./server-types.js";

const STABLE_FORK_MODES = new Set<CollaborationMode>(["plan", "build", "edit", "yolo", "auto"]);

export function stableForkMode(value: string, fallback: CollaborationMode): CollaborationMode {
  return STABLE_FORK_MODES.has(value as CollaborationMode)
    ? (value as CollaborationMode)
    : fallback;
}

export function modelSelectionWithOptionFallback(
  selection: ModelSelection | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return fallback && cloneModelSelection(fallback);
  // 兼容旧 fork 消息可能缺少 reasoning；输出预算属于单次请求，不属于 Selection。
  const reasoningLevel = selection.options?.reasoningLevel ?? fallback?.options?.reasoningLevel;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel !== undefined
      ? {
          options: { reasoningLevel },
        }
      : {}),
  };
}

export function cloneModelSelection(
  selection: ReturnType<LCodeProtocolSessionRecord["app"]["runtime"]["getSessionModelSelection"]>,
): ModelSelection | undefined {
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}
