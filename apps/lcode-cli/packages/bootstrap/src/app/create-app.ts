import { createInMemorySessionEventStore } from "@lcode/adapters/storage";
import { createNodeContextSourceAdapter } from "@lcode/adapters/context";
import { AgentRuntime, buildPluginReferenceCatalog } from "@lcode/core";
import { isRemoteWorkspaceIdentity } from "@lcode/shared";
import { createModelAdapter } from "../model-factory.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type { LCodeApp, LCodeAppOptions } from "./types.js";
import { runtimeConfigLogContext } from "./runtime-config.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import { completeAppStartup, markRuntimeConstructed } from "./startup-marks.js";
import { createAppStartupContext } from "./app-startup-context.js";
import { prepareAppConfiguration } from "./app-configuration.js";
import { createAppAdapters } from "./app-adapters.js";
import { createAppSessionResume } from "./app-session-resume.js";
import { createAppSkillPort } from "./app-skills.js";
import { createAppDynamicWorkflowPort } from "./app-dynamic-workflow.js";
import { createAppWorkspaceHookSecurity } from "./app-workspace-hooks.js";
import { createAppFacade } from "./app-facade.js";

export async function createLCodeApp(options: LCodeAppOptions): Promise<LCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createLCodeApp requires a Provider Registry");
  }
  const startup = createAppStartupContext(options);
  const {
    sessionId,
    traceContext,
    workingDirectory,
    configResult,
    logger,
    loggerFactory,
    startupTimer,
    modelLogger,
    modelTelemetry,
    appVersion,
  } = startup;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  try {
    const configuration = await prepareAppConfiguration(startup);
    const { pluginOutcome, pluginRuntimeFeatures, modelIoDir } = configuration;
    let { configuredMcpServers, runtimeConfig } = configuration;
    const browserControlPort = options.browserControlPort;
    if (
      browserControlPort &&
      pluginRuntimeFeatures.browserUse === true &&
      runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
    ) {
      nodeReplBrowserBroker =
        options.nodeReplBrowserBroker ??
        (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
          browserControlPort,
          logger,
          platform: options.platform,
        }));
      configuredMcpServers = injectNodeReplBrowserBroker(
        configuredMcpServers,
        nodeReplBrowserBroker,
      );
      runtimeConfig.mcp = {
        ...runtimeConfig.mcp,
        servers: injectNodeReplBrowserBroker(
          runtimeConfig.mcp.servers ?? {},
          nodeReplBrowserBroker,
        ),
      };
    }
    startupTimer.mark("LCode runtime configuration resolved", {
      context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
      event: "bootstrap.app.startup.runtime_config.completed",
      stage: "resolve_runtime_config",
    });
    // Plugin 对话引用：身份 catalog 在 App（Session runtime）
    // 创建时冻结一次。冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin。
    const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("LCode runtime is not initialized yet.");
      return runtime;
    };
    const workspaceHookRuntimeSecurity = createAppWorkspaceHookSecurity({
      startup,
      runtimeConfig,
      getRuntime,
    });
    const adapters = createAppAdapters(startup, {
      ...configuration,
      configuredMcpServers,
      runtimeConfig,
    });
    const {
      permissionService,
      artifactStore,
      imageProcessorPort,
      sessionMailboxPort,
      mcpPort,
      executionPort,
      pdfDocumentPort,
      videoProcessorPort,
      fileSystemPort,
      httpClientPort,
    } = adapters;
    const {
      prepareResume,
      prepareUserExecutionBoundary,
      resumeFromStore,
      resolveSessionShellSelection,
    } = createAppSessionResume({ startup, sessionStore: configuration.sessionStore, getRuntime });
    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    if (options.physicalRequestAccounting) {
      modelAdapter.setPhysicalRequestAccounting(options.physicalRequestAccounting);
    }
    // 进程级并发治理器：run service 拿它的窄端口给
    // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
    // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
    // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
    // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
    // 新建的 Model 才看得到，child 不各自冻结一份。
    const modelFactory = providerModelRuntime.modelFactory;
    // 子运行时必须复用完整的有效端口；重新扫描 config roots 会遗漏插件技能和灰度禁用项。
    const skillPort = createAppSkillPort({ options, configResult, pluginOutcome, runtimeConfig });
    const workflowDeps = {
      skillPort,
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: { ...options, executionPort },
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      videoProcessorPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore: configuration.sessionStore,
      storageRoot: configuration.storageRoot,
      traceContext,
      workingDirectory,
    };
    const scriptWorkflowFacade = createScriptWorkflowBridge(workflowDeps);
    const dynamicWorkflowRunPort = createAppDynamicWorkflowPort({
      ...workflowDeps,
      executionPort,
      workflowConcurrencyGovernor,
    });
    // dwf snippet service：EvalWorkflowSnippet 的执行面。刻意**不**依赖 dwf journal——
    // snippet 完全瞬态（内存 journal），不该被 run service 的 durability 前提连坐；
    // 所以即使 run 端口因 journal 缺席而不构造，实验通道仍然可用。
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // 模型目录：工具层把用户说的模型名解析成 workflow run 的子代理选型（model-catalog-port.ts）。
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    runtime = new AgentRuntime(sessionId, runtimeConfig, {
      agentTelemetry: modelTelemetry.agentExecution,
      // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
      modelRequestAdmission: workflowConcurrencyGovernor.observer(),
      eventStore: options.eventStore ?? createInMemorySessionEventStore(),
      sessionStore: configuration.sessionStore,
      sessionMailboxPort,
      logger,
      executionPort,
      workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
      workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      videoProcessorPort,
      artifactStore,
      contextSourcePort:
        options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
      skillPort,
      mcpPort,
      eventSink: options.eventSink,
      modelFactory,
      modelIoDir,
      providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
      resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
      isRemoteWorkspace: () =>
        isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
      permissionBroker: options.permissionBroker,
      checkoutExecutionPort: options.checkoutExecutionPort,
      resolveSessionShellSelection,
      permissionService,
      workflowPort: scriptWorkflowFacade.workflowPort,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      appVersion,
      traceContext,
    });
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    return createAppFacade({
      startup,
      configuration: { ...configuration, configuredMcpServers, runtimeConfig },
      adapters,
      runtime,
      getRuntime,
      providerModelRuntime,
      modelAdapter,
      modelFactory,
      skillPort,
      pluginReferenceCatalog,
      workspaceHookRuntimeSecurity,
      dynamicWorkflowRunPort,
      scriptWorkflowFacade,
      resumeBoundary: {
        prepareResume,
        prepareUserExecutionBoundary,
        resumeFromStore,
        resolveSessionShellSelection,
      },
      closeNodeReplBrowserBroker: async () => {
        await ownedNodeReplBrowserBroker?.close();
      },
    });
  } catch (error) {
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("LCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
