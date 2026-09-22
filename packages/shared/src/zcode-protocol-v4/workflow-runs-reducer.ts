// ============================================================
// workflowRuns 的纯归约：一条 dwf 进度事件 → 新的 workflowRuns 状态
// ============================================================
// 与 workflow-runs.ts（状态 schema）同居，因为它们是同一份词汇表的两半：schema 说"状态长什么样"，
// 这里说"事件怎么把它推进一格"。归约必须单一实现：它若长在 bootstrap 的 v4 product-projection 里，
// 而 TUI 也要同一份状态——
// 抽出来是为了守住**单时钟**原则（workflow-runs.ts）：投影与 TUI 镜像不允许各归约一份。
//
// 本模块是纯函数：无 Date.now、无随机、无 I/O。投影的**非纯部分**（身份闸门、
// recordDynamicWorkflowRunProgress 接线、cold hydration 归类、state.updated 发射）留在 bootstrap。
//
// 依赖方向：contracts → shared。所以输入事件类型在这里**结构化定义**，不 import contracts 的
// DynamicWorkflowRunProgressPayload；bootstrap 侧把 contracts 的有界 payload 赋给
// WorkflowRunProgressEnvelope，赋值本身就是两边形状不漂移的编译期闸。
//
// 三个来自引擎 Boundary C 的**结构性**事实，值得在读代码前先知道，否则下面几处会像兜底：
//   1. 节点相位就是引擎实际发出的事件：queued/dispatched/executing/waiting/repairing/nudged/settled。
//      `executing` / `waiting` 是 driver 的观察：
//      模型请求真的发出去了 / 在等进程级槽位或退避；两者在 dispatched 之后来回切换。
//   2. resume 的完结命中短路**直接发 node-settled**，不经 node-queued（engine.ts），
//      而 `kind` 只在 queued 上携带——所以 node.kind 是可缺省的，不是漏填。
//   3. run 级用量：`usage-updated` 直接携带已花 token 总量；
//      `nodesUsed` 由 `node-dispatched` 的首次相位跃迁计数（同一实例重放不重复计数），
//      没有任何上限可供反算，也不需要。

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunPendingQuestion,
  type WorkflowRunReport,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

import { serializeWorkflowArtifact } from "./workflow-artifact.js";
import {
  countTaggedReport,
  upsertBoundedByArtifactId,
  workflowArtifactSummary,
} from "./workflow-runs-artifacts.js";
import { reduceConcurrencyChanged, withoutCooldown } from "./workflow-runs-concurrency.js";
import { readRunIdField, readWorkflowRunStopReason } from "./workflow-runs-lineage.js";
import { carryNodeProgress, reduceNodeProgress } from "./workflow-runs-node-progress.js";
import { upsertBoundedRunNode } from "./workflow-runs-node-window.js";
import { reducePhaseEntered, reduceRunLaunched } from "./workflow-runs-phases.js";
import { reduceRunStarted } from "./workflow-runs-started.js";
import { withDerivedWorkflowActorStatuses } from "./workflow-runs-actor-status.js";

/**
 * 节点事件 → 相位。不用 `eventType.slice("node-".length)`（事件名恰好就是相位名），改用显式表
 * 是为了让读者一眼看到全部节点事件与它们各落到哪个相位，将来再加事件也不靠字符串切片撞运气。
 */
const NODE_EVENT_PHASE: Readonly<Record<string, WorkflowRunNode["phase"]>> = {
  "node-queued": "queued",
  "node-dispatched": "dispatched",
  "node-executing": "executing",
  "node-waiting": "waiting",
  "node-repairing": "repairing",
  "node-nudged": "nudged",
  "node-paused": "paused",
  "node-retried": "queued",
  "node-settled": "settled",
};

/**
 * 一条 workflow run 进度事件的**结构化**入参。字段与 contracts 的
 * `DynamicWorkflowRunProgressPayload` 同形，但这里全部可缺省：本模块不做 schema 校验，
 * 而是对残缺输入按「能归约多少算多少」处理（runId / eventType 缺席即整条无效）。
 *
 * `actorSessionId` 是 run service 挂在 payload **之外**的派生字段
 * （见 dynamic-workflow-run-launch.ts 的 toProgressPayload）：确定性铸造的 actor
 * 会话 id。它不是引擎的可观察事实，但缺了下游只能自己重造一份契约。
 */
export interface WorkflowRunProgressEnvelope {
  runId?: string;
  toolCallId?: string;
  sequence?: number;
  eventType?: string;
  payload?: Record<string, unknown>;
  actorSessionId?: string;
}

/**
 * 把一条进度事件归约进 `workflowRuns` 状态键。
 *
 * 返回 `null` 表示**语义无变化**：无效事件（缺 runId / eventType），或同一条事件重放后
 * 内容逐字节相同。调用方据此决定不发 `state.updated` / 不刷 UI——revision 因此只在真有
 * 变化时抬升（幂等重放不抬 revision）。
 *
 * `previous` 缺席等价于空态 `{ revision: 0, runs: [] }`。
 */
export function reduceWorkflowRunsState(
  previous: WorkflowRunsState | undefined,
  envelope: WorkflowRunProgressEnvelope,
): WorkflowRunsState | null {
  const runId = envelope.runId;
  if (!runId || typeof envelope.eventType !== "string") return null;
  const sequence = typeof envelope.sequence === "number" ? envelope.sequence : 0;
  const payload = isPlainRecord(envelope.payload) ? envelope.payload : {};

  const prior: WorkflowRunsState = previous ?? { revision: 0, runs: [] };
  const existing = prior.runs.find((run) => run.runId === runId);
  const base: WorkflowRunState = existing ?? {
    runId,
    ...(envelope.toolCallId ? { toolCallId: envelope.toolCallId } : {}),
    status: "pending",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: sequence,
  };

  const next = applyWorkflowRunEvent(base, envelope.eventType, payload, {
    ...(envelope.actorSessionId === undefined ? {} : { actorSessionId: envelope.actorSessionId }),
    ...(envelope.toolCallId === undefined ? {} : { toolCallId: envelope.toolCallId }),
    // 单调：迟到/重放的事件不会把水位拉回去。
    sequence: Math.max(base.lastEventSequence, sequence),
  });

  // 幂等：语义无变化不产 delta（同一条事件重放不抬 revision）。
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(next)) return null;

  const runs = existing
    ? prior.runs.map((run) => (run.runId === runId ? next : run))
    : [...prior.runs, next];
  // 最近 ~8 个，按最旧淘汰。终态 run 的完整事实仍在 journal（详情页经事件日志 query 可取）。
  const bounded =
    runs.length > WORKFLOW_RUNS_LIMITS.maxRuns
      ? runs.slice(runs.length - WORKFLOW_RUNS_LIMITS.maxRuns)
      : runs;
  return { revision: prior.revision + 1, runs: bounded };
}

function applyWorkflowRunEvent(
  base: WorkflowRunState,
  eventType: string,
  payload: Record<string, unknown>,
  derived: {
    actorSessionId?: string;
    toolCallId?: string;
    sequence: number;
  },
): WorkflowRunState {
  const run: WorkflowRunState = {
    ...base,
    ...(derived.toolCallId && !base.toolCallId ? { toolCallId: derived.toolCallId } : {}),
    lastEventSequence: derived.sequence,
  };

  switch (eventType) {
    /**
     * run-started：回到 running、用量归零、剥掉上一世的结算残影，并记下本 run 自己的并发界。
     * 规则在同族的 workflow-runs-started.ts（resume 的重臂语义值得一整个文件头来讲）。
     */
    case "run-started":
      return reduceRunStarted(run, payload);
    case "actor-created": {
      const ref = workflowInstanceRef(payload.actor);
      if (!ref) return run;
      const name = boundedActorName(nonEmptyString(payload.name));
      // 出生阶段名：`actor-created` 是 actor 的出生事件，戳只在这里到，
      // 没有后续事件可以携带或改写它。
      const phaseName = boundedPhaseName(nonEmptyString(payload.phaseName));
      const actor: WorkflowRunActor = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        ...(name ? { name } : {}),
        ...(derived.actorSessionId ? { sessionId: derived.actorSessionId } : {}),
        ...(phaseName === undefined ? {} : { phaseName }),
        // 占位值：紧接着的 withDerivedWorkflowActorStatuses 会按节点与 run 终态重算。
        status: "waiting",
      };
      const upserted = upsertBoundedByInstance(run.actors, actor, WORKFLOW_RUNS_LIMITS.maxActors);
      return withDerivedWorkflowActorStatuses({
        ...run,
        actors: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      });
    }
    case "node-queued":
    case "node-dispatched":
    case "node-executing":
    case "node-waiting":
    case "node-repairing":
    case "node-nudged":
    case "node-paused":
    case "node-retried":
    case "node-settled": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      const phase = NODE_EVENT_PHASE[eventType]!;
      const previousNode = run.nodes.find(
        (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
      );
      const incomingAttempt = readAttempt(payload.instance);
      if ((previousNode?.attempt ?? 1) > incomingAttempt) return run;
      const actorRef = workflowInstanceRef(payload.actor);
      const kind =
        payload.kind === "ask" || payload.kind === "world-read" ? payload.kind : previousNode?.kind;
      // 出生阶段名：引擎只在出生事件上打戳——`node-queued`，以及 replay 命中时
      // 直接发的 `node-settled { cached: true }`（那条节点没有 queued，它就是出生事件）。其余
      // `node-*` 不带，向前携带，与上面 kind / actorSiteId 同一条先例。
      const phaseName =
        boundedPhaseName(nonEmptyString(payload.phaseName)) ?? previousNode?.phaseName;
      const node: WorkflowRunNode = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        ...(kind === undefined ? {} : { kind }),
        phase,
        ...(incomingAttempt > 1 ? { attempt: incomingAttempt } : {}),
        ...(payload.outcome === "ok" ||
        payload.outcome === "failed" ||
        payload.outcome === "cancelled"
          ? { outcome: payload.outcome }
          : {}),
        ...(payload.cached === true ? { cached: true } : {}),
        ...(actorRef
          ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal }
          : previousNode?.actorSiteId !== undefined
            ? { actorSiteId: previousNode.actorSiteId, actorOrdinal: previousNode.actorOrdinal }
            : {}),
        ...(phaseName === undefined ? {} : { phaseName }),
        // 任务摘要与进度读数：node-queued 取载荷、其余事件向前携带，出生事件清掉上一世的计数。
        // 规则在同族的 workflow-runs-node-progress.ts（那里也讲了为什么必须显式携带）。
        ...carryNodeProgress(eventType, payload, previousNode),
      };
      const upsertedNodes = upsertBoundedRunNode(run.nodes, node, WORKFLOW_RUNS_LIMITS.maxNodes);
      // 步数：一个实例**首次**派发计一步。重放同一条 node-dispatched 时 previousNode 已在
      // dispatched 之后的相位，不再计数——归约必须幂等（顶层靠逐字节比对判「无变化」）。
      // 触界被拒的实例查不到 previousNode，会照常计数：步数是 run 级事实，不受展示界约束。
      const firstDispatch =
        eventType === "node-dispatched" &&
        (previousNode === undefined || (previousNode.phase === "queued" && incomingAttempt === 1));
      return withDerivedWorkflowActorStatuses({
        ...run,
        ...(firstDispatch ? { usage: { ...run.usage, nodesUsed: run.usage.nodesUsed + 1 } } : {}),
        nodes: upsertedNodes.list,
        ...(upsertedNodes.truncated || run.truncated ? { truncated: true } : {}),
      });
    }
    /**
     * node-progress：一次 ask 的某个轮次解析完了（driver 每个已解析轮次发一条）。
     *
     * **不是生命周期事件**：它不落相位、不计步、不动 actor 状态，只把三个读数写到那个节点上。
     * 所以它刻意不在上面那组 case 里，也不进 NODE_EVENT_PHASE 表。规则在
     * workflow-runs-node-progress.ts。
     */
    case "node-progress": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      const current = run.nodes.find(
        (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
      );
      if ((current?.attempt ?? 1) > readAttempt(payload.instance)) return run;
      return reduceNodeProgress(run, ref, payload);
    }
    /**
     * report：脚本 `report(item)` 交出的一条渐进产物（详情页 Results 区的数据源）。
     *
     * 它**刻意不碰 `nodes[]`**：report 没有 node-queued/node-settled 生命周期，计进去会让
     * 一个报得勤的工作流步数虚高（紧凑卡与任务列表的 `settled/observed` 读的就是 nodes），
     * 也会把一个没有任何顺序含义的实例带进状态叠加。同理它不碰 actor 状态——它不是某个
     * actor 在动的证据。
     */
    case "report": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      // `report(item, artifactId)` 的第二实参：这条条目喂给哪个预置看板。缺席即普通 report，下面的计数分支整个不走。
      const artifactId = nonEmptyString(payload.artifactId);
      const report: WorkflowRunReport = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        preview: workflowReportPreview(payload.item),
        ...(artifactId === undefined ? {} : { artifactId }),
      };
      const existingReports = run.reports ?? [];
      // 计数的去重键与 reports 表**同一个**：(siteId, ordinal)。必须在 upsert **之前**判，
      // 否则 upsert 完了每条都"已存在"。见下面 countTaggedReport 里为什么这条判定在触界
      // 之后会失准，以及为什么那个方向的失准是安全的。
      const firstSighting = !existingReports.some(
        (item) => item.siteId === ref.siteId && item.ordinal === ref.ordinal,
      );
      // 按 (siteId, ordinal) upsert：脚本 replay 时每个 report 调用都会重跑（引擎按同一个键
      // 静默跳过已记录的那次），所以同一实例必须落成同一行而不是两行。触界语义与
      // actors/nodes 同族：拒绝新条目、已有条目照常更新，超界事实仍在 journal 里。
      const upserted = upsertBoundedByInstance(
        existingReports,
        report,
        WORKFLOW_RUNS_LIMITS.maxReports,
      );
      // 打标签的条目**仍然进 reports**：一条通道一套上限，标签只是多一个去处，不是改道。
      const counted =
        artifactId !== undefined && firstSighting
          ? countTaggedReport(run.artifacts, artifactId)
          : run.artifacts;
      return {
        ...run,
        reports: upserted.list,
        ...(counted === undefined ? {} : { artifacts: counted }),
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-published：脚本经 `artifact.*` 发布了一个**用户面**产物的一个版本，或者
     * 声明了一块预置看板。内容成员发布成功与预置成员
     * 声明都走这一条；缓存命中不重发（同 report）。
     *
     * ⚠ 术语：这里的 artifact 是给**用户**看的产出。`resultPreview` 背后那个「脚本顶层
     * 返回值」在引擎内部也叫 artifact，是给**模型**看的——两者无关。见 workflow-artifacts.ts。
     *
     * 与 report 一样**不碰 `nodes[]` 与 actor 状态**：产物站点不在任何图里、没有 node 生命
     * 周期事件（连 node-settled 都不发，正是为了不在侧板长出一个 untracked
     * 节点）。它也不计步数——交付一件产物不是"多跑了一步"。
     *
     * 去重键是**产物 id**，不是站点实例：同 id 再发布是**新版本**，而新版本必须覆盖同一张卡
     * 而不是长出第二张。这与 nodes/actors/reports 那三张按 (siteId, ordinal) 去重的表是不同
     * 的族——同一个 id 的两个版本来自两个不同的站点实例，按实例去重会得到两张卡。
     */
    case "artifact-published": {
      const summary = workflowArtifactSummary(payload.artifact);
      if (summary === undefined) return run;
      const upserted = upsertBoundedByArtifactId(
        run.artifacts ?? [],
        summary,
        WORKFLOW_RUNS_LIMITS.maxArtifacts,
      );
      return {
        ...run,
        artifacts: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-failed：一次内容产物发布被拒（文件不在 / 越界 / 超上限 / store 缺席）。
     *
     * **刻意不改任何状态。** 失败的发布不认领 id、不认领种类、不占版本号
     * （只有 completed 行认领这些，否则 live 路径会认领 resume 路径认领不了的东西，两本账）。
     * 于是这里没有可 upsert 的东西：为一个从未存在的产物摆一张"失败卡"，会让用户看见一件
     * 并不存在的交付物，而脚本很可能已经 catch 住它、让子代理补写后重新发布成功了。
     *
     * 这条事件的读者是**事件日志**（详情页的审计面按 journal 分页读，不经本归约）。这里
     * 显式列出 case 而不是落到 default，是为了让"不改状态"是一条**读得见的裁决**，
     * 而不是一个漏写的分支。
     */
    case "artifact-failed":
      return run;
    case "usage-updated": {
      // 事件直接携带已花总量（引擎在 emit 前一行写过 dwf_run.spent_tokens）；缺席即保持已知值。
      if (typeof payload.spentTokens !== "number") return run;
      return { ...run, usage: { ...run.usage, spentTokens: payload.spentTokens } };
    }
    /**
     * escalation：一个 actor 把阻塞问题升级给主代理，并停在自己那次 ask 里等答案。
     *
     * 与 report 一样**不碰 `nodes[]` 与 actor 状态**：升级没有 node 生命周期、不计步数
     * （等待不是工作量，与 report 豁免同一 doctrine）。它也不该把提问的 actor 翻成 idle——
     * 那个 actor 的 ask 仍然是 dispatched 的，状态照旧由节点相位派生，这里一个字都不改。
     *
     * 去重键是 `qid` 而不是站点实例：升级没有 site 身份。upsert（而非 push）让重放天然幂等——
     * 同一条 raised 事件再来一次得到逐字节相同的表，顶层的 JSON 比对随即返回 null。
     */
    case "escalation-raised": {
      const qid = nonEmptyString(payload.qid);
      const question = nonEmptyString(payload.question);
      // qid 是身份、question 是这条记录存在的全部理由；缺任一即无从展示，只抬水位。
      if (qid === undefined || question === undefined) return run;
      // actor ref 读不动**不**丢弃整条：身份是 qid，actor 只是属性。为了一个残缺的 ref 把
      // 问题藏起来，恰好毁掉「被卡住的问题必须可见」这个唯一的兜底价值（渲染侧另有兜底标签）。
      const actorRef = workflowInstanceRef(payload.actor);
      const actorName = boundedActorName(nonEmptyString(payload.actorName));
      const context = nonEmptyString(payload.context);
      // 提问时刻只能由事件携带：本模块无时钟（文件头的纯度约定）。事件侧必填，但老 journal
      // 重放得出的事件可能没有它——缺席时整个字段不落，渲染侧据此不显示等待时长。
      const askedAt =
        typeof payload.askedAt === "number" && Number.isFinite(payload.askedAt)
          ? payload.askedAt
          : undefined;
      const pending: WorkflowRunPendingQuestion = {
        qid,
        ...(actorRef ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal } : {}),
        ...(actorName === undefined ? {} : { actorName }),
        question: boundedQuestionText(question),
        ...(context === undefined ? {} : { context: boundedQuestionText(context) }),
        ...(askedAt === undefined ? {} : { askedAt }),
      };
      const upserted = upsertBoundedByQid(
        run.pendingQuestions ?? [],
        pending,
        WORKFLOW_RUNS_LIMITS.maxPendingQuestions,
      );
      return {
        ...run,
        pendingQuestions: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * 主代理答了：那个 actor 的轮次就地继续，问题不再欠着。
     *
     * 答案本身**不落投影**：它作为 `escalate` 的工具结果活在 actor 轮次的转录里（缓存命中时
     * 整轮逐字节重放），这里只需要把问题从"欠答"表里划掉。事件日志那一行仍然带着答案原文，
     * 那是审计面，与"现在还欠谁"这个活事实是两回事。
     */
    case "escalation-resolved": {
      const qid = nonEmptyString(payload.qid);
      if (qid === undefined) return run;
      return withoutPendingQuestions(run, (pending) => pending.qid !== qid);
    }

    /**
     * concurrency-changed：进程级治理器调整了本 run 所在 provider key 的 cap。不碰 `nodes[]` 与 actor 状态：
     * cap 是闸门，不是任何节点的事。规则在 workflow-runs-concurrency.ts。
     */
    case "concurrency-changed":
      return reduceConcurrencyChanged(run, payload);

    /** phase-entered / run-launched：阶段归约在同族的 workflow-runs-phases.ts（后者只搬运声明阶段表）。 */
    case "phase-entered":
      return reducePhaseEntered(run, payload);
    case "run-launched":
      return reduceRunLaunched(run, payload);

    case "run-settled": {
      const status = payload.status;
      const error = isPlainRecord(payload.error) ? payload.error : undefined;
      const message = typeof error?.message === "string" ? error.message : undefined;
      // 终态清空停驻问题：真相是进程内的停驻 deferred，而终态 run 按定义没有在听的人
      // （cancel 已让 cancelAsk 拒掉它们；进程亡故则整张注册表随之消失，`resolved` 事件
      // 永远不会来）。留着它们等于让侧栏摆出一个不可能被作答的问题——比不显示更坏，因为
      // 它读起来像"还有人在等"。清空发生在**所有**终态上，包括 completed：一个已完成的 run
      // 若还挂着 pending，那也只是一条永远不会有下文的残影。
      // 冷却是"新派发被冻结到何时"，终态 run 不再派发任何东西——留着它只会让状态头显示一个
      // 没有对象的倒计时。cap / ceiling 照留：它们是这次 run 跑在什么并发下的历史事实。
      const cleared = withoutCooldown(withoutPendingQuestions(run, () => false));
      // actor 三态里 waiting / completed 的分界看 run 是否终态，所以终态要重新派生一遍：
      // 一个建了却没被 ask 过的 actor 在 run 结束那一刻从「等待」变成「已完成」。
      // 三终态词；`stopReason` 只在 stopped 时搬运，
      // 后继指针只随 superseded 到达（卡片据它画「已被 run X 替代」的链接）。
      const carriedStopReason =
        status === "stopped" ? readWorkflowRunStopReason(payload.stopReason) : undefined;
      const supersededBy =
        carriedStopReason === "superseded" ? readRunIdField(payload.supersededBy) : undefined;
      // 之前的 journal 里 `run-settled` 的 status 是
      // 旧词 cancelled / failed。这里原来对闭集之外的词「一律忽略」，冷回放于是把一个早已停下的 run
      // 留在 running：卡片亮着灯、Cancel 可点而后端无事可取消。结算事件到了，run 就绝不能再活着：
      // 认不出的词按 errored 落终态（不可恢复、不亮 Resume），文案保留，缺席时说明是哪个词。
      // CLI 侧的冷回放已改成按行铸造结算（dynamic-workflow-run-replay.ts），这里是线上第二道闸。
      const terminal = status === "completed" || status === "errored" || status === "stopped";
      const settledMessage = terminal
        ? message
        : (message ?? `run settled with an unrecognized status: ${String(status)}`);
      return withDerivedWorkflowActorStatuses({
        ...cleared,
        status: terminal ? status : "errored",
        ...(carriedStopReason === undefined ? {} : { stopReason: carriedStopReason }),
        ...(supersededBy === undefined ? {} : { supersededBy }),
        ...(settledMessage === undefined
          ? {}
          : { error: settledMessage.slice(0, WORKFLOW_RUNS_LIMITS.maxErrorLength) }),
        // 可恢复性由 CLI 在载荷上裁定（resume 门的同一个谓词），这里只搬运；为真才在场。
        ...(payload.resumable === true ? { resumable: true as const } : {}),
      });
    }
    // log / compaction 不是 step，也没有 site id，所以只抬水位（它们只进事件日志，不进图）。
    default:
      return run;
  }
}

/** 引擎的 `InstanceRef` / `ActorRef` 同构：站点 id × 序号。缺任一即无法定位，返回 null。 */
function workflowInstanceRef(value: unknown): { siteId: string; ordinal: number } | null {
  if (!isPlainRecord(value)) return null;
  const siteId = nonEmptyString(value.siteId);
  const ordinal = value.ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return null;
  return { siteId, ordinal };
}

/**
 * 按 (siteId, ordinal) upsert 进有界列表。
 *
 * actor 表触界时拒绝新条目、仍接受已有条目的更新；节点窗口另见
 * `upsertBoundedRunNode`，它优先保留活动中的节点。
 */
function upsertBoundedByInstance<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  entry: T,
  limit: number,
): { list: T[]; truncated: boolean } {
  const index = list.findIndex(
    (item) => item.siteId === entry.siteId && item.ordinal === entry.ordinal,
  );
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}

/**
 * 按 `qid` upsert 进有界的停驻问题表。
 *
 * 与 `upsertBoundedByInstance` 是同一条触界语义（拒新、仍更新已有），只是键不同：升级没有
 * 站点实例身份，qid 才是它的键。没有把两者合并成一个泛型函数，是因为键的**取法**正是这里
 * 唯一要说的事——合并之后调用点要传一个取键函数，读者反而看不出"这张表按什么去重"。
 */
function upsertBoundedByQid(
  list: readonly WorkflowRunPendingQuestion[],
  entry: WorkflowRunPendingQuestion,
  limit: number,
): { list: WorkflowRunPendingQuestion[]; truncated: boolean } {
  const index = list.findIndex((item) => item.qid === entry.qid);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}

/**
 * 按谓词保留停驻问题，并在**一条不剩时把整个键摘掉**（而不是留一个空数组）。
 *
 * 「零条 ⇒ 键缺席」是这个字段的协议约定（见 schema 注释），侧栏据此整区不渲染。它同时是
 * 幂等的支点：resolve 一个已经不在表里的 qid 会得到逐字节相同的 run 对象，顶层的 JSON 比对
 * 随即返回 null——不抬 revision、不刷 UI。
 */
function withoutPendingQuestions(
  run: WorkflowRunState,
  keep: (pending: WorkflowRunPendingQuestion) => boolean,
): WorkflowRunState {
  const current = run.pendingQuestions;
  if (current === undefined) return run;
  const remaining = current.filter(keep);
  if (remaining.length === current.length) return run;
  if (remaining.length > 0) return { ...run, pendingQuestions: remaining };
  const { pendingQuestions: _emptied, ...withoutKey } = run;
  return withoutKey;
}

/** 问题/补充说明的展示上界。省略号让截断可见，与 report 预览同一个习语。 */
function boundedQuestionText(text: string): string {
  const limit = WORKFLOW_RUNS_LIMITS.maxQuestionLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * 一条 report 条目的展示预览。
 *
 * 序列化规则与 run 产物回投**同源**（`serializeWorkflowArtifact`：string 原样、其余 pretty
 * JSON——原住 contracts，随本归约一起搬进本包，contracts 侧 re-export），因为同一个值会
 * 同时出现在完成通知的 `<reports>` 与详情页的 Results 区，两处长得不一样就是 bug。在归约
 * 侧算而不是让 renderer 算：预览是协议线上的**有界**字段，而把序列化契约复制进 UI 层总有
 * 一天会与通知/TaskOutput 里的文本漂开。
 */
function workflowReportPreview(item: unknown): string {
  // 载荷已经过 boundDynamicWorkflowRunEventPayload（字符串 2048 / 深度 6 / 32 键），所以这里
  // 只可能因为「键多的对象展开成 pretty JSON 后变长」而超界。省略号让截断在 UI 上可见，
  // 于是不需要给每条条目再加一个协议字段（run 级 truncated 说的是"有条目没进来"，两回事）。
  const text = serializeWorkflowArtifact(item) ?? "";
  const limit = WORKFLOW_RUNS_LIMITS.maxReportPreviewLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * actor 的 `status` 是**派生**的：Boundary C 除了 `actor-created` 之外不发任何 actor
 * 生命周期事件，所以"这个 actor 在动吗、在等吗、干完了吗"只能由它名下节点的相位与 run 的终态回答。
 *
 * 键用 `\0` 连接而不是任何可打印字符：siteId 是引擎给的字符串，用 `-` 之类会让
 * ("a-1", 2) 与 ("a", "1-2") 撞车。（搬来时保留原实现的分隔符语义，只把源码里的裸 NUL
 * 字节写成转义 `\0`——同一个运行时字符串，但文件不再是 grep 眼里的二进制。）
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAttempt(instance: unknown): number {
  if (!isPlainRecord(instance)) return 1;
  const attempt = instance.attempt;
  return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 子代理名曾原样透传上线。名字由脚本任意拼（`agent("reader-" + paths.join("+"))`），
 * 一个 131 字的名字超过了 `workflowRunActorSchema.name` 的 128 上界，而 CLI 不校验出站帧、渲染端
 * 对每一帧做严格校验——于是父会话在这个 actor 出现之后的每一帧（online / recovery / initial 快照）
 * 全部被拒，订阅以 `fault.subscription.recoveryFailed` 永久失效。修法与 `boundedQuestionText` 同族：
 * 生产者按 schema 界裁剪，线上永远合法；完整名字仍在 journal（`dwf_actor.name`）里。
 */
function boundedActorName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength);
}

/**
 * 实例出生阶段名的线上界。与
 * `boundedActorName` 同族、同理由：名字是脚本作者写的任意字符串（`phase("检查 " + file)`），
 * 超界会让父会话之后的每一帧被渲染端拒收。**直接截断、不加省略号**——这个字段不是给人读的
 * 文本而是一个关联键，UI 的 `phaseNameMatches` 正是按前缀把截断的名字关联回 display 阶段。
 */
function boundedPhaseName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
}
