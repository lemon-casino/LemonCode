// ============================================================
// Workflow 升级问答的停驻注册表（driver 与 run service 之间的唯一连线）
// ============================================================
// actor 的 `escalate` 停驻在 driver 里（它持有 ask 轮次
// 上下文），而作答入口 `resolveQuestion` 在 run service 上（它是端口的持有者）——两者之间需要
// 一张按 qid 查的表。本文件就是那张表，且只是那张表：无 I/O、无持久化、无引擎知识。
//
// 为什么不把 driver 实例交给 service：driver 由 `makeDriver(sink)` 在 `runWorkflowScript`
// **内部**构造，service 从来看不到它。传一张表进去，比为了拿到实例而在 launch 里加一个捕获
// 钩子要少一处时序（表在 launch 之前就存在，注册与查询天然同生命周期）。
//
// **纯内存，与停驻的 deferred 同命**。刻意不持久化：进程亡故后 deferred 已死，一张持久化的
// pending 表只会说谎（它会让主代理去回答一个再也没有人在等的问题）。自愈靠 resume——那个
// ask 会 live 重跑，actor 重新提问并得到一个新 qid，而陈旧 id 拿到结构化拒绝。
//
// 作用域是**每个 run service 实例一张**（≈ 每个 app 会话），而不是模块级单例：跨会话共享一张
// 表等于开一个跨会话的应答洞，与本仓既有的「枚举面只看本会话」同一条纪律。一张表跨本服务名下
// **所有在飞 run**，这正是 qid 必须全局唯一的原因。

import type {
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPendingQuestion,
} from "@lcode/contracts";

/**
 * 已退场 qid 的记忆条数。**有界**：一个长跑的会话可以问答任意多次，无界的历史表就是一处
 * 静默增长的内存。被逐出之后 `resolveQuestion` 只会把它归到 `unknown_question`——那是诚实的
 * 退化（「我不知道这个 id」），而不是一个错误的答案。
 */
const RETIRED_HISTORY_LIMIT = 256;

/** 一次停驻登记所需的事实（driver 提供；qid 已由 driver 铸好）。 */
export interface ParkedQuestionInput {
  qid: string;
  runId: string;
  /** 提问的 actor，`refToString` 形态（如 `actor#1@1`）。 */
  actor: string;
  /** actor 的有效名（`agent("poet")` 的 `"poet"`）；匿名 actor 缺席，不合成兜底标签。 */
  actorName?: string;
  question: string;
  context?: string;
  askedAt: number;
}

/** 一个 qid 退场的原因：决定后来的 resolve 收到哪一条结构化拒绝。 */
type RetiredReason = "resolved" | "withdrawn";

export interface WorkflowEscalationRegistry {
  /**
   * 登记一个停驻中的问题。`settle` 由 driver 提供，收到答案时解开那个 deferred。
   *
   * 调用方必须先用 {@link isTaken} 保证 qid 未被占用（driver 的铸造循环做这件事）——
   * 重复登记会静默覆盖前一个停驻项，那正是错配答案的成因。
   */
  park(entry: ParkedQuestionInput, settle: (answer: string) => void): void;
  /** qid 是否已被占用（停驻中或已退场）。driver 铸造 qid 时据它保证全局唯一。 */
  isTaken(qid: string): boolean;
  /**
   * 撤下一个停驻项而**不作答**：ask 被取消 / turn 失败时由 driver 调用（deferred 那一侧
   * 由 driver 自己拒绝）。之后对该 qid 的 resolve 得到 `run_not_in_flight`。
   */
  withdraw(qid: string): void;
  /** 结算一个停驻项。三类结构化拒绝各自陈述现状与下一步。 */
  resolve(qid: string, answer: string): DynamicWorkflowResolveQuestionResult;
  /** 某个 run 上此刻停驻的问题，按提问顺序。快照 `pendingQuestions` 的投影源。 */
  pendingFor(runId: string): DynamicWorkflowRunPendingQuestion[];
}

interface ParkedQuestion extends ParkedQuestionInput {
  settle: (answer: string) => void;
}

export function createWorkflowEscalationRegistry(): WorkflowEscalationRegistry {
  // Map 的插入序即提问序（pendingFor 直接依赖它，不另存序号）。
  const parked = new Map<string, ParkedQuestion>();
  const retired = new Map<string, RetiredReason>();

  const retire = (qid: string, reason: RetiredReason): void => {
    parked.delete(qid);
    retired.set(qid, reason);
    while (retired.size > RETIRED_HISTORY_LIMIT) {
      // Map 的迭代序是插入序，所以第一个键就是最老的那条。
      const oldest = retired.keys().next();
      if (oldest.done === true) break;
      retired.delete(oldest.value);
    }
  };

  return {
    park(entry, settle) {
      parked.set(entry.qid, { ...entry, settle });
    },

    isTaken(qid) {
      return parked.has(qid) || retired.has(qid);
    },

    withdraw(qid) {
      // 只对停驻中的项有意义：已 resolved 的 qid 不该被降级成 `run_not_in_flight`
      // （那会把「答案已送达」改写成「没人在等」，对主代理是两个不同的事实）。
      if (!parked.has(qid)) return;
      retire(qid, "withdrawn");
    },

    resolve(qid, answer) {
      const entry = parked.get(qid);
      if (entry === undefined) {
        const reason = retired.get(qid);
        if (reason === "resolved") {
          return {
            ok: false,
            reason: "already_resolved",
            message:
              `Question ${qid} was already answered and the subagent has moved on with that ` +
              `answer. No need to answer again; if you have more to add, wait for its next ` +
              `escalation.`,
          };
        }
        if (reason === "withdrawn") {
          return {
            ok: false,
            reason: "run_not_in_flight",
            message:
              `The ask that raised question ${qid} is no longer in flight (the run was ` +
              `cancelled, or that ask already failed), so nobody is waiting for this answer. ` +
              `Use GetWorkflowRun to see the run's current state before deciding what to do next.`,
          };
        }
        return {
          ok: false,
          reason: "unknown_question",
          message:
            `Unknown question id ${qid}. It may be misspelled, or it may come from a process ` +
            `that is gone: parked questions are not persisted, so they vanish on restart (a ` +
            `resume makes the subagent ask again under a new id). Use GetWorkflowRun to read ` +
            `the run's pendingQuestions for the ids that are actually awaiting an answer.`,
        };
      }
      retire(qid, "resolved");
      // settle 在退场之后调用：它会同步解开 actor 那一侧的 deferred，而那条链上的任何再入
      // （例如同一轮里紧接着又一次 escalate）都必须看到一张已经不含本 qid 的表。
      entry.settle(answer);
      return { ok: true, qid };
    },

    pendingFor(runId) {
      const out: DynamicWorkflowRunPendingQuestion[] = [];
      for (const entry of parked.values()) {
        if (entry.runId !== runId) continue;
        out.push({
          qid: entry.qid,
          actor: entry.actor,
          ...(entry.actorName === undefined ? {} : { actorName: entry.actorName }),
          question: entry.question,
          ...(entry.context === undefined ? {} : { context: entry.context }),
          askedAt: entry.askedAt,
        });
      }
      return out;
    },
  };
}
