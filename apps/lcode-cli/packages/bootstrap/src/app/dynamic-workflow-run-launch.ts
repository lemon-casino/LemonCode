// ============================================================
// Dynamic Workflow Run 的启动执行体（submit 与 resume 的共享半身）
// ============================================================
// submit（新 runId）与 resume（既有 runId，引擎走
// resume 分支）在「装配 driver → 跑 runWorkflowScript」这一段完全同构，抽到本文件共享：
// 两条入口各自维护一份，迟早有一边忘记接事件 sequence 截取或 actor 重水化。
//
// 本文件持有三件事：
//   1. journal sequence 截取（emit 侧拿到刚 append 的那条事件的 sequence）；
//   2. RunEvent → 会话事件载荷（有界化 + 两个派生字段）；
//   3. 启动输入、lineage lease 与模型快照的装配，actor runtime 的模型绑定、持久化和重水化
//      委托给 workflow-actor-runtime.ts；仍经同一个 runtimeFactory 接入 driver。

import {
  boundDynamicWorkflowRunEventPayload,
  LCODE_DWF_CHILD_COMMAND,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunProgressPayload,
  type SessionId,
} from "@lcode/contracts";
import { parseModelPickerValue, type ModelSelection } from "@lcode/shared/model-selection";
import {
  type ActorSubmitProfile,
  validate,
  type AskSpec,
  type Caps,
  type CausalityGraph,
  type ImportedRunCache,
  type JsonSchema,
  type WorkflowEngine,
  type RunEvent,
  type RunSettlement,
  type ValidateFn,
} from "@lcode/dynamic-workflow";
import { runWorkflowScript } from "@lcode/dynamic-workflow-runtime";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import type { DynamicWorkflowRunExecutionFailoverLineageLease } from "./dynamic-workflow-run-observation.js";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import {
  readRunLaunch,
  readRunActorModelConfiguration,
  readRunSubagentModel,
  runActorModelConfigurationFromLaunch,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import { createAgentRuntimeWorkflowDriver, mintActorSessionId } from "./workflow-driver.js";
import { createWorkflowActorRuntimeFactory } from "./workflow-actor-runtime.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

/** 适配包内校验器到引擎的 ValidateFn 契约（launch 是 runWorkflowScript 的唯一调用点）。 */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/** 一次编译的全部产物。四个消费者共用同一个 ts.Program（编译一次，见 run service 不变式 2）。 */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** world.run 的已批准命令集（编译期字面量收集）。 */
  declaredRunCommands: ReadonlySet<string>;
  /** 每个 actor 站点的 submit profile。 */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
  /** Static causal ordering; used only as a conservative revision invalidation hint. */
  causality: CausalityGraph;
}

interface LaunchDynamicWorkflowRunInput {
  caps: Caps;
  compiled: CompiledDynamicWorkflowScript;
  cwd: string;
  deps: DynamicWorkflowRunServiceDeps;
  /** run 的展示名（`CreateWorkflow` 的可选 `input.name`）：随 EngineConfig 在 createRun 时落 dwf_run.name。 */
  name?: string;
  /**
   * 本次 run 的实参（saved workflow 的已校验实参袋）。两个去处：随 EngineConfig 落
   * `dwf_run.args_json`，以及进 spawn payload 注入沙箱的 `args` 全局。
   *
   * resume 分支传的是**从 journal 读回的那一份**，不是调用方新给的——见 run service 的
   * resume 注释。
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  runId: string;
  onControlReady?: (control: Pick<WorkflowEngine, "pauseAsk" | "retryAsk">) => void;
  scriptText: string;
  signal: AbortSignal;
  toolCallId?: string;
  /**
   * 修订续跑的 lineage 指针（`dwf_run.resumed_from`）与导入缓存。两者**成对**出现：
   * 指针是行级事实（UI 的「续自 run X」、崩溃后 resume 据它重建），缓存是本次执行的加速结构。
   *
   * 与其余元数据同一条路——launch → harness → EngineConfig，中途零加工。构建（读前驱 journal、
   * 走 `resumed_from` 链、解析转录源）全部发生在 run service：这里已经是执行侧，把构建放进来
   * 就等于让 resume 与 submit 各构建一次（而它们必须是同一个纯函数的两次调用）。
   */
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  /**
   * 建 run 时的用量起点：前驱结算后的 `spentTokens`。
   * 与 lineage 指针同一条路——launch → harness → EngineConfig，中途零加工；amend 路径给出，
   * 全新 submit 与 resume 缺席（后者的用量从既有行恢复）。
   */
  inheritedTokens?: number;
  /**
   * 发起 run 那一轮的锚点。submit 路径给出（引擎在建 run
   * 那一世记 `run-launched`）；resume 路径缺席，本函数从 journal 读回——两条路径都用同一个值给
   * `actor-created` / `run-settled` 进度事件派生 `launchInputId`。submit 路径还随车带脚本声明的
   * 阶段表（`phaseNames`）与本 run 的子代理模型（`subagentModel`，规范 picker 串），三者同样
   * 只在建 run 那一世落 journal，resume 路径一概从那条事件读回。
   */
  launch?: RunLaunch;
  executionFailoverLineageLease?: Promise<
    DynamicWorkflowRunExecutionFailoverLineageLease | undefined
  >;
  /**
   * 升级问答的停驻注册表。由 run service 持有一张、
   * 跨它名下所有在飞 run，两条入口（submit / resume）传的是**同一个对象**——注册表按完整 qid
   * 索引，两条入口各持一张会让 resume 之后的 run 作答不到自己刚提的问题。
   */
  escalationRegistry: WorkflowEscalationRegistry;
}

/**
 * 启动（或恢复）一个 run：装配 sequence 截取 → emit 钩子 → 真实 driver → runWorkflowScript。
 * fire-and-forget 语义由调用方决定（本函数只返回结算 promise，不做注册表簿记）。
 */
export async function launchDynamicWorkflowRun(
  input: LaunchDynamicWorkflowRunInput,
): Promise<RunSettlement> {
  // 直接启动和恢复工作流都绕过普通 turn；统一在真实引擎执行前取得同一个 checkout writer。
  const lease = await input.deps.acquireCheckoutWriterLease?.(input.runId, input.signal);
  try {
    return await executeDynamicWorkflowRun(input);
  } finally {
    await lease?.release();
  }
}

async function executeDynamicWorkflowRun(
  input: LaunchDynamicWorkflowRunInput,
): Promise<RunSettlement> {
  const {
    args,
    caps,
    compiled,
    cwd,
    deps,
    escalationRegistry,
    importedCache,
    name,
    parentSessionId,
    resumedFrom,
    runId,
    scriptText,
    signal,
    toolCallId,
  } = input;
  // acquisition promise 在注册表条目建立的同步片就已创建；这里先等待它，确保首个 actor
  // 不会越过 run-level lease。旧测试装配没有该能力时沿用只读 lineage resolver。
  const executionFailoverLineageLease = await input.executionFailoverLineageLease;
  const executionFailoverLineageId =
    executionFailoverLineageLease?.foregroundExecutionId ??
    deps.resolveExecutionFailoverLineageId?.();
  const childSpawn = dynamicWorkflowChildSpawn();
  // 锚点：submit 给的（本次建 run）或 journal 里的（resume）。升级前的 run 两边都没有 → 缺席，
  // 进度事件不带 launchInputId，子代理不上报。
  const launch = input.launch ?? readRunLaunch(deps.journal, runId);
  // lineage 指针：submit/amend 路径由入参给出；resume 路径入参缺席（createRun 早已写死），从
  // journal 行读回——两条路径的 `run-started` 载荷因此同形。
  const lineageFrom = resumedFrom ?? deps.journal.getRun(runId)?.resumedFrom;
  // 并发天花板：`run-started` 载荷的第二个宿主派生字段。每次 launch 算一次而不是每条事件算
  // 一次——它是进程事实，一个 run 跑到一半核数不会变，而 `availableParallelism()` 是系统调用。
  const concurrencyCeiling = resolveWorkflowConcurrencyCeiling(deps.availableParallelism);
  // 子代理模型：submit 给的（随锚点同车）或 journal 里的（resume 从同一条 run-launched 读回）。
  // 与锚点同一条论证，两条路径因此同形；升级前的 run 两边都没有 → 缺席 = 跑在会话模型上。
  const subagentModel = input.launch?.subagentModel ?? readRunSubagentModel(deps.journal, runId);
  const recordedActorModels =
    input.launch === undefined
      ? readRunActorModelConfiguration(deps.journal, runId)
      : runActorModelConfigurationFromLaunch(input.launch);
  // 新记录直接保存结构化选择，避免 picker 字符串丢掉 speed。旧记录仍可从显示串恢复。
  const runSubagentModel =
    recordedActorModels.defaultSelection ??
    (recordedActorModels.defaultProvenance !== "runModel" || subagentModel === undefined
      ? undefined
      : parseModelPickerValue(subagentModel));

  // 事件的 journal sequence 只有 appendEvent 知道，而引擎在 record() 里
  // `journal.appendEvent(...)` 之后**同步**紧接着 `driver.emit(...)`，并丢掉了返回的
  // StoredEvent（engine.ts）。所以这里包一层 journal 把分配到的 sequence 截下来：
  // emit 拿到的一定是刚才那一条。替代方案都更差——本地自增计数器会在 resume（sequence
  // 从既有最大值续下去）时整体偏移，而每条事件回查一次 journal 是白付一次 IO。
  // 「append 紧跟 emit、一一对应」这个前提由测试钉住：钩子看到的 sequence 序列必须与
  // listEvents 返回的逐条相等。
  const sequenceCapture = createJournalSequenceCapture(deps.journal);

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      // 事件扇出绝不能把 run 打挂：钩子是观察者，异常吞在此边界并记日志。
      try {
        if (deps.onRunEvent === undefined) return;
        deps.onRunEvent(
          toProgressPayload({
            event,
            runId,
            sequence: sequenceCapture.sequenceOf(event),
            occurredAt: sequenceCapture.timeOf(event),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(launch === undefined ? {} : { launchInputId: launch.inputId }),
            ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
            concurrencyCeiling,
            ...(subagentModel === undefined ? {} : { subagentModel }),
            ...(runSubagentModel === undefined ? {} : { subagentSelection: runSubagentModel }),
            ...(launch?.sessionSelection === undefined
              ? {}
              : { sessionSelection: launch.sessionSelection }),
          }),
          // 路由与载荷分开：事件必须落在**发起该 run 的**会话里，而 parentSessionId 是
          // 判断"是不是那个会话"的唯一依据。
          parentSessionId === undefined ? {} : { parentSessionId },
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run event hook failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run_event.hook_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    },
    executionPort: deps.executionPort,
    fileSystemPort: deps.fileSystemPort,
    escalationRegistry,
    cwd,
    // 用户面产物的落点。会话作用域取**本服务
    // 的**父会话（= 本 app 的会话）而不是 launch 入参里那个可选的 parentSessionId：两者在
    // 生产里同值（run start 传的就是 runtime 自己的 sessionId），但只有前者是必填的，而
    // 「字节写进哪个会话的目录」不该有一条 undefined 的分支。store 缺席时整对都不传，
    // driver 侧因此以 ArtifactStoreUnavailable 大声拒绝。
    ...(deps.artifactStore === undefined
      ? {}
      : {
          artifactStore: deps.artifactStore,
          parentSessionId: deps.parentSessionId as SessionId,
        }),
    declaredRunCommands: compiled.declaredRunCommands,
    // 每个 actor 站点拿哪一种 submit_result（typed / generic / 无），编译期已定。
    actorSubmitProfiles: compiled.actorSubmitProfiles,
    runId,
    // 边界记账与种子复制都要读写 actor 会话的消息（driver 侧，见 workflow-driver.ts 的文件头）。
    ...(deps.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: deps.actorTranscriptStore }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // 进程级并发治理器的窄端口：在场时 driver 给每个
    // actor runtime 一个请求级准入端口（下面 runtimeFactory 原样下传）；缺席即 actor 不受闸门约束。
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    // 测试注入的 driver 时钟（故障矩阵）；生产缺席，driver 走真时间。
    ...(deps.driverClock === undefined ? {} : { clock: deps.driverClock }),
    ...(deps.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: deps.registerResidencyBlockingWork }),
    runtimeFactory: createWorkflowActorRuntimeFactory({
      deps,
      runId,
      recordedActorModels,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(executionFailoverLineageId === undefined ? {} : { executionFailoverLineageId }),
      ...(runSubagentModel === undefined ? {} : { runSubagentModel }),
    }),
  });

  return runWorkflowScript({
    askSpecs: compiled.askSpecs,
    caps,
    // SEA 下必须换 spawn 策略，非 SEA 一律不传。
    ...(childSpawn === undefined ? {} : { childSpawn }),
    cwd,
    lowered: compiled.lowered,
    makeDriver,
    ...(input.onControlReady === undefined ? {} : { onControlReady: input.onControlReady }),
    // 入口文件写不进项目 `.lcode/` 时 harness 回落到 OS 临时目录并报一声——run 照常启动，
    // 但这条日志是排查「项目里为什么没有 workflow-runs 存档」的唯一线索。
    onWarning: (warning) => {
      deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
        event: "dynamic_workflow.entry_file.fallback",
        module: "bootstrap.app",
        runId,
        ...warning,
      });
    },
    // name 与 scriptText 同一条元数据路：harness 原样转交 EngineConfig（resume 时 journal
    // 命中短路 createRun，传它无害且保持 submit/resume 两条 launch 输入同形）。
    ...(name === undefined ? {} : { name }),
    // 实参与 name / scriptText 同一条元数据路，但多一个去处：harness 既转交 EngineConfig
    // （落 args_json），也放进 spawn payload 注入沙箱。
    ...(args === undefined ? {} : { args }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    runId,
    // 落库的是作者原文与它的哈希，不是 lowered 函数体（resume 的比对基准是原文）。
    scriptHash: compiled.scriptHash,
    scriptText,
    // 关联锚点随 run 落库：重启后工具卡 join 与 resume 通知都只能从 dwf_run 还原它。
    ...(toolCallId === undefined ? {} : { toolCallId }),
    // 修订续跑：lineage 指针落库（createRun 一次写死），导入缓存注入引擎（纯数据，核心零 I/O）。
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
    // 用量起点与缓存同车：引擎在 createRun 时把它写成 spent_tokens 的初值，命中既有行时忽略。
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // 锚点只在建 run 那一世落 journal（引擎侧的门），resume 时传它无害。
    ...(launch === undefined ? {} : { launch }),
    signal,
    validate: validateFn,
  });
}

/**
 * 沙箱子进程的 spawn 策略：SEA 下走隐藏子命令自 re-exec，否则不表态（harness 缺省
 * `node --max-old-space-size=… <entry>`）。
 *
 * SEA 单文件二进制不解释 Node CLI 旗标，harness 缺省 argv 里的
 * `--max-old-space-size` 会原样落进 CLI 的严格 parseArgs，子进程立即报错退出——**SEA 下每一个
 * workflow run 必然失败**。修法与 official plugin host 同款
 * （official-plugin-runtime.ts 的 `officialPluginHostPrefixArgs`）。
 *
 * SEA 判定留在 bootstrap 而不下沉到 harness：harness 是 app-free 的（只依赖
 * `@lcode/dynamic-workflow` 与 node 内建），既拿不到 contracts 的子命令常量，也不该知道
 * 自己被哪种宿主打包。`isSea` 可注入只为可测——默认探针在测试进程里必然返回 false，
 * 于是「非 SEA 不得带 argsPrefix」也是一条可断言的事实。
 */
export function dynamicWorkflowChildSpawn(
  isSea: boolean = isSeaRuntime(),
): { argsPrefix: readonly string[] } | undefined {
  return isSea ? { argsPrefix: [LCODE_DWF_CHILD_COMMAND] } : undefined;
}

/** SEA 运行时探针（official-plugin-runtime.ts 私有同名 helper 的本地镜像，刻意不跨文件复用）。 */
function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

export { journalActorResolvedModel } from "./workflow-actor-runtime.js";

/**
 * RunEvent → 协议事件的映射（**本注释即契约**）：`type` 取事件的判别式，`payload` 是同一个
 * 事件对象去掉 `type` 后的其余字段，经 {@link boundDynamicWorkflowRunEventPayload} 有界化。
 * 刻意不重塑字段名——读端（详情页事件日志）按事件种类解释 payload，而引擎的词汇表就是那份 schema。
 *
 * 引擎实际发出的种类：run-started / actor-created / node-queued / node-dispatched /
 * node-repairing / node-nudged / node-settled / usage-updated / log / report / phase-entered /
 * run-settled。
 * （`executing` 不是可观察事件；`compaction` v1 从不发出。）另有两种由 **driver** 发出、
 * 走同样两条轨的事件：escalation-raised / escalation-resolved（workflow-driver.ts 的升级桥接）。
 *
 * 新增一个事件种类在**本函数**里是零改动的，这正是"不重塑字段名"买到的东西：`type` 取判别式、
 * payload 是其余字段，这里没有按种类的分支可漏。**但下游确实有一个按种类的 switch**：
 * `lcode-protocol-v4/product-projection.ts` 的 `applyWorkflowRunEvent` 逐种类归约，其
 * `eventType` 形参是 `string` 而不是 `RunEvent["type"]`，漏一支 tsc 不会报——加事件种类时
 * 要去读那个 switch，不能指望编译器。
 */
export function toProtocolEvent(sequence: number, event: RunEvent): DynamicWorkflowRunEvent {
  const { type, ...rest } = event;
  const { payload, truncated } = boundDynamicWorkflowRunEventPayload(
    rest as Record<string, unknown>,
  );
  return { sequence, type, payload, ...(truncated ? { truncated } : {}) };
}

/**
 * RunEvent → 会话事件载荷。`payload` 与 {@link toProtocolEvent} 逐字节相同（一次序列化、
 * 两个消费者），另加两个**派生字段**。
 *
 * 派生字段放在 payload **之外**是有意的：payload 必须保持"引擎发了什么"的原样，否则事件日志
 * 就在展示我们的加工品。两个字段各自都不是可观察事实，但缺了它们下游只能自己重造一份契约：
 *
 *   - `actorSessionId`：Boundary C 的 actor-created 不带会话 id（它由 driver 铸造）。让
 *     renderer 按 (runId, actorRef) 自己拼，等于把 sanitize 契约复制进 UI 层；这里调用
 *     铸造它的**同一个函数**，两边不可能漂移（测试钉住相等）。
 *   （曾经还有第二个派生字段 `spentTokens`：老的 budget-updated 只发剩余量。现在 usage-updated
 *   自己携带已花总量，与 dwf_run.spent_tokens 在同一同步步骤产生，不再需要派生。）
 */
export function toProgressPayload(input: {
  event: RunEvent;
  runId: string;
  sequence: number;
  occurredAt?: number;
  toolCallId?: string;
  /** run 的锚点 inputId；只在 actor-created / run-settled 上派生（子代理归属的两个时刻）。 */
  launchInputId?: string;
  /** 修订 run 的前驱；只在 `run-started` 上派生（卡片的「调整自 run X」）。 */
  resumedFrom?: string;
  /**
   * 铸造这条载荷那一刻的进程并发天花板；只在 `run-started` 上派生
   *
   * 引擎事件只带它自己的 `caps.maxConcurrency`，而「这个数值不值得显示」要拿它和天花板比——
   * 天花板是宿主事实（机器核数），引擎既看不见也不该看见。投影侧据 `caps.maxConcurrency <
   * concurrencyCeiling` 记下本 run 的自有上界，UI 的并发 chip 再取 min(共享 cap, 本 run 上界)。
   */
  concurrencyCeiling?: number;
  /**
   * 本 run 的子代理模型（规范 picker 串）；只在 `run-started` 上派生，且**只在设过时**在场。
   * 与 `concurrencyCeiling` 不同，它不需要与任何默认值比对：
   * 引擎压根不知道有这件事（模型面整个在宿主侧），所以缺席即「子代理跑在会话模型上」。
   * 冷回放从同一条 `run-launched` 事件给出同一个键，两侧载荷因此逐字节相等。
   */
  subagentModel?: string;
  /** 启动时冻结的完整模型选择，包含速度。 */
  subagentSelection?: ModelSelection;
  sessionSelection?: ModelSelection;
}): DynamicWorkflowRunProgressPayload {
  const {
    event,
    runId,
    sequence,
    toolCallId,
    launchInputId,
    resumedFrom,
    concurrencyCeiling,
    subagentModel,
    subagentSelection,
    sessionSelection,
  } = input;
  const protocolEvent = toProtocolEvent(sequence, event);
  return {
    runId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sequence,
    ...(typeof input.occurredAt === "number" &&
    Number.isSafeInteger(input.occurredAt) &&
    input.occurredAt >= 0
      ? { occurredAt: input.occurredAt }
      : {}),
    eventType: protocolEvent.type,
    // `run-settled` 多带一位 `resumable`：
    // resume 门的谓词只在 CLI 有，投影与 UI 只搬运这一位、绝不自行按 status 推导。
    // 谓词 = stopped ∧ 非 superseded；冷回放对孤儿收敛过的
    // 行给同一个键——两条链、一个谓词（isResumableSettlement）。stopReason / supersededBy 随事件载荷原样透出。
    // `run-started` 多带 `resumedFrom`：引擎事件不带它（引擎不读 lineage），但卡片要画这条边。
    // 同一条缝里还多带 `concurrencyCeiling`：引擎只发自己的 caps，而「这个上界是不是默认值」
    // 要拿它和宿主的天花板比（见上面的字段注释）。两者互不相关，各自缺席即各自不出。
    payload:
      event.type === "run-settled" && isResumableSettlement(event.status, event.stopReason)
        ? { ...protocolEvent.payload, resumable: true }
        : event.type === "run-started"
          ? {
              ...protocolEvent.payload,
              ...(resumedFrom === undefined ? {} : { resumedFrom }),
              ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              ...(subagentModel === undefined ? {} : { subagentModel }),
              ...(subagentSelection === undefined ? {} : { subagentSelection }),
              ...(sessionSelection === undefined ? {} : { sessionSelection }),
            }
          : protocolEvent.payload,
    ...(protocolEvent.truncated ? { truncated: true } : {}),
    ...(event.type === "actor-created"
      ? { actorSessionId: mintActorSessionId(runId, event.actor) }
      : {}),
    // 第三个派生字段：下游只在这两种事件上
    // 需要锚点——actor-created 登记子代理归属，run-settled 结算该 run 全部子代理。
    ...((event.type === "actor-created" || event.type === "run-settled") &&
    launchInputId !== undefined
      ? { launchInputId }
      : {}),
  };
}
