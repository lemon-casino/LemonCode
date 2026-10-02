import type {
  HookInvocationRow,
  SessionUsageState,
  RunningSubagentSummary,
  ConversationRow,
  ConversationSnapshot,
  MutableConversationSnapshotAccumulator,
  CuaAppIdentity,
} from "@lcode/shared/lcode-protocol-v4";
import type { SessionEvent, ModelSelectedPayload, TurnInputIntentMetadata } from "@lcode/contracts";
import type {
  CanonicalUserIntentFact,
  ConversationNormalizationDiagnostic,
} from "./event-normalizer.js";

export type HookInvocationRowContent = Omit<
  HookInvocationRow,
  | "actions"
  | "createdAt"
  | "createdAtSeq"
  | "entityId"
  | "productTurnId"
  | "rowId"
  | "turnId"
  | "visibility"
>;

export interface PendingSessionHookInvocation {
  firstEvent: SessionEvent;
  content: HookInvocationRowContent;
}

export interface SessionConfigSeed {
  permissionGrant?: { interactionId: string };
  planEnabled?: boolean;
  modelSelection?: ModelSelectedPayload["modelSelection"];
  provider?: string;
  model?: string;
  thought?: string;
  thoughtLevels?: readonly string[];
  mode?: string;
}

export interface SessionUsageSeed {
  contextWindow: Omit<NonNullable<SessionUsageState["contextWindow"]>, "maxTokens"> & {
    maxTokens: number | null;
  };
  cumulative?: Partial<SessionUsageState["cumulative"]>;
}

export interface ContextWindowProjectionState {
  maxTokens: number | null;
  touchedByEvent: boolean;
  usedTokens: number;
}

export interface SessionSubagentsSeed {
  revision: number;
  childSessionIds: string[];
  running: RunningSubagentSummary[];
}

export interface StableForkCandidate {
  productTurnId: string;
  transcriptTurnId: string;
  startMessageId: string | null;
  boundaryMessageId: string;
}

export type StableForkCandidateResolution =
  | { ok: true; candidate: StableForkCandidate }
  | {
      ok: false;
      reasonCode:
        | "guard.forkAssistantOnly"
        | "guard.forkTargetNotStable"
        | "guard.forkTargetAmbiguous"
        | "guard.compactOperationLock";
    };

export interface ConversationEditTarget {
  entityId: string;
  productTurnId: string;
  transcriptMessageId: string;
  coveredByStableCompact: boolean;
  intent: {
    kind: "sendText" | "sendGoalCommand";
    text: string;
    sourceCommandId?: string;
    clientId?: string;
    attachments?: CanonicalUserIntentFact["attachments"];
    queueItemId?: string;
    admissionSeq?: number;
    admittedAt?: number;
    requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
    admittedDelivery?: "startNow" | "queue" | "guide";
    fallbackReasonCode?: string;
    modelSelection?: TurnInputIntentMetadata["modelSelection"];
    mode?: TurnInputIntentMetadata["mode"];
    planEnabled?: boolean;
    provenance?: CanonicalUserIntentFact["provenance"];
  };
}

export type ConversationRowTargetAction =
  | "forkAssistant"
  | "editUserQuery"
  | "retryTurn"
  | "applyFileRewind"
  | "fileChanges"
  | "fileRewindPreview"
  | "setAssistantFeedback";

export type ConversationRowTargetResolution =
  | {
      ok: true;
      action: ConversationRowTargetAction;
      row: ConversationRow;
      editTarget?: ConversationEditTarget;
      messageId?: string;
      messageIds?: string[];
    }
  | {
      ok: false;
      status: "stale" | "rejected";
      reasonCode: "proto.staleTarget" | "guard.actionUnavailable";
    };

export interface FileToolInputPreviewState {
  lastPublishedAt: number | null;
  pendingAppend: string;
}

export type TurnModelBaseline =
  | { kind: "silentInitial" }
  | { kind: "sourceLess" }
  | { kind: "known"; provider: string; model: string; thought: string };

/**
 * 仅描述 ProductProjection 已有字段，不创建状态容器或新 owner。
 * 每个职责以 Pick 借用需要的字段；clone/adopt 是这些字段唯一的候选提交边界。
 * desktop continuous 与 mobile replayable 都消费同一次 event → delta → snapshot。
 */
export interface ProductProjectionState {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
  hydrationAccumulator: MutableConversationSnapshotAccumulator | null;
  nextRowId: number;
  streamingTextRowId: number | null;
  streamingReasoningRowId: number | null;
  outputContinuationTextRowId: number | null;
  toolRowIdByCallId: Map<string, number>;
  latestListAppsSnapshot: Map<number, CuaAppIdentity>;
  openForegroundToolCallIds: Set<string>;
  fileToolInputPreviewByCallId: Map<string, FileToolInputPreviewState>;
  subagentRowIdByAgentId: Map<string, number>;
  backgroundLifecycleByWorkId: Map<string, string>;
  consumedBackgroundLifecycles: Set<string>;
  hookRowIdByInvocationId: Map<string, number>;
  pendingSessionHookInvocations: Map<string, PendingSessionHookInvocation>;
  rewoundHookInvocationIds: Set<string>;
  invalidSubagentChildSessionIds: Set<string>;
  messageIdByRowId: Map<number, string>;
  outputContinuationRowIdByMessageId: Map<string, number>;
  entityIdByRowId: Map<number, string>;
  editTargetByEntityId: Map<string, ConversationEditTarget>;
  currentEditableEntityId: string | null;
  stableCompactCoverageBoundaryRowId: number | null;
  turnHeaderRowIdByTurnId: Map<string, number>;
  compactMarkerRowIdByOperationId: Map<string, number>;
  goalVerifyMarkerRowIdByLifecycleKey: Map<string, number>;
  productTurnIdByRuntimeTurnId: Map<string, string>;
  runtimeTurnIdByProductTurnId: Map<string, string>;
  productTurnSplitOrdinalByRuntimeTurnId: Map<string, number>;
  currentProductTurnStartedAtMs: number | null;
  deliveryByPendingInputId: Map<string, "guide" | "queue">;
  currentTurnId: string | null;
  currentTurnStartedModelOnly: boolean;
  contextWindowState: ContextWindowProjectionState;
  lastTurnModel: TurnModelBaseline;
  configModelTouchedByEvent: boolean;
  configThoughtLevelsTouchedByEvent: boolean;
  configModeTouchedByEvent: boolean;
  executionFailoverRevision: number;
  executionFailoverEpochStartSequence: number;
  droppedContentStreamEventCount: number;
  normalizationDiagnostics: ConversationNormalizationDiagnostic[];
}
