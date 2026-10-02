import {
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  type PermissionBrokerRequest,
} from "@lcode/contracts";

import type { V4InteractionRegistrationOptions } from "../lcode-protocol-v4/interaction-registry.js";

import type { LCodeProtocolAgentServerContext } from "./server-types.js";

export function createInteractionRegistrationOptions(
  request: PermissionBrokerRequest,
  kind: V4InteractionRegistrationOptions["kind"],
  context?: LCodeProtocolAgentServerContext,
  initialAutoResolution?: V4InteractionRegistrationOptions["initialAutoResolution"],
): V4InteractionRegistrationOptions {
  return {
    sessionId: String(request.sessionId),
    kind,
    ...(initialAutoResolution ? { initialAutoResolution } : {}),
    ...(kind === "askUserQuestion" && context
      ? {
          onAutoResolutionUpdated: async (autoResolution) => {
            const record = context.sessions?.get(String(request.sessionId));
            if (!record) return;
            try {
              await record.app.runtime.recordUserInputAutoResolutionUpdate({
                interactionId: request.requestId,
                toolCallId: request.toolCallId,
                autoResolution,
                traceContext: {
                  ...record.traceContext,
                  traceId: request.traceId,
                  turnId: request.turnId,
                },
              });
            } catch (error) {
              context.logger?.error(
                "Failed to persist user input auto-resolution state",
                error instanceof Error ? error : new Error(String(error)),
                {
                  interactionId: request.requestId,
                  sessionId: request.sessionId,
                },
              );
            }
          },
        }
      : {}),
  };
}

export async function readPersistedAutoResolution(
  context: LCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
): Promise<V4InteractionRegistrationOptions["initialAutoResolution"]> {
  const sessionStore = context.deps?.sessionStore;
  if (!sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: request.sessionId,
      type: SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
    });
    const matching = entries
      .filter((entry) => {
        const data = isRecord(entry.data) ? entry.data : {};
        return (
          data.interactionId === request.requestId &&
          String(data.toolCallId ?? "") === String(request.toolCallId)
        );
      })
      .sort((left, right) => right.time.updated - left.time.updated)[0];
    if (!matching || !isRecord(matching.data)) return undefined;
    return parsePersistedAutoResolution(matching.data.autoResolution);
  } catch (error) {
    context.logger?.warn("Failed to restore user input auto-resolution state", {
      error: error instanceof Error ? error.message : String(error),
      event: "lcode_protocol.user_input_auto_resolution_restore_failed",
      interactionId: request.requestId,
      module: "bootstrap.lcode_protocol",
      sessionId: request.sessionId,
    });
    return undefined;
  }
}

function parsePersistedAutoResolution(
  value: unknown,
): V4InteractionRegistrationOptions["initialAutoResolution"] {
  if (!isRecord(value) || typeof value.startedAt !== "number") return undefined;
  if (
    (value.state === "hiddenGrace" || value.state === "visibleCountdown") &&
    typeof value.visibleAt === "number" &&
    typeof value.deadlineAt === "number"
  ) {
    return {
      state: value.state,
      startedAt: value.startedAt,
      visibleAt: value.visibleAt,
      deadlineAt: value.deadlineAt,
    };
  }
  if (value.state === "snoozed" && typeof value.snoozedAt === "number") {
    return {
      state: "snoozed",
      startedAt: value.startedAt,
      snoozedAt: value.snoozedAt,
    };
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
