import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
} from "@lcode/contracts";
import {
  WorkspaceHookReviewFlowRegistry,
  type WorkspaceHookReviewFlow,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
} from "@lcode/core";
import type { WorkspaceHookReviewRequestPayload } from "@lcode/shared/lcode-protocol-v4";
import { WorkspaceHookMutationError } from "@lcode/shared/workspace-hook-mutation";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookReviewHostPort,
  WorkspaceHookReviewMutationPort,
} from "./workspace-hook-review-types.js";
import { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";

interface WorkspaceHookReviewToggleContext {
  admission: WorkspaceHookRuntimeAdmissionPort;
  mutation: WorkspaceHookReviewMutationPort;
  host: WorkspaceHookReviewHostPort;
  registry: WorkspaceHookReviewFlowRegistry;
  telemetry: WorkspaceHookReviewTelemetry;
  emitAdmissionUpdatedAfterMutation(): Promise<void>;
  refreshPendingFlow(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined>;
}

export async function toggleWorkspaceHookReviewItem(
  context: WorkspaceHookReviewToggleContext,
  target: WorkspaceHookReviewTarget,
  reviewItemId: string,
  enabled: boolean,
): Promise<WorkspaceHookReviewCommandResult & { request?: WorkspaceHookReviewRequestPayload }> {
  const validation = context.registry.validate(target, {
    action: "trust_selected",
    reviewItemIds: [reviewItemId],
  });
  if (!validation.accepted) return validation;
  const currentSnapshot = context.admission.getCurrentSnapshot();
  const entry = currentSnapshot.hooks.find((item) => item.reviewItemId === reviewItemId);
  if (!entry?.editable) {
    return {
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch" as const,
    };
  }
  let writeCommitted = false;
  let nextSnapshot: WorkspaceHookBundleSnapshot;
  try {
    nextSnapshot = await context.mutation.toggle(
      { snapshot: currentSnapshot, reviewItemId, enabled },
      () => {
        writeCommitted = true;
        context.admission.invalidate("workspace_hooks_config_rebuild_failed");
      },
    );
    context.admission.replaceSnapshot(nextSnapshot);
  } catch (error) {
    if (!writeCommitted) {
      // 裸 catch 曾把 mutation port 的全部失败一律报成
      // config_write_failed——包括发生在写盘之前的 snapshot mismatch（review 后
      // bundle 已变/discovery 读败）。用户据此重试"写"永远失败，也掩盖真实原因。
      // 按 WorkspaceHookMutationError.code 透传；telemetry 补 cause 便于定位。
      const isMutationError =
        error instanceof WorkspaceHookMutationError ||
        (error instanceof Error && error.name === "WorkspaceHookMutationError");
      const mutationCode = isMutationError
        ? ((error as WorkspaceHookMutationError).code as WorkspaceHookReasonCode)
        : ("workspace_hooks_config_write_failed" as const);
      context.telemetry.toggleFailure(
        target.bundleDigest,
        mutationCode,
        error instanceof Error ? error.message : String(error),
      );
      return {
        accepted: false,
        reasonCode: mutationCode as WorkspaceHookReasonCode,
      };
    }
    context.telemetry.toggleFailure(target.bundleDigest, "workspace_hooks_config_rebuild_failed");
    context.registry.fail(target, "workspace_hooks_config_rebuild_failed");
    await context.host.emit({
      type: SessionEventType.WorkspaceHookReviewSettled,
      payload: {
        interactionId: target.interactionId,
        state: "configuration_error",
        reasonCode: "workspace_hooks_config_rebuild_failed",
      },
    });
    return {
      accepted: false,
      reasonCode: "workspace_hooks_config_rebuild_failed" as const,
    };
  }

  const nextFlow = await context.refreshPendingFlow(nextSnapshot);
  // 软门禁:toggle 重建 bundle 后重新评估 pending 状态
  await context.emitAdmissionUpdatedAfterMutation();
  return {
    accepted: true,
    reviewItemIds: [reviewItemId],
    ...(nextFlow ? { request: nextFlow.request } : {}),
  };
}
