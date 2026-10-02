import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "../dynamic-workflow-run-roster.port.js";
import type { ModelSelection } from "../../model/model.js";
import type { WorkflowTaskSnapshot } from "../workflow.port.js";
import type {
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunStopReason,
  DynamicWorkflowRunError,
  DynamicWorkflowRunSummary,
  DynamicWorkflowRunUsage,
  DynamicWorkflowRunActor,
  DynamicWorkflowRunLogEntry,
} from "./observation.js";
import type { DynamicWorkflowActorModelOverride } from "./commands.js";
import type { DynamicWorkflowRunPendingQuestion } from "./questions.js";
import type { DynamicWorkflowRunArtifact } from "./artifacts.js";

/**
 * run 快照：沿用 {@link WorkflowTaskSnapshot} 的形状（后台任务追踪器与通知管线按它读），
 * 只把 `output` 放宽——workflow run 的产物是脚本的顶层返回值，形状由脚本决定，不是 legacy
 * `Workflow` 工具的输出类型。legacy 端口本身不加宽（两套 workflow 机制不共用端口）。
 *
 * `reports` 是脚本 `report(item)` 交出的渐进产物**原值**，按报告顺序，来自 journal 的
 * `kind = "report"` 节点行——那是这些条目的持久家（`workflowRuns.reports` 只是有界的
 * memory-only 展示面）。完成通知据此在 completed / failed / cancelled 三态下一律回投：
 * 一个死在第 12 个 ask 上的 run 仍然做完了 11 个 ask 的活，捞回它正是 `report` 存在的理由。
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * run 的真实终态词。基类的 `status` 是后台任务
   * 追踪器的通用词汇（`stopped` 折成 `cancelled`、`errored` 折成 `failed`），通知与工具文案
   * 要说真话必须读这两个字段；`stopReason` 只在 `runStatus === "stopped"` 时在场。
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
  /** 发起这个 run 的会话（journal 的 parent_session_id；注册表条目在场时取它的）。 */
  parentSessionId?: string;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /**
   * 本 run 自己的并发上界（`dwf_run.caps_max_concurrency`），**只在低于当前天花板时在场**：
   * 跑在天花板上的 run 没有可说的（「无则缺席」，与 `reports` 同规）。`AmendWorkflow` 的
   * `resolveInput` 据它决定省略 `max_concurrency` 时沿用什么。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型（journal 事件 `run-launched` 上的那一个），规范形
   * `providerId/modelId[$reasoningLevel]`，**只在设过时在场**：继承会话模型的 run 没有可说的
   * （「无则缺席」，与 `maxConcurrency` 同规）。
   * 这里是字符串而不是 {@link ModelSelection}：读面只用来显示与原样回填，没有人按字段取值。
   */
  subagentModel?: string;
  /** 启动时冻结的完整选择，含会话继承的思考档和速度。 */
  subagentSelection?: ModelSelection;
  /** 发起会话的冻结选择；显式覆盖也不抹掉此值。 */
  sessionSelection?: ModelSelection;
  /** 启动时批准的 actor 级模型覆盖；普通修订与 GUI 设置修订默认原样继承。 */
  actorModelOverrides?: DynamicWorkflowActorModelOverride[];
  /**
   * 本 run 的脚本文件（绝对路径，journal 事件 `run-launched` 上的那一个）。**只在这个 run 记下过文件时在场**。
   *
   * 终态通知据它把「改好脚本再内联提交」换成「就地编辑那个文件、再 `path` 修订」，所以它必须
   * 能从快照读到；用户面一概不显示（与 `subagentModel` 不同，后者会进桌面的 run 面板）。
   */
  scriptPath?: string;
  /** 结构化失败（与 {@link DynamicWorkflowRunDetail.error} 同源）；基类的 `error` 是它的 message。 */
  failure?: DynamicWorkflowRunError;
  reports?: readonly unknown[];
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * **从内存注册表投影，不是 journal 重放**：journal 里有 `escalation-raised` 与
   * `escalation-resolved` 两类事件，但「现在还欠谁一个答案」是进程内的活事实——重放出来的
   * 未配对 raised 在进程亡故后只会说谎（停驻的 deferred 早已随进程消失，resume 会让 actor
   * 重新提问、得新 qid）。
   *
   * 这是通知被丢弃（stale branch generation / shutdown drop）之后的**查询兜底**：主代理任何
   * 时候都能经既有观察面重新发现待答问题。零条时整字段缺席（不发空数组）。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 本 run 发布的**用户面产物**，按首次出现顺序，来自
   * journal 的 `kind = "artifact"` 行——那是版本历史的持久家（`workflowRuns.artifacts` 只带
   * 最新版元数据）。与 `reports` 同规：**只在终态**读（`getTask` 被反复轮询，而产物行的
   * 消费者是终态通知与 GetWorkflowRun）；零件时整字段缺席。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与本类型的 `output`
   * （脚本顶层返回值，引擎内部叫 `RunSettlement.artifact`）无关。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};

/** 单 run 详情：共同截面 + 进度 + 情势截面 + 按终态分叉的产物 / 失败。 */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  /**
   * 本 run 自己的并发上界，语义同 {@link DynamicWorkflowRunSnapshot.maxConcurrency}：只在低于当前
   * 天花板时在场。刻意不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个很少设置的字段加宽。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型，语义同 {@link DynamicWorkflowRunSnapshot.subagentModel}：只在设过时
   * 在场。与 `maxConcurrency` 同理不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个
   * 很少设置的字段加宽。
   */
  subagentModel?: string;
  /**
   * 本 run 的脚本文件，语义同 {@link DynamicWorkflowRunSnapshot.scriptPath}：只在记下过文件时
   * 在场。`GetWorkflowRun` 据它在 `<amendable>` 里把下一步说成「就地编辑这个文件」。
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
  /** `log()` 事件的尾巴，按时序（sequence 升序）。无 log 事件即空数组。 */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * 阶段表：声明序的已声明阶段，后面接上「进过但没声明」的那些
   *
   * **脚本没声明阶段、也一个都没进过时整字段缺席**——那样的 run 没有阶段这回事，
   * 发一个空数组读起来像「阶段表是空的」，是另一句话。
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * 子代理花名册，按 actor 行的顺序（= 铸造顺序）。**恒在场**，一个 actor 都没有的 run 是空
   * 数组：与 `phases` 不同，「这个 run 有几个子代理」永远是个有答案的问题，而 0 就是那个答案。
   *
   * 与并列的 `actors` 刻意不合并：`actors` 是一张恒定的身份表（siteId / ordinal / name），
   * 消费者已经按它 join；这里的每一项都是**读时快照**，同一个 run 隔一秒读就不一样。
   */
  subagents: DynamicWorkflowRunSubagentView[];
  /** run 整体还在不在动（见 {@link DynamicWorkflowRunHealth}）。恒在场。 */
  health: DynamicWorkflowRunHealth;
  /**
   * 脚本的顶层返回值，**原值**（未序列化）。只有 completed 的 run 才在场；`undefined` 产物
   * 即整字段缺席。
   *
   * 为什么不在这里序列化：面向模型的文本投影已经有唯一实现（core 的
   * `serializeWorkflowArtifact`，完成通知与 TaskOutput 共用它）。端口再做一次，就会出现
   * 「同一个 run 的产物在通知里和在本工具里长得不一样」——正是那份共用要排除的损失类别。
   * 所以序列化留在 core，端口只负责把原值送到边界。
   */
  result?: unknown;
  /** errored 恒在场；stopped 只对 provider / interrupted 在场。code 原样透出，不折叠。 */
  error?: DynamicWorkflowRunError;
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * 与 {@link DynamicWorkflowRunSnapshot.pendingQuestions} **同源同投影**（都读进程内的升级
   * 停驻表，都在零条时整字段缺席），只是换了一条读面：快照服务后台任务追踪器，本字段服务
   * `GetWorkflowRun`——而后者是**模型侧唯一的发现面**。这条链路不是可选的锦上添花：升级通知
   * 有两条已知的丢弃路径（stale branch generation / shutdown），查询是这两条路径的兜底，`resolveQuestion` 的 `unknown_question` 文案也明确让模型来这里找 qid。
   * 缺了它，那两处承诺都会指向一个什么都不返回的工具。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 本 run 的用户面产物（任意状态都附；journal-backed，与 {@link DynamicWorkflowRunSnapshot.artifacts}
   * 同源）。`GetWorkflowRun` 据此告诉模型「这些已经以卡片呈现给用户了，按标题引用即可」。
   * 零件时整字段缺席。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/**
 * {@link DynamicWorkflowRunPort.listRunsForSession} 的 run 摘要。字面与 journal 的
 * `dwf_run.status` 同集，但**刻意在这里重新声明**：端口只承载 JSON 形状，引擎词汇表一旦
 * 进 contracts，每个持有端口的层都会编译期依赖引擎内部类型。
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
  /** 发起 run 的 CreateWorkflow 工具调用 id（工具卡 → 详情页/Resume 的关联键）；老 run 缺席。 */
  toolCallId?: string;
  /**
   * 展示标签，服务端读时派生（`name` → 脚本首行 → runId，见 bootstrap 的
   * `resolveDynamicWorkflowRunLabel`）。可选是为了**偏斜安全**：老服务端不发这个键，
   * 读侧回落到 runId 即可——列表少一个标签是退化，不是错误。
   *
   * 与 `resumable` 同理由集中在服务端：两处各拼一次兜底，同一个 run 在
   * `/dwf list` 与工具卡上会显示不同的名字。
   */
  label?: string;
  /**
   * 最后更新时间（epoch 毫秒，来自 journal 的 `dwf_run.time_updated`）。可选同上：
   * 老服务端缺席，读侧不显示时间列。列表排序仍由存储层负责（最近更新在前），
   * 这个字段只供展示——读侧不要拿它重排，否则与服务端的 tie-break 漂移。
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /** errored / stopped(provider|interrupted) 的结构化失败编码（`ProviderStop` / `Interrupted` …）。 */
  failureCode?: string;
  failureMessage?: string;
  /**
   * 是否可恢复。**服务端按 resume 门的同一个谓词算好**：UI 若自行按 status+failureCode
   * 重新推导，两处谓词总有一天不一致——按钮亮着但命令被拒。
   */
  resumable: boolean;
}
