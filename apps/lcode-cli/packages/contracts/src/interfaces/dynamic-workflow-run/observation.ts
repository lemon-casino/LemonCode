// ————————————————————————————————————————————————————————————————
// run 内省（ListWorkflowRuns / GetWorkflowRun 的取数面）
// ————————————————————————————————————————————————————————————————

/**
 * run 的生命周期状态。字面与 journal 的 `dwf_run.status` 同集，但**刻意在这里重新声明**
 * 而不是从 @lcode/dynamic-workflow import：端口只承载 JSON 形状，引擎的词汇表一旦进
 * contracts，每个持有端口的层都会编译期依赖引擎内部类型（与 {@link DynamicWorkflowRunEvent}
 * 的 `type` 同一条论证）。
 *
 * 与 {@link DynamicWorkflowRunSnapshot} 的 status 刻意不同：后者是后台任务追踪器的词汇表，
 * 把 `pending` 折进 `running`。内省面必须保留 `pending`——「已提交、引擎还没建行」是一个
 * 模型能看懂且有意义的区别。
 */
export type DynamicWorkflowRunLifecycleStatus =
  | "completed"
  | "errored"
  | "pending"
  | "running"
  | "stopped";

/**
 * `stopped` 的原因：`user` 用户取消 / `model` 主代理
 * TaskStop / `provider` 确定性模型侧错误 / `interrupted` 持有进程亡故或沙箱故障 / `superseded`
 * 被一次 AmendWorkflow 停下并替代。前四者可 resume，`superseded` 不可（活的是它的后继）；
 * `errored`（脚本之错）不可。字面与引擎 `RunStopReason` 同集，刻意在这里重新声明。
 */
export type DynamicWorkflowRunStopReason =
  | "user"
  | "model"
  | "provider"
  | "interrupted"
  | "superseded";

/** {@link DynamicWorkflowRunPort.listRuns} 的查询袋。 */
export interface DynamicWorkflowRunListQuery {
  /**
   * 项目键，**必填**。字面等值匹配 `dwf_run.cwd`（写入侧原样落、读侧原样查）。
   * 端口不替调用方猜一个默认 cwd：工具面恒查 `context.workingDirectory`，模型无权跨项目扫库。
   */
  cwd: string;
  /** 返回条数上限，**必填**。钳制策略属于工具面（[1, 50]）；端口不做无界枚举。 */
  limit: number;
  /** 可选状态子集。缺省即不过滤；空数组即「不匹配任何状态」（回空列表）。 */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * 列表与详情**共同的截面**。标签、归属标注与时间戳三者在两条读面上必须逐字段同源——
 * 同一个 run 在列表里和详情里显示不同的名字或归属，是最难被测试抓住、又最直接损害信任的
 * 那类不一致。所以这里是一个共享的基接口，而不是两份各自演化的字段表。
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * 展示标签。**已烹熟**：实现侧（run service）按 name → 脚本首行 → runId 的顺序派生好，
   * 消费方直接展示。之所以不把原料（name / scriptText）交出去让工具层自己拼：那条兜底链
   * 是读时启发式，两个工具各拼一次就会漂移，而 scriptText 是端口上最大的一个字符串
   * （列表面根本不该为了取首行把 50 份脚本搬过边界）。
   */
  label: string;
  /** 标签来源：`"name"` = 用户起的名字；`"script"` = 读时从脚本派生（含 runId 兜底）。 */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run（`dwf_run.resumed_from`）；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代（`stopped(superseded)` 的结算袋）；未被替代则缺席。 */
  supersededBy?: string;
  /** 本会话是否是这个 run 的发起方（journal 的 parent_session_id 命中，或在本会话注册表里）。 */
  ownedByThisSession: boolean;
  /**
   * 「本会话无法证实它还活着」：journal 非终态 ∧ 非本会话 ∧ 不在本会话注册表。可能是死进程
   * 的遗物，也可能是同进程兄弟会话正在飞的 run——所以这是**标注而非状态改写**，读面绝不
   * 替别人收尸（孤儿收敛的执行权只属于 owning 会话的构造时刻）。为真时才在场。
   */
  possiblyInterrupted?: boolean;
  /** journal 的 `time_created` / `time_updated`（epoch ms）。 */
  createdAt: number;
  updatedAt: number;
}

/** 列表的一项：共同截面 + 用量。刻意轻——无 actors、无节点计数、无产物预览。 */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
  /** 直读 `dwf_run.spent_tokens`（run 级 token 用量的唯一权威）。 */
  spentTokens: number;
}

/**
 * `listRuns` 的返回。刻意是一个对象而不是裸数组：页级字段（如 {@link truncated}）是纯追加
 * 改动，而裸数组只能整体换形状。
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
   * 这个项目还有更多 run 没进这一页。**为真时才在场**。
   *
   * 判据是「多取一条」（实现侧按 `limit + 1` 查询后回落），不是 `length === limit`：后者在
   * 条数正好等于 limit 时误报，而误报会让模型去追一页不存在的历史。同一个惯例在 v4 网关的
   * 事件分页上（`hasMore`）已经用过一次。
   */
  truncated?: boolean;
}

/**
 * run 的进度与用量（观察面，没有任何上限）。`nodesObserved`
 * 是**已落库节点的行数**（三态之和），绝不冒充「总步数」：动态工作流没有静态总数，而
 * `queued` 只存在于事件相位、不落库。
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** 一个 actor 站点实例。`persona` 刻意不出：整段 system prompt 是端口上天然无界的字段。 */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** 一条 `log()` 叙事。 */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
  /** 已按端口的字符串上限（{@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}）有界化。 */
  message: string;
  /**
   * 这条事件落 journal 的时刻（`dwf_event.time_created`）。序号定位，时刻回答「多久以前」——
   * 情势截面的三组字段都按这一把尺算年龄，叙事尾巴没有理由用另一把。**没有这一列的老
   * journal 上缺席**，读侧据此不给年龄，绝不用读时的 `Date.now()` 兜底。
   */
  at?: number;
}

/** 结构化失败。`code` 是稳定判别键——模型必须能分辨「进程死了」与「脚本真失败」。 */
export interface DynamicWorkflowRunError {
  code: string;
  message: string;
  /** 只在 `code === "ProviderStop"` 时在场（引擎 `ProviderStopDetails` 的 JSON 镜像）。 */
  providerStop?: DynamicWorkflowRunProviderStop;
}

/** `ProviderStop` 的结构化明细（引擎 `ProviderStopDetails` 的镜像，端口只承载 JSON 形状）。 */
export interface DynamicWorkflowRunProviderStop {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  subagent?: string;
  subagentName?: string;
  phase?: string;
  rawMessage?: string;
  resetAt?: number;
}
