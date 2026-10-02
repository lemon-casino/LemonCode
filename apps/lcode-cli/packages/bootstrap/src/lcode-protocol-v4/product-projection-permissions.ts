// 权限、用户问题和 workspace Hook 审核的同一交互投影。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import {
  type SessionEvent,
  type PermissionRequestedPayload,
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  type PermissionResolvedPayload,
  type PermissionDeniedPayload,
  type WorkspaceHookReviewRequestedPayload,
  type WorkspaceHookReviewSettledPayload,
  type WorkspaceHookReviewSupersededPayload,
  type WorkspaceHookAdmissionUpdatedPayload,
  type UserInputAutoResolutionUpdatedPayload,
} from "@lcode/contracts";
import {
  type ConversationDelta,
  type PendingInteraction,
  PERMISSION_FULL_ACCESS_OPTION_ID,
  workspaceHookReviewRequestPayloadSchema,
  type ToolCallRow,
} from "@lcode/shared/lcode-protocol-v4";
import { findToolRow, ms } from "./product-projection-rows.js";
import {
  isAskUserQuestionToolName,
  readAskUserQuestionPayloadQuestions,
  isExitPlanModeToolName,
  createExitPlanModeApprovalQuestion,
  toProtocolToolCallDisplay,
} from "./product-projection-tool-payloads.js";
import {
  buildProtocolPermissionOptions,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
} from "../permission-options.js";
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID } from "@lcode/shared";
import { verdictWorkspaceHookReviewRequest } from "@lcode/shared/workspace-hook-review-monotonicity";

type PermissionRequestedHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "toolRowIdByCallId"
>;

type CreatePendingInteractionFromPermissionEventHost = Pick<
  ProductProjectionState,
  "toolRowIdByCallId"
>;

type WorkspaceHookReviewRequestedHost = Pick<ProductProjectionState, "snapshot">;

// ── 权限交互（阻塞交互 → 状态）──

export function onPermissionRequested(
  host: PermissionRequestedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionRequestedPayload;
  const toolCallId = String(payload.toolCallId);
  const interactionId = payload.requestId ?? `perm-${toolCallId}`;
  const interaction = createPendingInteractionFromPermissionEvent(
    host,
    event,
    payload,
    toolCallId,
    interactionId,
  );
  const deltas: ConversationDelta[] = [];
  const row = findToolRow(host, toolCallId);
  if (row) {
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        status: "pendingApproval",
        approvalInteractionId: interactionId,
      },
    });
  }
  deltas.push({
    op: "state.updated",
    patch: {
      pendingInteractions: [...host.snapshot.pendingInteractions, interaction],
    },
  });
  return deltas;
}

function createPendingInteractionFromPermissionEvent(
  host: CreatePendingInteractionFromPermissionEventHost,
  event: SessionEvent,
  payload: PermissionRequestedPayload,
  toolCallId: string,
  interactionId: string,
): PendingInteraction {
  if (isAskUserQuestionToolName(payload.toolName)) {
    // AskUserQuestion 的 permission_requested 只是 runtime 等待态；
    // v4 UI 需要结构化 questions 才能回填 answers，而不是 Allow/Deny 权限弹窗。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: host.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { toolName: payload.toolName },
        questions: readAskUserQuestionPayloadQuestions(payload.input),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (isExitPlanModeToolName(payload.toolName)) {
    // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批反馈；
    // 普通 permission payload 无法表达 approve/custom feedback 的业务语义。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: host.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { interaction: "plan_approval", toolName: payload.toolName },
        questions: [createExitPlanModeApprovalQuestion(payload.reason)],
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  const askDisplay = toProtocolToolCallDisplay(payload.display);
  return {
    interactionId,
    kind: "permission",
    anchorRowId: host.toolRowIdByCallId.get(toolCallId) ?? null,
    createdAt: ms(event),
    payload: {
      kind: "permission",
      toolCallId,
      toolName: payload.toolName,
      summary: payload.reason,
      detail: payload.input,
      freeText: true,
      ...(payload.fullAccessSupported === true && !payload.origin && !payload.optionsPolicy
        ? {
            fullAccessOption: {
              optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
              label: "Full access",
              kind: "custom" as const,
              response: { decision: "deny" as const, reason: "Full access requires V4 approval" },
            },
          }
        : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(askDisplay ? { display: askDisplay } : {}),
      options: [
        ...buildProtocolPermissionOptions({
          input: payload.input,
          suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
          ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
          toolName: payload.toolName,
        }).map((option) => ({
          optionId:
            option.kind === "allow_once"
              ? "allowOnce"
              : option.kind === "allow_always"
                ? "allowAlways"
                : option.optionId,
          label: option.name,
          // 会话免确认的 kind 映到闭集里的 allowAlways（排序槽位 / 样式与 always allow 同），
          // optionId 原样 allowSession——broker 靠它精确命中，GUI 靠 name 本地化。
          kind:
            option.kind === "allow_once"
              ? ("allowOnce" as const)
              : option.kind === "allow_always" ||
                  option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                ? ("allowAlways" as const)
                : ("deny" as const),
          response: option.response,
        })),
        // workflow Refine 只在 v4 投放（legacy 选项列表刻意不含，见 session-mapper 注释）。
        // 静态 response 是普通 deny：任何不认识该
        // optionId 的消费面（无 freeText 的应答）都退化为拒绝，反馈升级只发生在
        // interaction-broker 对 freeText 的特判里。
        ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
        payload.toolName === AMEND_WORKFLOW_TOOL_NAME
          ? [
              {
                optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                label: "Refine",
                kind: "custom" as const,
                response: { decision: "deny" as const, reason: "Denied" },
              },
            ]
          : []),
      ],
    },
  };
}

export function onPermissionResolved(
  host: PermissionRequestedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionResolvedPayload;
  return settlePermission(
    host,
    String(payload.toolCallId),
    payload.decision === "deny" ? "cancelled" : "running",
  );
}

export function onPermissionDenied(
  host: PermissionRequestedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionDeniedPayload;
  return settlePermission(host, String(payload.toolCallId), "cancelled");
}

export function onWorkspaceHookReviewRequested(
  host: WorkspaceHookReviewRequestedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewRequestedPayload;
  const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
  const current = host.snapshot.pendingInteractions.find(
    (item) => item.payload.kind === "workspaceHookReview",
  );
  if (current?.payload.kind === "workspaceHookReview") {
    const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
    // 跨 flow 只能在 onSessionResumed 已清空旧 review 后接管（epoch 应用策略在
    // onSessionResumed）；其余 stale/replay/conflict 均不得覆盖或延长当前 authority。
    if (verdict !== "same_flow_advance") {
      return [];
    }
  }
  const interaction: PendingInteraction = {
    interactionId: request.interactionId,
    kind: "workspaceHookReview",
    anchorRowId: null,
    createdAt: request.createdAt,
    payload: request,
  };
  // 同 flow 的更高 generation 是唯一合法替换；Runtime 重启的跨 flow 接管必须先经过
  // SessionResumed 清旧 authority。这里仍原子替换，避免历史异常状态残留多个 review。
  const pendingInteractions = host.snapshot.pendingInteractions.filter(
    (item) => item.payload.kind !== "workspaceHookReview",
  );
  pendingInteractions.push(interaction);
  return [{ op: "state.updated", patch: { pendingInteractions } }];
}

export function onWorkspaceHookReviewSettled(
  host: WorkspaceHookReviewRequestedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSettledPayload;
  return removeWorkspaceHookReview(host, payload.interactionId);
}

export function onWorkspaceHookReviewSuperseded(
  host: WorkspaceHookReviewRequestedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSupersededPayload;
  return removeWorkspaceHookReview(host, payload.interactionId);
}

function removeWorkspaceHookReview(
  host: WorkspaceHookReviewRequestedHost,
  interactionId: string,
): ConversationDelta[] {
  const pendingInteractions = host.snapshot.pendingInteractions.filter(
    (item) =>
      !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
  );
  return pendingInteractions.length === host.snapshot.pendingInteractions.length
    ? []
    : [{ op: "state.updated", patch: { pendingInteractions } }];
}

/**
 * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
 *
 * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
 * pendingCount === 0 → 置 null(提示条消失)。
 */
export function onWorkspaceHookAdmissionUpdated(event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
  const workspaceHookAdmission =
    payload.pendingCount === 0
      ? null
      : {
          pendingCount: payload.pendingCount,
          bundleDigest: payload.bundleDigest,
          ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
        };
  return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
}

export function onUserInputAutoResolutionUpdated(
  host: WorkspaceHookReviewRequestedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
  let changed = false;
  const pendingInteractions = host.snapshot.pendingInteractions.map((interaction) => {
    if (
      interaction.interactionId !== payload.interactionId ||
      interaction.payload.kind !== "userInput"
    ) {
      return interaction;
    }
    changed = true;
    return {
      ...interaction,
      autoResolution: payload.autoResolution,
    };
  });
  return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
}

function settlePermission(
  host: PermissionRequestedHost,
  toolCallId: string,
  status: ToolCallRow["status"],
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const row = findToolRow(host, toolCallId);
  if (row) {
    const next: ToolCallRow = { ...row, status };
    delete next.approvalInteractionId;
    deltas.push({ op: "row.upserted", row: next });
  }
  const remaining = host.snapshot.pendingInteractions.filter(
    (item) =>
      !(
        (item.payload.kind === "permission" || item.payload.kind === "userInput") &&
        item.payload.toolCallId === toolCallId
      ),
  );
  if (remaining.length !== host.snapshot.pendingInteractions.length) {
    deltas.push({
      op: "state.updated",
      patch: { pendingInteractions: remaining },
    });
  }
  return deltas;
}
