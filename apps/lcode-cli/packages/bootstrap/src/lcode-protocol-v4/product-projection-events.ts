// 权威事件的有序派发；只组合既有 reducer，不改变各事实的准入与调用顺序。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { CanonicalConversationFact } from "./event-normalizer.js";
import type { ConversationDelta } from "@lcode/shared/lcode-protocol-v4";
import { SessionEventType, type ModelNetworkStatusPayload } from "@lcode/contracts";
import {
  onSessionCreated,
  onSessionResumed,
  onSessionTitleUpdated,
  onExecutionFailoverChanged,
  onFollowupModeChanged,
  onSessionModeChanged,
} from "./product-projection-session.js";
import {
  resetModelOutput,
  projectModelOutputStatus,
  clearActiveModelOutput,
} from "./model-output-statistics.js";
import { onTurnStarted } from "./product-projection-turn-start.js";
import {
  flushPendingSessionHookInvocations,
  onHookRunLifecycle,
} from "./product-projection-hooks.js";
import {
  acceptsActiveModelEvent,
  setApiRetry,
  onModelNetworkStatus,
  onStreamRecoveryStarted,
  onStreamRecoveryTailDiscarded,
  onStreamRecoveryRetryStarted,
} from "./product-projection-model-recovery.js";
import { isLCodeModelRetryRecoveryProgressPayload } from "@lcode/shared";
import { onModelStreaming } from "./product-projection-model-stream.js";
import { turnIdOf, ms } from "./product-projection-rows.js";
import { onModelSelected } from "./product-projection-model-config.js";
import { onModelComplete } from "./product-projection-model-usage.js";
import {
  onToolCallScheduled,
  onToolCallActivity,
  onToolCallResult,
  onToolCallError,
} from "./product-projection-tools.js";
import {
  onPermissionRequested,
  onPermissionResolved,
  onPermissionDenied,
  onUserInputAutoResolutionUpdated,
  onWorkspaceHookReviewRequested,
  onWorkspaceHookReviewSettled,
  onWorkspaceHookReviewSuperseded,
  onWorkspaceHookAdmissionUpdated,
} from "./product-projection-permissions.js";
import {
  onTurnSteerQueued,
  onTurnSteerDeliveryChanged,
  onTurnSteerDispatchChanged,
  onTurnSteerDiscarded,
  onSessionInputPromoted,
  onTurnSteerReordered,
  onQueueAutoDrainChanged,
} from "./product-projection-queue.js";
import { onTurnSteerDrained } from "./product-projection-queue-drain.js";
import { onTurnComplete, onTurnError } from "./product-projection-turns.js";
import {
  onCompactLifecycle,
  onSessionForked,
  onRewindTriggered,
} from "./product-projection-history.js";
import { onTargetChanged, onTargetVerification } from "./product-projection-goals.js";
import {
  onBackgroundTaskLifecycle,
  onBackgroundTaskResultConsumed,
} from "./product-projection-background.js";
import { onDynamicWorkflowRunProgress } from "./product-projection-workflow.js";
import {
  onSubagentSpawned,
  onSubagentMessage,
  onSubagentStopped,
} from "./product-projection-subagents.js";

type ReduceHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "streamingTextRowId"
  | "streamingReasoningRowId"
  | "outputContinuationTextRowId"
  | "toolRowIdByCallId"
  | "latestListAppsSnapshot"
  | "openForegroundToolCallIds"
  | "fileToolInputPreviewByCallId"
  | "subagentRowIdByAgentId"
  | "backgroundLifecycleByWorkId"
  | "consumedBackgroundLifecycles"
  | "hookRowIdByInvocationId"
  | "pendingSessionHookInvocations"
  | "rewoundHookInvocationIds"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "stableCompactCoverageBoundaryRowId"
  | "turnHeaderRowIdByTurnId"
  | "compactMarkerRowIdByOperationId"
  | "goalVerifyMarkerRowIdByLifecycleKey"
  | "productTurnIdByRuntimeTurnId"
  | "runtimeTurnIdByProductTurnId"
  | "productTurnSplitOrdinalByRuntimeTurnId"
  | "currentProductTurnStartedAtMs"
  | "deliveryByPendingInputId"
  | "currentTurnId"
  | "currentTurnStartedModelOnly"
  | "contextWindowState"
  | "lastTurnModel"
  | "configModelTouchedByEvent"
  | "configThoughtLevelsTouchedByEvent"
  | "configModeTouchedByEvent"
  | "executionFailoverRevision"
  | "executionFailoverEpochStartSequence"
  | "droppedContentStreamEventCount"
>;

export function reduce(host: ReduceHost, fact: CanonicalConversationFact): ConversationDelta[] {
  const event = fact.event;
  switch (event.type) {
    case SessionEventType.SessionCreated:
      return onSessionCreated(host, event);
    case SessionEventType.SessionResumed:
      return onSessionResumed(host, event);
    case SessionEventType.SessionTitleUpdated:
      return onSessionTitleUpdated(host, event);
    case SessionEventType.TurnStarted:
      if (fact.semanticKind !== "userIntent") return [];
      return [
        ...resetModelOutput(host.snapshot.usage),
        ...onTurnStarted(host, fact),
        // model-only 维护 turn（manual /compact、goal continuation）没有资格
        // 承载 SessionStart 摘要；pending 保持到下一条 user-visible 真实 turn。
        ...(host.currentTurnStartedModelOnly
          ? []
          : flushPendingSessionHookInvocations(host, fact.productTurnId)),
      ];
    case SessionEventType.ModelStreaming: {
      if (fact.semanticKind !== "assistantSegment") return [];
      const shouldClearApiRetry =
        acceptsActiveModelEvent(host, event) &&
        isLCodeModelRetryRecoveryProgressPayload(
          event.payload as unknown as Record<string, unknown>,
        );
      const streamingDeltas = onModelStreaming(host, fact);
      return shouldClearApiRetry
        ? [...streamingDeltas, ...setApiRetry(host, null)]
        : streamingDeltas;
    }
    case SessionEventType.ModelNetworkStatus:
      return [
        ...(acceptsActiveModelEvent(host, event) &&
        String(event.sessionId) === host.snapshot.sessionId
          ? projectModelOutputStatus(
              host.snapshot.usage,
              event.payload as ModelNetworkStatusPayload,
              turnIdOf(host, event),
              ms(event),
            )
          : []),
        ...onModelNetworkStatus(host, event),
      ];
    case SessionEventType.StreamRecoveryStarted:
      return onStreamRecoveryStarted(host, event);
    case SessionEventType.StreamRecoveryTailDiscarded:
      return onStreamRecoveryTailDiscarded(host, event);
    case SessionEventType.StreamRecoveryRetryStarted:
      return onStreamRecoveryRetryStarted(host, event);
    case SessionEventType.ModelSelected:
      return onModelSelected(host, event);
    case SessionEventType.ExecutionFailoverChanged:
      return onExecutionFailoverChanged(host, event);
    case SessionEventType.ModelComplete:
      return onModelComplete(host, event);
    case SessionEventType.ToolCallScheduled:
      return onToolCallScheduled(host, event);
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
      return onToolCallActivity(host, event);
    case SessionEventType.ToolCallResult:
      return onToolCallResult(host, event);
    case SessionEventType.ToolCallError:
      return onToolCallError(host, event);
    case SessionEventType.PermissionRequested:
      return onPermissionRequested(host, event);
    case SessionEventType.PermissionResolved:
      return onPermissionResolved(host, event);
    case SessionEventType.PermissionDenied:
      return onPermissionDenied(host, event);
    case SessionEventType.UserInputAutoResolutionUpdated:
      return onUserInputAutoResolutionUpdated(host, event);
    case SessionEventType.WorkspaceHookReviewRequested:
      return onWorkspaceHookReviewRequested(host, event);
    case SessionEventType.WorkspaceHookReviewSettled:
      return onWorkspaceHookReviewSettled(host, event);
    case SessionEventType.WorkspaceHookReviewSuperseded:
      return onWorkspaceHookReviewSuperseded(host, event);
    case SessionEventType.WorkspaceHookAdmissionUpdated:
      return onWorkspaceHookAdmissionUpdated(event);
    case SessionEventType.HookRunStarted:
    case SessionEventType.HookRunProgress:
    case SessionEventType.HookRunCompleted:
    case SessionEventType.HookRunFailed:
    case SessionEventType.HookRunBlocked:
      return onHookRunLifecycle(host, event);
    case SessionEventType.TurnSteerQueued:
      return onTurnSteerQueued(host, event);
    case SessionEventType.TurnSteerDeliveryChanged:
      return onTurnSteerDeliveryChanged(host, event);
    case SessionEventType.TurnSteerDispatchChanged:
      return onTurnSteerDispatchChanged(host, event);
    case SessionEventType.TurnSteerDrained:
      return onTurnSteerDrained(host, event);
    case SessionEventType.TurnSteerDiscarded:
      return onTurnSteerDiscarded(host, event);
    case SessionEventType.SessionInputPromoted:
      return onSessionInputPromoted(host, event);
    case SessionEventType.TurnSteerReordered:
      return onTurnSteerReordered(host, event);
    case SessionEventType.QueueAutoDrainChanged:
      return onQueueAutoDrainChanged(host, event);
    case SessionEventType.FollowupModeChanged:
      return onFollowupModeChanged(host, event);
    case SessionEventType.SessionModeChanged:
      return onSessionModeChanged(host, event);
    case SessionEventType.TurnComplete:
      return [
        ...clearActiveModelOutput(host.snapshot.usage, turnIdOf(host, event)),
        ...onTurnComplete(host, event),
      ];
    case SessionEventType.TurnError:
      return [
        ...clearActiveModelOutput(host.snapshot.usage, turnIdOf(host, event)),
        ...onTurnError(host, event),
      ];
    case SessionEventType.CompactStarted:
    case SessionEventType.CompactCompleted:
    case SessionEventType.CompactFailed:
      return onCompactLifecycle(host, event);
    case SessionEventType.TargetChanged:
      return onTargetChanged(host, event);
    case SessionEventType.TargetCompletionVerification:
      return onTargetVerification(host, event);
    case SessionEventType.SessionForked:
      return onSessionForked(host, event);
    case SessionEventType.RewindTriggered:
      return onRewindTriggered(host, event);
    case SessionEventType.BackgroundTaskStarted:
    case SessionEventType.BackgroundTaskUpdated:
    case SessionEventType.BackgroundTaskCompleted:
      return onBackgroundTaskLifecycle(host, event);
    case SessionEventType.BackgroundTaskResultConsumed:
      return onBackgroundTaskResultConsumed(host, event);
    case SessionEventType.DynamicWorkflowRunProgress:
      return onDynamicWorkflowRunProgress(host, event);
    case SessionEventType.SubagentSpawned:
      return onSubagentSpawned(host, event);
    case SessionEventType.SubagentMessage:
      return onSubagentMessage(host, event);
    case SessionEventType.SubagentStopped:
      return onSubagentStopped(host, event);
    default:
      return [];
  }
}
