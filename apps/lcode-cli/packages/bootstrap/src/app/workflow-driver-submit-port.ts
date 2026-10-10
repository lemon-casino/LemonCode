import type {
  SessionId,
  SubmitResultRequest,
  SubmitVerdict as ContractsSubmitVerdict,
  WorkflowSubmitPort,
} from "@lcode/contracts";
import { WorkflowError, type WorkflowReportSink } from "@lcode/dynamic-workflow";
import { defer, rejectWith } from "./workflow-driver-helpers.js";
import type { SessionState } from "./workflow-driver-types.js";

/** Borrow the driver's existing session map; driver remains the only state owner. */
export function createSessionSubmitPort(
  sessionId: SessionId,
  sessions: ReadonlyMap<string, SessionState>,
  sink: WorkflowReportSink,
): WorkflowSubmitPort {
  return {
    respond: (request: SubmitResultRequest): Promise<ContractsSubmitVerdict> => {
      const state = sessions.get(sessionId);
      const instance = state?.currentInstance;
      if (state === undefined || instance === undefined || state.cancelled) {
        // 无在飞 ask 却收到 submit：不路由到引擎，直接拒绝（避免悬挂）。
        return Promise.resolve(rejectWith("no active ask is awaiting a submitted result"));
      }
      // Untyped ask 在 driver 边界拒绝，不能依赖引擎早退而使 deferred 永久悬挂。
      if (!state.currentTyped) {
        return Promise.resolve(
          rejectWith(
            "this ask does not accept submit_result; provide your answer as your final message",
          ),
        );
      }
      // 单前实例不变式：至多一个挂起 deferred。若已有（不应发生），先拒旧的避免泄漏。
      state.pendingSubmit?.reject(
        new WorkflowError("DriverError", "This submit was superseded by a newer submit."),
      );
      const deferred = defer<ContractsSubmitVerdict>();
      state.pendingSubmit = deferred;
      // 同步上报：引擎在本调用栈内校验并经 respondToSubmit 回裁决（同步解开 deferred）。
      sink.askSubmitAttempted(instance, request.result);
      return deferred.promise;
    },
  };
}
