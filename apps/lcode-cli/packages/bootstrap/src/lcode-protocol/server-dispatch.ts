import { querySessionDebug } from "./session-debug.js";
import { workspaceFileMutationJournal } from "./workspace-file-mutation-journal.js";
import { lcodeProtocolMethods, lcodeWorkspaceHookTrustGrantParamsSchema } from "@lcode/shared";

import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@lcode/shared/lcode-protocol-v4";
import type { LCodeProtocolRequest, LCodeProtocolRequestId } from "@lcode/shared";
import {
  cancelBackgroundTask,
  closeSession,
  compactSession,
  createSession,
  forkSession,
  generateWorkspaceText,
  goalSession,
  getTaskTokenUsage,
  getUsageStats,
  listSessions,
  listSessionSubagents,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  sendPrompt,
  setMode,
  setModel,
  setThoughtLevel,
  stopSession,
  subscribeSession,
} from "./server-operations.js";
import { listChildProcesses } from "./process-child-processes.js";

import {
  readWorkspacePresentation,
  testProviderModelConnectivity,
} from "./workspace-model-runtime.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "./plugins.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows.js";
import { listMcpServers } from "./mcp.js";
import { updateInteractionPreferences } from "./interaction-preferences.js";
import { updateAccountProviderConfig } from "./account-provider-config.js";
import { updateModelIoPreferences } from "./model-io-preferences.js";
import { updateOffPeakToolPolicy } from "./off-peak-tool-policy.js";
import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";
import { grantWorkspaceHookTrustForProtocol } from "./workspace-hook-trust.js";

import {
  ProtocolRequestError,
  type LCodeProtocolAgentServerContext,
  type LCodeProtocolSessionRecord,
} from "./server-types.js";

import {
  withPluginOperationSignal,
  cancelPluginOperation,
  withWorkspaceGenerateTextSignal,
  cancelWorkspaceGenerateText,
  type ProtocolOperationState,
} from "./server-operation-signals.js";
import type { LCodeProtocolOutboundMessage } from "./server-client-requests.js";

export interface LCodeProtocolPostResponseBatch {
  readonly messages: readonly LCodeProtocolOutboundMessage[];
  commit(): boolean;
}

export interface ProtocolDispatchHost extends ProtocolOperationState {
  context: LCodeProtocolAgentServerContext;
  postResponseOutbox: Map<LCodeProtocolRequestId, LCodeProtocolPostResponseBatch>;
}

/**
 * Trust store 落盘后各 session 的 coordinator
 * 内存镜像（仅创建时 load）不会自动更新，已信任 Hook 继续被拒、banner pendingCount
 * 停留旧值。pretrust 授权成功后按 workspaceKey 通知所有匹配的活跃 session 重载。
 * 独立导出为纯调度函数（不触网、不发事件），便于回归测试直接构造 sessions Map。
 */
async function notifyWorkspaceHookTrustGrantSessions(input: {
  grantedWorkspaceKey?: string;
  sessions: Map<string, LCodeProtocolSessionRecord>;
}): Promise<void> {
  if (!input.grantedWorkspaceKey) return;
  await Promise.all(
    [...input.sessions.values()]
      .filter((record) => record.workspace.workspaceKey === input.grantedWorkspaceKey)
      .map((record) => record.app.reloadWorkspaceHookTrust()),
  );
}

export function requireV4Gateway(host: Pick<ProtocolDispatchHost, "context">) {
  if (!host.context.v4Gateway) {
    throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
  }
  return host.context.v4Gateway;
}

export async function dispatchRequest(host: ProtocolDispatchHost, request: LCodeProtocolRequest) {
  switch (request.method) {
    // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
    case V4_METHODS.connectionFlow: {
      requireV4Gateway(host).setConnectionFlowState(request.params);
      return {};
    }
    case V4_METHODS.conversationSubscribe: {
      // 同一 subscribe 方法按 topic 前缀分派：
      // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
      const gateway = requireV4Gateway(host);
      const topic = (request.params as { topic?: unknown } | null)?.topic;
      let dispatch;
      if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
        dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
      } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
        dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
      } else {
        dispatch = await gateway.subscribeReserved(request.params);
      }
      if (dispatch.initialWires.length > 0) {
        host.postResponseOutbox.set(request.id, {
          messages: dispatch.initialWires.map((wire) => ({
            method: V4_NOTIFICATIONS.conversationFrame,
            params: wire,
          })),
          commit: dispatch.commit,
        });
      }
      return { ack: dispatch.ack };
    }
    case V4_METHODS.conversationResync: {
      // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
      // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
      const dispatch = requireV4Gateway(host).resyncReserved(request.params);
      if (dispatch.initialWires.length > 0) {
        host.postResponseOutbox.set(request.id, {
          messages: dispatch.initialWires.map((wire) => ({
            method: V4_NOTIFICATIONS.conversationFrame,
            params: wire,
          })),
          commit: dispatch.commit,
        });
      }
      return { ack: dispatch.ack };
    }
    case V4_METHODS.conversationUnsubscribe: {
      // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
      // subId 对 conversation/sessions-index/workspace-config 广撒网。
      requireV4Gateway(host).unsubscribe(request.params);
      return {};
    }
    // ── 行分页 query（独立分支，便于与帧分派改动合并）──
    case V4_METHODS.conversationRowsRange:
      return await requireV4Gateway(host).rowsRange(request.params);
    case V4_METHODS.conversationPlans:
      return await requireV4Gateway(host).plans(request.params);
    case V4_METHODS.backgroundBashOutput:
      return await requireV4Gateway(host).backgroundBashOutput(request.params);
    case V4_METHODS.conversationFileChanges:
      return await requireV4Gateway(host).fileChanges(request.params);
    case V4_METHODS.conversationFileRewindPreview:
      return await requireV4Gateway(host).fileRewindPreview(request.params);
    // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
    case V4_METHODS.conversationWorkflowRunEvents:
      return await requireV4Gateway(host).workflowRunEvents(request.params);
    // dwf run 枚举（重启后的发现查询）。
    case V4_METHODS.conversationWorkflowRuns:
      return await requireV4Gateway(host).workflowRuns(request.params);
    // dwf 用户面产物的三个读面。同族：只读、无状态、
    // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
    case V4_METHODS.conversationWorkflowRunArtifacts:
      return await requireV4Gateway(host).workflowRunArtifacts(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactData:
      return await requireV4Gateway(host).workflowRunArtifactData(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactRead:
      return await requireV4Gateway(host).workflowRunArtifactRead(request.params);
    // dwf 工作区 transcript 的两个读面。同族。
    case V4_METHODS.conversationWorkflowRunWorkspace:
      return await requireV4Gateway(host).workflowRunWorkspace(request.params);
    case V4_METHODS.conversationWorkflowRunNodeResult:
      return await requireV4Gateway(host).workflowRunNodeResult(request.params);
    // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
    case V4_METHODS.attachmentBegin:
      return await requireV4Gateway(host).attachmentBegin(request.params);
    case V4_METHODS.attachmentChunk:
      return await requireV4Gateway(host).attachmentChunk(request.params);
    case V4_METHODS.attachmentCommit:
      return await requireV4Gateway(host).attachmentCommit(request.params);
    case V4_METHODS.attachmentAbort:
      await requireV4Gateway(host).attachmentAbort(request.params);
      return {};
    case V4_METHODS.attachmentRead:
      return await requireV4Gateway(host).attachmentRead(request.params);
    case V4_METHODS.conversationAttachmentRead:
      return await requireV4Gateway(host).conversationAttachmentRead(request.params);
    case V4_METHODS.conversationAttachmentStat:
      return await requireV4Gateway(host).conversationAttachmentStat(request.params);
    case V4_METHODS.attachmentPreviewSource:
      return await requireV4Gateway(host).attachmentPreviewSource(request.params);
    // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
    // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
    // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
    case V4_METHODS.usageStats:
      return await getUsageStats(host.context, request.params);
    case V4_METHODS.conversationUsage:
      return await getTaskTokenUsage(host.context, request.params);
    case V4_METHODS.command:
      return requireV4Gateway(host).handleCommand(request.params);
    case V4_METHODS.commandsQuery:
      return requireV4Gateway(host).queryCommands(request.params);
    case lcodeProtocolMethods.sessionCreate:
      return await createSession(host.context, request.params, request.trace);
    case lcodeProtocolMethods.sessionResume:
      return await resumeSession(host.context, request.params);
    case lcodeProtocolMethods.sessionList:
      return await listSessions(host.context, request.params);
    case lcodeProtocolMethods.sessionSubagents:
      return await listSessionSubagents(host.context, request.params);
    case lcodeProtocolMethods.sessionRead:
      return await readSession(host.context, request.params);
    case lcodeProtocolMethods.sessionMessages:
      return await readMessages(host.context, request.params);
    case lcodeProtocolMethods.sessionEvents:
      return await readEvents(host.context, request.params);
    case lcodeProtocolMethods.sessionSubscribe:
      return await subscribeSession(host.context, request.params);
    case lcodeProtocolMethods.sessionSend:
      return await sendPrompt(host.context, request.params);
    case lcodeProtocolMethods.sessionStop:
      return await stopSession(host.context, request.params);
    case lcodeProtocolMethods.sessionCancelBackgroundTask:
      return await cancelBackgroundTask(host.context, request.params);
    case lcodeProtocolMethods.sessionFork:
      return await forkSession(host.context, request.params);
    case lcodeProtocolMethods.sessionCompact:
      return await compactSession(host.context, request.params);
    case lcodeProtocolMethods.sessionGoal:
      return await goalSession(host.context, request.params);
    case lcodeProtocolMethods.sessionSetModel:
      return await setModel(host.context, request.params);
    case lcodeProtocolMethods.sessionSetThoughtLevel:
      return await setThoughtLevel(host.context, request.params);
    case lcodeProtocolMethods.sessionSetMode:
      return await setMode(host.context, request.params);
    case lcodeProtocolMethods.sessionClose:
      return await closeSession(host.context, request.params);
    case lcodeProtocolMethods.workspaceReadPresentation:
      return await readWorkspacePresentation(host.context, request.params);
    case lcodeProtocolMethods.workspaceHookTrustGrant: {
      const grantResult = await grantWorkspaceHookTrustForProtocol(request.params, {
        appVersion: host.context.deps.version,
        policyProvider: host.context.deps.workspaceHookPolicyProvider,
      });
      if (grantResult.accepted) {
        await notifyWorkspaceHookTrustGrantSessions({
          // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
          // safeParse 只为取出 workspaceKey 做匹配，失败即跳过通知（防御，正常必成功）。
          grantedWorkspaceKey: lcodeWorkspaceHookTrustGrantParamsSchema.safeParse(request.params)
            .success
            ? lcodeWorkspaceHookTrustGrantParamsSchema.parse(request.params).workspace.workspaceKey
            : undefined,
          sessions: host.context.sessions,
        });
      }
      return grantResult;
    }
    case lcodeProtocolMethods.providerUpdateAccountConfig:
      return await updateAccountProviderConfig(host.context, request.params);
    case lcodeProtocolMethods.workspaceUpdateInteractionPreferences:
      return await updateInteractionPreferences(host.context, request.params);
    case lcodeProtocolMethods.workspaceUpdateModelIoPreferences:
      return await updateModelIoPreferences(host.context, request.params);
    case lcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy:
      return await updateOffPeakToolPolicy(host.context, request.params);
    case lcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
      return await updateDynamicWorkflowPolicy(host.context, request.params);
    case lcodeProtocolMethods.workspaceGenerateText:
      return await withWorkspaceGenerateTextSignal(host, request, (signal) =>
        generateWorkspaceText(host.context, request.params, signal),
      );
    case lcodeProtocolMethods.workspaceFileMutationJournal:
      return await workspaceFileMutationJournal(host.context, request.params);
    case lcodeProtocolMethods.workspaceCancelGenerateText:
      return cancelWorkspaceGenerateText(host, request.params);
    case lcodeProtocolMethods.providerTestModelConnectivity:
      return await testProviderModelConnectivity(host.context, request.params);
    case lcodeProtocolMethods.mcpList:
      return await listMcpServers(host.context, request.params);
    case lcodeProtocolMethods.pluginsList:
      return await listPlugins(host.context, request.params);
    case lcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
      return await getPluginReferenceCatalog(host.context, request.params, true);
    case lcodeProtocolMethods.pluginsReferenceCatalog:
      return await getPluginReferenceCatalog(host.context, request.params);
    case lcodeProtocolMethods.skillsReferenceCatalog:
      return await getSkillReferenceCatalog(host.context, request.params);
    case lcodeProtocolMethods.workflowsList:
      return await listSavedWorkflowsOp(host.context, request.params);
    case lcodeProtocolMethods.workflowsGet:
      return await getSavedWorkflowOp(host.context, request.params);
    case lcodeProtocolMethods.workflowsUpdateMeta:
      return await updateSavedWorkflowMetaOp(host.context, request.params);
    case lcodeProtocolMethods.workflowsDelete:
      return await deleteSavedWorkflowOp(host.context, request.params);
    case lcodeProtocolMethods.workflowsRuns:
      return await listSavedWorkflowRunsOp(host.context, request.params);
    case lcodeProtocolMethods.workflowsMove:
      return await moveSavedWorkflowOp(host.context, request.params);
    case lcodeProtocolMethods.pluginsResolveSuggestedReference:
      return await withPluginOperationSignal(host, request, (signal) =>
        resolveSuggestedPluginReference(host.context, request.params, signal),
      );
    case lcodeProtocolMethods.pluginsSetEnabled:
      return await withPluginOperationSignal(host, request, (signal) =>
        setPluginEnabled(host.context, request.params, signal),
      );
    case lcodeProtocolMethods.pluginsOverview:
      return await getPluginsOverview(host.context, request.params);
    case lcodeProtocolMethods.processChildProcesses:
      return listChildProcesses(host.context.deps.mcpTelemetry?.listProcesses() ?? []);
    case lcodeProtocolMethods.runtimeCapabilities:
      return { independentPlanState: true };
    case lcodeProtocolMethods.pluginsMarketplaceAdd:
      return await withPluginOperationSignal(host, request, (signal) =>
        addPluginMarketplace(host.context, request.params, signal),
      );
    case lcodeProtocolMethods.pluginsMarketplaceRemove:
      return await removePluginMarketplace(host.context, request.params);
    case lcodeProtocolMethods.pluginsMarketplaceUpdate:
      return await withPluginOperationSignal(host, request, (signal) =>
        updatePluginMarketplace(host.context, request.params, signal),
      );
    case lcodeProtocolMethods.pluginsInstall:
      return await withPluginOperationSignal(host, request, (signal) =>
        installPlugin(host.context, request.params, signal),
      );
    case lcodeProtocolMethods.pluginsCancelOperation:
      return cancelPluginOperation(host, request.params);
    case lcodeProtocolMethods.pluginsUninstall:
      return await uninstallPlugin(host.context, request.params);
    case lcodeProtocolMethods.pluginsUpdate:
      return await updatePlugin(host.context, request.params);
    case lcodeProtocolMethods.pluginsRestoreBuiltin:
      return await restoreBuiltinPlugin(host.context, request.params);
    case lcodeProtocolMethods.pluginsConfigure:
      return await configurePlugin(host.context, request.params);
    case lcodeProtocolMethods.pluginsResetConfig:
      return await resetPluginConfig(host.context, request.params);
    case lcodeProtocolMethods.pluginsValidate:
      return await validatePlugin(host.context, request.params);
    case lcodeProtocolMethods.pluginsDescribe:
      return await describePlugin(host.context, request.params);
    case lcodeProtocolMethods.usageStats:
      return await getUsageStats(host.context, request.params);
    case lcodeProtocolMethods.sessionDebug:
      return querySessionDebug(host.context, request.params);
    case lcodeProtocolMethods.sessionUsage:
      return await getTaskTokenUsage(host.context, request.params);
    default:
      throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
  }
}
