// ============================================================
// AgentRuntime-backed WorkflowDriver：turn 执行与交换收尾
// ============================================================
// 只借用 driver 持有的 SessionState；不另建会话、尝试或 dispose 状态。
// 旧 turn（含 handler 与转录收尾）→ 新 turn；progress → stats → 数消息 → 终局 → journal marker。

import { createQueryId } from "@lcode/contracts";
import type { TurnResult } from "@lcode/core";
import type { InstanceRef, WorkflowImageRef } from "@lcode/dynamic-workflow";
import { handleModelTurnFailure, type ModelFailureHost } from "./workflow-driver-model-failure.js";
import {
  isTurnCancelled,
  reportTurnObservations,
  sameAskAttempt,
  toWorkflowError,
} from "./workflow-driver-helpers.js";
import { countSessionTranscript, journalAskMessageBoundary } from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";
import { verifyWorkflowImageRefs, workflowImageTurnAttachments } from "./workflow-image-refs.js";

/** 与模型失败处理共用重驱接缝；dispose 与升级表仍只由 driver 读取、撤销。 */
export interface WorkflowTurnHost extends ModelFailureHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  withdrawEscalations(state: SessionState): void;
}

export function runWorkflowTurn(
  host: WorkflowTurnHost,
  state: SessionState,
  instance: InstanceRef,
  input: string,
  epilogueStart: number,
  attachments?: WorkflowImageRef[],
): void {
  const abortSignal = state.abortController?.signal;
  const previous = state.turn;
  const execute = (): Promise<void> => {
    if (host.isDisposed() || !sameAskAttempt(state.currentInstance, instance) || state.cancelled)
      return Promise.resolve();
    state.turnGeneration++;
    const start = () => {
      const queryId = createQueryId();
      // 新尝试要等旧 turn 真正退出后才认领事件；只读 currentInstance 会误收旧工具收尾。
      state.modelActivity.beginTurn(queryId);
      return state.runtime.executeTurn(input, workflowImageTurnAttachments(attachments), {
        ...(abortSignal ? { abortSignal } : {}),
        epilogueStart,
        queryId,
      });
    };
    return Promise.resolve()
      .then(() =>
        attachments?.length
          ? verifyWorkflowImageRefs(attachments, host.deps.artifactStore).then((valid) => {
              if (!valid) throw new Error("Workflow image reference is unavailable");
              return start();
            })
          : start(),
      )
      .then(
        (result) => onTurnResolved(host, state, instance, result),
        (error) => onTurnRejected(host, state, instance, error),
      );
  };
  // 旧 turn 的工具与转录收尾必须退出，同一持久 runtime 才能接新尝试。
  state.turn = previous === undefined ? execute() : previous.then(execute, execute);
}

function onTurnResolved(
  host: WorkflowTurnHost,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): void | Promise<void> {
  if (!sameAskAttempt(state.currentInstance, instance) || state.cancelled) return;
  state.modelActivity.endTurn();
  // 一次 turn 解析的两条回报（进度先于用量），顺序与载荷都在 reportTurnObservations 里。
  reportTurnObservations(host.sink, state, instance, result);
  if (host.deps.actorTranscriptStore === undefined) {
    // 无转录存取面：原样的同步路径，一个 await 都不多欠（边界记账整体缺席，见 deps 字段注释）。
    reportTurnOutcome(host, state, instance, result);
    return;
  }
  return settleExchange(host, state, instance, result);
}

/**
 * 报告一个 turn 的终局，并回答「这次 ask 的交换到此为止了吗」。
 *
 * accept 之外只有一条路：把最终文本交给引擎（typed → nudge 或耗尽失败；untyped → 据此结算）。
 * nudge 时引擎会在本调用栈内经 respondToSubmit 安排下一轮；turnGeneration 沿用原来的
 * 交换判据。repair 不在此列：它们在同一个 turn 里，本方法根本不会被调用。
 */
function reportTurnOutcome(
  host: WorkflowTurnHost,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): boolean {
  // 已提交并被引擎 accept：ask 已结算，turn 结束只是确认，不再上报 askTurnEnded。
  if (!sameAskAttempt(state.currentInstance, instance) || state.cancelled || state.accepted)
    return true;
  const generation = state.turnGeneration;
  host.sink.askTurnEnded(instance, result.response);
  return state.turnGeneration === generation;
}

/**
 * 一次交换的收尾：数消息 → 报终局 → 交换真的结束了就把边界写进 ask 的 journal 行。
 *
 * **先数后报**，顺序是载荷性的：报出去之后引擎可能立刻在同一个会话上派发这个 actor 的下一个
 * ask（per-actor FIFO 只保证串行，不保证之间有空隙），那一轮的消息会落进同一个会话，把本次
 * 计数撑大。先数下来，读到的就是这次交换结束那一刻的长度。
 */
async function settleExchange(
  host: WorkflowTurnHost,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): Promise<void> {
  const boundary = await countSessionTranscript(host.deps, state, instance);
  if (!sameAskAttempt(state.currentInstance, instance) || state.cancelled) return;
  const ended = reportTurnOutcome(host, state, instance, result);
  if (!ended || boundary === undefined) return;
  journalAskMessageBoundary(host.deps, state, instance, boundary);
}

function onTurnRejected(
  host: WorkflowTurnHost,
  state: SessionState,
  instance: InstanceRef,
  error: unknown,
): void {
  if (!sameAskAttempt(state.currentInstance, instance) || state.cancelled) return;
  state.modelActivity.endTurn();
  // turn 死了就没有人再读工具结果了：停驻中的升级问答必须一并撤下，否则它们会永远留在
  // 快照的 pendingQuestions 里，请主代理去回答一个没有听众的问题。
  host.withdrawEscalations(state);
  if (state.cancelled || isTurnCancelled(error)) {
    // 引擎发起的取消（abort）：引擎已结算该 ask，driver 不重复上报。
    return;
  }
  // 模型侧错误的收容住在 workflow-driver-model-failure.ts（策略表判 stop / context_exceeded /
  // 瞬态重驱）；不是模型层错误才是 driver 侧失败。
  if (handleModelTurnFailure(host, state, instance, error)) return;
  host.sink.askFailed(instance, toWorkflowError(error));
}
