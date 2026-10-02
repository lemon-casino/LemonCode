import { normalizeModelSelection, type ModelSelection } from "@lcode/provider";
import { SESSION_ENTRY_MODEL_SELECTION, traceContextToLogContext } from "@lcode/contracts";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import {
  completeAuxiliaryRegistryModelSelection,
  getRegistryBackedModel,
  listRegistryBackedModels,
  requireRegistryThoughtLevel,
  resolveRegistryModelSelection,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";
import type { LCodeApp } from "./types.js";
import type { CreateSessionFacadeDeps } from "./session-facade-types.js";

type SessionModelDeps = Pick<
  CreateSessionFacadeDeps,
  | "runtime"
  | "providerRegistry"
  | "temporaryModelFactory"
  | "configuredDefaultModelSelection"
  | "sessionStore"
  | "sessionId"
  | "traceContext"
  | "logger"
>;

export function createSessionModelFacade(
  deps: SessionModelDeps,
): Pick<
  LCodeApp,
  | "getModel"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "listModels"
  | "getCurrentModelOption"
  | "getModelOption"
  | "listThoughtLevels"
  | "generateWorkspaceText"
  | "testModelConnectivity"
  | "setModel"
  | "setThoughtLevel"
> {
  const currentRegistrySelection = ():
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      } => {
    const registry = deps.providerRegistry;
    const selection = deps.runtime.getSessionModelSelection();
    if (!selection) return { owned: false };
    const { providerId } = selection;
    if (!registry.getProvider(providerId)) return { owned: false };
    const resolved = resolveRegistryModelSelection(registry, selection);
    return resolved ? { owned: true, registry, selection: resolved } : { owned: true, registry };
  };

  return {
    getModel: () => formatLegacyRuntimeModelValue(deps.runtime.getSessionModelSelection()),
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : deps.runtime.getSessionModelSelection()?.options?.reasoningLevel;
    },
    // 当前档位只读会话事实；缺失时不能借默认档位伪装成已完成选择。
    getThoughtLevel: () => deps.runtime.getSessionModelSelection()?.options?.reasoningLevel,
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = deps.runtime.getSessionModelSelection();
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
    generateWorkspaceText: async (input, options) => {
      // 辅助文本入口只规范化模型身份；具体的最低档位由 Core 的辅助请求调用点显式决定。
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      const temporary = input.mode === "temporary";
      if (temporary && !deps.temporaryModelFactory) {
        throw new Error("当前 Environment 未提供临时 Model 解析能力");
      }
      // 普通检测仍经严格 Registry；临时模型在单次 factory 内解析并绑定最低档位，不写会话选择。
      const selection = temporary
        ? input.selection
        : completeAuxiliaryRegistryModelSelection(deps.providerRegistry, input.selection);
      await deps.runtime.testModelConnectivity(
        { selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
          ...(temporary ? { rawModelFactory: deps.temporaryModelFactory } : {}),
        },
      );
    },
    setModel: async (modelId, options) => {
      // 配置命令已提交完整 Selection；转成字符串会丢档位。先整体校验再一次
      // 更新/保存，非法档位不能留下已换模型的半次修改。旧字符串入口补齐新模型默认值。
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = deps.runtime.getSessionModelSelection();
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      deps.runtime.setSessionModelSelection(sessionSelection);
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection(deps);
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = deps.runtime.getSessionModelSelection();
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        deps.runtime.setSessionModelSelection({
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        });
        await persistSessionModelSelection(deps);
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
  };
}

async function persistSessionModelSelection(deps: SessionModelDeps): Promise<void> {
  if (!deps.sessionStore.saveSessionEntry) return;
  const selection = deps.runtime.getSessionModelSelection();
  if (!selection) return;
  const timestamp = Date.now();
  try {
    await deps.sessionStore.saveSessionEntry({
      id: `${deps.sessionId}:runtime-model-selection`,
      sessionID: deps.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // 模型与思考档位是 session-local 原子选型；切换后立即落同一稳定 entry，
      // 不必等下一条消息，也不会在冷恢复时读取 workspace/draft 的全局最新选择。
      // 同时配置补写不代表用户新活动，不能触发 session.time_updated 变成“刚刚”。
      data: {
        modelId: selection.modelId,
        providerId: selection.providerId,
        ...(selection.options ? { options: selection.options } : {}),
      },
    });
  } catch (error) {
    // 选型已经在当前 runtime 生效；持久化失败不能反向伪装成切换失败，但必须留生产日志。
    deps.logger.warn("Session model selection persistence failed", {
      ...traceContextToLogContext(deps.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "bootstrap",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}

/** 仅供仍以 provider/model 字符串工作的内部 App facade；不是 ModelSelection 序列化。 */
function formatLegacyRuntimeModelValue(selection: ModelSelection | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}
