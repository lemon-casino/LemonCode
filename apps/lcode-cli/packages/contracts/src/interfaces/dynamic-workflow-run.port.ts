import type { DynamicWorkflowRunProgressPayload } from "../events/session.events.js";
import type {
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitOptions,
  DynamicWorkflowRunSubmitResult,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunWaitOptions,
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowAskControlRequest,
  DynamicWorkflowAskControlResult,
  DynamicWorkflowAskRevisionRequest,
  DynamicWorkflowAskRevisionResult,
  DynamicWorkflowRunResumeResult,
} from "./dynamic-workflow-run/commands.js";
import type {
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunSessionSummary,
} from "./dynamic-workflow-run/snapshot.js";
import type {
  DynamicWorkflowRunEventPage,
  DynamicWorkflowRunEvent,
} from "./dynamic-workflow-run/events.js";
import type {
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunListResult,
} from "./dynamic-workflow-run/observation.js";
import type { DynamicWorkflowResolveQuestionResult } from "./dynamic-workflow-run/questions.js";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactBytes,
} from "./dynamic-workflow-run/artifacts.js";
import type {
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunWorkspaceNodeResult,
} from "./dynamic-workflow-run/workspace.js";

/**
 * workflow run 的窄端口。与 legacy {@link import("./workflow.port.js").WorkflowPort} 并列而非
 * 合并：后者服务 `Workflow` 工具与 `workflow_*` 旧表，共用一个端口等于在接口层把
 * 「独立于既有 workflow 机制」这条边界重新耦合回去。
 *
 * 取消没有专属 RPC：详情页按钮与后台面板的停止共用既有的 v4 `cancelBackgroundWork`
 * 命令，它落到这里的 {@link cancel}（runId ≡ workId）。
 */
export interface DynamicWorkflowRunPort {
  /** 编译一次并启动引擎；返回 runId（即 backgroundTaskId）。 */
  submit(
    request: DynamicWorkflowRunSubmitRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunSubmitResult>;
  /**
   * 修订一个 run：预检前驱 → 铸新 id → 前驱在飞则以 `{ superseded: newRunId }` 取消并等它结算
   * → 从前驱导入缓存 → 启动新 run（见 {@link DynamicWorkflowRunAmendRequest}）。预检被拒即
   * 结构化失败且**什么都没动**。老宿主可能没有这个方法（可选成员）：工具层按能力探测归一成
   * 「本会话不支持修订」。
   */
  amend?(
    request: DynamicWorkflowRunAmendRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunAmendResult>;
  /**
   * run 自己并发上界的天花板（`max(1, min(16, availableParallelism() − 2))`，每进程一个值）。同步、无副作用。
   *
   * 工具层的两个读者：`CreateWorkflow` / `AmendWorkflow` 的 `resolveInput` 把模型给的
   * `max_concurrency` 钳到它之下（确认窗显示的必须是将要生效的值），`GetWorkflowRun` 据它决定
   * 一个 run 的上界是否值得一提。**可选成员**（消费方 `typeof` 探测）：端口 stub 不必为它陪跑，
   * 缺席时工具层不钳、原样下传（端口实现自己还会钳一次）。
   */
  concurrencyCeiling?(): number;
  getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  waitForTask(
    taskId: string,
    options?: DynamicWorkflowRunWaitOptions,
  ): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /**
   * 停下一个 run：中止在飞 ask 并 kill 子进程，run 结算 `stopped(initiator)`。`initiator`
   * 缺省 `user`；主代理经 TaskStop 停的传 `model`（原因从此落库，不再只活在后台任务注册表里）；amend 路径传 `{ superseded: newRunId }`。
   * 未知 runId 返回 false。
   */
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
  /** 只控制本会话在飞 run 的单次 ask；已完成任务的因果修订走独立入口。 */
  controlAsk?(request: DynamicWorkflowAskControlRequest): Promise<DynamicWorkflowAskControlResult>;
  /** Revise a completed ask in a settled predecessor; preserve independent cached work. */
  reviseAsk?(request: DynamicWorkflowAskRevisionRequest): Promise<DynamicWorkflowAskRevisionResult>;
  /** 按 cursor 翻取事件日志；越界 cursor 返回空页而非报错。 */
  listEvents(
    runId: string,
    options: DynamicWorkflowRunEventPage,
  ): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * 按项目（cwd）枚举 run，最近更新的在前。服务 `ListWorkflowRuns` 工具。
   *
   * **可选成员**，照 {@link cancel} 之前的先例（消费方 `typeof` 探测）：实现方只有在 journal
   * 带内省查询时才提供它，既有的端口 stub 也不必为一个只读枚举面全员陪跑。消费方对
   * 「端口缺席」与「方法缺席」给同一个业务失败——对模型这是同一件事（本会话没有这个能力）。
   */
  listRuns?(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult>;
  /**
   * 单 run 详情（进度摘要 + 产物 / 失败）。服务 `GetWorkflowRun` 工具。未知 runId 返回
   * `undefined`（消费方归一成 `run_not_found`），**不做 wait/block 语义**——等待是
   * {@link waitForTask} 的活，这里是即时快照。可选成员的理由同 {@link listRuns}。
   */
  getRunDetail?(runId: string): Promise<DynamicWorkflowRunDetail | undefined>;
  /**
   * run 存档的脚本原文（`dwf_run.script_text`，resume 重放的同一份字节），逐字节、不做任何处理。
   * `AmendWorkflow` 的两处读它：省略脚本时把前驱的脚本回填进
   * 入参，以及 `path` 修订的 `script_unchanged` 预检——
   * 那必须比字节而不能比哈希，工具侧读到的是文件内容，不是编译产物。GUI「配置」走同一条读路。
   *
   * 单独一条读面而不是 {@link DynamicWorkflowRunSnapshot} 的字段：快照被后台追踪器反复轮询，而
   * 脚本是端口上最大的一个字符串（{@link DynamicWorkflowRunSummary.label} 同一条理由）。未知 run
   * 与「记录里没有脚本」（落库之前的老 run）都回 `undefined`——对调用方是同一个事实：没有可沿用的
   * 脚本。只读、不看服务是否已关闭。**可选成员**（消费方 `typeof` 探测），理由同 {@link listRuns}：
   * 缺席时省略脚本的修订当场失败，`script_unchanged` 预检则被跳过（它是网，不是门）。
   */
  getScript?(runId: string): Promise<string | undefined>;
  /**
   * 恢复一个已取消 / 被进程死亡打断的 run：同 runId 重跑（引擎走 resume 分支，journal
   * 命中短路、未完结节点重新派发）。门在实现侧：只有 `cancelled` 或 `failed` 且失败编码为
   * `Interrupted` 的 run 可恢复。
   *
   * **可选成员**，照 {@link listEvents} 之前 cancel 的先例（消费方 `typeof` 探测）：
   * 端口 stub 不必为 resume 面全员陪跑；对消费方「端口缺席」与「方法缺席」是同一个业务失败。
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * 枚举**本服务父会话**名下的 run 摘要（最近更新在前，journal-backed）。UI 的重启后发现面：
   * `workflowRuns` 投影跨进程不存活，工具卡 join 与 Resume 按钮的可用性只能从这里还原。
   * 刻意不收 parentSessionId 参数——服务实例本就按父会话构造（per-app），让调用方传任意
   * 会话等于开一个跨会话读洞。可选成员的理由同 {@link resume}。
   */
  listRunsForSession?(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * 冷回放：把**本服务父会话**名下、本进程
   * 没跑过的 run 从 journal 回放成进度事件载荷——与 live 时 `onRunEvent` 交出的是**同一种**
   * 载荷、同一条铸造链，冷物化把它们当内存事件喂给同一个 reducer，`workflowRuns` 投影因此
   * 在重启前后逐字节一致。
   *
   *   - 上界与投影的淘汰同（最近更新的 8 条），最旧的 run 在前；
   *   - `excludeRunIds`：调用方内存里已有事件的 run（本进程跑过 / 正在跑）不回放；
   *   - 行是终态而事件流没有 `run-settled` 的 run（进程死亡后被孤儿收敛改写的行）追加一条
   *     **内存态**合成 settle 载荷（携行的 status / failure / resumable），绝不写进 journal。
   *
   * 可选成员的理由同 {@link listRunsForSession}：内存 journal 没有枚举面，回放无物可还原。
   */
  replayProgressForSession?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * 回答一个 actor 升级上来的阻塞问题。服务
   * `ResolveWorkflowQuestion` 工具。
   *
   * 只收一个不透明 token 而不是 `(runId, qid)` 对：qid 全局唯一（跨 run），多 run 并发时
   * 让模型自己配对是错配的温床。答案原样成为 actor 那次 `escalate` 调用的工具结果，
   * actor 的轮次随即继续；run 状态全程不动（升级是 ask 内部的一次慢工具调用，
   * 不是 run 生命周期事件）。
   *
   * **可选成员**，照 {@link resume} 的先例（消费方 `typeof` 探测）：端口 stub 不必为一个
   * 应答面全员陪跑；对消费方「端口缺席」与「方法缺席」是同一个业务失败。
   */
  resolveQuestion?(qid: string, answer: string): Promise<DynamicWorkflowResolveQuestionResult>;
  /**
   * 本 run 的用户面产物清单（journal `kind = "artifact"` 行按 id 分组、版本升序）。UI 冷恢复与中枢详情的 durable 读法。
   * 未知 runId 返回 `undefined`。**可选成员**，理由同 {@link listRuns}（journal 带产物
   * 读面时才提供；消费方 `typeof` 探测）。
   */
  listArtifacts?(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * 喂给某个预置产物的 `report` 条目，按 journal sequence 升序分页（看板的取数面）。
   * 越界 cursor 返回空页而非报错。可选成员，理由同 {@link listArtifacts}。
   */
  listArtifactItems?(
    runId: string,
    artifactId: string,
    page: DynamicWorkflowRunArtifactItemPage,
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * 读某个产物版本的字节：**先**在 journal 里确认 `(runId, artifactId, version)` 有一行
   * `completed` 记录，再按行上的 `uri` 经 tool-artifact store 取——调用方传来的任何 id 都
   * 不直接成为路径。无此版本 / 非内容产物 /
   * store 缺席 → `undefined`。分块归网关（v4 `workflowRunArtifactRead`，≤ 512 KiB 一块）。
   * 可选成员，理由同 {@link listArtifacts}。
   */
  readArtifact?(
    runId: string,
    artifactId: string,
    version: number,
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * 本 run 的工作区 transcript：journal 里
   * `kind ∈ {world-read, world-run}` 的行按落库先后，**不带正文**。
   *
   * 授权与 {@link readArtifact} 同一条链：run 必须属于本服务的父会话，否则 `undefined`
   * （与「无此 run」同一个答案——不告诉越权的调用方它猜对了哪一半）。正文可能含工作区文件
   * 内容，所以清单也不放行别的会话。可选成员，理由同 {@link listArtifacts}。
   */
  listWorkspaceNodes?(
    runId: string,
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  /**
   * 一个工作区节点的正文，按 `maxBytes` 保形有界化。授权链同 {@link listWorkspaceNodes}；
   * 无此节点 / 非 world 行 / 不是你的 run → `undefined`。可选成员，理由同 {@link listArtifacts}。
   */
  readWorkspaceNodeResult?(
    runId: string,
    siteId: string,
    ordinal: number,
    query: DynamicWorkflowRunWorkspaceNodeResultQuery,
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
}

/**
 * workflow run 里**任意脚本值**（顶层返回的产物、`report(item)` 的条目）→ 给模型或读者看的
 * 文本。实现已随共享 workflowRuns reducer 搬进 `@lcode/shared/lcode-protocol-v4`
 * （workflow-artifact.ts，规则与来龙去脉见那边的注释）：`reports[].preview` 的归约下沉到
 * shared 后成了第四个消费者，而依赖方向是 contracts → shared，只能函数跟着搬。这里保留
 * re-export，既有的三个消费者（完成通知、TaskOutput 的 resultText、v4 投影）一行不改。
 */
export { serializeWorkflowArtifact } from "@lcode/shared/lcode-protocol-v4";

// 情势截面（阶段 / 子代理 / 健康）的类型住在 dynamic-workflow-run-roster.port.ts（同上），
// 此处原样再导出以保持 `@lcode/contracts` 的导入路径不变。
export type * from "./dynamic-workflow-run-roster.port.js";

export type {
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitOptions,
  DynamicWorkflowRunSubmitResult,
  DynamicWorkflowAskControlRequest,
  DynamicWorkflowActorModelOverride,
  DynamicWorkflowAskControlResult,
  DynamicWorkflowAskRevisionRequest,
  DynamicWorkflowAskRevisionResult,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendRefusalReason,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowRunWaitOptions,
  DynamicWorkflowRunResumeErrorReason,
  DynamicWorkflowRunResumeResult,
} from "./dynamic-workflow-run/commands.js";

export type {
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunSessionSummary,
} from "./dynamic-workflow-run/snapshot.js";

export type {
  DynamicWorkflowRunArtifactVersion,
  DynamicWorkflowRunArtifactKind,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunArtifactBytes,
} from "./dynamic-workflow-run/artifacts.js";

export type {
  DynamicWorkflowRunWorkspaceNodeKind,
  DynamicWorkflowRunWorkspaceNodeStatus,
  DynamicWorkflowRunWorkspaceNodeSummary,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunWorkspaceNodeResult,
} from "./dynamic-workflow-run/workspace.js";

export type {
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowResolveQuestionRefusalReason,
  DynamicWorkflowResolveQuestionResult,
} from "./dynamic-workflow-run/questions.js";

export {
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS,
  boundDynamicWorkflowRunEventPayload,
} from "./dynamic-workflow-run/events.js";

export type {
  DynamicWorkflowRunEventPage,
  DynamicWorkflowRunEvent,
} from "./dynamic-workflow-run/events.js";

export type {
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunStopReason,
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunSummary,
  DynamicWorkflowRunListItem,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunUsage,
  DynamicWorkflowRunActor,
  DynamicWorkflowRunLogEntry,
  DynamicWorkflowRunError,
  DynamicWorkflowRunProviderStop,
} from "./dynamic-workflow-run/observation.js";
