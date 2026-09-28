// ============================================================
// submit profile 的运行时守卫
// ============================================================
// 独立成文件：workflow-driver.ts 早已超过 max-lines，而这段只读 driver 的 deps / sink / 会话态，
// 与状态机的其余部分无关。
//
// 静态 profile 是站点图 may-set 上的推导；一个 typed ask 落到与之不符的会话上，只可能是分析不够
// 精确——不是脚本的错，也不该让 run 静默出错：
//   - `mono` 但 schema 不同：把这个会话的 submit_result 换回通用声明并让 runtime 重算工具面，
//     此后该会话按 generic 走（尾注带整份 schema）。代价是一次缓存前缀失效，正确性不受影响。
//   - `untyped`：这个 runtime 根本没有 submit 端口（工厂据 profile 没注入），没有工具可换回——
//     以 DriverError 让**这个 ask** 失败并说清是哪个站点，而不是让它耗尽 nudge 后以
//     ResultNotSubmitted 失败、把分析问题伪装成模型问题。

import { submitResultToolEntry } from "@lcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  canonicalJson,
  refToString,
  WorkflowError,
  type AskMessage,
  type InstanceRef,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/** 静态 profile 与 ask 不符时的日志事件名。 */
const SUBMIT_PROFILE_MISMATCH_EVENT = "dynamic_workflow.submit_profile.mismatch";

/**
 * 让会话的 submit_result 形态与这次 typed ask 相符。返回 false 表示 ask 已经失败、调用方不得再派发
 * turn。generic 会话与 schema 相同的 mono 会话原样通过。
 */
export function ensureSubmitProfileFits(
  deps: AgentRuntimeWorkflowDriverDeps,
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  message: AskMessage,
): boolean {
  const profile = state.submitProfile;
  if (profile.kind === "generic") return true;
  if (profile.kind === "mono" && canonicalJson(profile.schema) === canonicalJson(message.schema)) {
    return true;
  }
  if (profile.kind === "untyped") {
    sink.askFailed(
      instance,
      new WorkflowError(
        "DriverError",
        `Typed ask ${refToString(instance)} reached subagent session ${state.sessionId} whose static ` +
          `submit profile is "untyped" (no submit_result registered): the ask→actor analysis missed this ask.`,
      ),
    );
    return false;
  }
  deps.logger?.warn?.(
    "Dynamic workflow submit profile mismatch: falling back to the generic submit_result",
    {
      event: SUBMIT_PROFILE_MISMATCH_EVENT,
      module: "bootstrap.app",
      instance: refToString(instance),
      runId: deps.runId ?? "run",
      sessionId: state.sessionId,
    },
  );
  // 同一个注册表、同一个名字：register 覆盖 typed 条目；静默，因为覆盖正是意图。缓存必须失效，
  // 否则 getTools 会继续把旧的 typed 声明发给模型。
  state.runtime.getToolRegistry().register(submitResultToolEntry, { silentDuplicateWarning: true });
  state.runtime.invalidateToolCache();
  state.submitProfile = GENERIC_SUBMIT_PROFILE;
  return true;
}
