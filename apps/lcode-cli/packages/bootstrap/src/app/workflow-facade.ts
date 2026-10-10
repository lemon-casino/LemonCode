import { join } from "node:path";
import { createNodeContextSourceAdapter } from "@lcode/adapters/context";
import { createNodeExecutionAdapter } from "@lcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@lcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@lcode/adapters/http";
import type { ConfigResult } from "@lcode/adapters/config";
import { createInMemorySessionEventStore } from "@lcode/adapters/storage";
import {
  createNodeWorkflowDefinitionStore,
  createNodeWorkflowStore,
} from "@lcode/adapters/workflow";
import {
  AgentRuntime,
  ExpertWorkflowRuntime,
  createExpertWorkflowDefinition,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
  type PermissionService,
  type WorkflowAgentRunner,
} from "@lcode/core";
import {
  type AgentExecutionTelemetryPort,
  createChildTraceContext,
  createSessionId,
  type ContextSourcePort,
  type ExecutionPort,
  type FileSystemPort,
  type HttpClientPort,
  type ImageProcessorPort,
  type PdfDocumentPort,
  type Logger,
  type McpPort,
  type SessionEventSink,
  type SessionId,
  type SessionStorePort,
  type SkillPort,
  type ToolArtifactStorePort,
  type TraceContext,
  type WorkflowDefinition,
} from "@lcode/contracts";
import type { PrepareUserExecutionBoundary, LCodeAppOptions } from "./types.js";
import { createWorkflowMethods, type WorkflowFacade } from "./workflow-methods.js";

interface CreateWorkflowFacadeDeps {
  agentTelemetry: AgentExecutionTelemetryPort;
  appOptions: LCodeAppOptions;
  appVersion: string;
  artifactStore?: ToolArtifactStorePort;
  cliStorageRoot: string;
  configResult: ConfigResult;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  logger: Logger;
  mcpPort?: McpPort;
  /** 父会话的 model factory（与 script-workflow-child-runtime.ts 同一约定）。 */
  modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]>;
  permissionService: PermissionService;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  runtime: AgentRuntime;
  runtimeConfig: AgentRuntimeConfig;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  skillPort?: SkillPort;
  storageRoot: string;
  traceContext: TraceContext;
  workingDirectory: string;
}

export function createWorkflowFacade(deps: CreateWorkflowFacadeDeps): WorkflowFacade {
  const workflowStore = createNodeWorkflowStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  const workflowDefinitionStore = createNodeWorkflowDefinitionStore({
    rootDir: join(deps.cliStorageRoot, "workflows"),
  });
  const builtInExpertWorkflowDefinition = createExpertWorkflowDefinition();
  const workflowRuntimeCache = new Map<string, ExpertWorkflowRuntime>();
  const workflowAgentRunner: WorkflowAgentRunner = {
    run: async (request) => {
      await deps.prepareUserExecutionBoundary({ traceContext: request.traceContext });
      const workflowKind = request.workflowKind ?? builtInExpertWorkflowDefinition.kind;
      const childSessionId = createSessionId(`workflow_${request.activityId}`);
      const childTraceContext = createChildTraceContext(request.traceContext ?? deps.traceContext, {
        attributes: {
          parentSessionId: deps.sessionId,
          workflowActivityId: request.activityId,
          workflowKind,
          workflowPhase: request.phase,
          workflowRunId: request.runId,
        },
        sessionId: childSessionId,
      });
      const parentSelection = deps.runtime.getSessionModelSelection();
      await request.onChildSessionStarted?.({
        model: parentSelection
          ? `${parentSelection.providerId}/${parentSelection.modelId}`
          : undefined,
        sessionId: childSessionId,
        traceId: childTraceContext.traceId,
      });
      const childRuntime = createWorkflowChildRuntime(deps, {
        childSessionId,
        childTraceContext,
        workflowKind,
      });
      const unsubscribe = request.onEvent
        ? childRuntime.subscribeEvents({ onSessionEvent: request.onEvent })
        : undefined;

      try {
        const result = await childRuntime.executeTurn(request.prompt, undefined, {
          abortSignal: request.abortSignal,
          inputSource: "subagent",
          traceContext: childTraceContext,
        });
        const childSelection = childRuntime.getSessionModelSelection();
        return {
          model: childSelection
            ? `${childSelection.providerId}/${childSelection.modelId}`
            : undefined,
          response: result.response,
          sessionId: childSessionId,
          traceId: result.traceId,
          turnId: result.turnId,
        };
      } finally {
        unsubscribe?.();
        await childRuntime.closeBrowserSession();
      }
    },
  };

  const resolveWorkflowDefinition = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<WorkflowDefinition> => {
    const requestedKind = input?.workflowKind ?? builtInExpertWorkflowDefinition.kind;
    const requestedDefinitionId = input?.definitionId;
    if (!requestedDefinitionId && requestedKind === builtInExpertWorkflowDefinition.kind) {
      return builtInExpertWorkflowDefinition;
    }

    const lookupId = requestedDefinitionId ?? requestedKind;
    const definition = await workflowDefinitionStore.readDefinition(lookupId);
    if (!definition) {
      throw new Error(`Workflow definition not found: ${lookupId}`);
    }
    if (input?.workflowKind && definition.kind !== input.workflowKind) {
      throw new Error(
        `Workflow definition ${definition.definitionId} has kind ${definition.kind}, expected ${input.workflowKind}`,
      );
    }
    return definition;
  };

  const workflowRuntimeForDefinition = (definition: WorkflowDefinition): ExpertWorkflowRuntime => {
    const cacheKey = [definition.definitionId, definition.definitionVersion, definition.kind].join(
      ":",
    );
    const cached = workflowRuntimeCache.get(cacheKey);
    if (cached) return cached;
    const runtimeForDefinition = new ExpertWorkflowRuntime({
      agentRunner: workflowAgentRunner,
      definition,
      onWorkflowEvent: deps.appOptions.onWorkflowEvent,
      store: workflowStore,
    });
    workflowRuntimeCache.set(cacheKey, runtimeForDefinition);
    return runtimeForDefinition;
  };

  const workflowRuntimeForRequest = async (input?: {
    definitionId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> =>
    workflowRuntimeForDefinition(await resolveWorkflowDefinition(input));

  const workflowRuntimeForLookup = async (input?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowRuntime> => {
    if (input?.runId) {
      const snapshot = await workflowStore.readRun(input.runId, { signal: input.abortSignal });
      if (snapshot) {
        if (
          snapshot.kind === builtInExpertWorkflowDefinition.kind &&
          (snapshot.definitionId === undefined ||
            snapshot.definitionId === builtInExpertWorkflowDefinition.definitionId)
        ) {
          return workflowRuntimeForDefinition(builtInExpertWorkflowDefinition);
        }
        return workflowRuntimeForDefinition(
          await resolveWorkflowDefinition({
            definitionId: snapshot.definitionId,
            workflowKind: snapshot.kind,
          }),
        );
      }
    }
    return workflowRuntimeForRequest({
      definitionId: input?.definitionId,
      workflowKind: input?.workflowKind,
    });
  };

  const listWorkflowRuns: NonNullable<WorkflowFacade["listWorkflows"]> = async (options) => {
    let workflowKind = options?.workflowKind;
    if (options?.definitionId) {
      const definition = await resolveWorkflowDefinition({
        definitionId: options.definitionId,
        workflowKind,
      });
      workflowKind = definition.kind;
    }
    return workflowStore.listRuns(
      { cwd: deps.workingDirectory, kind: workflowKind, limit: options?.limit },
      { signal: options?.abortSignal },
    );
  };

  const workflowExternalActivityPrompt = (definition: WorkflowDefinition, task: string): string =>
    definition.kind === builtInExpertWorkflowDefinition.kind
      ? `/expert ${task}`
      : `/workflow ${definition.kind} ${task}`;

  const switchWorkflowToYolo = (): void => {
    if (deps.runtime.getMode() !== "yolo") {
      deps.runtime.updateConfig({ mode: "yolo" });
    }
  };

  const createStartInput = async (
    input: { definitionId?: string; task: string; workflowKind?: string },
    defaultKind?: string,
  ) => {
    const definition = await resolveWorkflowDefinition({
      definitionId: input.definitionId,
      workflowKind: input.workflowKind ?? defaultKind,
    });
    const workflow = workflowRuntimeForDefinition(definition);
    return { definition, workflow };
  };

  const persistWorkflowActivity = async (
    definition: WorkflowDefinition,
    task: string,
    traceContext: TraceContext,
  ): Promise<void> => {
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      workflowExternalActivityPrompt(definition, task),
      { traceContext },
    );
  };

  return createWorkflowMethods({
    builtInExpertWorkflowDefinition,
    createStartInput,
    listWorkflowRuns,
    prepareUserExecutionBoundary: deps.prepareUserExecutionBoundary,
    persistWorkflowActivity,
    sessionId: deps.sessionId,
    switchWorkflowToYolo,
    traceContext: deps.traceContext,
    workflowRuntimeForLookup,
    workingDirectory: deps.workingDirectory,
  });
}

function createWorkflowChildRuntime(
  deps: CreateWorkflowFacadeDeps,
  options: {
    childSessionId: SessionId;
    childTraceContext: TraceContext;
    workflowKind: string;
  },
): AgentRuntime {
  return new AgentRuntime(
    options.childSessionId,
    {
      ...deps.runtimeConfig,
      // 父 Runtime 已在执行边界采用当前 Shell，不能继续读取创建 App 时的旧配置。
      bashShellSelection: deps.runtime.getSessionShellSelection(),
      agentName: options.workflowKind === "expert" ? "lcode-expert" : "lcode-workflow",
      mode: "yolo",
      modelSelection: deps.runtime.getSessionModelSelection(),
      parentSessionId: deps.sessionId,
      taskType: "workflow_child",
      workingDirectory: deps.workingDirectory,
    },
    {
      agentTelemetry: deps.agentTelemetry,
      agentTelemetryCausation: deps.agentTelemetry.captureCausation(),
      // Workflow 在父工具返回后独立调度，不能伪装成父 Span 的同步 Child。
      agentTelemetryCausationMode: "linked_root",
      eventStore: createInMemorySessionEventStore(),
      sessionStore: deps.sessionStore,
      logger: deps.logger,
      executionPort:
        deps.appOptions.executionPort ??
        createNodeExecutionAdapter({
          onToolExecResource: deps.appOptions.onToolExecResource,
          network: {
            httpProxy: deps.configResult.config.network.httpProxy,
            noProxy: deps.configResult.config.network.noProxy,
            caCertFile: deps.configResult.config.network.caCertFile,
          },
          outputRootDir: join(deps.storageRoot, "cli", "exec"),
          processEnv: deps.appOptions.env ?? process.env,
        }),
      // 优先复用主装配已登记治理根的端口；旧 facade 调用方仍保留既有 fallback。
      fileSystemPort:
        deps.fileSystemPort ?? deps.appOptions.fileSystemPort ?? createNodeFileSystemAdapter(),
      httpClientPort:
        deps.appOptions.httpClientPort ??
        createNodeWebFetchHttpClientAdapter({
          env: deps.appOptions.env ?? process.env,
          timeoutMs: deps.configResult.config.network.timeout,
          proxyUrl: deps.configResult.config.network.httpProxy,
          noProxy: deps.configResult.config.network.noProxy,
          caCertFile: deps.configResult.config.network.caCertFile,
        }),
      imageProcessorPort: deps.imageProcessorPort,
      pdfDocumentPort: deps.pdfDocumentPort,
      artifactStore: deps.artifactStore,
      contextSourcePort:
        deps.appOptions.contextSourcePort ??
        createNodeContextSourceAdapter({ env: deps.appOptions.env }),
      // 复用主会话有效 SkillPort，保持插件根与用户禁用规则一致。
      skillPort: deps.skillPort,
      mcpPort: deps.mcpPort,
      eventSink: deps.eventSink,
      modelFactory: deps.modelFactory,
      resolveEffectiveModelSelection: deps.appOptions.resolveEffectiveModelSelection,
      // 对外交互端口由父 runtime 派生（permissionBroker + providerRuntimeHeadersPort）：
      // 子会话不是协议客户端认识的身份，直接透传 appOptions 的端口会让反向请求发到一个
      // 客户端找不到的 session 上、response 永不回来。
      ...deps.runtime.createChildClientPorts({
        agentId: options.childSessionId,
        agentType: options.workflowKind === "expert" ? "lcode-expert" : "lcode-workflow",
        childSessionId: options.childSessionId,
        description: `${options.workflowKind} workflow agent`,
        ...(options.childTraceContext.turnId === undefined
          ? {}
          : { parentTurnId: options.childTraceContext.turnId }),
      }),
      permissionService: deps.permissionService,
      appVersion: deps.appVersion,
      traceContext: options.childTraceContext,
    },
  );
}
