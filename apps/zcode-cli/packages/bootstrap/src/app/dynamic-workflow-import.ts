// ============================================================
// amend-resume 的导入构建：读前驱 journal → ImportedRunCache
// ============================================================
//
// 本模块是 amend-resume 唯一的**读前驱**处，三个调用点共用它：
//   1. `port.amend` 的**预检**（{@link preflightAmendImport}）：停下在飞前驱之前就判定
//      `run_not_found` / `missing_boundaries`——被拒时前驱照旧在跑、一行不建；
//   2. `port.amend` 在前驱结算之后构建缓存（{@link buildImportedCache}）；
//   3. `port.resume` 见 `record.resumedFrom` 在场：崩溃后重建同一张表。
//
// 两处必须是**同一个纯函数**：修订 run 的 journal 只对「已到达的执行前缀」自含，未消费的导入
// 靠重建补回。所以确定性不是风格偏好而是正确性前提——同一份 journal 状态必须给出同一张表
// （无时间戳、无随机、遍历序全部来自 journal 的插入序）。
//
// 唯一的 I/O 是 journal 读与转录条数读（两者都经窄端口注入），本模块自己不碰会话存储实现。

import type { Logger, SessionId } from "@zcode/contracts";
import type {
  ActorRecord,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedRunCache,
  ImportedWorldEntry,
  NodeRecord,
  RunRecord,
} from "@zcode/dynamic-workflow";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";

/**
 * 构建导入缓存所需的 journal 读面：三个读方法，全部按 runId。
 *
 * 结构上是引擎 `JournalStorePort` 的真子集（生产直接把 journal 传进来），窄化的理由与
 * {@link ActorTranscriptStore} 同款：构建器只读这三样，声明成整个端口会让「导入构建依赖
 * journal 的全部能力（含写）」变成一句真话——而它一个字节都不写。**前驱只读**是不变式，让类型把它说出来。
 */
interface ImportedCacheJournalReader {
  getRun(runId: string): RunRecord | undefined;
  listActors(runId: string): ActorRecord[];
  listNodes(runId: string): NodeRecord[];
}

/**
 * 导入构建被拒的三个理由。**判别键而非文案**：模型据它选下一步动作（换 run / 等它结算 /
 * 放弃修订走全新 run），所以三者必须可分辨。可操作文案归工具层。
 *
 * 与端口的 `DynamicWorkflowRunSubmitRefusalReason`（contracts）**逐字面同集**：service 把这里的
 * reason 原样交出去，所以两处一旦漂移就是编译错误，而不是一个悄悄变成 `undefined` 的判别键。
 * 刻意不从 contracts import：本模块是领域侧的构建器，端口词汇表反过来依赖它才是正确方向。
 */
type ImportedCacheRefusalReason =
  /** journal 里没有这个前驱 run。 */
  | "run_not_found"
  /** 前驱仍在飞（非终态）。修订**任意终态** run 都合法，含 completed。 */
  | "not_amendable"
  /** 前驱有已完结但缺消息边界的 ask：无 marker 前驱整体拒绝（无回退降级）。 */
  | "missing_boundaries";

/** 构建结果：成功带表与 lineage 指针，失败只带判别键。 */
type BuildImportedCacheResult =
  | { ok: true; cache: ImportedRunCache; resumedFrom: string }
  | { ok: false; reason: ImportedCacheRefusalReason };

/**
 * amend 预检的两个拒绝理由：与端口的 `DynamicWorkflowRunAmendRefusalReason` 逐字面同集。
 * 没有 `not_amendable`——在飞的前驱由 amend 停下，不是被拒。
 */
type AmendPreflightRefusalReason = Exclude<ImportedCacheRefusalReason, "not_amendable">;

type AmendPreflightResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: AmendPreflightRefusalReason };

/**
 * amend 的**预检**：前驱存在 ∧ 每个已完结 ask 都有消息边界。**不看状态**——这两条都是前驱
 * journal 的性质，停止不会改变它们，所以在停止之前就能判定；预检过了再停，被拒的 amend 才
 * 不会留下一个被白白停掉的 run。在飞 run 的已完结 ask 早已连边界一起落库，所以对在飞前驱
 * 的预检与对已结算前驱的一样决定性。
 */
export function preflightAmendImport(
  journal: Pick<ImportedCacheJournalReader, "getRun" | "listNodes">,
  predecessorRunId: string,
): AmendPreflightResult {
  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  if (!completedAsksHaveBoundaries(journal.listNodes(predecessorRunId))) {
    return { ok: false, reason: "missing_boundaries" };
  }
  return { ok: true, run };
}

/**
 * 门 3 的谓词，预检与构建共用：无 marker 只有两种成因——marker 列引入之前写下的 journal，与 driver
 * 侧记账失败——两者都意味着「这个 run 的边界记账不可信」，所以严格到全表而不是只看会被导入
 * 的那些。未完结的 ask 没有边界是**正常**的（它们从不进导入前缀），所以只看 completed 行。
 */
function completedAsksHaveBoundaries(nodes: readonly NodeRecord[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "ask" || node.status !== "completed") continue;
    if (node.messageBoundary === undefined) return false;
  }
  return true;
}

/**
 * 构建导入缓存要的三样依赖。字段名与 `DynamicWorkflowRunServiceDeps` 逐字对齐（本接口是它的
 * 结构子集），所以 run service 的两个调用点直接把 `deps` 原样递进来——多一层改名映射，就多一处
 * 会漂移的接线，而漂移的症状是「转录面明明接上了却不做诚实性检查」这类静默降级。
 */
interface AmendImportDeps {
  journal: ImportedCacheJournalReader;
  /**
   * 会话转录读面。在场时多做一道**源诚实性检查**（见 {@link honorsBoundary}）；缺席时
   * 候选照收——driver 侧的种子兑现仍会大声失败，那是 corruption 级的兜底。
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
}

/**
 * 读前驱 journal，构建 {@link ImportedRunCache}。**纯确定**：同一份 journal 状态恒给出同一张表。
 *
 * 三道门按序（先门后建：门不过时一行都不必读）：
 *   1. 前驱不存在 → `run_not_found`；
 *   2. 前驱非终态 → `not_amendable`；
 *   3. 前驱有 completed 但无 `messageBoundary` 的 ask → `missing_boundaries`。
 *
 * 门 3 之所以**严格到全表**（而不是只检查真正会被导入的那些）：无 marker 只有两种成因——
 * marker 列引入之前写下的 journal，与 driver 侧记账失败——两者都意味着「这个 run 的边界记账不可信」，
 * 而不是「这一条恰好没记上」。逐条放行等于让一个记账半坏的前驱产出一张看似完整的表，
 * 分歧时截断到一个错误的位置（模型看见的上文与 journal 记的边界悄悄错位）。dwf 未发布，
 * 无 marker 的 journal 只存在于开发机（整体拒绝，不做合成播种回退）。
 * 未完结的 ask 没有边界是**正常**的（它们从不进导入前缀），所以门只看 completed 行。
 */
export async function buildImportedCache(
  deps: AmendImportDeps,
  predecessorRunId: string,
): Promise<BuildImportedCacheResult> {
  const { actorTranscriptStore: transcripts, journal, logger } = deps;

  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  // 可修订集 = 任意终态，**刻意不复用** plain resume 的 isResumableRecord：那个谓词是
  // byte-identical resume 的门（stopped），而修订恰恰对它排除的两类
  // 最有用——脚本真失败（修 bug 保缓存）与 completed（温启动扩展分析）。两个集合各说各的。
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { ok: false, reason: "not_amendable" };

  const nodes = journal.listNodes(predecessorRunId);
  if (!completedAsksHaveBoundaries(nodes)) return { ok: false, reason: "missing_boundaries" };

  const actors = new Map<string, ImportedActorCandidate>();
  for (const record of namedUniqueActors(journal.listActors(predecessorRunId), logger)) {
    const name = record.name!;
    const candidate = await buildActorCandidate({
      actor: record,
      journal,
      ...(logger === undefined ? {} : { logger }),
      nodes,
      predecessorRunId,
      ...(transcripts === undefined ? {} : { transcripts }),
    });
    if (candidate !== undefined) actors.set(name, candidate);
  }

  return {
    ok: true,
    cache: { actors, world: buildWorldQueues(nodes) },
    resumedFrom: predecessorRunId,
  };
}

/**
 * 前驱里的**可作候选**的 actor 行：名字非空 ∧ 该名在本 run 内唯一。
 *
 * 匿名不收（名字是缓存身份键，没有名字就没有可比对的坐标）；重名**两个都不收**——
 * 引擎的 `DuplicateActorName` 是后加的运行期不变式，早于它写下的 journal 里可以真的存在
 * 重名行，而「按名取候选」在那种前驱上是掷骰子。挑一个不如都不挑：代价是这两个 actor 全新
 * 重跑，而错挑的代价是把另一个 actor 的会话前缀当成本 actor 的上文。
 */
function namedUniqueActors(records: ActorRecord[], logger?: Logger): ActorRecord[] {
  const byName = new Map<string, ActorRecord[]>();
  for (const record of records) {
    const name = record.name;
    if (name === undefined || name === "") continue;
    const bucket = byName.get(name);
    if (bucket === undefined) byName.set(name, [record]);
    else bucket.push(record);
  }
  const unique: ActorRecord[] = [];
  for (const [name, bucket] of byName) {
    if (bucket.length === 1) {
      unique.push(bucket[0]!);
      continue;
    }
    logger?.warn?.("Dynamic workflow amend: duplicate actor name in predecessor, skipped", {
      actorName: name,
      count: bucket.length,
      event: "dynamic_workflow.amend.duplicate_actor_name",
      module: "bootstrap.app",
    });
  }
  return unique;
}

/**
 * 一个候选 actor 的可导入前缀 + 转录源。任一环节缺料即回 `undefined`（该 actor 全新重跑）。
 *
 * **降级而不失败**是这里的总基调（与门的「整体拒绝」相反）：缺前缀、缺 persona、链上无会话、
 * 源会话被清理，全都只是「这个 actor 没有缓存」——journal 里没有缓存行就是没有，不撒谎。
 * 唯一会整体拒绝的是边界记账不可信，因为那会让**已收下的**候选截断到错误位置。
 */
async function buildActorCandidate(input: {
  actor: ActorRecord;
  journal: ImportedCacheJournalReader;
  logger?: Logger;
  nodes: NodeRecord[];
  predecessorRunId: string;
  transcripts?: ActorTranscriptStore;
}): Promise<ImportedActorCandidate | undefined> {
  const { actor, journal, logger, nodes, predecessorRunId, transcripts } = input;
  const name = actor.name!;

  // persona 是引擎在 createActor 时同步落的冻结身份，所以正常必在场；缺席只可能是被外力
  // 改写过的行。运行期比对没有比对物就无从谈起 persona 一致性——弃候选而不是拿 `{}` 顶。
  if (actor.persona === undefined) return undefined;

  const entries = completedAskPrefix(nodes, actor);
  if (entries.length === 0) return undefined;

  const source = resolveTranscriptSource({
    actorName: name,
    journal,
    startRunId: predecessorRunId,
  });
  if (source === undefined) {
    // 链上没有任何祖先持有该 actor 的会话（从未建过，或会话已被清理）。全保真转录是本特性的
    // 裁决，没有转录就没有可接续的上文——降级为全新 actor。
    logger?.info?.("Dynamic workflow amend: no transcript source for actor, import dropped", {
      actorName: name,
      event: "dynamic_workflow.amend.transcript_source_missing",
      module: "bootstrap.app",
      runId: predecessorRunId,
    });
    return undefined;
  }

  const boundary = entries[entries.length - 1]!.messageBoundary;
  if (
    transcripts !== undefined &&
    !(await honorsBoundary(transcripts, source.sessionId, boundary))
  ) {
    logger?.warn?.(
      "Dynamic workflow amend: transcript source shorter than boundary, import dropped",
      {
        actorName: name,
        event: "dynamic_workflow.amend.transcript_source_short",
        messageBoundary: boundary,
        module: "bootstrap.app",
        sessionId: source.sessionId,
      },
    );
    return undefined;
  }

  return {
    persona: actor.persona,
    entries,
    transcriptSourceSessionId: source.sessionId,
    ...(source.resolvedModel === undefined ? {} : { resolvedModel: source.resolvedModel }),
  };
}

/**
 * 该 actor 的**最长全 completed ask 前缀**（按 actorSeq 0..k 连续）。
 *
 * 前缀在第一个非 completed 处停死，三种停法同一处理：失败、崩溃中（running）、序号空洞。
 * 失败的 ask 对新 run **无约束力**（模型有随机性，修订常常就是为了越过一次失败），所以它自己
 * 不导入；但跳过它去导入其后的条目会走私上下文——被跳过那一轮的问答仍在源会话转录里，
 * 而缓存却声称它没发生过。停在第一个非 completed 处是唯一自洽的读法。
 */
function completedAskPrefix(nodes: NodeRecord[], actor: ActorRecord): ImportedAskEntry[] {
  const bySeq = new Map<number, NodeRecord>();
  for (const node of nodes) {
    if (node.kind !== "ask") continue;
    if (node.actorSiteId !== actor.siteId || node.actorOrdinal !== actor.ordinal) continue;
    if (node.actorSeq === undefined) continue;
    bySeq.set(node.actorSeq, node);
  }

  const entries: ImportedAskEntry[] = [];
  for (let seq = 0; ; seq++) {
    const node = bySeq.get(seq);
    if (node === undefined || node.status !== "completed") break;
    // 边界必在场：门 3 已对整个前驱把关，所以这里不是乐观读而是不变式的兑现。
    const entry: ImportedAskEntry = {
      inputHash: node.inputHash,
      result: node.result,
      messageBoundary: node.messageBoundary!,
    };
    if (node.stats !== undefined) entry.stats = node.stats;
    entries.push(entry);
  }
  return entries;
}

/**
 * 沿 `resumed_from` 链回溯**最近一个**持有该名 actor 会话的祖先 run。
 *
 * 为什么需要走链：run B 里某 actor 全程命中缓存 ⇒ B 从未给它建过会话（惰性创建），于是
 * B→C 的修订要接续该 actor 时，转录只存在于 A。count 边界跨前缀复制不变，所以在链上任何
 * 持会话祖先处，B 抄来的边界值都直接可用——这正是链式修订成立的根基。
 *
 * `resolvedModel` 与会话取自**同一行**：pin 的意义是「接续这段转录时别换模型」，取自别的行
 * 就是在为一段不属于它的转录做承诺。
 *
 * 环防御（seen）是纯防御：supersede 只能指向已终结的更早 run，构造不出环。但这个 while 若真
 * 遇到损坏数据就是死循环，而防御的代价是一个 Set。
 */
function resolveTranscriptSource(input: {
  actorName: string;
  journal: ImportedCacheJournalReader;
  startRunId: string;
}): { sessionId: string; resolvedModel?: string } | undefined {
  const { actorName, journal, startRunId } = input;
  const seen = new Set<string>();
  let runId: string | undefined = startRunId;

  while (runId !== undefined && !seen.has(runId)) {
    seen.add(runId);
    const matches = journal.listActors(runId).filter((actor) => actor.name === actorName);
    // 0 = 这一代根本没有这个 actor（链对该名字断了）；>1 = 重名，按名取会话是掷骰子。
    // 两种都停在这里而不是继续上溯：上一代的会话不是**这段**转录的源。
    if (matches.length !== 1) return undefined;
    const actor = matches[0]!;
    if (actor.sessionId !== undefined) {
      return {
        sessionId: actor.sessionId,
        ...(actor.resolvedModel === undefined ? {} : { resolvedModel: actor.resolvedModel }),
      };
    }
    runId = journal.getRun(runId)?.resumedFrom;
  }
  return undefined;
}

/**
 * 源会话是否真兑现得了边界（消息数 ≥ 边界）。
 *
 * 这道检查把 driver 的**大声失败**语义与构建期的**降级**语义接在一起：driver 的
 * `seedActorTranscript` 对短会话抛 `DriverError`（corruption 级，见那边的性质 3）；构建期缺少转录时则降级为全新重跑。两者都对，但作用域不同——**可预见的**缺料（会话被清理 / 被截断）
 * 应当在构建期就把候选弃掉，driver 那一侧的失败因此退化成真正不该发生时的兜底。
 *
 * 读失败（会话不存在等）同样按「兑现不了」处理：构建器不为会话存储的错误分类负责，而任何
 * 读不到的源都不是可用的源。
 */
async function honorsBoundary(
  transcripts: ActorTranscriptStore,
  sessionId: string,
  boundary: number,
): Promise<boolean> {
  try {
    const messages = await transcripts.messages({ sessionID: sessionId as SessionId });
    return messages.length >= boundary;
  } catch {
    return false;
  }
}

/**
 * world 节点的内容表：`inputHash` → 按 journal 插入序排好的记录队列（第 n 次出现对第 n 条）。
 *
 * 键直接用**前驱记录的 inputHash**，不重算：引擎对 `{op,args}` 的哈希口径（engine.ts 的
 * worldRead）就是写进这一列的那个值，重算一遍等于在这里复制一份哈希契约，而它一旦漂移，
 * 表面上是「缓存莫名不命中」。
 *
 * 失败/中断也占一个出现序槽位：若直接跳过，后一次同参成功会冒充第一次失败的读取。
 * 槽位为 null 时消费游标但重新执行；只有 completed 能供导入。
 * world-run 与 world-read 同表——导入 world-run 是**安全特性**而不是优化：修订续跑绝不静默
 * 重放一次已 journal 的效应（部署脚本跑两次）。
 */
function buildWorldQueues(nodes: NodeRecord[]): ReadonlyMap<string, (ImportedWorldEntry | null)[]> {
  const world = new Map<string, (ImportedWorldEntry | null)[]>();
  for (const node of nodes) {
    if (node.kind !== "world-read" && node.kind !== "world-run") continue;
    const queue = world.get(node.inputHash);
    // 修订后同一哈希的第 n 次读取必须对应前驱第 n 次；不能把失败记录压缩掉。
    const entry: ImportedWorldEntry | null = node.status === "completed"
      ? { inputHash: node.inputHash, kind: node.kind, result: node.result }
      : null;
    if (queue === undefined) world.set(node.inputHash, [entry]);
    else queue.push(entry);
  }
  return world;
}

/**
 * resume 侧的入口：重建修订 run 的导入缓存。**任何失败都只降级、不拒绝 resume**。
 *
 * 与提交侧共用同一个 {@link buildImportedCache}——这不是复用的顺手，而是正确性前提：修订 run 的
 * journal 只对「已到达的执行前缀」自含，未消费的导入靠这次重建补回，两侧算出不同的表就意味着
 * 「重建」变成了「另建一张」。
 *
 * 三条理由让「重建失败」与「提交时构建失败」判然不同：
 *   - 修订 run 已经存在了。拒绝 resume 等于把一个可续跑的 run 变成永久卡死的 run；
 *   - 已消费的命中在本 run 的 journal 里是**真行**，replay 不需要这张表——run 的自含性不依赖它；
 *   - 未消费的导入退化成 live 重执行，结果正确，只是花掉本可省下的 token。
 *
 * 所以这里连门的三个理由都不区分：对 resume 而言 `run_not_found`（前驱被清理）与
 * `missing_boundaries` 是同一件事——「这次没有缓存可用」。前驱 journal 因此是修订 run 的**存续
 * 依赖，但只是加速结构**：丢了变贵，不变错。记一条 info 便于事后解释账单。
 */
export async function rebuildImportedCacheForResume(
  deps: AmendImportDeps,
  /** 被 resume 的修订 run 与它的 `resumed_from`（调用方已确认后者在场）。 */
  run: { runId: string; predecessorRunId: string },
): Promise<ImportedRunCache | undefined> {
  const { predecessorRunId, runId } = run;
  const built = await buildImportedCache(deps, predecessorRunId);
  if (built.ok) return built.cache;
  deps.logger?.info?.("Dynamic workflow amend cache rebuild skipped; resuming without it", {
    event: "dynamic_workflow.amend.rebuild_skipped",
    module: "bootstrap.app",
    reason: built.reason,
    resumedFrom: predecessorRunId,
    runId,
  });
  return undefined;
}
