import {
  conversationInputIntentSchema,
  type AttachmentRef,
  type CommandEnvelope,
  type ConversationInputIntent,
  type CommandPayloadMap,
} from "@lcode/shared/lcode-protocol-v4";

import type { ConversationRowTargetResolution } from "../lcode-protocol-v4/product-projection.js";

import type { ForkCommitBundle, SessionId } from "@lcode/contracts";
import { resolveHistoricalCapsuleRefs } from "../lcode-protocol-v4/commands/handlers/fork-edit-retry-context.js";

interface InputCommandForAdmission {
  kind: ConversationInputIntent["kind"];
  text: string;
  attachments: readonly AttachmentRef[];
  modelSelection?: ConversationInputIntent["modelSelection"];
  mode?: ConversationInputIntent["mode"];
  planEnabled?: boolean;
  goalAcceptance?: ConversationInputIntent["goalAcceptance"];
  sharedContextRefs?: ConversationInputIntent["sharedContextRefs"];
  contextCapsuleRefs?: ConversationInputIntent["contextCapsuleRefs"];
  requestedDelivery?: ConversationInputIntent["delivery"]["requested"];
  admittedDelivery?: ConversationInputIntent["delivery"]["admitted"];
  fallbackReasonCode?: string;
  provenance?: ConversationInputIntent["provenance"];
}

type ResolveAdmissionRowTarget = (
  sessionId: string,
  target: { rowId: number; entityId: string },
  action: "editUserQuery" | "retryTurn",
) => ConversationRowTargetResolution | null;

function admissionAttachmentRefs(
  attachments: NonNullable<
    Extract<ConversationRowTargetResolution, { ok: true }>["editTarget"]
  >["intent"]["attachments"],
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              ref: attachment.ref,
              fileName: attachment.fileName,
              mime: attachment.mime,
              bytes: attachment.bytes,
              ...(attachment.previewRef ? { previewRef: attachment.previewRef } : {}),
            },
          ]
        : [],
    ) ?? []
  );
}

/**
 * admission 只持久化真正会产生输入的命令。edit/retry 不能从 payload 猜 intent；
 * 必须复用 projection 的 canonical target，并把旧来源折叠进 provenance。
 */
export function resolveInputCommandForAdmission(
  envelope: CommandEnvelope,
  admissionSessionId: string,
  resolveRowTarget: ResolveAdmissionRowTarget,
): InputCommandForAdmission | null {
  if (envelope.type === "createSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: {
          text: string;
          attachments?: AttachmentRef[];
          modelSelection?: ConversationInputIntent["modelSelection"];
          mode?: ConversationInputIntent["mode"];
          planEnabled?: boolean;
        };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: firstInput.attachments ?? [],
          ...(firstInput.modelSelection ? { modelSelection: firstInput.modelSelection } : {}),
          ...(firstInput.mode ? { mode: firstInput.mode } : {}),
          ...(firstInput.planEnabled !== undefined ? { planEnabled: firstInput.planEnabled } : {}),
        }
      : null;
  }
  if (envelope.type === "createSelectionSideSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: [],
        }
      : null;
  }
  if (
    envelope.type === "sendText" ||
    envelope.type === "sendGoalCommand" ||
    envelope.type === "sendStrictGoalCommand"
  ) {
    const payload = envelope.payload as {
      text: string;
      attachments?: AttachmentRef[];
      modelSelection?: ConversationInputIntent["modelSelection"];
      mode?: ConversationInputIntent["mode"];
      planEnabled?: boolean;
      acceptance?: ConversationInputIntent["goalAcceptance"];
      context_refs?: CommandPayloadMap["sendText"]["context_refs"];
    };
    return {
      kind: envelope.type === "sendStrictGoalCommand" ? "sendGoalCommand" : envelope.type,
      text: payload.text,
      attachments: payload.attachments ?? [],
      ...(payload.modelSelection ? { modelSelection: payload.modelSelection } : {}),
      ...(payload.mode ? { mode: payload.mode } : {}),
      ...(payload.planEnabled !== undefined ? { planEnabled: payload.planEnabled } : {}),
      ...(envelope.type === "sendStrictGoalCommand" ? { goalAcceptance: payload.acceptance } : {}),
      ...(payload.context_refs
        ? {
            sharedContextRefs: payload.context_refs.filter(
              (ref) => ref.kind === "shared_context_import",
            ),
            contextCapsuleRefs: payload.context_refs.filter(
              (ref) => ref.kind === "context_capsule",
            ),
          }
        : {}),
    };
  }
  if (envelope.type === "compact") {
    return { kind: "compact", text: "/compact", attachments: [] };
  }
  if (envelope.type !== "editUserQuery" && envelope.type !== "retryTurn") return null;
  if (!envelope.sessionId) return null;
  const payload = envelope.payload as {
    target: { rowId: number; entityId: string };
    newText?: string;
    attachments?: AttachmentRef[];
    modelSelection?: ConversationInputIntent["modelSelection"];
  };
  const resolution = resolveRowTarget(envelope.sessionId, payload.target, envelope.type);
  if (!resolution?.ok || !resolution.editTarget) return null;
  const canonical = resolution.editTarget;

  // 会先提交 append-only branch cut，不再为 edit 创建 hidden child。
  const originalSourceCommandId =
    canonical.intent.provenance?.sourceCommandId ?? canonical.intent.sourceCommandId;
  return {
    kind: canonical.intent.kind,
    ...(canonical.intent.goalAcceptance ? { goalAcceptance: canonical.intent.goalAcceptance } : {}),
    ...(canonical.intent.mode ? { mode: canonical.intent.mode } : {}),
    ...(canonical.intent.planEnabled !== undefined
      ? { planEnabled: canonical.intent.planEnabled }
      : {}),
    contextCapsuleRefs: resolveHistoricalCapsuleRefs(
      canonical,
      envelope.type === "editUserQuery" ? payload.newText : undefined,
    ),
    text:
      envelope.type === "editUserQuery"
        ? (payload.newText ?? canonical.intent.text)
        : canonical.intent.text,
    ...((payload.modelSelection ?? canonical.intent.modelSelection)
      ? { modelSelection: payload.modelSelection ?? canonical.intent.modelSelection }
      : {}),
    attachments:
      envelope.type === "editUserQuery" && payload.attachments
        ? payload.attachments
        : admissionAttachmentRefs(canonical.intent.attachments),
    ...(canonical.intent.requestedDelivery
      ? { requestedDelivery: canonical.intent.requestedDelivery }
      : {}),
    ...(canonical.intent.admittedDelivery
      ? { admittedDelivery: canonical.intent.admittedDelivery }
      : {}),
    ...(canonical.intent.fallbackReasonCode
      ? { fallbackReasonCode: canonical.intent.fallbackReasonCode }
      : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.intent.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.intent.queueItemId ? { queueItemId: canonical.intent.queueItemId } : {}),
            ...(canonical.intent.clientId ? { clientId: canonical.intent.clientId } : {}),
          },
        }
      : {}),
  };
}

export function isConversationInputAdmissionCommand(type: CommandEnvelope["type"]): boolean {
  return (
    type === "sendText" ||
    type === "sendGoalCommand" ||
    type === "sendStrictGoalCommand" ||
    type === "compact" ||
    type === "editUserQuery" ||
    type === "retryTurn"
  );
}

export function buildForkInitialInput(
  envelope: CommandEnvelope,
  childSessionId: string,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  input: InputCommandForAdmission,
): ForkCommitBundle["initialInput"] {
  const requested = input.requestedDelivery ?? "startNow";
  const fallbackReasonCode = input.fallbackReasonCode;
  const admitted =
    input.admittedDelivery ??
    (fallbackReasonCode ? "queue" : requested === "auto" ? "startNow" : requested);
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind: input.kind,
    text: input.text,
    attachments: input.attachments,
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.planEnabled !== undefined ? { planEnabled: input.planEnabled } : {}),
    ...(input.goalAcceptance ? { goalAcceptance: input.goalAcceptance } : {}),
    ...(input.sharedContextRefs ? { sharedContextRefs: input.sharedContextRefs } : {}),
    ...(input.contextCapsuleRefs ? { contextCapsuleRefs: input.contextCapsuleRefs } : {}),
    delivery: {
      requested,
      admitted,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: { admissionSeq: admission.admissionSeq },
    steer: fallbackReasonCode
      ? { state: "fellBack", reasonCode: fallbackReasonCode }
      : { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: admission.admittedAt,
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return {
    id: admission.queueItemId,
    sessionID: childSessionId as SessionId,
    kind: intent.kind,
    delivery: intent.delivery.admitted,
    payload: {
      text: intent.text,
      conversationInputIntent: intent,
      attachments: intent.attachments,
      sourceCommandType: envelope.type,
    },
  };
}
