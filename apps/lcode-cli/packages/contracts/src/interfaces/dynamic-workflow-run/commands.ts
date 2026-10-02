import type { ModelSelection } from "../../model/model.js";
import type { SessionId, ToolCallId } from "../shared.js";
import type { TraceContext } from "../../tracing/tracer.js";

/**
 * 一次 workflow run 的提交请求。脚本文本是权威输入（编译、site 表、schema 合成、lowering
 * 都从它派生），因此这里只递脚本与执行上下文，不递任何编译产物——「编译一次」发生在
 * 端口实现侧（run service），调用方不该有编译产物的概念。
 */
export interface DynamicWorkflowRunSubmitRequest {
  /** workflow 脚本源码。逐字节落库（dwf_run.script_text），resume 以其哈希为前提。 */
  scriptText: string;
  /** run 的工作目录（沙箱子进程 cwd、world-read 的根）。 */
  cwd: string;
  /**
   * run 的展示名（`CreateWorkflow` 的可选 `input.name`）。落 `dwf_run.name`，供枚举面当标签。
   * 纯展示元数据：不参与执行、不参与 resume 校验；缺席即没起名（读侧按脚本首行兜底）。
   */
  name?: string;
  /**
   * 本次 run 的实参（saved workflow 的声明式参数，工具侧已按声明校验并回填默认值）。
   *
   * 与 `name` 不同，这**不是**展示元数据：它落 `dwf_run.args_json` 并注入沙箱成为脚本可读
   * 的 `args` 全局，是 run 身份的一部分——resume 重放存下的这一份，永不接受新的。内联脚本
   * 没有实参，字段缺席即 `{}`。
   */
  args?: Record<string, unknown>;
  /** 发起这次 run 的会话；引擎事件投影回该会话。 */
  parentSessionId?: SessionId | string;
  /** 发起这次 run 的 CreateWorkflow 工具调用（工具卡→详情页的关联键）。 */
  toolCallId?: ToolCallId | string;
  /**
   * 发起 run 那一轮的 inputId：子代理的
   * `agent_step` 归到这个 message 下。只有中枢直接启动填它（`startSavedWorkflowRun` 铸的
   * UUID v7，与 controlOnly 启动轮共用）；聊天路径缺席，由 run service 从父 runtime 的活动轮解析。
   */
  launchInputId?: string;
  /**
   * 脚本声明的阶段表（因果图有名阶段，声明序，≤ 32 × 128；`createWorkflowPhaseNames`）。引擎把它
   * 与锚点一起记进 `run-launched`，sessions-index 投影据此给侧栏迷你轨道画出前方的站点。纯展示元数据：不参与执行、
   * 不参与 resume 校验；脚本没有 `phase()` 标记时缺席。
   */
  phaseNames?: string[];
  /**
   * 本 run 自己的并发上界：同时在飞的
   * ask 数，落 `dwf_run.caps_max_concurrency`、resume 照用。**缺席即天花板**（机器推导值，
   * `resolveWorkflowConcurrencyCeiling`）；给了就钳到 `[1, 天花板]`——它只能压低并发，永不抬高。
   * 工具层在 `resolveInput` 里已经钳过一次（确认窗要显示实际生效的值），这里再钳是端口自己的契约。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理跑在哪个模型上。记进 journal 事件
   * `run-launched` 的那个规范形的来源、resume 照用；**缺席即继承发起会话的模型**。
   *
   * 收的是结构化 {@link ModelSelection} 而不是字符串：工具层**已经**把用户说的名字经模型目录
   * 解析过一次（解不出来在确认窗之前就退回了），端口不该再做一次名字匹配——那会让「解析在哪
   * 发生」有两个答案。主代理自己不受影响：它恒留在会话模型上。
   */
  subagentModel?: ModelSelection;
  /** User-approved overrides for selected actor call sites or concrete instances. */
  actorModelOverrides?: DynamicWorkflowActorModelOverride[];
  /**
   * 本 run 的脚本**来自哪个文件**的绝对路径。与 {@link subagentModel} 走同一条路：随 `run-launched` 记一次、引擎从不读、
   * 零 SQL（`dwf_run` 上没有这一列），两条读面再从事件读回。
   *
   * ⚠ 与本文件里产物的 `sourcePath` 无关：那是产物落盘的位置，这里是**脚本**的家。
   *
   * 缺席即这个 run 没有可编辑的脚本文件（草稿写不下去的项目、升级前发起的 run），模型面
   * 因此退回「改好脚本再内联提交」的老话。纯模型面元数据：桌面与 TUI 一概不显示它。
   */
  scriptPath?: string;
  /**
   * 与 {@link DynamicWorkflowRunSubmitRequest.phaseNames} **按位置对齐**的「同时在跑」表
   * （`createWorkflowPhaseAlongside`）：`phaseAlongside[i]` 是进入 `phaseNames[i]` 时 strand 仍在
   * 跑的其他阶段的**下标**（下标落在同一张 `phaseNames` 里）。侧栏迷你轨道据此把并行的两站画成
   * 双线段。
   *
   * 与 `phaseNames` 同一姿态：纯展示元数据，随锚点落 `run-launched`，引擎不读；没有阶段并行时
   * 整个字段缺席（缺席就是「这条轨道是一条直线」）。
   */
  phaseAlongside?: number[][];
  trace: TraceContext;
}

export interface DynamicWorkflowRunSubmitOptions {
  signal?: AbortSignal;
}

/**
 * submit 的结果。成功只有 runId：它同时是 backgroundTaskId 与 cancelBackgroundWork 的
 * workId（runId ≡ taskId ≡ workId），所以三条路径不需要各自的身份映射表。全新 run 没有可拒之处：
 * 接线故障（编译产物损坏、journal 不可用）仍然上抛。
 */
export type DynamicWorkflowRunSubmitResult = { ok: true; runId: string };

/** 任务身份包含尝试代次；旧侧板发出的命令不得作用于更新的重跑。 */
export interface DynamicWorkflowAskControlRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  attempt: number;
  action: "stop" | "retry";
  /** 本次重跑追加给目标任务的修订要求。 */
  supplement?: string;
  attachments?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
  }>;
}

export interface DynamicWorkflowActorModelOverride {
  siteId?: string;
  name?: string;
  ordinal?: number;
  selection: ModelSelection;
}

export type DynamicWorkflowAskControlResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_running" | "not_ready" | "not_active" };

export interface DynamicWorkflowAskRevisionRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  supplement?: string;
  attachments?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
  }>;
}

export type DynamicWorkflowAskRevisionResult =
  | { ok: true; runId: string; invalidatedSites: string[] }
  | {
      ok: false;
      reason: "not_found" | "not_completed" | "still_running" | "missing_boundaries" | "not_ready";
    };

/**
 * {@link DynamicWorkflowRunPort.amend} 的请求。
 *
 * 修订是 **supersede**：以新脚本铸**新 run**，从前驱 journal 导入「每具名 actor 的已完结 ask
 * 前缀」与 world 节点作缓存。前驱**可以仍在飞**——那正是本方法存在的理由：service 先停下它、
 * 等它结算，再导入、再启动，一次调用完成，模型不再需要 TaskStop + 轮询 + 重提交三步。
 * 与 `scriptText` 完全正交：修订 run 重新声明脚本；实参（saved 来源才有）不随修订传递。
 */
export interface DynamicWorkflowRunAmendRequest {
  scriptText: string;
  cwd: string;
  /** 被修订的前驱 run。任意状态。 */
  predecessorRunId: string;
  /** 新 run 的展示名；缺席时 service 沿用前驱的 name。 */
  name?: string;
  parentSessionId?: SessionId | string;
  /** 发起这次修订的 AmendWorkflow 工具调用（新 run 的工具卡 → 详情页关联键）。 */
  toolCallId?: ToolCallId | string;
  /** **新脚本**的声明阶段表；语义同 {@link DynamicWorkflowRunSubmitRequest.phaseNames}。 */
  phaseNames?: string[];
  /**
   * 新 run 的并发上界；语义同 {@link DynamicWorkflowRunSubmitRequest.maxConcurrency}（缺席即天花板）。
   * 「省略即沿用前驱、`null` 即解除」是**工具面**的三态，在 `AmendWorkflow` 的 `resolveInput`
   * 里归一成这里的一个数或缺席——确认窗要显示沿用下来的值，所以那条规则只能住在 handler 之前。
   */
  maxConcurrency?: number;
  /**
   * 新 run 的子代理模型；语义同 {@link DynamicWorkflowRunSubmitRequest.subagentModel}（缺席即
   * 继承会话模型）。「省略即沿用前驱、`null` 即清除」是**工具面**的三态，在 `AmendWorkflow` 的
   * `resolveInput` 里连同一次重新解析归一成这里的一个选择或缺席。
   */
  subagentModel?: ModelSelection;
  /** GUI 恢复继承时沿用前驱启动快照，不读取后来变化的父会话。 */
  sessionModelSelection?: ModelSelection;
  actorModelOverrides?: DynamicWorkflowActorModelOverride[];
  /**
   * **新脚本**来自哪个文件的绝对路径；语义同 {@link DynamicWorkflowRunSubmitRequest.scriptPath}。
   *
   * 与并发上界、子代理模型不同，它**没有三态**：修订记的永远是这一次修订的脚本来自哪个文件
   * （`path` 提交就是那个文件，内联提交就是刚写下的草稿），绝不沿用前驱的——前驱的路径指向
   * 的是**旧脚本**，把它记到新 run 上就是让模型下次去编辑一个已经不在跑的文件。
   */
  scriptPath?: string;
  /**
   * **新脚本**的「同时在跑」表；语义同 {@link DynamicWorkflowRunSubmitRequest.phaseAlongside}
   * （下标落在本请求的 `phaseNames` 上，不是前驱的那张表）。
   */
  phaseAlongside?: number[][];
  /**
   * 新 run 沿用前驱落库的实参（`dwf_run.args_json`）。缺席即修订不带实参（工具路径的契约不变）。
   * 只有 GUI 的「配置」传它：它重跑的是前驱自己的脚本，脚本读的正是前驱启动时的那份实参；不沿用的话，一个带实参
   * 从中枢启动的已保存工作流会以空 `args` 重跑。
   */
  inheritArgs?: true;
  trace: TraceContext;
}

/**
 * amend 被拒的结构化理由。两者对模型是**两个不同的下一步**（换一个 run id / 放弃修订走一次
 * 全新 run），所以必须可分辨。可操作文案在工具层，端口只承载判别键。
 *
 * 没有「前驱仍在飞」这一条：在飞的前驱被停下而不是被拒（旧版的 `not_amendable` 与随之而来的
 * 「停止后轮询到 stopped 再重提交」竞态由此消失）。
 *
 * **拒绝即零副作用**：预检在停止前驱**之前**跑完，被拒时没有 dwf_run 行、没有注册表条目、
 * 前驱照旧在跑。
 */
export type DynamicWorkflowRunAmendRefusalReason =
  /** journal 里没有这个前驱 run。 */
  | "run_not_found"
  /** 前驱有已完结却缺消息边界记账的 ask，导入的转录截断无从谈起（整体拒绝，无降级回退）。 */
  | "missing_boundaries";

export type DynamicWorkflowRunAmendResult =
  | {
      ok: true;
      runId: string;
      /** 前驱在飞、被本次修订停下时在场（= predecessorRunId）；前驱早已结算则缺席。 */
      supersededRunId?: string;
    }
  | { ok: false; reason: DynamicWorkflowRunAmendRefusalReason };

/**
 * 取消的发起方。`user` / `model` 是两条停止入口的 initiator；`{ superseded }` 是 amend 路径
 * 停下在飞前驱时传的：新 run 的 id 随原因一起落进前驱的结算袋（`supersededBy`）。
 */
export type DynamicWorkflowRunCancelInitiator = "user" | "model" | { superseded: string };

export interface DynamicWorkflowRunWaitOptions {
  signal?: AbortSignal;
}

/** {@link DynamicWorkflowRunPort.resume} 的结构化失败原因。 */
export type DynamicWorkflowRunResumeErrorReason =
  /** journal 里没有这个 run。 */
  | "not_found"
  /** run 不在可恢复集里（completed 或 errored；只有 stopped 可恢复）。 */
  | "not_resumable"
  /** run 被一次 AmendWorkflow 停下并替代：活的是后继，重放它等于把同一件事做两遍。 */
  | "superseded"
  /** 同 runId 的 run 正在本进程内飞行。 */
  | "already_running"
  /** 记录缺 scriptText（落库该字段之前的老 run），没有可重跑的脚本。 */
  | "script_missing"
  /** 记录的 scriptHash 与按 scriptText 重算的不一致（记录自身被外力改写过）。 */
  | "script_mismatch"
  /**
   * 记录的 scriptText 在**当前** facade 下不再通过类型检查（facade 重构后的老 run）。逐字重放
   * 只会失败；出路是按当前 facade 改写脚本后走 AmendWorkflow。`message` 携带有界诊断。
   */
  | "compile_failed";

/**
 * resume 的结构化结果。失败走 reason 而不是 throw：五种原因全是调用方可预期的业务分支
 * （错误码而非错误文本做流程判断，house rule），throw 只留给真正的接线故障。
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };
