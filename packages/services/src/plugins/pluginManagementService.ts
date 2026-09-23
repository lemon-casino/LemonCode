// 设置页插件管理薄服务实现——plugins/* 旧协议词的唯一 host 侧消费点。
// 插件安装/市场/启停的事实源在 zcode-cli 进程（读写 ~/.zcode 插件目录并热更新
// 运行态），host 无副本，故实现保持 agent 协议往返；收敛价值在 UI 层不再直触
// IZCodeAgentService，词表消费面从 UI 散点收拢到本文件一处。
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";

const logger = createServiceLogger("plugin-management");

interface PluginManagementServiceDependencies {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    | "listPlugins"
    | "getPluginReferenceCatalog"
    | "resolveSuggestedPluginReference"
    | "onDynamicPluginOperationProgress"
    | "getPluginsOverview"
    | "addPluginMarketplace"
    | "removePluginMarketplace"
    | "updatePluginMarketplace"
    | "installPlugin"
    | "cancelPluginOperation"
    | "uninstallPlugin"
    | "updatePlugin"
    | "restoreBuiltinPlugin"
    | "configurePlugin"
    | "resetPluginConfig"
    | "validatePlugin"
    | "describePlugin"
    | "setPluginEnabled"
    | "disposeWorkspace"
  >;
}

export function createPluginManagementService(
  dependencies: PluginManagementServiceDependencies,
): IPluginManagementService {
  const agent = dependencies.zcodeAgentService;
  return {
    listPlugins: (params) => agent.listPlugins(params),
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: (params) => agent.getPluginsOverview(params),
    addPluginMarketplace: (params) => agent.addPluginMarketplace(params),
    removePluginMarketplace: (params) => agent.removePluginMarketplace(params),
    updatePluginMarketplace: (params) => agent.updatePluginMarketplace(params),
    installPlugin: (params) => agent.installPlugin(params),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) => agent.uninstallPlugin(params),
    updatePlugin: (params) => agent.updatePlugin(params),
    restoreBuiltinPlugin: (params) => agent.restoreBuiltinPlugin(params),
    configurePlugin: (params) => agent.configurePlugin(params),
    resetPluginConfig: (params) => agent.resetPluginConfig(params),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
    setPluginEnabled: async (params) => {
      const result = await agent.setPluginEnabled(params);
      if (params.pluginId.trim().toLowerCase() !== ZCODE_CUA_OFFICIAL_PLUGIN_ID) {
        return result;
      }

      try {
        // Computer Use 的 runtime feature 与 Helper tuple 都在 workspace Agent 启动时冻结。
        // 过去只落盘开关，预热过的 Agent 会继续沿用旧工具集；写入成功后精确推进该
        // workspace runtime，下一次请求才能按新配置重建，同时不触碰管理 lane 与 Helper owner。
        await agent.disposeWorkspace({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        });
      } catch (error) {
        // 配置已由 Agent 持久化，且 dispose 会先移除旧 client、推进 generation 再清理进程。
        // 清理尾声失败不能把 UI 回滚成旧配置；保留成功事实并记录可诊断告警。
        logger.warn(
          undefined,
          "Computer Use toggle persisted but workspace cleanup reported an error",
          {
            enabled: params.enabled,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return result;
    },
  };
}
