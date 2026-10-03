import type {
  TraceContext,
  DynamicWorkflowRunProgressPayload,
  ExecutionPort,
  FileSystemPort,
  Logger,
  SessionId,
  ModelRequestAdmission,
  ModelSelection,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@lcode/contracts";
import type { AgentRuntime } from "@lcode/core";
import type {
  ActorModelProvenance,
  ActorSubmitProfile,
  ActorRef,
  JournalStorePort,
  PersonaSpec,
} from "@lcode/dynamic-workflow";
import { type DynamicWorkflowTaskLinkStore } from "./dynamic-workflow-run-journal.js";
import { type DynamicWorkflowRunExecutionFailoverLineageLease } from "./dynamic-workflow-run-observation.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";

/** actor runtime 工厂的输入。runId 在内，因为会话 id 与 task link 都要 run 作用域。 */
export interface DynamicWorkflowActorRuntimeInput {
  runId: string;
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * 该 actor 的 submit profile：`untyped` 不注入
   * submitPort（无工具），`mono` 注入端口 + typed 声明，`generic` 只注入端口。工厂是这条映射的
   * 唯一落点（与子代理工具面的固定 disallowlist 同一处 seam）。
   */
  submitProfile: ActorSubmitProfile;
  /**
   * 会话级升级端口：注入即为该 actor 会话注册 `escalate`
   * 工具，与 submitPort 完全同构。**恒在场**，不做 opt-in——最可能撞上未预见之墙的 actor
   * 恰是作者没标记的那一个。
   */
  escalatePort: WorkflowEscalatePort;
  /** launch 已按显式配置、同 run 绑定与 import seed 裁决出的选择；缺席即继承父会话。 */
  actorModelSelection?: ModelSelection;
  /** 与 actorModelSelection 同一次裁决得到的来源，供 failover scope 与 journal 共用。 */
  actorModelProvenance: ActorModelProvenance;
  /**
   * 该 actor runtime 的模型请求准入端口：
   * driver 在治理器端口在场时给出；工厂原样放进 runtime deps。缺席即不受闸门约束。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /** session-inherited actor 安全切换成功后，将新的完整 selection 写回本 run journal。 */
  onExecutionFailoverSelection?: (selection: ModelSelection) => Promise<void> | void;
  /** run 启动时冻结的父 execution lineage；同一 run 后续 actor 共用。 */
  executionFailoverLineageId?: string;
}

export interface DynamicWorkflowRunServiceDeps {
  acquireCheckoutWriterLease?: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<{ release(): Promise<void> } | undefined>;
  /** durable journal（dwf_* 表）。缺失即不构造本服务，见文件头不变式 3。 */
  journal: JournalStorePort;
  /**
   * 发起锚点的解析：给出 submit 那一刻父 runtime 活动轮的
   * inputId；`trace.turnId` 与活动轮不一致或没有活动轮时回 `undefined`（submit 侧兜底铸值）。
   * 缺席即宿主没有「当前轮」概念（CLI、测试装配）。
   */
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  /** run 启动时读取一次；不得在每个 actor 创建时重新采样。 */
  resolveExecutionFailoverLineageId?: () => string | undefined;
  /**
   * run 级 lineage lease 在引擎启动前取得；它不伪装成 work，也不进入 eligibility 投影。
   * 返回的 release 必须幂等，生命周期所有者会在终态失败重试。
   */
  acquireExecutionFailoverLineageLease?: (
    leaseId: string,
  ) => Promise<DynamicWorkflowRunExecutionFailoverLineageLease | undefined>;
  /**
   * 本服务实例的父会话 id（= 本 app 的会话，见 create-app.ts）。
   *
   * 它是**孤儿收敛与枚举的作用域**，所以不是可选项：缺席只剩两条路——全局清扫（会把同进程
   * 兄弟会话正在飞的 run 标死，两者共用同一个 sqlite、各有各的内存注册表）或干脆不收敛
   * （就是那个「run 永远停在 running」的 bug）。宁可让接线错误在编译期出现。
   */
  parentSessionId: string;
  /** world-read（files.glob / files.read / files.grep）落到的文件系统端口。 */
  fileSystemPort: FileSystemPort;
  /** git.* world-read 落到的子进程执行端口（cwd = run 的工作区）。 */
  executionPort: ExecutionPort;
  /**
   * 用户面产物（`artifact.file` / `artifact.markdown`）的字节落点，原样转交 driver。⚠ 这里的 artifact 指**交付给用户看的
   * 产出**，不是引擎内部那个顶层返回值。
   *
   * **可选**：不带 store 的装配（测试、最小 stub）照旧能跑 run，只是内容成员会以命名的
   * `ArtifactStoreUnavailable` 拒绝——一条脚本可 catch 的失败，不是静默降级。会话作用域
   * 用的是本服务的 {@link DynamicWorkflowRunServiceDeps.parentSessionId}（= 本 app 的会话，
   * 也就是父会话）。
   */
  artifactStore?: ToolArtifactStorePort;
  /** 造一个 actor 的 child AgentRuntime（生产包装 createScriptWorkflowAgentRuntime）。 */
  createActorRuntime: (input: DynamicWorkflowActorRuntimeInput) => AgentRuntime;
  /** Launch-time parent selection snapshot; read exactly once for each new run. */
  getSessionModelSelection?: () => ModelSelection | undefined;
  /** actor 会话的 task link 落库面；缺席则跳过建 link（会话本身仍落库）。 */
  taskLinkStore?: DynamicWorkflowTaskLinkStore;
  /**
   * actor 会话的转录存取面（生产就是 session store 本身）。driver 用它做两件事：ask 边界记账的
   * 计数，与 amend-resume 分歧 actor 的转录截断复制。
   *
   * 缺席时边界记账整体缺席——run 照常跑完，只是**不能再作为修订的前驱**（service 的
   * 「无 marker 前驱整体拒绝」门会挡下来）。可选而非必填，是因为不带会话存储的装配里本来就没有
   * 转录可数；带种子的会话创建在缺席时由 driver 大声失败。
   */
  actorTranscriptStore?: ActorTranscriptStore;
  /**
   * 引擎事件钩子：交出的是**已经准备好的会话事件载荷**（有界 payload + journal sequence +
   * 两个派生字段），调用方只负责把它追加到父会话（create-app 接 runtime 的 record 方法）。
   *
   * 为什么由本服务准备而不是让调用方拼：sequence 与 spentTokens 都只能从 journal 读，
   * 而 journal 是本服务的依赖；actor 会话 id 只能由铸造它的那个函数算。把这三件事推给
   * 调用方，等于把三个契约复制到一个没有 journal 的层里。
   *
   * 第二个参数是**路由**信息，刻意与载荷分开：`parentSessionId` 决定事件该落到哪个会话，
   * 但它不属于载荷本身（事件已经在那个会话里了，再存一份是冗余）。调用方据它做身份闸门，
   * 见 {@link createDynamicWorkflowRunProgressSink}。
   */
  onRunEvent?: (
    progress: DynamicWorkflowRunProgressPayload,
    routing: { parentSessionId?: string },
  ) => void;
  logger?: Logger;
  /** 注入并发度探测，供 caps 默认值测试固定双核（地板必须是 1）。 */
  availableParallelism?: () => number;
  /**
   * 进程级并发治理器的窄端口。原样转交 driver：
   * 有效并发 = min(本 run 的 caps.maxConcurrency, 该 provider key 的共享 live cap)。缺席即只有
   * per-run 上界（测试装配、无治理器的宿主）。
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * 把一次启动登记为父 runtime 的**常驻阻塞工作**。
   *
   * 引擎活在会话 App 的闭包里、不进 runtime task registry，而常驻池当时
   * 只读 registry——一个仍在跑的 run 被读成 idle，App 被关闭，resume 起了第二个引擎。登记走
   * runtime 唯一的那个口（`trackResidencyBlockingWork`），常驻池因此不必再对 sidecar 做猜测。
   *
   * 缺席即宿主没有常驻概念（CLI 一次性执行、测试装配）：run 照常跑完，只是不挡关闭。
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /**
   * driver 的时钟与定时器：run 级
   * stall 时钟与瞬态失败的退避重驱都读它。**只为测试注入**（故障矩阵把 2s→60s 的重驱曲线与
   * 20 分钟的 stall 窗缩到毫秒级）；生产装配永不设置，缺席即 driver 用真时间。
   */
  driverClock?: AgentRuntimeWorkflowDriverDeps["clock"];
}
