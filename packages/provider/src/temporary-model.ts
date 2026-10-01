import { ModelConfig, ModelConfigRules, resolveApiKeyAccessKeys } from "./config/index.js";
import type { ModelSelection } from "./registry.js";
import type { ProviderRegistryServiceSnapshot } from "./registry-service.js";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  type Provider,
  type ProviderModel,
} from "./resolver.js";

export interface TemporaryModelResolution {
  readonly provider: Provider;
  readonly model: ProviderModel;
  readonly providerSaveGeneration?: string;
}

/** 从一次权威快照纯解析探测模型；结果不发布到 Registry，也不保存或修改成员资格。 */
export function resolveTemporaryModel(
  snapshot: ProviderRegistryServiceSnapshot,
  selection: Pick<ModelSelection, "providerId" | "modelId">,
): TemporaryModelResolution {
  const { providerId } = selection;
  const modelId = selection.modelId.trim();
  if (!modelId) throw new Error("临时检测 Model ID 不能为空");
  const provider = snapshot.resolution.resolvedProviders.find(
    (candidate) => candidate.providerId === providerId,
  );
  // executable 依赖至少一个已发布模型，不能作为空供应商的探测资格。
  // 临时模式只放宽模型成员/启用状态，供应商完整性、账号 current/entitled 边界保持不变。
  if (!provider || !provider.enabled || provider.providerIssues.length > 0) {
    throw new Error(`Provider 不可用于临时检测: ${providerId}`);
  }
  const providerConfig = createRegistryProviderConfig(provider.config);
  if (!providerConfig.ok) throw new Error(`Provider 配置不完整: ${providerId}`);
  const access = providerConfig.config.access;
  if (
    snapshot.account.states?.[providerId]?.current === false ||
    (access.type === "zhipu-account"
      ? access.entitled !== true
      : !resolveApiKeyAccessKeys(access).some((key) => key.enabled !== false))
  ) {
    throw new Error(`Provider 鉴权资格不可用: ${providerId}`);
  }
  const resolved = ModelConfigRules.composeEffective(
    snapshot.config.lcodeBuiltinModelRules,
    snapshot.config.personalModels,
  ).resolve({
    providerId,
    modelId,
    templateId: provider.templateId,
    apiType: provider.config.api?.type,
    baseUrl: provider.config.api?.baseUrl,
  });
  // enabled=false 是列表发布开关而不是网络能力。只覆盖本次不可变模型，不改变原规则。
  const modelConfig = createRegistryModelConfig(
    resolved.overlay(new ModelConfig({ enabled: true })),
  );
  if (!modelConfig.ok) throw new Error(`Model 配置不完整: ${providerId}/${modelId}`);
  const model = Object.freeze({ modelId, config: modelConfig.config });
  const providerSaveGeneration = snapshot.config.personalSaveGenerations?.[providerId];
  return Object.freeze({
    provider: Object.freeze({
      providerId,
      providerName: provider.providerName,
      templateId: provider.templateId,
      config: providerConfig.config,
      models: Object.freeze([model]),
    }),
    model,
    ...(providerSaveGeneration === undefined ? {} : { providerSaveGeneration }),
  });
}
