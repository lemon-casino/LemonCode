import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  type PermissionBrokerResult,
} from "@lcode/contracts";

import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  type LCodePermissionOption,
  type LCodePermissionResponse,
} from "@lcode/shared";

import type { V4InteractionAnswer } from "../lcode-protocol-v4/interaction-registry.js";

import {
  buildSessionPermissionUpdates,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildPermissionDeniedContent,
} from "./permission-options.js";

/**
 * v4 permission 应答映射：优先按 optionId 精确匹配 buildProtocolPermissionOptions
 * 合成的选项（allow_project 携带 permissionUpdates 持久化规则，不能丢）；投影侧
 * 合成的 allowAlways 语义等价 allow_project。未知 optionId 按 deny 兜底——权限
 * 语义下宁可拒绝也不放行未知应答。
 *
 * workflow Refine：该选项只在 v4 投影
 * 合成、不进 legacy 选项列表，所以在精确匹配之前特判。freeText 为空、或非
 * CreateWorkflow 工具伪造该 optionId，都落到既有 deny 兜底且不带 reasonSource——
 * 反馈升级为 user message 的通道必须只对真实用户输入开放。
 */
export function v4AnswerToPermissionResponse(
  answer: V4InteractionAnswer,
  permissionOptions: LCodePermissionOption[],
  toolName: string,
): LCodePermissionResponse & {
  reasonSource?: PermissionBrokerResult["reasonSource"];
  sessionPermissionUpdates?: PermissionBrokerResult["sessionPermissionUpdates"];
} {
  const refineFeedback = answer.freeText?.trim();
  if (
    (toolName === CREATE_WORKFLOW_TOOL_NAME || toolName === AMEND_WORKFLOW_TOOL_NAME) &&
    answer.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID &&
    refineFeedback
  ) {
    return {
      decision: "deny",
      reason: refineFeedback,
      reasonSource: "workflow_refine_feedback",
    };
  }
  const exact = permissionOptions.find((option) => option.optionId === answer.optionId);
  if (exact) {
    if (exact.kind === "deny") {
      return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
    }
    // 会话免确认：会话语义在这里合成，而不是放进
    // option.response——wire 上 lcodePermissionUpdateSchema 是 strict，旧桌面多一个字段就丢事件。
    if (exact.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND) {
      return withWorkflowModifiedInput(toolName, answer, {
        ...exact.response,
        sessionPermissionUpdates: buildSessionPermissionUpdates(toolName),
      });
    }
    return withWorkflowModifiedInput(toolName, answer, exact.response);
  }
  if (answer.optionId === "allowAlways") {
    const allowAlways = permissionOptions.find((option) => option.kind === "allow_always");
    if (allowAlways) {
      return withWorkflowModifiedInput(toolName, answer, allowAlways.response);
    }
  }
  if (answer.optionId === "allowOnce") {
    return withWorkflowModifiedInput(toolName, answer, {
      decision: "allow",
      reason: "Approved once",
    });
  }
  // deny/rejectOnce/rejectAlways、未知 optionId、无 optionId 全部落 deny。
  return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
}

function withWorkflowModifiedInput(
  toolName: string,
  answer: V4InteractionAnswer,
  response: LCodePermissionResponse & {
    sessionPermissionUpdates?: PermissionBrokerResult["sessionPermissionUpdates"];
  },
): LCodePermissionResponse & {
  sessionPermissionUpdates?: PermissionBrokerResult["sessionPermissionUpdates"];
  modifiedInput?: unknown;
} {
  const modifiedInput = answer.content?.modifiedInput;
  if (
    response.decision !== "allow" ||
    (toolName !== CREATE_WORKFLOW_TOOL_NAME && toolName !== AMEND_WORKFLOW_TOOL_NAME) ||
    modifiedInput === undefined
  ) {
    return response;
  }
  // 只把工作流审批窗产生的覆盖转成现有 modify 决策；executor 随后仍按 runtime schema
  // 重新验证完整输入，客户端不能借此绕过工具输入校验。
  return { ...response, decision: "modify", modifiedInput };
}
