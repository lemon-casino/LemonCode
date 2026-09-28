// ============================================================
// AgentRuntime-backed WorkflowDriver：升级问答桥接（escalate）
// ============================================================
// workflow-driver.ts 顶到 oxlint max-lines 上限（400 行），把第四条时序（升级问答）的四个方法——会话级 escalate 端口、qid 铸造、作答结算、
// 整会话撤下——拆到本文件成自由函数；driver 类上只留薄薄的委托。公开面不变，仍从
// workflow-driver.ts 导出。
//
// 四个函数对 driver 状态的全部触碰都经 {@link EscalationHost} 显式递进来（会话表、qid 反查表、
// deps、per-run 序号、双轨 record），本文件不持有任何自己的状态——原方法体逐字保留，只把
// `this.` 换成 `host.`。

import type {
  EscalateQuestionRequest,
  SessionId,
  WorkflowEscalateOutcome,
  WorkflowEscalatePort,
} from "@lcode/contracts";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type PersonaSpec,
  type RunEvent,
} from "@lcode/dynamic-workflow";
import {
  ESCALATION_BUDGET_EXHAUSTED,
  MAX_ESCALATIONS_PER_ASK,
  defer,
  effectiveActorName,
  normalizeEscalationContext,
  questionIdFragments,
} from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * driver 交给升级桥接的宿主面。全是 driver 私有状态的**引用**（不是副本）：`sessions` /
 * `qidToSession` 就是类里的那两张表，`nextEscalationSeq` 递增类里的 per-run 序号，`record` 是
 * 类的双轨落地（journal + emit，顺序不可换——见 driver 的 record 注释）。
 */
export interface EscalationHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly qidToSession: Map<string, SessionState>;
  /** 取下一个 per-run 单调的升级序号（qid 的第二段）。 */
  nextEscalationSeq(): number;
  record(event: RunEvent): void;
}

/**
 * 结算一个停驻中的升级问答（run service 经注册表调进来）。与 {@link AgentRuntimeWorkflowDriver.respondToSubmit} 同族：
 * 解开 deferred，让 `escalate` 的工具结果变成这段答案，actor 的轮次就地继续。
 *
 * 返回 false 表示本 driver 没有这个 qid（run 不对，或它刚被 cancelAsk 撤下）。注册表在调用
 * 本方法之前已经把 qid 退场，所以这里不再回写注册表——两处各删一次会让「已回答」与
 * 「被撤下」这两个退场原因互相覆盖。
 */
export function respondToParkedEscalation(
  host: EscalationHost,
  qid: string,
  answer: string,
): boolean {
  const state = host.qidToSession.get(qid);
  if (state === undefined) return false;
  const deferred = state.pendingEscalations.get(qid);
  host.qidToSession.delete(qid);
  state.pendingEscalations.delete(qid);
  if (deferred === undefined) return false;
  try {
    host.record({ type: "escalation-resolved", qid, answer });
  } catch (error) {
    // 与 raise 路径**相反**的取舍，理由也相反：那里写不进去就没人看得见这个问题，停驻只会
    // 让 actor 永久阻塞，所以撤回并上抛；到了这里 actor 已经在等这段答案，为了一条观察事件
    // 把它继续挂着才是更坏的结果。记 warn，答案照送。
    host.deps.logger?.warn?.("Dynamic workflow escalation resolved event not journaled", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.escalation.resolved_journal_failed",
      module: "bootstrap.app",
      qid,
      runId: host.deps.runId ?? "run",
    });
  }
  deferred.resolve(answer);
  return true;
}

/**
 * 撤下某会话上所有停驻中的升级问答：deferred 拒绝（handler 不再悬挂），注册表条目退场
 * （之后对这些 qid 作答得到 `run_not_in_flight`）。
 *
 * 三个调用点覆盖了 ask 结束的全部异常路径：`cancelAsk`（引擎主动取消）、`onTurnRejected`
 * （turn 自己抛错——此时没有人再读工具结果了）、`startAsk`（同一会话上换了下一个 ask）。
 * 正常路径不需要它：停驻中的 escalate 会阻塞住 turn，ask 不可能在还欠着答案时结算。
 */
export function withdrawSessionEscalations(host: EscalationHost, state: SessionState): void {
  if (state.pendingEscalations.size === 0) return;
  const entries = [...state.pendingEscalations];
  state.pendingEscalations.clear();
  for (const [qid, deferred] of entries) {
    host.qidToSession.delete(qid);
    host.deps.escalationRegistry.withdraw(qid);
    deferred.reject(
      new WorkflowError("Cancelled", `Escalation ${qid} was cancelled along with its ask.`),
    );
  }
}

/**
 * 造一个会话级升级端口：`escalate` handler mid-turn 调用它并阻塞等主代理作答。
 *
 * 与 {@link AgentRuntimeWorkflowDriver.makeSubmitPort} 逐条对称，唯二的不同都源于对端不是引擎而是主代理：
 *   1. **不上报 sink**。引擎核心零改动——升级全程发生在 driver 执行 ask 的边界内（与
 *      repair / nudge 轮次同层），零 I/O 状态机不感知它。事件走的是 journal + emit 两条轨。
 *   2. **停驻项可以有多个**（键 = qid），因为一轮里模型可以并行发出几个 escalate 调用。
 *
 * 两条早退都返回**普通工具结果**而不是抛错：预算耗尽时抛错只会让模型把它
 * 当成可重试的故障，反复撞同一堵墙——而这个特性存在的理由正是消灭那种空转。
 */
export function makeSessionEscalatePort(
  host: EscalationHost,
  sessionId: SessionId,
  actor: ActorRef,
  persona: PersonaSpec,
): WorkflowEscalatePort {
  const actorName = effectiveActorName(persona);
  return {
    escalate: (request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome> => {
      const state = host.sessions.get(sessionId);
      if (state === undefined || state.currentInstance === undefined) {
        // 无在飞 ask：问题无处停驻。不停驻、不悬挂（与 submit 的同名守卫同一条论证）。
        return Promise.resolve({
          kind: "refused",
          reason: "no_active_ask",
          message:
            "No ask is in flight, so there is nowhere to park this question and nobody " +
            "would answer it. Escalate only while working on an ask.",
        });
      }
      if (state.escalationsUsed >= MAX_ESCALATIONS_PER_ASK) {
        // per-ask 上限（nudge 预算同族）：第 4 次起短路，绝不停驻。
        return Promise.resolve({
          kind: "refused",
          reason: "budget_exhausted",
          message: ESCALATION_BUDGET_EXHAUSTED,
        });
      }
      state.escalationsUsed++;

      const qid = mintEscalationQuestionId(host);
      const deferred = defer<string>();
      state.pendingEscalations.set(qid, deferred);
      host.qidToSession.set(qid, state);
      const context = normalizeEscalationContext(request.context);
      // 时钟**只读一次**，事件与停驻记录共用：两处各调一次 Date.now() 会让同一个问题在事件轨
      // 与快照上带着相差几毫秒的两个提问时刻，而下游要拿它算「等了多久」。
      const askedAt = Date.now();
      host.deps.escalationRegistry.park(
        {
          qid,
          runId: host.deps.runId ?? "run",
          actor: refToString(actor),
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        },
        (answer) => {
          respondToParkedEscalation(host, qid, answer);
        },
      );
      try {
        host.record({
          type: "escalation-raised",
          qid,
          actor,
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        });
      } catch (error) {
        // journal 写不进去就没有 durable 的问答记录，而停驻会让 actor 无限期阻塞在一个
        // 谁也看不见的问题上。撤回登记并把错误交给 handler，比悄悄停驻诚实。
        state.pendingEscalations.delete(qid);
        host.qidToSession.delete(qid);
        host.deps.escalationRegistry.withdraw(qid);
        throw error;
      }
      return deferred.promise.then((answer) => ({ kind: "answered", answer, qid }) as const);
    },
  };
}

/**
 * 铸一个全局唯一的问题 id：`dwfq-<runId 片段>-<seq>`。
 *
 * 片段供人类调试辨认（语义上不透明——模型只把它当 token 传回来），seq 是 per-run 单调的。
 * 短片段（8 字符）在极端情况下可能撞上另一个 run 的片段，所以候选按长度递进，取第一个
 * 注册表里没占用的：**最后一个候选是完整 runId**，而「runId 唯一 × per-run 单调 seq」按构造
 * 无碰撞，因此这个循环必然终止在一个未占用的 id 上。全都占用只可能意味着两个 driver 共用了
 * 同一个 runId（装配错误），此时大声失败而不是发一个会错配答案的 id。
 */
function mintEscalationQuestionId(host: EscalationHost): string {
  const seq = host.nextEscalationSeq();
  for (const fragment of questionIdFragments(host.deps.runId ?? "run")) {
    const candidate = `dwfq-${fragment}-${seq}`;
    if (!host.deps.escalationRegistry.isTaken(candidate)) return candidate;
  }
  throw new WorkflowError(
    "DriverError",
    `Cannot mint a free escalation question id for run ${host.deps.runId ?? "run"} ` +
      `(seq=${seq}): every candidate is already taken in the registry. Two drivers may be ` +
      `sharing one runId.`,
  );
}
