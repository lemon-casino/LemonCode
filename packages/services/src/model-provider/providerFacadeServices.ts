import type { Event } from "@lcode/rpc";
import { ServiceChannels } from "@lcode/shared";
import {
  type ModelConfigObject,
  type ModelId,
  type ModelSelection,
  type ModelSelectionFacade,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderConfigObject,
  type ProviderId,
  type ProviderSettingsFacade,
  type ProviderSettingsCreationResult,
  type ModelConfigResolution,
  type ProviderSettingsView,
  type ResolveModelConfigInput,
  type SavePersonalModelDraftInput,
} from "@lcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import type { ModelConnectivityResult } from "@lcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createProviderCatalogClient,
  type ProviderApiKeyProbeResult,
  type ProviderCatalogClient,
  type ProviderRemoteModelCatalog,
} from "./providerCatalogClient.js";
import type { ProviderApiKeyProbeProgress } from "./providerApiKeyProbe.js";
import { compactProviderSettingsView } from "./providerSettingsCompactView.js";
import { isApiKeyAccess, resolveApiKeyAccessKeys } from "@lcode/provider";

export type {
  ProviderSettingsProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@lcode/provider";
export type { ProviderApiKeyProbeResult, ProviderRemoteModelCatalog };
export type { ProviderApiKeyProbeProgress };
export interface ProviderApiKeyProbeEvent extends ProviderApiKeyProbeProgress {
  readonly providerId: ProviderId;
  readonly operationId: string;
}

export interface IProviderSettingsService {
  readonly onDidChange: Event<ProviderSettingsView>;
  readonly onDidProbeApiKeys: Event<ProviderApiKeyProbeEvent>;
  /** 大 Key 列表以 apiKeySummary/apiKeysOmitted 表示，管理窗口再按需读取。 */
  getView(): Promise<ProviderSettingsView>;
  /** 完整 Key 按需传输为 JSON 文本，Renderer 在 Worker 中解析。 */
  getApiKeysJson(providerId: ProviderId): Promise<string>;
  refresh(reason: string): Promise<ProviderSettingsView>;
  createPersonalProvider(
    input?: Parameters<ProviderSettingsFacade["createPersonalProvider"]>[0],
  ): Promise<ProviderSettingsCreationResult>;
  resolveModelConfig(input: ResolveModelConfigInput): Promise<ModelConfigResolution>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Parameters<ProviderSettingsFacade["savePersonalProviderOverlay"]>[2],
  ): Promise<ProviderSettingsView>;
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView>;
  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView>;
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView>;
  /** 缺省测试已发布 Model；temporary 由目标 Environment 只读解析一次性 Model。 */
  testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult>;
  listRemoteModels(providerId: ProviderId): Promise<ProviderRemoteModelCatalog>;
  probeApiKeys(
    providerId: ProviderId,
    keyIds?: readonly string[],
    options?: { readonly operationId: string; readonly streamResults?: boolean },
  ): Promise<readonly ProviderApiKeyProbeResult[]>;
  cancelApiKeyProbe(providerId: ProviderId, operationId: string): Promise<void>;
}

export const IProviderSettingsService = createServiceDescriptor<IProviderSettingsService>(
  ServiceChannels.ProviderSettings,
);

export interface ProviderSettingsConnectivityTestInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly mode?: "temporary";
}

export interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly mode?: "temporary";
}

export type ProviderSettingsConnectivityTester = (
  input: ProviderSettingsConnectivityTestInput,
) => Promise<ModelConnectivityResult>;

export interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

export interface ModelSelectionConfiguredDefaultSource {
  read(): Promise<ModelSelection | undefined>;
  onDidChange?(listener: () => void): () => void;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);

export function createProviderSettingsService(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void> = async () => {},
  testConnectivity?: ProviderSettingsConnectivityTester,
  catalogClient: ProviderCatalogClient = createProviderCatalogClient(),
): IProviderSettingsService & { dispose(): void } {
  const probes = new Map<
    string | symbol,
    { providerId: ProviderId; controller: AbortController }
  >();
  const probeListeners = new Set<(event: ProviderApiKeyProbeEvent) => void>();
  let disposed = false;
  return {
    onDidChange: toEvent((listener) =>
      facade.onDidChange((view) => listener(compactProviderSettingsView(view))),
    ),
    onDidProbeApiKeys: toEvent((listener) => {
      probeListeners.add(listener);
      return () => probeListeners.delete(listener);
    }),
    getView: async () => {
      await ensureReady();
      return compactProviderSettingsView(facade.getView());
    },
    getApiKeysJson: async (providerId) => {
      await ensureReady();
      await facade.waitForProviderOperations(providerId);
      const provider = facade.getView().providers.find((item) => item.providerId === providerId);
      if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
      const access = provider.effectiveConfig.access;
      return JSON.stringify(isApiKeyAccess(access) ? resolveApiKeyAccessKeys(access) : []);
    },
    refresh: async (reason) => {
      await ensureReady();
      return compactProviderSettingsView(await facade.refresh(reason));
    },
    createPersonalProvider: async (input) => {
      await ensureReady();
      const result = await facade.createPersonalProvider(input);
      return { ...result, view: compactProviderSettingsView(result.view) };
    },
    resolveModelConfig: async (input) => {
      await ensureReady();
      return facade.resolveModelConfig(input);
    },
    savePersonalProviderOverlay: async (providerId, config, metadata) => {
      await ensureReady();
      return compactProviderSettingsView(
        await facade.savePersonalProviderOverlay(providerId, config, metadata),
      );
    },
    deletePersonalProvider: async (providerId) => {
      await ensureReady();
      return compactProviderSettingsView(await facade.deletePersonalProvider(providerId));
    },
    reorderPersonalProviders: async (providerIds) => {
      await ensureReady();
      return compactProviderSettingsView(await facade.reorderPersonalProviders(providerIds));
    },
    reorderPersonalModels: async (providerId, modelIds) => {
      await ensureReady();
      return compactProviderSettingsView(await facade.reorderPersonalModels(providerId, modelIds));
    },
    addPersonalModel: async (providerId, modelId, config, useRecommendedConfig) => {
      await ensureReady();
      return compactProviderSettingsView(
        await facade.addPersonalModel(providerId, modelId, config, useRecommendedConfig),
      );
    },
    renamePersonalModel: async (providerId, currentModelId, nextModelId) => {
      await ensureReady();
      return compactProviderSettingsView(
        await facade.renamePersonalModel(providerId, currentModelId, nextModelId),
      );
    },
    deletePersonalModel: async (providerId, modelId) => {
      await ensureReady();
      return compactProviderSettingsView(await facade.deletePersonalModel(providerId, modelId));
    },
    savePersonalModelDraft: async (input) => {
      await ensureReady();
      return compactProviderSettingsView(await facade.savePersonalModelDraft(input));
    },
    setPersonalModelEnabled: async (providerId, modelId, enabled) => {
      await ensureReady();
      return compactProviderSettingsView(
        await facade.setPersonalModelEnabled(providerId, modelId, enabled),
      );
    },
    testModelConnectivity: async (input) => {
      await ensureReady();
      if (!testConnectivity) {
        throw new Error("当前 Environment 未装配模型连通性测试能力");
      }
      await facade.waitForProviderOperations(input.providerId);
      // 禁用对象仍存在于配置视图，但不进入执行 Registry；不能把未发布误报成配置丢失。
      // 只消费操作完成后的公共资格，不另查 Key、权益，也不替代目标 Environment 最终校验。
      // 临时检测不能依赖由已发布模型反推的 provider.executable，否则空/全禁用列表永远无法检测。
      const provider = facade
        .getView()
        .providers.find((item) => item.providerId === input.providerId);
      const model = provider?.models.find((item) => item.modelId === input.modelId);
      const unavailable =
        !provider || !provider.enabled
          ? "provider-unavailable"
          : input.mode === "temporary"
            ? provider.issues.length > 0
              ? "provider-unavailable"
              : undefined
            : !model || !model.enabled || model.issues.length > 0
              ? "model-unavailable"
              : !provider.executable
                ? "provider-unavailable"
                : !model.executable
                  ? "model-unavailable"
                  : undefined;
      if (unavailable) {
        return {
          success: false,
          error: {
            code: unavailable,
            message:
              unavailable === "provider-unavailable"
                ? "This provider is currently unavailable for connectivity testing."
                : "This model is currently unavailable for connectivity testing.",
          },
        };
      }
      return testConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        providerId: input.providerId,
        modelId: input.modelId,
        ...(input.mode ? { mode: input.mode } : {}),
      });
    },
    listRemoteModels: async (providerId) => {
      await ensureReady();
      await facade.waitForProviderOperations(providerId);
      const provider = facade.getView().providers.find((item) => item.providerId === providerId);
      if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
      return catalogClient.listModels(provider.effectiveConfig);
    },
    probeApiKeys: async (providerId, keyIds, options) => {
      if (disposed) throw new Error("Provider Settings Service 已 dispose");
      const controller = new AbortController();
      const operationId = options?.operationId;
      const owner = operationId ?? Symbol();
      if (operationId && probes.has(operationId))
        throw new Error("API Key probe is already running");
      // 在首个 await 前登记 owner，取消命令也能中断等待配置事务的检测。
      probes.set(owner, { providerId, controller });
      try {
        await ensureReady();
        await facade.waitForProviderOperations(providerId);
        if (controller.signal.aborted) return [];
        const provider = facade.getView().providers.find((item) => item.providerId === providerId);
        if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
        const results = await catalogClient.probeApiKeys(provider.effectiveConfig, keyIds, {
          signal: controller.signal,
          onProgress: operationId
            ? (progress) => {
                for (const listener of probeListeners)
                  listener({ ...progress, providerId, operationId });
              }
            : undefined,
        });
        return options?.streamResults ? [] : results;
      } finally {
        probes.delete(owner);
      }
    },
    cancelApiKeyProbe: async (providerId, operationId) => {
      const probe = probes.get(operationId);
      if (probe?.providerId === providerId) probe.controller.abort();
    },
    dispose: () => {
      disposed = true;
      for (const probe of probes.values()) probe.controller.abort();
      probes.clear();
      probeListeners.clear();
    },
  };
}

export function createModelSelectionService(
  facade: ModelSelectionFacade,
  ensureReady: () => Promise<void> = async () => {},
  configuredDefaultSource?: ModelSelectionConfiguredDefaultSource,
): IModelSelectionService & { dispose(): void } {
  const log = createServiceLogger("model-selection");
  let revision = 0;
  let disposed = false;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    await ensureReady();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const configuredDefault = await configuredDefaultSource?.read();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const base = facade.getView(configuredDefault);
    if (revision < base.revision) revision = base.revision;
    return facade.getView(configuredDefault, revision, input);
  };
  const emit = (): void => {
    if (disposed) return;
    revision += 1;
    void getView().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        // Registry 事件触发的异步 View 重建没有 owner；Host dispose 后它仍会继续
        // 读取已释放的配置仓库，并形成未处理 rejection。dispose 是明确的取消边界；仅在服务
        // 仍存活时记录真实读取失败。
        if (disposed) return;
        log.warn(undefined, `ModelSelection View 刷新失败: ${String(error)}`);
      },
    );
  };
  const disposeFacade = facade.onDidChange(emit);
  const disposeConfiguredDefault = configuredDefaultSource?.onDidChange?.(emit);

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getView,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeFacade();
      disposeConfiguredDefault?.();
      listeners.clear();
    },
  };
}

function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}
