import { AgentRuntime } from "@lcode/core";
import { completeNewModelSelection } from "@lcode/provider";
import { type TraceContext } from "@lcode/contracts";
import {
  createDynamicWorkflowRunService,
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
} from "./dynamic-workflow-run-service.js";
import { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import { createWorkflowToolOperationAdmission } from "./workflow-tool-operation-admission.js";
import { workflowActorExecutionFailoverScope } from "./workflow-actor-model.js";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";
import type { ScriptWorkflowAgentRuntimeDeps } from "./script-workflow-child-runtime.js";
import type { ExecutionPort, ToolArtifactStorePort } from "@lcode/contracts";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";

type AppDynamicWorkflowDeps = Omit<ScriptWorkflowAgentRuntimeDeps, "runtime"> & {
  artifactStore: ToolArtifactStorePort;
  executionPort: ExecutionPort;
  traceContext: TraceContext;
  getRuntime(): AgentRuntime;
  workflowConcurrencyGovernor: WorkflowConcurrencyPort;
};

// 拆分后的推断返回类型会引用工厂模块的私有接口；沿用工厂返回类型，保持声明可命名且不缩减能力。
export function createAppDynamicWorkflowPort(
  input: AppDynamicWorkflowDeps,
): ReturnType<typeof createDynamicWorkflowRunService> | undefined {
  const {
    appOptions: options,
    appVersion,
    artifactStore,
    configResult,
    fileSystemPort,
    httpClientPort,
    imageProcessorPort,
    logger,
    mcpPort,
    modelFactory,
    permissionService,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot,
    workingDirectory,
    skillPort,
    traceContext,
    getRuntime,
    executionPort,
    workflowConcurrencyGovernor,
    agentTelemetry,
  } = input;
  // workflow run service：CreateWorkflow 的确认窗 Allow 之后真启动引擎的那一侧。
  // journal 窄化失败（store 不带 dwf_* 表）时**不构造**服务——端口保持 undefined，
  // CreateWorkflow 因此回到占位诊断路径。这是一个记了日志的可见降级，而不是一条
  // 会静默丢掉持久化的运行路径（详见 dynamic-workflow-run-service.ts 的文件头）。
  const dynamicWorkflowJournal = resolveDynamicWorkflowJournalStore(sessionStore, logger);
  const workflowToolOperationAdmission = createWorkflowToolOperationAdmission();
  const dynamicWorkflowRunPort =
    dynamicWorkflowJournal === undefined
      ? undefined
      : createDynamicWorkflowRunService({
          concurrency: workflowConcurrencyGovernor,
          createActorRuntime: ({
            persona,
            actorModelSelection,
            actorModelProvenance,
            onExecutionFailoverSelection,
            executionFailoverLineageId,
            sessionId: actorSessionId,
            submitPort,
            submitProfile,
            escalatePort,
            modelRequestAdmission,
          }) => {
            const parentRuntime = getRuntime();
            const executionFailoverScope = workflowActorExecutionFailoverScope({
              childSessionId: actorSessionId,
              foregroundExecutionId: executionFailoverLineageId,
              provenance: actorModelProvenance,
            });
            const requestedSelection = actorModelSelection;
            const effectiveSelection =
              requestedSelection === undefined
                ? undefined
                : (() => {
                    const defaults = completeNewModelSelection(
                      options.providerRegistry.getView(),
                      requestedSelection,
                    );
                    if (defaults === undefined) return undefined;
                    return {
                      ...defaults,
                      options: { ...defaults.options, ...requestedSelection.options },
                    };
                  })();
            if (requestedSelection !== undefined && effectiveSelection === undefined) {
              throw new Error(
                `Workflow actor model is unavailable: ${requestedSelection.providerId}/${requestedSelection.modelId}`,
              );
            }
            if (effectiveSelection !== undefined) {
              const validation = options.providerRegistry.validateSelection(effectiveSelection);
              if (!validation.ok) {
                throw new Error(
                  `Workflow actor model options are invalid (${validation.code}): ${effectiveSelection.providerId}/${effectiveSelection.modelId}`,
                );
              }
            }
            return createScriptWorkflowAgentRuntime({
              childSessionId: actorSessionId,
              configOverrides: {
                // persona 的身份（有效名 + system）→ context builder 的工作流子代理路径。
                // 匿名 / 无 system 时字段缺席，builder 据此省略 named 从句与 persona 段。
                workflowActor: {
                  ...(persona.name === undefined ? {} : { name: persona.name }),
                  ...(persona.system === undefined ? {} : { persona: persona.system }),
                },
                // actor 的工具面是减法（全集减去会悬挂/越权的交互工具），只能经 configOverrides
                // 表达（request.opts.tools 只有 allowlist）。
                ...workflowActorToolPolicy(),
                // launch 已把显式配置、同 run journal 绑定与 import seed 归约成一个选择。
                // 缺席即沿用 child runtime 的父会话基线；provenance 单独决定是否加入父 failover。
                ...(effectiveSelection === undefined ? {} : { modelSelection: effectiveSelection }),
              },
              deps: {
                skillPort,
                agentTelemetry: agentTelemetry,
                appOptions: options,
                appVersion,
                artifactStore,
                configResult,
                fileSystemPort,
                httpClientPort,
                imageProcessorPort,
                logger,
                mcpPort,
                // 父会话的 model factory：actor 与主 turn 从同一份 Registry 视图造 Model，
                // 不各自冻结一份。
                modelFactory,
                permissionService,
                runtime: parentRuntime,
                runtimeConfig,
                sessionId,
                sessionStore,
                storageRoot,
                workingDirectory,
              },
              // persona 不再经 request.opts.systemPrompt 整段替换子代理的系统提示，而是经
              // workflowActor 叠加到基座之上。
              // request 在这里只是工厂签名的占位：opts 为空即「不覆盖任何东西」。
              request: { opts: {} } as never,
              traceContext,
              ...(executionFailoverScope === undefined
                ? {}
                : {
                    executionFailover: {
                      ...(onExecutionFailoverSelection
                        ? { onSelectionActivated: onExecutionFailoverSelection }
                        : {}),
                      policyPort: parentRuntime.getExecutionFailoverPolicyPort(),
                      scope: executionFailoverScope,
                    },
                  }),
              // submit profile → submit_result 形态：
              // `untyped` 不注入端口（core 的注册门是端口在场，于是没有这个工具——全 untyped 的子代理
              // 本来就无处可提交）；`mono` 注入端口 + typed 声明；`generic` 只注入端口（通用声明）。
              ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
              // 展开：dwf 的 JsonSchema 是无索引签名的 interface，contracts 的是 Record；
              // 字面量展开拿到隐式索引签名，不必在两包之间造一个转换函数。
              ...(submitProfile.kind === "mono"
                ? { workflowSubmitSchema: { ...submitProfile.schema } }
                : {}),
              // 升级端口与 submit 端口同进同出：两者都是 actor 会话的控制通道，而端口在场
              // 就是 core 侧的注册门。恒传（端口在 run service 里恒被构造），不做 opt-in——
              // 最可能撞上未预见之墙的 actor 恰是作者没标记的那一个。
              workflowEscalatePort: escalatePort,
              // 请求级准入端口：driver 在治理器在场时给出，runner 每次尝试先过闸门。
              ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
              toolOperationAdmission: workflowToolOperationAdmission,
            });
          },
          // 边界记账与转录截断都读写 actor 会话的消息，走的必须是同一个 store。
          actorTranscriptStore: sessionStore,
          // 用户面产物的字节落点：与主会话、workflow 子
          // 代理共用同一个 tool-artifact store，产物因此和别的大结果落在同一棵目录树下。
          artifactStore,
          executionPort,
          fileSystemPort,
          journal: dynamicWorkflowJournal,
          goalEvidenceOwner: {
            sessionId,
            workspacePath: workingDirectory,
            workspaceKey:
              runtimeConfig.workspaceIdentity?.trim() ||
              runtimeConfig.workspacePath ||
              workingDirectory,
            fileSystem: fileSystemPort,
            store: sessionStore,
          },
          getSessionModelSelection: () => getRuntime().getSessionModelSelection(),
          logger,
          // 进度投影的接缝：一条引擎事件 → 一条父会话的会话事件 → v4 的 workflowRuns 状态键。
          // 走 runtime 的 append 链路（而不是直接推 eventSink）是必需的：只有它同时做持久化、
          // 补 sequenceNumber 与扇出，冷恢复与 replayable 重连因此免费。
          //
          // 身份闸门、runtime 未就绪与 append 失败三条降级路径都在这个汇里（连同它们的单测），
          // 见 dynamic-workflow-run-progress-sink.ts 的文件头。
          onRunEvent: createDynamicWorkflowRunProgressSink({
            // 惰性：run service 在 runtime 构造之前就建好了（它是 AgentRuntime 的依赖之一）。
            getRuntime,
            logger,
            sessionId,
          }),
          // 孤儿收敛的作用域：本 app 的会话。构造时把**这个会话**留在 journal 里的非终态
          // run（死进程的遗物）收敛成 failed；兄弟会话的在飞 run 因此绝不会被误伤。
          parentSessionId: sessionId,
          // 在飞的引擎把本会话钉成常驻。
          // 惰性取 runtime 同 onRunEvent：run service 是 AgentRuntime 的依赖，构造更早；
          // 而启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
          registerResidencyBlockingWork: (work) => {
            getRuntime().retainSessionStoreDependentCloseWork(work);
          },
          // 发起锚点：CreateWorkflow 在父会话的活动轮里执行，
          // 那一轮的 inputId 就是子代理 agent_step 要挂的 message。trace.turnId 对不上活动轮
          // （理论上不该发生）就交回 submit 侧兜底铸值，绝不把别的轮的 id 记成锚点。
          resolveLaunchInputId: (trace) => {
            const active = getRuntime().getActiveTurnInfo();
            return active !== undefined && active.turnId === trace.turnId
              ? active.inputId
              : undefined;
          },
          resolveExecutionFailoverLineageId: () => getRuntime().getExecutionFailoverLineageId(),
          acquireCheckoutWriterLease: (runId, signal) =>
            getRuntime().acquireCheckoutWriterLease(`workflow:${runId}`, signal),
          acquireExecutionFailoverLineageLease: async (leaseId) => {
            const policyPort = getRuntime().getExecutionFailoverPolicyPort();
            const lease = await policyPort.acquireLineageLease(leaseId);
            return lease === undefined
              ? undefined
              : {
                  ...lease,
                  release: () => policyPort.releaseLineageLease(lease.leaseId),
                };
          },
          ...(isDynamicWorkflowTaskLinkStore(sessionStore) ? { taskLinkStore: sessionStore } : {}),
        });
  return dynamicWorkflowRunPort;
}
