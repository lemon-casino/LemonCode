import { AgentRuntime } from "@lcode/core";
import type { LCodeApp } from "./types.js";
import { resolveEffectiveLocale } from "./app-config-options.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createInputFacade } from "./input-facade.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { createSessionFacade } from "./session-facade.js";
import { DYNAMIC_WORKFLOW_GATED_COMMAND_NAMES } from "./dynamic-workflow-gate.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import { resolveLCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { resolveLCodeBuiltinPromptCommand } from "../builtin-prompt-command.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import type { AiSdkModelAdapter } from "@lcode/adapters/model";
import type { PluginReferenceCatalog, SkillPort } from "@lcode/contracts";
import type { RuntimeModelFactory } from "./provider-registry-model-runtime.js";
import type { AppStartupContext } from "./app-startup-context.js";
import type { PreparedAppConfiguration } from "./app-configuration.js";
import type { AppAdapters } from "./app-adapters.js";
import type { createAppSessionResume } from "./app-session-resume.js";
import { createAppAttachmentFacade } from "./app-attachment-facade.js";
import { createAppWorkspaceHookFacade } from "./app-workspace-hooks.js";
import { createAppWorkflowRunFacade } from "./app-workflow-run-facade.js";

interface AppFacadeDeps {
  startup: AppStartupContext;
  configuration: PreparedAppConfiguration;
  adapters: AppAdapters;
  runtime: AgentRuntime;
  getRuntime(): AgentRuntime;
  providerModelRuntime: ApiProviderModelRuntime;
  modelAdapter: AiSdkModelAdapter;
  modelFactory: RuntimeModelFactory;
  skillPort: SkillPort | undefined;
  pluginReferenceCatalog: PluginReferenceCatalog;
  workspaceHookRuntimeSecurity: ReturnType<typeof createWorkspaceHookRuntimeSecurity>;
  dynamicWorkflowRunPort: ReturnType<typeof createDynamicWorkflowRunService> | undefined;
  scriptWorkflowFacade: ReturnType<typeof createScriptWorkflowBridge>;
  resumeBoundary: ReturnType<typeof createAppSessionResume>;
  closeNodeReplBrowserBroker(): Promise<void>;
}

export function createAppFacade(input: AppFacadeDeps): LCodeApp {
  const {
    options,
    appVersion,
    sessionId,
    traceContext,
    workingDirectory,
    configResult,
    loggerFactory,
    logger,
    modelTelemetry,
  } = input.startup;
  const {
    storageRoot,
    cliStorageRoot,
    sessionStore,
    localSettingStore,
    projectID,
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
    ownsSessionStore,
  } = input.configuration;
  const {
    permissionService,
    artifactStore,
    inputHistoryStore,
    imageProcessorPort,
    mcpPort,
    ownsMcpPort,
    executionPort,
    ownsExecutionPort,
    pdfDocumentPort,
    fileSystemPort,
  } = input.adapters;
  const {
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
  } = input;
  const { prepareResume, prepareUserExecutionBoundary, resumeFromStore } = input.resumeBoundary;
  const inputFacade = createInputFacade({
    artifactStore,
    customCommandPromptResolver: async (text, resolverOptions) => {
      const builtinPrompt = resolveLCodeBuiltinPromptCommand(text, {
        workingDirectory,
      });
      if (builtinPrompt !== undefined) {
        return builtinPrompt;
      }
      return await resolveLCodeCustomCommandPrompt(text, {
        // 动态工作流灰度关闭时 `/workflow` 不得展开成插件提示词。目录侧已经
        // 把它从 `/` 面板剔除，但用户仍可手打命令名，两条路径必须给出同一个结论。
        // 缺席（TUI、headless、workflow_child）不设门禁，见 runtimeConfig 字段注释。
        ...(runtimeConfig.dynamicWorkflowEnabled === false
          ? { disabledCommandNames: DYNAMIC_WORKFLOW_GATED_COMMAND_NAMES }
          : {}),
        env: options.env,
        executionPort,
        logger,
        projectConfigPath: options.projectConfigPath,
        sessionId,
        signal: resolverOptions?.abortSignal,
        skipUserConfig: options.skipUserConfig,
        traceContext: resolverOptions?.traceContext ?? traceContext,
        userConfigPath: options.userConfigPath,
        workingDirectory,
      });
    },
    inputHistoryStore,
    logger,
    prepareUserExecutionBoundary,
    runtime,
    sessionId,
    traceContext,
  });
  const workflowFacade = createWorkflowFacade({
    skillPort,
    agentTelemetry: modelTelemetry.agentExecution,
    appOptions: options,
    appVersion,
    artifactStore,
    cliStorageRoot,
    configResult,
    eventSink: options.eventSink,
    fileSystemPort,
    imageProcessorPort,
    pdfDocumentPort,
    logger,
    mcpPort,
    modelFactory,
    permissionService,
    prepareUserExecutionBoundary,
    runtime,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot,
    traceContext,
    workingDirectory,
  });
  const sessionFacade = createSessionFacade({
    // App 关闭时停下本会话拥有的 dwf run：
    // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
    configResult,
    configuredMcpServers,
    ...(options.configuredDefaultModelSelection
      ? {
          configuredDefaultModelSelection: options.configuredDefaultModelSelection,
        }
      : {}),
    executionPort,
    localSettingStore,
    logger,
    loggerFactory,
    mcpPort,
    ownsExecutionPort,
    ownsMcpPort,
    closeNodeReplBrowserBroker: input.closeNodeReplBrowserBroker,
    ownsSessionStore,
    prepareUserExecutionBoundary,
    prepareResume,
    projectID,
    providerRegistry: options.providerRegistry,
    temporaryModelFactory: providerModelRuntime.temporaryModelFactory,
    resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
    runtime,
    sessionId,
    sessionStore,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
  });

  const closeSession = sessionFacade.close;
  return {
    sessionId,
    traceId: traceContext.traceId,
    runtime,
    ...createAppWorkspaceHookFacade(workspaceHookRuntimeSecurity),
    setModelIoFullRetentionEnabled: (enabled) =>
      modelAdapter.setModelIoFullRetentionEnabled(enabled),
    ...createAppAttachmentFacade({
      artifactStore,
      fileSystemPort,
      sessionStore,
      sessionId,
      traceContext,
    }),
    ...sessionFacade,
    close: async () => {
      try {
        await closeSession?.();
      } finally {
        try {
          providerModelRuntime.dispose();
        } finally {
          await modelTelemetry.shutdown();
        }
      }
    },
    ...workflowFacade,
    ...scriptWorkflowFacade,
    ...createAppWorkflowRunFacade({
      dynamicWorkflowRunPort,
      getRuntime,
      prepareUserExecutionBoundary,
      traceContext,
    }),
    ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
    getPluginReferenceCatalog: () => pluginReferenceCatalog,
    getSkillCatalog: async () => {
      // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
      // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
      await prepareUserExecutionBoundary({ traceContext });
      return await getRuntime().getSkillCatalog(traceContext);
    },
    resume: resumeFromStore,
    ...inputFacade,
  };
}
