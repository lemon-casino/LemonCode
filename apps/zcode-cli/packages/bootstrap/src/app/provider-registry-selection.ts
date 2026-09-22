import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import {
  completeNewModelSelection,
  normalizeModelSelection,
  type ModelSelection,
  type Provider,
  type ProviderModel,
} from "@zcode/provider";
import type { ZCodeModelOption } from "@zcode/shared";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

export interface ResolvedRegistrySelection {
  readonly provider: Provider;
  readonly model: ProviderModel;
  readonly selection: ModelSelection;
}

/**
 * Registry 是模型选择的正式候选来源。当前 Turn 临时携带的 Provider 属于执行输入，
 * 不进入模型选择列表。
 */
export function listRegistryBackedModels(
  registry: ProviderRegistryModelSource,
): ZCodeModelOption[] {
  const view = registry.getView();
  return view.providers.flatMap((provider) =>
    provider.models.map((model) => toModelOption(provider, model)),
  );
}

export function getRegistryBackedModel(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ZCodeModelOption | undefined {
  const provider = registry.getProvider(selection.providerId);
  const model = registry.getModel(selection.providerId, selection.modelId);
  return provider && model ? toModelOption(provider, model) : undefined;
}

/**
 * 为连通性等辅助调用补齐最低推理档位。Factory 只接受完整执行选择，
 * 因而必须在创建 Model 之前完成，不能等 Model 创建后再 bind。
 */
export function completeAuxiliaryRegistryModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ModelSelection {
  const model = registry.getModel(selection.providerId, selection.modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values[0];
  if (!reasoningLevel) return selection;
  const speed = model.config.optionSpecs.speed?.values[0];
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: {
      ...selection.options,
      reasoningLevel,
      ...(speed ? { speed } : {}),
    },
  };
}

export function resolveRegistryOwnedSelection(
  registry: ProviderRegistryModelSource,
  requested: string,
  configuredDefault?: ModelSelection,
): ResolvedRegistrySelection | undefined {
  const parsed = parseRequestedModelSelection(requested, configuredDefault);
  if (!parsed) return undefined;
  // 字符串选模型是主动切换，旧协议没有速度字段；只在此入口补目标模型默认值。
  const normalized = normalizeModelSelection(registry.getView(), parsed);
  const selection = normalized?.options
    ? normalized
    : completeNewModelSelection(registry.getView(), parsed);
  return selection ? resolveRegistryOwnedModelSelection(registry, selection) : undefined;
}

function parseRequestedModelSelection(
  requested: string,
  configuredDefault?: ModelSelection,
): ModelSelection | undefined {
  const normalized = requested.trim();
  if (normalized === "main") return configuredDefault;
  return parseProviderQualifiedModelSelection(normalized);
}

export function parseProviderQualifiedModelSelection(
  requested: string,
): ModelSelection | undefined {
  const normalized = requested.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) return undefined;
  const providerId = normalized.slice(0, separator).trim();
  const modelId = normalized.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/**
 * 解析由 Registry 已接管 Provider 的模型选择。
 *
 * 返回 undefined 表示进程 Registry 不拥有该 Provider。Registry 已拥有 Provider 时，
 * 缺失 Model 必须直接报错；调用方不能再回退 Turn Overlay 或临时 Provider 快照。
 */
export function resolveRegistryOwnedModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
  options?: { allowMissingReasoning?: boolean },
): ResolvedRegistrySelection | undefined {
  const validation = registry.validateSelection(selection);
  if (!validation.ok) {
    if (validation.code === "provider-not-found") return undefined;
    if (validation.code === "reasoning-level-missing" && options?.allowMissingReasoning) {
      return resolveRegistryModelSelection(registry, selection);
    }
    throw createRegistrySelectionProtocolError(validation);
  }
  const resolved = resolveRegistryModelSelection(registry, selection);
  if (!resolved) throw new Error("Registry Selection 校验与索引结果不一致");
  return resolved;
}

/** Registry 选择校验失败到稳定 Model 协议错误的唯一映射。 */
export function createRegistrySelectionProtocolError(
  validation: Exclude<ReturnType<ProviderRegistryModelSource["validateSelection"]>, { ok: true }>,
): ModelProtocolError {
  switch (validation.code) {
    case "provider-not-found":
      return new ModelProtocolError(
        ModelErrorCode.ProviderNotFound,
        `Provider Registry 中不存在 Provider: ${validation.providerId}`,
      );
    case "model-not-found":
      return new ModelProtocolError(
        ModelErrorCode.ModelNotFound,
        `Provider Registry 中不存在 Model: ${validation.providerId}/${validation.modelId}`,
      );
    case "reasoning-level-missing":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Reasoning level is required for ${validation.providerId}/${validation.modelId}`,
      );
    case "reasoning-level-not-supported":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Reasoning effort "${validation.reasoningLevel}" is not supported by ${validation.providerId}/${validation.modelId}`,
      );
    case "speed-missing":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Model speed is required for ${validation.providerId}/${validation.modelId}`,
      );
    case "speed-not-supported":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Model speed "${validation.speed}" is not supported by ${validation.providerId}/${validation.modelId}`,
      );
  }
}

export function resolveRegistryModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ResolvedRegistrySelection | undefined {
  const provider = registry.getProvider(selection.providerId);
  const model = registry.getModel(selection.providerId, selection.modelId);
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
    selection: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.options ? { options: { ...selection.options } } : {}),
    },
  };
}

export function resolveRegistryThoughtLevel(
  selection: ResolvedRegistrySelection | undefined,
  requested?: string,
): string | undefined {
  const spec = selection?.model.config.optionSpecs.reasoningLevel;
  if (!spec) return undefined;
  return requested && spec.values.includes(requested) ? requested : undefined;
}

export function requireRegistryThoughtLevel(
  selection: ResolvedRegistrySelection,
  requested: string,
): string {
  const spec = selection.model.config.optionSpecs.reasoningLevel;
  if (!spec.values.includes(requested)) {
    throw new Error(`Unsupported reasoning effort: ${requested}`);
  }
  return requested;
}

function toModelOption(provider: Provider, model: ProviderModel): ZCodeModelOption {
  const properties = model.config.properties;
  const optionSpecs = model.config.optionSpecs;
  const reasoning = optionSpecs.reasoningLevel;
  return {
    ref: { providerId: provider.providerId, modelId: model.modelId },
    label: model.modelId,
    providerLabel: provider.providerName ?? provider.providerId,
    contextWindow: properties.contextWindow,
    maxOutputTokens: optionSpecs.maxOutputTokens.max,
    reasoning: {
      levels: reasoning.values.map((level) => ({ value: level, label: level })),
      defaultLevel: reasoning.values.at(-1),
    },
    properties: {
      inputFormat: properties.inputFormat,
      outputFormat: properties.outputFormat,
    },
  };
}
