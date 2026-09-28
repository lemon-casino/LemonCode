// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 ILCodeAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 lcode-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@lcode/rpc";
import type {
  LCodePluginOperationProgressNotification,
  LCodePluginsConfigureResult,
  LCodePluginsCancelOperationResult,
  LCodePluginsDescribeResult,
  LCodePluginsInstallResult,
  LCodePluginsListResult,
  LCodePluginsMarketplaceMutationResult,
  LCodePluginsOverviewResult,
  LCodePluginsReferenceCatalogResult,
  LCodePluginsRestoreBuiltinResult,
  LCodePluginsSetEnabledResult,
  LCodePluginsUninstallResult,
  LCodePluginsValidateResult,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  LCodeAgentAddPluginMarketplaceParams,
  LCodeAgentConfigurePluginParams,
  LCodeAgentCancelPluginOperationParams,
  LCodeAgentDescribePluginParams,
  LCodeAgentInstallPluginParams,
  LCodeAgentPluginReferenceCatalogParams,
  LCodeAgentResolveSuggestedPluginReferenceParams,
  LCodeAgentResetPluginConfigParams,
  LCodeAgentPluginViewParams,
  LCodeAgentRemovePluginMarketplaceParams,
  LCodeAgentRestoreBuiltinPluginParams,
  LCodeAgentSetPluginEnabledParams,
  LCodeAgentUninstallPluginParams,
  LCodeAgentUpdatePluginMarketplaceParams,
  LCodeAgentUpdatePluginParams,
  LCodeAgentValidatePluginParams,
} from "../lcode-agent/lcodeAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: LCodeAgentPluginViewParams): Promise<LCodePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: LCodeAgentPluginReferenceCatalogParams,
  ): Promise<LCodePluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: LCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@lcode/shared").LCodePluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<LCodePluginOperationProgressNotification>;
  getPluginsOverview(params: LCodeAgentPluginViewParams): Promise<LCodePluginsOverviewResult>;
  addPluginMarketplace(
    params: LCodeAgentAddPluginMarketplaceParams,
  ): Promise<LCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: LCodeAgentRemovePluginMarketplaceParams,
  ): Promise<LCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: LCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<LCodePluginsMarketplaceMutationResult>;
  installPlugin(params: LCodeAgentInstallPluginParams): Promise<LCodePluginsInstallResult>;
  cancelPluginOperation(
    params: LCodeAgentCancelPluginOperationParams,
  ): Promise<LCodePluginsCancelOperationResult>;
  uninstallPlugin(params: LCodeAgentUninstallPluginParams): Promise<LCodePluginsUninstallResult>;
  updatePlugin(params: LCodeAgentUpdatePluginParams): Promise<LCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: LCodeAgentRestoreBuiltinPluginParams,
  ): Promise<LCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: LCodeAgentConfigurePluginParams): Promise<LCodePluginsConfigureResult>;
  resetPluginConfig(
    params: LCodeAgentResetPluginConfigParams,
  ): Promise<LCodePluginsConfigureResult>;
  validatePlugin(params: LCodeAgentValidatePluginParams): Promise<LCodePluginsValidateResult>;
  describePlugin(params: LCodeAgentDescribePluginParams): Promise<LCodePluginsDescribeResult>;
  setPluginEnabled(params: LCodeAgentSetPluginEnabledParams): Promise<LCodePluginsSetEnabledResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);
