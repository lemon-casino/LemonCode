import type { ModelSelection } from "@zcode/shared";

export interface DraftModelSelectionContext {
  provider: string;
  model: string;
}

export interface DraftModelSelectionSource {
  modelSelection?: ModelSelection | null;
  provider?: string | null;
  model?: string | null;
}

/**
 * Bug 原因：thought/speed 曾只改 draft 字段，运行中 failover 仍保留旧 options。
 * 按用户操作时看到的模型合并单个档位，让 draft 与接管命令复用同一份完整选择。
 */
export function updateDraftModelSelectionOption(
  source: DraftModelSelectionSource,
  modelContext: DraftModelSelectionContext,
  option: "reasoningLevel" | "speed",
  value: string,
): ModelSelection | null {
  const normalizedValue = value.trim();
  const legacyProviderId = source.provider?.trim();
  const legacyModelId = source.model?.trim();
  const selection =
    source.modelSelection ??
    (legacyProviderId && legacyModelId
      ? { providerId: legacyProviderId, modelId: legacyModelId }
      : null);
  if (
    !selection ||
    !normalizedValue ||
    selection.providerId !== modelContext.provider ||
    selection.modelId !== modelContext.model
  ) {
    return null;
  }

  return {
    ...selection,
    options: {
      ...selection.options,
      [option]: normalizedValue,
    },
  };
}
