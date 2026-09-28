import {
  isAutomationCreateLimitError,
  CoreErrorType,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type CollaborationMode,
} from "@lcode/contracts";
import type { ToolEntry, ToolExecutionResult } from "../types.js";

const DEFAULT_EXIT_PLAN_DENIED_MESSAGE = `Permission denied for ${EXIT_PLAN_MODE_TOOL_NAME}`;
const EXIT_PLAN_DENIED_BY_USER_MESSAGE = "The plan was not approved by the user.";
const WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE = "The workflow run was not approved by the user.";
const AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE =
  "Automation creation was not performed because the global retained-task limit of 20 was reached. " +
  "This limit cannot be recovered automatically in the current turn. Do not list, delete, overwrite, " +
  "retry, or use another tool. Reply once in the user's language that they must manually delete an " +
  "existing task on the Automations page and then retry.";

export function withAutomationCreateLimitTurnStop(
  result: ToolExecutionResult,
  input: { error: unknown; toolName: string },
): ToolExecutionResult {
  if (
    result.success ||
    input.toolName !== "CronCreate" ||
    !isAutomationCreateLimitError(input.error)
  ) {
    return result;
  }

  // 创建上限是需要用户手动释放名额的产品边界，不是 Agent 可恢复错误。
  // 给模型隐藏带有“Delete...”诱导性的原始错误，并请求 executor 取消当前 step 的后续工具。
  return {
    ...result,
    modelContent: AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE,
    turnControl: {
      reason: "automation_create_limit",
      stopTurnAfterResult: true,
    },
  };
}

export function withPlanExitDeniedTurnStop(
  result: ToolExecutionResult,
  input: {
    mode: CollaborationMode;
    planEnabled?: boolean;
    toolName: string;
  },
): ToolExecutionResult {
  if (
    !(input.planEnabled ?? input.mode === "plan") ||
    input.toolName !== EXIT_PLAN_MODE_TOOL_NAME ||
    result.success
  ) {
    return result;
  }

  const feedback = readPlanExitDeniedFeedback(result);
  if (feedback) {
    return {
      ...result,
      followUpUserInput: {
        input: feedback,
        reasonSource: "plan_approval_feedback",
      },
      // feedback 会通过 steer 成为真实 user message；tool_result 只能表达计划被拒绝，
      // 不能承诺反馈一定跟随，否则 steer 被拒绝时 provider 会看到不存在的后续 user message。
      modelContent: EXIT_PLAN_DENIED_BY_USER_MESSAGE,
    };
  }

  // 拒绝退出计划代表用户要继续讨论，不能把它当普通工具错误继续喂给模型自我重写计划。
  return {
    ...result,
    turnControl: {
      reason: "plan_exit_denied",
      stopTurnAfterResult: true,
    },
  };
}

function readPlanExitDeniedFeedback(result: ToolExecutionResult): string | undefined {
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // project rule / hook / broker 也可能返回 deny + reason；
  // 只有 ExitPlanMode 审批自定义输入带上的专用 source 才能被解释为用户修改意见。
  if (result.error.reasonSource !== "plan_approval_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  if (!message || message === DEFAULT_EXIT_PLAN_DENIED_MESSAGE) {
    return undefined;
  }
  return message;
}

/**
 * workflow 运行确认窗的 Refine 应答。
 * 与 withPlanExitDeniedTurnStop 同构但更窄：只有反馈升级，没有停 turn 分支——
 * 普通 Deny 沿用既有语义（喂标准权限错误，turn 继续），反馈经 steer 成为真实
 * user message 后模型在同一 turn 内修订脚本重提，重提自然触发新一轮确认。
 * 不按 mode 键入：CreateWorkflow 的 ask 本就无视模式（alwaysAsk）。
 */
export function withWorkflowRefineDeniedFollowUp(
  result: ToolExecutionResult,
  input: { toolName: string },
): ToolExecutionResult {
  if (
    (input.toolName !== CREATE_WORKFLOW_TOOL_NAME && input.toolName !== AMEND_WORKFLOW_TOOL_NAME) ||
    result.success
  ) {
    return result;
  }
  const feedback = readWorkflowRefineDeniedFeedback(result);
  if (!feedback) {
    return result;
  }
  return {
    ...result,
    followUpUserInput: {
      input: feedback,
      reasonSource: "workflow_refine_feedback",
    },
    // tool_result 只能表达运行未获批准，不能承诺反馈一定跟随，
    // 否则 steer 被拒绝时 provider 会看到不存在的后续 user message。
    modelContent: WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE,
  };
}

function readWorkflowRefineDeniedFeedback(result: ToolExecutionResult): string | undefined {
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // 同 readPlanExitDeniedFeedback：hook / project rule 的 deny + reason 不带该专用 source，
  // 不得被升级成用户消息。
  if (result.error.reasonSource !== "workflow_refine_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  return message || undefined;
}

// submit_result 之类的终态工具在其 ToolEntry.metadata 上声明 stopTurnOnSuccess=true：它们的
// 成功结果表示一次终态提交，必须结束 actor 的 turn。这里读声明式 metadata，而不是按工具名硬编码
// ——终态是一种一般性的内在能力（任何未来的终态工具都可复用），与失败侧
// withPlanExitDeniedTurnStop / withAutomationCreateLimitTurnStop 按 tool 特定 error/state 键入的
// 条件性 stop 不同。这些工具的 handler 保证成功⟺该终止（gate 抛错、reject 走失败），故无需
// handler 侧信号通道。
export function withTerminalToolTurnStop(
  result: ToolExecutionResult,
  input: { entry: ToolEntry },
): ToolExecutionResult {
  if (!result.success || input.entry.metadata.stopTurnOnSuccess !== true) {
    return result;
  }
  return {
    ...result,
    turnControl: {
      reason: "subagent_terminal",
      stopTurnAfterResult: true,
    },
  };
}
