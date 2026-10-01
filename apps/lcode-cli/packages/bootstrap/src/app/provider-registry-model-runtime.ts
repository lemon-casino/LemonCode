import type { AiSdkModelAdapter } from "@lcode/adapters/model";
import type { Model } from "@lcode/contracts";
import type { AgentRuntimeDeps } from "@lcode/core";
import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
  type TemporaryModelResolution,
} from "@lcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getSnapshot?(): {
    readonly config: {
      readonly personalSaveGenerations?: Readonly<Record<string, string>>;
    };
  } | null;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  resolveTemporaryModel?(selection: ModelSelection): TemporaryModelResolution;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    return this.#createRegistryModel(
      provider,
      registryModel,
      target,
      resolveProviderSaveGeneration(this.#registry, providerId).providerSaveGeneration,
    );
  };

  // 每次探测独立解析并冻结配置；不能临时替换共享 factory，否则并发会话会拿到探测模型。
  readonly temporaryModelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const resolved = this.#registry.resolveTemporaryModel?.(target.selection);
    if (!resolved) throw new Error("当前 Environment 未提供临时 Model 解析能力");
    const speed = resolved.model.config.optionSpecs.speed?.values[0];
    return this.#createRegistryModel(
      resolved.provider,
      resolved.model,
      {
        ...target,
        selection: {
          providerId: resolved.provider.providerId,
          modelId: resolved.model.modelId,
          options: {
            reasoningLevel: resolved.model.config.optionSpecs.reasoningLevel.values[0]!,
            ...(speed ? { speed } : {}),
          },
        },
      },
      resolved.providerSaveGeneration,
    );
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
    providerSaveGeneration: string | undefined,
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // 正式选择已通过 Registry 校验；临时选择来自本次完整解析，两者都显式带最低/所选档位。
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    const speed = target.selection.options?.speed;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      // 创建时冻结。只有本供应商自己的保存代次变化才清失败 Key。
      ...(providerSaveGeneration === undefined ? {} : { providerSaveGeneration }),
      modelConfig: config,
      ...(provider.config.access.type === "zhipu-account" &&
      provider.config.access.mode === "off-peak"
        ? {
            requestDependencies: {
              requestAuth: {
                source: target.requestDependencies?.requestAuth?.source,
              },
            },
          }
        : {}),
      options: {
        reasoningLevel: normalReasoningLevel,
        ...(speed ? { speed } : {}),
      },
    });
  }
}

export function resolveProviderSaveGeneration(
  registry: Pick<ProviderRegistryModelSource, "getSnapshot">,
  providerId: string,
): {
  readonly providerSaveGeneration?: string;
} {
  const config = registry.getSnapshot?.()?.config;
  const generation = config?.personalSaveGenerations?.[providerId];
  return generation === undefined ? {} : { providerSaveGeneration: generation };
}
