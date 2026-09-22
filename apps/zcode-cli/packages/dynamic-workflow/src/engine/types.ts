/**
 * 执行引擎的边界类型（boundary types）。
 *
 * 这个模块是纯类型 + 结构化错误 + 常量的词汇表，三条边界都以它为契约：
 * - Boundary A（host API）：沙箱脚本的 facade shim 调用 {@link WorkflowHostApi}。
 * - Boundary B（driver port）：引擎核心（确定性状态机）向下驱动 {@link WorkflowDriver}，
 *   driver 通过 {@link WorkflowReportSink} 向上回报进度。
 * - Journal：{@link JournalStorePort} 以仓储式方法暴露 run/actor/node/event 记录，
 *   内存实现与未来 SQLite 实现都能自然落位（同步方法契合 node:sqlite 的 DatabaseSync，且让核心保持确定性）。
 */

import type { WorkflowAskRevision } from "./workflow-ask-revision.js";
import type { WorkflowImageRef } from "./workflow-image-ref.js";
export type { WorkflowAskRevision } from "./workflow-ask-revision.js";
export type { WorkflowImageRef } from "./workflow-image-ref.js";

import type {
  ArtifactContentOp,
  ArtifactOp,
  ArtifactPresetOp,
  WorldReadOp,
} from "../facade/registry.js";
import type { AskProgress, AskStats } from "./ask-observation-types.js";
import type { JournalStorePort } from "./journal-types.js";

// ————————————————————————————————————————————————————————————————
// 身份（identity）
// ————————————————————————————————————————————————————————————————

/**
 * 一个 ask 实例的身份：站点 id × 每站点执行序号（ordinal）。
 * 第 n 次 `ask("ask#3", …)` 调用即实例 `ask#3@n`（ordinal 从 1 开始）。
 */
export interface InstanceRef {
  siteId: string;
  ordinal: number;
  /** 一次 ask 的尝试代次；缺席表示首次派发。journal 节点身份不含它。 */
  attempt?: number;
}

/** actor 身份：创建站点 × 序号（与 InstanceRef 同构，但语义是 actor 而非 ask）。 */
export interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * 交给脚本的不透明 actor 句柄。脚本侧的 `Agent` 只是持有它的薄包装。
 * 引擎内部把 ActorId 映射回 {@link ActorRef}；格式对脚本不可见，但需稳定可解析。
 */
export type ActorId = string;

/** 把 InstanceRef / ActorRef 渲染为稳定字符串 `site@ordinal`，用于日志与句柄。 */
export function refToString(ref: InstanceRef | ActorRef): string {
  return `${ref.siteId}@${ref.ordinal}`;
}

// ————————————————————————————————————————————————————————————————
// persona / ask 消息
// ————————————————————————————————————————————————————————————————

/**
 * 冻结的 actor persona，交给 {@link WorkflowDriver.createActorSession}。
 *
 * persona 只剩身份（名字 + system prompt）。模型档位（`model?: "main" | "lite"`）
 * 与工具档位（`tools?: "default" | "readonly" | "none"`）都已退场：宿主没有 lite 模型来源，而
 * 工具档位买到的只有「裁判不能改文件」——普通子代理也不靠档位保证这一点，ask 文本说清即可。
 * 子代理一律跑在父会话当前模型上、拿完整工作工具集减去会悬挂/越权的交互工具。
 * 是否注册 submit_result 由 driver 结合站点图判定（全 untyped 的 actor 不注册），
 * 不在这里表达——保持 persona 只描述身份。
 */
export interface WorkflowModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
    speed?: string;
  };
}

export interface WorkflowActorModelOverride {
  /** Static agent() call site. */
  siteId?: string;
  /** Runtime actor identity; useful when the call site is shared by dynamic branches. */
  name?: string;
  /** Concrete fan-out instance. Omit to target every instance matched by site/name. */
  ordinal?: number;
  selection: WorkflowModelSelection;
}

export interface PersonaSpec {
  name?: string;
  system?: string;
  /** Script-authored default; an approved run override takes precedence. */
  model?: WorkflowModelSelection;
}

/**
 * 单次 ask 的下发消息：指令正文 + 是否 typed + typed 时的 schema（结构对核心不透明，
 * 仅透传给 {@link ValidateFn} 与 driver 的 schema 尾注）。schema 由 schema 合成侧产出，
 * 核心从不解读其形状。
 */
export interface AskMessage {
  instructions: string;
  attachments?: WorkflowImageRef[];
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// 校验（validation）
// ————————————————————————————————————————————————————————————————

/**
 * 单条校验违规，设计为在 repair 的 tool_result 里对模型可读：JSON 路径 + 期望 + 实得。
 * 与 schema 子模块共用同一类型（并行开发期各自声明，落地后统一到 schema/types）。
 */
export type { Violation } from "../schema/types.js";
import type { Violation } from "../schema/types.js";

/**
 * 注入的校验函数：`(schema, value) => 违规列表`（空列表即通过）。真正的校验器由另一
 * 个 agent 并行实现（src/schema/），核心只依赖这个最小契约，绝不 import 其实现。
 */
export type ValidateFn = (schema: unknown, value: unknown) => Violation[];

/** 每个 ask 站点的静态规格：是否 typed 及其 schema。untyped 站点无 schema。 */
export interface AskSpec {
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// 统计 / 预算
// ————————————————————————————————————————————————————————————————

/** 导入缓存关门的两种原因：子代理的改写工具、live 的 `world.run`。 */
export type ImportCloseCause = "mutating-tool" | "world-run";

/**
 * run 级别的容量上限，submit 时固定并存入 dwf_run；当前只有并发上界，
 * 取消是唯一的控制面。
 */
export interface Caps {
  maxConcurrency: number;
}

// 终态相关的结构化明细（ProviderStop 明细、run 级停滞观察）住在 run-terminal.ts，从这里
// 原样再导出：本文件已抵 400 行门，而它们的消费者按惯例仍从 types 取。
import type { ProviderStopDetails, RunStallInfo } from "./run-terminal.js";

export type { ProviderStopDetails, RunStallInfo };

// ————————————————————————————————————————————————————————————————
// 结构化错误（errors are first-class）
// ————————————————————————————————————————————————————————————————

/**
 * 稳定错误码。区分 node 级（拒绝单个 ask 的 promise）与 run 级（使整个 run 失败）：
 * - node 级：ValidationFailed / ResultNotSubmitted / DriverError / Cancelled / ContextLimit /
 *   WorldReadCapExceeded——一次世界读取超过它那个 op 的上限（`files.grep`：2000 条命中或
 *   256KB 序列化，先到先拒；`git.diff`：512KB；见 `facade/world-read-caps.ts`）。它是 node 级
 *   而不是 run 级，靠的是**拒绝通道**而不是严重程度：世界读取返回一个脚本能 `catch` 的
 *   promise，所以"缩窄 pattern 或加个 glob"是一条脚本真能走的路。也刻意**不**折进
 *   DriverError——上限是脚本可以据以重写自己的契约，而靠匹配 message 文本区分两者，
 *   正是这个联合类型存在的目的所要防的。
 * - run 级：InputHashMismatch / UnknownActor / MissingAskSpec /
 *   DuplicateActorName——同一个 run 内两次 createActor 得到相同的**非空**有效名
 *   （有效名 = normalizePersona 后的 `spec.name`，persona.name 压过 name 实参）。规则对
 *   **所有** run 生效而不只是修订 run：具名 actor 是 amend-resume 缓存导入的身份键，而任何
 *   run 都是未来修订的潜在前驱，前驱里重名会让导入匹配歧义。匿名（名缺席或空串）不查、不禁——代价是没有缓存资格。
 *   字面量重名另有编译期 courtesy 诊断（analysis/actor-names.ts），但动态名只有运行期能查，
 *   所以这条才是真正的门。
 *   ReportCapExceeded——一个 run 超过 256 条报告，或单条 item 序列化超过 32KB
 *   （见 `facade/report-caps.ts`）。它是 run 级而不是 node 级，与上面 WorldReadCapExceeded 的
 *   分界同理、结论相反：`report` 返回 `void`，脚本**没有**可以 catch 的通道，除了 run 无处可放。
 *   也正因如此这两个数字必须宽到讲道理的脚本永远碰不到——脚本作者写不出恢复路径。
 *   同样刻意不折进 DriverError：上限是脚本可据以重写自己的契约。
 * - 构造期（run 尚未开始，引擎构造函数同步抛出）：ScriptHashMismatch
 * - 宿主级（**引擎从不产出**）：Interrupted——拥有该 run 的进程在结算之前就没了，由宿主在
 *   下一次构造时收敛那行永远停在 running 的记录。它必须是**独立的码**而不是复用 DriverError：脚本
 *   自己抛错也编码成 DriverError（`dynamic-workflow-runtime/src/harness.ts`），两者若同码，
 *   「进程被杀」与「脚本真失败」就只能靠 message 文本区分——而这正是本联合类型要避免的。
 *   ProviderStop——一个子代理（或工具侧）的模型请求撞上**确定性的**模型侧错误（认证失效、
 *   模型不在套餐里、配额耗尽……），driver 让
 *   run 以 `stopped(provider)` 停下而不是让节点失败；结构化明细在 `providerStop`。它是宿主级
 *   的另一条：引擎只在 `stop("provider", error)` 里原样落库。
 * 流程判断一律用这里的码，绝不匹配错误文本。
 */
export type WorkflowErrorCode =
  | "ValidationFailed"
  | "ResultNotSubmitted"
  | "DriverError"
  | "WorldReadCapExceeded"
  | "Cancelled"
  | "ContextLimit"
  | "ReportCapExceeded"
  | "InputHashMismatch"
  | "UnknownActor"
  | "MissingAskSpec"
  | "DuplicateActorName"
  | "ScriptHashMismatch"
  | "Interrupted"
  | "ProviderStop"
  // ——————————— 用户面产物 ———————————
  // ⚠ 术语：这一批 artifact 全是**用户面产物**（脚本发布给用户看的产出），与
  // `RunSettlement.artifact`（顶层返回值）无关。
  //
  // 通道按**成员族**分裂，与 WorldReadCapExceeded / ReportCapExceeded 的分界同一条论证：
  // 内容成员（`file`/`markdown`）返回 promise，脚本可 catch，所以是节点级拒绝；预置成员
  // 返回 void，没有可拒绝进去的地方，所以同样的事实在那一族是 failRun。三个 driver 侧的
  // 码（Missing/Outside/TooLarge/StoreUnavailable）只可能来自内容成员，故恒为节点级。
  | "ArtifactSourceMissing"
  | "ArtifactPathOutsideWorkspace"
  | "ArtifactTooLarge"
  | "ArtifactStoreUnavailable"
  | "ArtifactVersionCapExceeded"
  | "ArtifactKindMismatch"
  | "ArtifactCapExceeded"
  | "ArtifactSpecInvalid"
  | "ArtifactRedeclared"
  | "ArtifactUndeclared"
  // 第二个 id 想当 primary：内容成员是节点级拒绝，
  // 预置成员是 failRun——与上面几条同一条分界。
  | "ArtifactPrimaryConflict";

/**
 * 值不匹配的结构化比对（哪一侧变了）。记录里的值是 `expected`，本次传入的是 `got`。
 * 排查 resume 被拒的人需要的是这两个值，而不是从 message 里正则抠——流程判断与展示
 * 都不该依赖错误文本。
 */
export interface WorkflowErrorMismatch {
  expected: string;
  got: string;
}

/** 错误的可序列化形态，落 journal（dwf_node.error_json / dwf_run.failure_json）。 */
export interface WorkflowErrorJson {
  code: WorkflowErrorCode;
  message: string;
  violations?: Violation[];
  finalText?: string;
  mismatch?: WorkflowErrorMismatch;
  /** 只在 `code === "ProviderStop"` 时在场。 */
  providerStop?: ProviderStopDetails;
}

/**
 * 跨 Boundary A 抛出的结构化错误。带稳定 code 与可选的 violations / finalText / mismatch，
 * 使脚本侧 try/catch 与上层都能按结构处理，而不依赖字符串匹配。
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly violations?: Violation[];
  readonly finalText?: string;
  readonly mismatch?: WorkflowErrorMismatch;
  readonly providerStop?: ProviderStopDetails;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    extra?: {
      violations?: Violation[];
      finalText?: string;
      mismatch?: WorkflowErrorMismatch;
      providerStop?: ProviderStopDetails;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    if (extra?.violations !== undefined) this.violations = extra.violations;
    if (extra?.finalText !== undefined) this.finalText = extra.finalText;
    if (extra?.mismatch !== undefined) this.mismatch = extra.mismatch;
    if (extra?.providerStop !== undefined) this.providerStop = extra.providerStop;
    if (extra?.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
  }

  /** 转为可序列化形态落 journal。 */
  toJSON(): WorkflowErrorJson {
    const json: WorkflowErrorJson = { code: this.code, message: this.message };
    if (this.violations !== undefined) json.violations = this.violations;
    if (this.finalText !== undefined) json.finalText = this.finalText;
    if (this.mismatch !== undefined) json.mismatch = this.mismatch;
    if (this.providerStop !== undefined) json.providerStop = this.providerStop;
    return json;
  }

  /** 从 journal 记录重建（replay 命中失败节点时用）。 */
  static fromJSON(json: WorkflowErrorJson): WorkflowError {
    return new WorkflowError(json.code, json.message, {
      violations: json.violations,
      finalText: json.finalText,
      mismatch: json.mismatch,
      providerStop: json.providerStop,
    });
  }
}

// ————————————————————————————————————————————————————————————————
// Boundary A：host API（沙箱脚本调用）
// ————————————————————————————————————————————————————————————————

/**
 * 世界读取操作（只读、可 journal）。词汇表由 world-read 注册表推导——加一个原语就是给
 * `facade/registry.ts` 加一行，这里不必改（见该模块顶部的容器键说明）。
 */
export type { WorldReadOp };

/**
 * 用户面产物的 op（词汇表由产物注册表推导，见 `facade/registry.ts`）。
 * `ArtifactContentOp` 走 {@link WorkflowHostApi.publishArtifact}（效应，经 driver），
 * `ArtifactPresetOp` 走 {@link WorkflowHostApi.declareArtifact}（声明，不经 driver）。
 */
export type { ArtifactContentOp, ArtifactOp, ArtifactPresetOp };

/**
 * 交给脚本的产物引用（facade 的 `ArtifactRef`）：id + 本次发布铸出的版本号。
 * 内容成员的 promise 以它兑现。
 */
export interface ArtifactRef {
  id: string;
  version: number;
}

/**
 * 一个产物版本的落库形态（`dwf_node.result_json` 的形状；shared 侧有 zod 镜像）。
 *
 * 内容成员与预置成员共用一个形状，各自只填自己那一半：内容有 `bytes`/`uri`/`sourcePath`，
 * 预置有 `spec`。字节**绝不**进 journal——`uri` 指向 tool-artifact store，那才是字节的家。
 */
export interface ArtifactVersionRecord {
  id: string;
  kind: ArtifactOp;
  /** 从 1 起。预置声明恒为 1（声明没有版本，它只有一次）。 */
  version: number;
  title?: string;
  description?: string;
  /** 内容成员的 MIME 类型（扩展名表或 `opts.contentType`）。 */
  contentType?: string;
  /** 内容成员的字节数。 */
  bytes?: number;
  /** store 返回的 `zcode-artifact://…`（内容成员）。 */
  uri?: string;
  /** 工作区相对的原路径（`file` 才有，作出处与「在工作区显示」）。 */
  sourcePath?: string;
  /** 预置成员的 spec（规范化后的形状；引擎按 canonicalJson 比对重复声明）。 */
  spec?: unknown;
  /** 发布时刻（epoch 毫秒）。driver / 宿主写入——引擎没有时钟。 */
  publishedAt?: number;
  /**
   * 这个 id 是本 run 的交付物。**引擎**盖章，
   * 不是 driver：按 id 粘着——一旦某版带上，之后的版本都带上，不管发布时有没有再写 `primary`。
   */
  primary?: true;
}

/**
 * driver 执行一次内容产物发布的请求（Boundary B）。
 *
 * `version` 由**引擎**在 dispatch 之前算好（journal 里该 id 已 completed 的行数 + 1）并传下来，
 * 而不是让 driver 自己数：driver 不该知道 journal 的形状，而 store 的 `toolCallId` 里要带上它
 * （每一版一份字节）。`path` / `content` 二选一，按 `op` 定；实参校验归 driver。
 */
export interface ArtifactPublishRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  op: ArtifactContentOp;
  id: string;
  version: number;
  /** `file`：工作区相对路径。 */
  path?: string;
  /** `markdown`：正文。 */
  content?: string;
  /** 脚本给的 `opts`（原样透传，形状校验归 driver）。 */
  opts?: unknown;
}

/**
 * host API：lowered 脚本的 facade shim 跨沙箱边界调用的表面。全部可序列化、异步。
 * `createActor` 同步返回不透明句柄；session 的创建在首次 live dispatch 时惰性完成。
 *
 * `worldRead` 带的是**位置实参数组**，不是按 op 定制的 payload 对象：`files.grep(pattern, glob?)`
 * 与 `git.diff(base?, path?)` 是多参、`git.status()` 无参，单字符串签名撑不住；而 payload 对象
 * 会把「按 op 分支」搬进 lowering——那恰是新增原语最该零改动的一处。lowering 只做原样透传，
 * 每个 op 的元数与校验归 driver（它才是知道一个 base ref 长什么样的那一侧）。
 */
export interface WorkflowHostApi {
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId;
  ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown>;
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * 发布一条中间结果。**即发即忘（同步签名、无返回值）却有站点、要落 journal**——这个组合
   * 就是 report 的全部设计，两半都是被迫的：脚本发布一条发现，没有什么可以 await；而
   * run 面板与完成通知在 resume 之后不能把同一条发现显示两次，所以必须 journal。
   *
   * 无 driver 往返：引擎在核心里落节点、发事件（或在 replay 命中时静默跳过）即结束。
   */
  report(siteId: string, item: unknown, artifactId?: string): void;
  /**
   * 控制流经过了一个 `phase("…")` 标记。同步、无返回值、无 driver 往返、**不落 journal 行**：
   * 引擎只发一条 `phase-entered` 事件就结束。`name` 由 lowering 从字面量取出并去两端空白。
   */
  enterPhase(name: string): void;
  /**
   * 发布一个**内容产物**（`artifact.file` / `artifact.markdown`）。效应：经 driver 把字节拷进
   * store，落一行 journal，成功兑现 {@link ArtifactRef}、失败**可 catch 地拒绝**。
   *
   * 与 `worldRead` 同规：`args` 是脚本调用点的位置实参（`[id, path, opts]`），lowering 原样
   * 打包，本层只从中取引擎自己要用的 id（上限与版本号要它），其余透传给 driver。
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef>;
  /**
   * 声明一个**预置产物**（`artifact.chart` / `table` / `metrics` / `board`）。同步、无返回值、
   * **不经 driver**：一个声明没有可等的东西，引擎在核心里校验 spec、落节点、发事件就结束。
   *
   * 失败（spec 非法 / 同 id 异 spec / 超上限）一律 failRun——void 返回没有拒绝通道，与
   * `report` 同一条论证。
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void;
  log(message: string): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary B：driver port
// ————————————————————————————————————————————————————————————————

/** 一个 actor 会话的不透明引用（生产侧是 zcode session id）。 */
export interface SessionRef {
  readonly id: string;
}

/** 核心对一次 submit 尝试的裁决，经 respondToSubmit 下发给 driver。 */
export type SubmitVerdict =
  | { kind: "accept" }
  | { kind: "reject"; violations: Violation[] }
  | { kind: "nudge" };

/**
 * 向下端口：核心请求 driver 执行的副作用。核心是纯确定性状态机，副作用与进度回报都在 driver。
 * journal 与 emit 挂在 driver 上：核心通过 `driver.journal` 做
 * journal 决策、通过 `driver.emit` 做 Boundary C 扇出。
 */
export interface WorkflowDriver {
  /**
   * 铸一个 actor 会话。`seed` **仅当该 actor 消费了 ≥1 条导入 ask 条目时在场**
   * （amend-resume 的转录截断，见 {@link ActorSessionSeed}）：driver 必须在返回之前把源会话
   * 的前 `messageCount` 条消息复制进新铸的会话，且这一步要**幂等**——目标会话已有内容时跳过，
   * 那是崩溃后 resume 重挂同一个会话 id 的情形（会话 id 由 driver 按 (runId, actorRef) 纯确定地铸出）。
   *
   * 参数可选：既有 driver 实现少写一个形参在 TS 里合法，不带种子语义的 driver（fake、
   * 纯 replay 测试）可以直接忽略它。
   */
  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef>;
  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void;
  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void;
  cancelAsk(instance: InstanceRef): void;
  /**
   * 执行一次世界读取。`args` 是脚本调用点的**位置实参**，lowering 原样打包、不做任何检查；
   * 每个 op 的元数与实参校验归 driver（见 {@link WorkflowHostApi.worldRead}）。
   */
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * 发布一个内容产物的字节：校验实参形状、
   * 解析工作区相对路径（越界拒绝）、读字节（cap+1 探测，超限拒绝不截断）、按扩展名定
   * contentType、写 tool-artifact store，返回落库记录。
   *
   * **可选**：纯 replay / fake 装配没有 store 也没有文件系统。缺席时引擎以
   * `ArtifactStoreUnavailable` 拒绝该节点——大声的一条命名失败，不是静默降级（预置成员不
   * 受影响，它们本来就不过 driver）。
   */
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  journal: JournalStorePort;
  emit(event: RunEvent): void;
  /**
   * run 结算后的资源释放：引擎在三条终态路径（complete / cancel / fail）记下 `run-settled`
   * 之后恰好调一次。生产 driver 在这里对每个 actor runtime 跑 app 关会话的同一条关闭链
   * （runtime 的 `closeBrowserSession`：beginShutdown + node_repl 会话释放 + 浏览器会话关闭）
   * 并清空会话表；在飞 ask 此刻已被 cancelAsk 中止。可选：fake / 纯 replay 装配没有可释放
   * 的东西。
   */
  dispose?(): void;
}

/**
 * 一次在飞 ask 的模型请求正在**等**：
 * - `cause: "slot"`：下一个请求在进程级准入闸门前排队（driver 的 `tryAdmit` 未命中）；无其余字段。
 * - `cause: "backoff"`：runner 已排定重试（`model_retry_scheduled`），带 reason / attempt / delayMs / retryAfterMs。
 *   `reason` 是 contracts `ModelRetryReason` 的值（`rate_limited` / `provider_overloaded` / `server_error` /
 *   `network_error` / `timeout` / `stream_idle_timeout` / `stale_connection` / `offpeak_queued` …），
 *   纯包不 import contracts 故为开放字符串。`delayMs` 是相对量：引擎无时钟。
 */
export interface AskWaitInfo {
  cause: "slot" | "backoff";
  reason?: string;
  attempt?: number;
  delayMs?: number;
  retryAfterMs?: number;
}

/** 进程级并发 cap 变化的原因。 */
export type ConcurrencyChangeReason =
  | "rate_limited"
  | "provider_overloaded"
  | "offpeak_queued"
  | "recovered"
  | "idle_reset";

/**
 * 治理器对某 provider key 的 cap 调整，扇出给每个有该 key 在飞或等待 ask 的 run
 * （进程级事实按 run 落多份是可接受的冗余——journal 里能解释「这个 run 为什么慢了」）。
 */
export interface ConcurrencyChange {
  /** provider key（`${providerId}/${modelId}`）。 */
  key: string;
  previous: number;
  next: number;
  reason: ConcurrencyChangeReason;
  lastGood?: number;
  lastBad?: number;
  /** 带 Retry-After 的限流：新派发冻结的时长（相对量）。 */
  cooldownMs?: number;
}

/**
 * 向上表面：driver 把会话进度回报进核心。核心实现这个接口（生产侧 driver 持有其引用；
 * 阶段一测试里由测试直接扮演"模型"调用这些方法）。
 */
export interface WorkflowReportSink {
  /** 一次 submit 尝试；核心校验后经 respondToSubmit 回裁决。 */
  askSubmitAttempted(instance: InstanceRef, payload: unknown): void;
  /** 一轮 turn 结束且未提交：核心决定 nudge，或据 finalText 结算 untyped ask。 */
  askTurnEnded(instance: InstanceRef, finalText: string): void;
  /**
   * 一次 turn 解析时的进度观察：引擎只
   * `record()` 成 `node-progress`，不据它做任何决策。**必须先于同一次 turn 的 askStats 调用**
   * ——两条事件的先后是读面的契约。run 已结算后到达的调用被忽略。
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void;
  /** 用量统计：累计 run 用量并广播 usage/instance 更新。 */
  askStats(instance: InstanceRef, stats: AskStats): void;
  /** driver 侧不可恢复错误，结算该 ask 为失败。 */
  askFailed(instance: InstanceRef, error: WorkflowError): void;
  /**
   * 确定性的模型侧错误：**不**结算
   * 节点，而是让整个 run 以 `stopped(provider)` 停下（在飞 ask 一律 abort，与 cancel 同）。
   * `error.code` 必须是 `ProviderStop`。run 已结算后到达的调用被忽略。
   */
  stopRun(error: WorkflowError): void;
  /** run 级停滞观察：引擎只 `record()`。 */
  runStalled(info: RunStallInfo): void;
  /**
   * 三个纯观察：引擎只 `record()`，不做任何决策。
   * run 已结算 / 节点已结算后到达的调用被忽略。
   */
  /** 该 ask 的下一个模型请求在等：进程级准入闸门（slot）或 runner 退避（backoff）。 */
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void;
  /** 该 ask 的一个模型请求真正发出了（`model_request_started`，且进入前不在 executing）。 */
  askExecuting(instance: InstanceRef): void;
  /**
   * 该 ask 的子代理**即将**执行一个会改写工作区的工具：
   * 引擎据此关闭导入缓存。这是唯一一个引擎据以做决策的 driver 观察——缓存的答案是对前驱世界
   * 说的，第一笔写入之后那个世界就不存在了。工具还没动手就上报（PreToolUse 之后、handler 之前），
   * 所以关门先于第一个字节落盘。run 已结算 / 节点已结算后到达的调用被忽略。
   */
  askMutating(instance: InstanceRef): void;
  /** 进程级治理器调整了本 run 所在 provider key 的 cap。 */
  concurrencyChanged(change: ConcurrencyChange): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary C：run 事件
// ————————————————————————————————————————————————————————————————

/**
 * 节点种类：ask、world-read、world-run 或 report（后三者都无 actor、无 actorSeq）。
 * `world-run` 是 world.run 的 journal 化命令执行——机制与 world-read 完全同构，单列一种
 * 是为了审计面诚实（效应不该伪装成读）。
 * `report` 有 journal 行却在两张图里都不是节点——它发的是进度而不是次序。
 * `artifact` 是**用户面产物**的一次发布或一次声明，与
 * `report` 同族地有行无节点：交付物不是别人能等的一步。⚠ 与 `RunSettlement.artifact`
 * （顶层返回值）无关。
 */
export type NodeKind = "ask" | "world-read" | "world-run" | "report" | "artifact";

/**
 * 一个 world-read / world-run 节点的**有界**输入（`dwf_node.input_json`）。`args` 按位置原样
 * 保留，但序列化后超过 {@link WORLD_READ_INPUT_MAX_BYTES} 时逐项截成字符串预览并置
 * `truncated`——审计面宁可诚实地说「被截了」，也不把一个 200 KB 的 `node -e` 代码串整个塞进
 * 一张高频读的表。
 */
export interface WorldReadInput {
  op: string;
  args: unknown[];
  truncated?: true;
}

/** `WorldReadInput` 序列化后的字节上限（4 KB）。 */
export const WORLD_READ_INPUT_MAX_BYTES = 4096;

/** 节点结算的语义结果。replay 命中通过事件上的 `cached` 标志区分，不并入这里。 */
export type NodeOutcome = "ok" | "failed" | "cancelled";

/**
 * run 生命周期状态。三个终态：
 * - `completed`：脚本 return；
 * - `errored`：脚本之错（脚本抛错、引擎契约违反）——不可 resume，只能 `resume_from` 修订；
 * - `stopped`：run 被停下（`RunStopReason`），**一律可 resume**。
 *
 * 物理列 `dwf_run.status` 仍是旧五值（`failed` / `cancelled`）且不迁移：这里是**逻辑**词汇，
 * 新旧之间的映射只活在 SQLite 仓储的编解码里（adapters `dwf-journal-codecs.ts`）。
 */
export type RunStatus = "pending" | "running" | "completed" | "errored" | "stopped";

/**
 * run 为什么停下：`user`（用户取消）/ `model`（主代理 TaskStop）/ `provider`（确定性模型侧
 * 错误，见 `ProviderStop`）/ `interrupted`（持有进程亡故、沙箱崩溃 / 超时 / 协议损坏——宿主侧，
 * 重跑很可能就好）/ `superseded`（被一次 AmendWorkflow 停下并替代，后继 id 在 `supersededBy`；
 * **不可 resume**——活的是后继）。
 */
export type RunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";

/**
 * run 事件词汇表（Boundary C）。每个值得观察的状态迁移都发一个事件。
 * `compaction` 为长上下文压缩预留——v1 从不发出，仅占位以便将来非破坏地加入。
 */
export type RunEvent =
  | { type: "run-started"; runId: string; caps: Caps }
  /**
   * 发起 run 的那一轮：`inputId` 是父会话里发起这次
   * run 的 turn 的 inputId（中枢直接启动为铸出的 UUID v7）。**只在建 run 那一世记一次**，紧跟第一条
   * `run-started`；resume 再发 `run-started` 时不再发它——同 run 的子代理 step 因此永远挂在同一个
   * message 下。零 SQL：锚点活在 journal 事件里，不在 dwf_run 列上（刻意不做迁移）。
   * `phaseNames` 是脚本声明的阶段表（声明序），由提交方从因果图填入；侧栏迷你轨道据此画出前方
   * 的站点。同样只记一次，
   * 冷重放免费重建；脚本没有 `phase()` 标记时缺席。
   * `subagentModel` 是本 run 的子代理跑在哪个模型上，规范形 `providerId/modelId[$reasoningLevel]`。与锚点、阶段表同一路宿主元数据：引擎**从不读它**，
   * 只在建 run 那一世随这条事件记一次；宿主在 resume 与两条读面上从事件头读回同一个串
   * （子代理会话按「本字段 > resume pin > 父会话模型」定选型，bootstrap 的
   * workflow-actor-model.ts）。同样零 SQL——不在 `dwf_run` 列上。缺席即子代理跑在会话模型上。
   * `phaseAlongside` 与 `phaseNames` **按位置对齐**：`phaseAlongside[i]` 是进入 `phaseNames[i]` 时
   * strand 仍在跑的其他阶段的下标（下标落在同一张 `phaseNames` 里）。侧栏据此把并行的两站画成
   * 双线段；没有阶段并行时缺席，缺席就是「这条轨道是一条直线」。
   * `scriptPath` 是本 run 的脚本**来自哪个文件**（绝对路径）。与 `subagentModel` 逐条同规：引擎从不读、只在建 run 那一世
   * 记一次、零 SQL，宿主在两条读面上从事件头读回同一个串。缺席即这个 run 没有可编辑的脚本
   * 文件（草稿写不下去的项目、本特性之前发起的 run），模型面因此退回内联重提交的老话。
   */
  | {
      type: "run-launched";
      inputId: string;
      toolCallId?: string;
      parentSessionId?: string;
      phaseNames?: string[];
      subagentModel?: string;
      /** Lossless launch-time workflow default (including reasoning and speed). */
      subagentSelection?: WorkflowModelSelection;
      sessionSelection?: WorkflowModelSelection;
      /** User-approved per-actor overrides. */
      actorModelOverrides?: WorkflowActorModelOverride[];
      /** Completed tasks intentionally rerun by this lineage revision. */
      askRevisions?: WorkflowAskRevision[];
      invalidatedSites?: string[];
      scriptPath?: string;
      phaseAlongside?: number[][];
    }
  /**
   * `phaseName` 记录实例出生时最近一次 `enterPhase` 指定的阶段名。
   * 只出现在**出生事件**上——actor 的 `actor-created`、
   * 节点的 `node-queued`、以及命中缓存（replay / amend-resume）时代替 queued 的
   * `node-settled { cached: true }`；其余 `node-*` 事件不带，reducer 沿用 `actorSiteId`
   * 的先例向前携带。标记之前出生的实例整个键缺席。
   *
   * 它**不是**发出这条事件时的当前阶段：node-queued 可能被 hold 规则推迟到下一个标记
   * 之后才发出，而出生时刻在上一个阶段。
   */
  | {
      type: "actor-created";
      actor: ActorRef;
      name?: string;
      persona?: PersonaSpec;
      phaseName?: string;
    }
  | {
      type: "node-queued";
      instance: InstanceRef;
      kind: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      phaseName?: string;
      /**
       * 作者指令的**开头** {@link INSTRUCTIONS_HEAD_MAX_CHARS} 个字符（去两端空白，不加省略号），
       * 只在 ask 节点上在场。事件轨上「这个子代理在干什么」的唯一答案：完整指令只活在
       * `dwf_node.input_json` 里，而读面（run 详情、GetWorkflowRun）不为一行摘要去读那张表。
       *
       * 取的是**准入时刻**的指令，也就是引擎尾注追加之前的那一份——尾注是引擎的话，不是作者的。
       */
      instructionsHead?: string;
    }
  | { type: "node-dispatched"; instance: InstanceRef }
  | { type: "node-paused"; instance: InstanceRef }
  | { type: "node-retried"; instance: InstanceRef; supplement?: string; attachments?: WorkflowImageRef[] }
  | { type: "node-repairing"; instance: InstanceRef; attempt: number; violations: Violation[] }
  | { type: "node-nudged"; instance: InstanceRef }
  /**
   * 自适应并发的三个观察事件。与 escalation 同族：
   * 引擎核心不据它们做任何决策，它们只是 driver / 治理器观察到的事实经引擎 `record()` 落
   * journal + 扇出。`node-waiting` ⇄ `node-executing` 是 dispatched 之后、settled 之前的自环
   * （`executing` 由此成为**可观察**相位），不改变节点的 journal 记录
   * （不写 dwf_node）。
   */
  | ({ type: "node-waiting"; instance: InstanceRef } & AskWaitInfo)
  | { type: "node-executing"; instance: InstanceRef }
  | ({ type: "concurrency-changed" } & ConcurrencyChange)
  | {
      type: "node-settled";
      instance: InstanceRef;
      outcome: NodeOutcome;
      cached?: boolean;
      error?: WorkflowErrorJson;
      /** 仅 `cached: true` 时在场：命中的节点没有 queued，这条就是它的出生事件。 */
      phaseName?: string;
    }
  /**
   * 一条 ask 在一次 turn 解析时的进度。
   * 与 escalation / 并发那几个观察同族：**引擎核心不解释它**，只 `record()`——它不改任何调度
   * 决策、不进 inputHash、replay 不比对它。同一次 turn 的两条事件顺序是载荷性的：
   * 本条先于 `usage-updated`，于是读到新用量的人一定已经读到了挣来它的那次进度。
   */
  | ({ type: "node-progress"; instance: InstanceRef } & AskProgress)
  /** run 级 token 用量更新：直接携带已花总量（journal 的 spent_tokens 同步写入，二者永远相等）。 */
  | { type: "usage-updated"; spentTokens: number }
  | { type: "log"; message: string }
  /**
   * amend-resume 的导入缓存关闭了：某个 live 子代理即将
   * 改写工作区（`cause: "mutating-tool"`，`actorName` 是它的有效名），或一条 `world.run` live 执行
   * （`cause: "world-run"`）。每个 run 最多一条；修订 run 崩溃后 resume 据它恢复「门已关」——这是
   * 关门的**唯一**事实来源，不再由「曾有 ask live」推断。非修订 run 没有表可关，不发。
   */
  | { type: "import-cache-closed"; instance: InstanceRef; cause: ImportCloseCause; actorName?: string }
  /**
   * 控制流经过了一个 `phase("…")` 标记。**无站点、无 journal 行、无 driver 往返**——标记不是一步工作，它只是
   * 「跑到哪了」的一个刻度。`name` 是作者的原词（去两端空白，与分析器铸造阶段 id 的键同一）；
   * `ordinal` 按名字计数，**每次求值都发**：同名再入即 +1，分析器也正是把第二个同名标记读成
   * 回边。resume 时脚本重跑会把前缀再发一遍（没有 journal 行可去重），消费者单调归约即免疫。
   */
  | { type: "phase-entered"; name: string; ordinal: number }
  /**
   * 一条被发布的中间结果，每个**未被跳过**的 report 调用恰好一次（replay 命中即静默跳过，
   * 不重发）。走与其他 run 事件完全相同的路线（进度汇 → 有界会话事件 → 投影 reducer），
   * 终点是 run 面板的 Results 区。
   *
   * `artifactId` 在场即这条 item 同时喂给了那个预置产物（`report(item, "perf")`）——投影据它
   * 给该产物的 `itemCount` 加一，看板 hook 以计数变化为增量取数的信号。
   */
  | { type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }
  /**
   * 一个**用户面产物**的新版本已就位：内容成员每成功发布一次一条，预置成员每次真正落下
   * 声明（幂等 no-op 不发）一条。与 report 同规——replay 命中不重发，冷恢复从 journal 读。
   *
   * 成功路径**只发这一条**，不发任何节点生命周期事件（node-queued / dispatched / settled）。
   * 与 `report` 同一条论证：产物是交付物，不是别人能等的一步，它在两张图里都不是节点。
   */
  | { type: "artifact-published"; instance: InstanceRef; artifact: ArtifactVersionRecord }
  /**
   * 一次内容产物发布失败（节点以 `failed` 落 journal，脚本那侧拿到一个可 catch 的拒绝）。
   *
   * **刻意不复用 `node-settled{failed}`**：那个事件的读者会把它归约进 `nodes[]` 并要求站点在
   * 图里有对应的节点，而产物站点**不进任何图**——一条 node-settled 落在这样的站点上，在 run
   * 面板里就是一个无从解释的「未知节点」，图层还会报告一个不认识的 site id。发布的失败因此
   * 需要自己的事件：它带着足以渲染一张失败卡的东西（id / 种类 / 结构化错误），而不冒充一步
   * 工作。replay 命中一条失败记录时**不重发**（同 report / artifact-published）。
   */
  | {
      type: "artifact-failed";
      instance: InstanceRef;
      id: string;
      op: ArtifactContentOp;
      error: WorkflowErrorJson;
    }
  | { type: "compaction"; actor: ActorRef }
  /**
   * 一个 actor 把阻塞问题升级给了主代理，并停驻在自己那次 ask 里等答案。
   *
   * **引擎核心从不发这两个事件**——它们由 driver 在执行 ask 的边界内发出（与 repair /
   * nudge 轮次同层），零 I/O 状态机不感知升级。之所以仍然住在这份词汇表里：它们走的是与
   * 其他 run 事件完全相同的两条轨（journal 的 dwf_event + driver.emit 的实时扇出），而那两条
   * 轨的形状由 `RunEvent` 定义。升级**不写 dwf_node 行**（等待不是工作量）。
   */
  | {
      type: "escalation-raised";
      qid: string;
      actor: ActorRef;
      /**
       * actor 的**有效名**（= `normalizePersona` 后的 `spec.name`，也就是 `actor-created`
       * 事件上那一个、以及 amend-resume 用作缓存身份键的那一个）。匿名 actor 缺席，
       * 且不合成兜底标签——消费者各自决定怎么渲染「无名」。
       */
      actorName?: string;
      question: string;
      context?: string;
      /**
       * 提问时刻（epoch 毫秒）。**必填**：读者要回答的第一个问题恒是「这个问题已经等了多久」，
       * 而事件轨上没有别的时钟可用——`dwf_event.time_created` 只在 durable 那一轨上有，实时轨
       * （driver.emit → progress sink → 侧栏）拿不到它，让 UI 用「收到事件的本地时刻」兜底就会
       * 在冷启动重放整段历史时把每个问题都显示成刚刚提的。
       *
       * 与快照 `pendingQuestions[].askedAt` **同一个瞬间**（driver 只取一次 `Date.now()`，
       * 事件与停驻记录共用），所以两条读面上的等待时长永远一致。
       */
      askedAt: number;
    }
  | { type: "escalation-resolved"; qid: string; answer: string }
  /** run 级停滞观察（见 {@link RunStallInfo}）；run 结算后到达的调用被忽略。 */
  | ({ type: "run-stalled" } & RunStallInfo)
  /**
   * `stopReason` 只在 `status === "stopped"` 时在场；`error` 在 `errored` 恒在场，在
   * `stopped` 只对 `provider`（`ProviderStop`）与 `interrupted`（`Interrupted`）在场。
   */
  | {
      type: "run-settled";
      status: RunStatus;
      stopReason?: RunStopReason;
      /** `stopReason === "superseded"` 时在场：停下本 run 的那次修订铸出的新 run。 */
      supersededBy?: string;
      error?: WorkflowErrorJson;
    };

// ————————————————————————————————————————————————————————————————
// Journal 存储端口 + 记录
// ————————————————————————————————————————————————————————————————

/** dwf_run 记录（核心只强依赖 caps/status/failure；其余为阶段二整形预留）。 */
export interface RunRecord {
  runId: string;
  parentSessionId?: string;
  cwd?: string;
  /**
   * 人给的 run 名字（`CreateWorkflow` 的可选 `input.name`）。纯展示元数据：引擎不读它，
   * 只在 createRun 时随 scriptText / cwd 一起落库，供宿主的枚举面拿来当标签——否则跨会话
   * 列出来的只能是一串裸 runId。缺席即没起名（读侧按脚本首行兜底，不回写）。
   */
  name?: string;
  /**
   * 发起这次 run 的 CreateWorkflow 工具调用 id。纯宿主元数据：引擎不读它，只在 createRun
   * 时随 scriptText / cwd 一起落库。它是重启后仅存的关联锚点——`workflowRuns` 投影跨进程
   * 不存活，工具卡 join、resume 的通知锚点都只能从这里还原。
   */
  toolCallId?: string;
  scriptText?: string;
  scriptHash?: string;
  /**
   * 本次 run 的实参（saved workflow 的声明式参数，已校验并回填默认值）。
   *
   * 与 `scriptText` 同级的 run **身份**的一部分，不是展示元数据：resume 重放这里存下的
   * 实参，永不接受新的——换实参就是另一次 run，该走一次新的确认窗。缺席（老行的 NULL）
   * 解读为 `{}`，不回填（不变式 6/7）。
   */
  args?: Record<string, unknown>;
  /**
   * amend-resume 的 lineage 指针：本 run 由哪个前驱 run 修订而来。宿主元数据，引擎不读它，只在 createRun 时随其余
   * 元数据落库。修订是 **supersede**——新 runId、新脚本、前驱行零触碰——所以两侧唯一的联系
   * 就是这个指针：resume 重建导入缓存（`port.resume` 见它在场即重建 ImportedCache）与
   * UI 的「续自 run X」都从这里还原。缺席即本 run 不是修订（绝大多数 run）。
   */
  resumedFrom?: string;
  caps: Caps;
  /** 累计 token 用量（观察面，不是控制面）。 */
  spentTokens: number;
  status: RunStatus;
  /** `status === "stopped"` 时在场（老行解码时缺席 ⇒ `user`，见仓储编解码）。 */
  stopReason?: RunStopReason;
  /** `stopReason === "superseded"` 时在场：替代本 run 的后继 run（与它的 `resumedFrom` 是同一条边的两端）。 */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  /** 脚本的顶层返回值。Present only for completed runs（`undefined` 产物即整字段缺席）。 */
  result?: unknown;
}

/** dwf_actor 记录，unique(runId, siteId, ordinal)。 */
export interface ActorRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  name?: string;
  persona?: PersonaSpec;
  sessionId?: string;
  /**
   * actor 实际跑在哪个模型上（`providerId/modelId`），由 driver 侧写入。
   *
   * 为什么不塞进 `persona`：persona 是引擎在 createActor 时同步写下的冻结身份，而模型是宿主
   * 事实（父会话**当时**的选择），引擎看不见。分成两个字段，身份与宿主事实就各有一个作者，
   * 谁写的谁负责。
   *
   * 为什么要落库：run 的成本因此可审计，且 resume 能重新附着到**同一个**模型——父会话在两次
   * 运行之间换了主模型，也不会让同一个 run 的后半段悄悄换模型（pin，见 bootstrap 的
   * workflow-actor-model.ts）。
   *
   * 与 `sessionId` 同属「driver 拥有的字段」：引擎的 putActor 只负责把已有值原样带过去
   * （见 engine.ts 的 createActor 与 scheduler.ts 的 ensureSession），绝不自己产出它。
   */
  resolvedModel?: string;
}

/**
 * 节点的落库状态。节点在**准入时**即以 `running` 落库（携带 actorSeq 与 inputHash），
 * 结算时更新为 completed/failed。因此崩溃于执行中的节点在 journal 里留有 `running` 记录，
 * resume 时按记录的 actorSeq 位置重新 live 派发（而非当作已完结结果短路）。
 *
 * **report 节点是这条「两次写」规则唯一的例外**：它只写一次、落库即 `completed`——准入与
 * 结算之间没有 driver 调用，也就没有什么能在中间失败。
 */
export type NodeRecordStatus = "running" | "completed" | "failed";

/**
 * dwf_node 记录。unique(runId, siteId, ordinal)；对 ask 另有
 * unique(runId, actorSiteId, actorOrdinal, actorSeq)。world-read 与 report 的 actor* 与
 * actorSeq 均空；report 行还满足：一次写入、status 恒为 `completed`、`result` 即被报告的 item、
 * `inputHash` 覆盖该 item（replay 命中时防御性比对）。
 */
export interface NodeRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  kind: NodeKind;
  actorSiteId?: string;
  actorOrdinal?: number;
  actorSeq?: number;
  inputHash: string;
  status: NodeRecordStatus;
  result?: unknown;
  error?: WorkflowErrorJson;
  stats?: AskStats;
  /**
   * **用户面产物**的 id（`dwf_node.artifact_id` 列）。两种行会带它：`kind: "artifact"` 的行
   * （它发布/声明的那个产物），以及带标签的 `kind: "report"` 行（这条 item 喂给了哪个预置）。
   * 后者正是「看板 = journal 的投影」这条不变式的落点——一个看板的每个点都是一行
   * `kind = report ∧ artifact_id = ?`。其余行为空。
   */
  artifactId?: string;
  /**
   * **world-read / world-run 节点专用**：这一站
   * 实际执行的 op 与实参，**有界**（{@link WorldReadInput}）。`inputHash` 只回答「同一个输入吗」，
   * 回答不了「输入是什么」——工作区 transcript 要说 *what ran*，不只是 *something ran*。
   * 准入即写（与 `inputHash` 同一次 putNode），结算的 upsert 原样带过去；0030 之前的行与
   * ask / report / artifact 行一律缺席。
   */
  input?: WorldReadInput;
  /**
   * **ask 节点专用**：该 ask 的完整交换（含 repair / nudge 轮与 submit 之后的收尾消息）结束后，
   * 该 actor 会话消息 log 的长度——一个 count offset，不是消息 id 区间。
   *
   * driver 拥有的补写字段（与 `stats` 回填同族、同样经 getNode + putNode 读改写落库），引擎
   * 不产出它。存 count 而不是 id 区间，是因为 count 的关键性质是**前缀复制下不变**：把源会话
   * 前 N 条消息复制进一个新会话，消息 id 全变而 count 不变，于是被复制 ask 的边界值在新会话里
   * 原样有效。这正是 amend-resume 全保真转录截断（以及链式修订）的根基。
   */
  messageBoundary?: number;
}

export type { StoredEvent, ListEventsOptions, RunSettlementRecord, JournalStorePort } from "./journal-types.js";

// driver 对 ask 的观察词汇表（用量 + 进度）住在 ask-observation-types.ts（同上），此处转出口以保持引用路径。
export {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
} from "./ask-observation-types.js";
export type { AskLastTool, AskProgress, AskStats } from "./ask-observation-types.js";

// ————————————————————————————————————————————————————————————————
// 导入缓存（amend-resume）
// ————————————————————————————————————————————————————————————————

// 导入缓存的数据结构住在 imported-cache-types.ts（本文件到 max-lines 上限后拆出），此处转出口以保持引用路径。
export type {
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedRunCache,
  ImportedWorldEntry,
} from "./imported-cache-types.js";

/**
 * 会话种子：分歧 actor 首次 live 派发时交给 {@link WorkflowDriver.createActorSession}，
 * 让新会话以源会话的**全保真转录前缀**开场。
 */
export interface ActorSessionSeed {
  /** 转录来源会话（前驱或更早祖先的该名 actor 会话）。 */
  sourceSessionId: string;
  /**
   * 复制源会话前多少条消息 = 最后一条被消费导入 ask 的 {@link NodeRecord.messageBoundary}。
   * count offset 跨前缀复制不变，所以这个值在链上任何持会话祖先处都直接可用。
   */
  messageCount: number;
  /** 承袭的模型 pin（转录接续下静默换模型正是 pin 要防的身份突变）。 */
  resolvedModel?: string;
}

// ————————————————————————————————————————————————————————————————
// 策略常量（此契约的一部分）
// ————————————————————————————————————————————————————————————————

/** 节点内 repair（拒绝重试）次数上限：3 次。 */
export const REPAIR_ATTEMPTS = 3;

/** turn 结束未提交时的 nudge 次数上限：1 次。 */
export const NUDGE_ATTEMPTS = 1;
