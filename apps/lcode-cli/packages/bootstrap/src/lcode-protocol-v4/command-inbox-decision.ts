// Admission guard 只读 host 真值；FIFO、in-flight/live pin 与 settled 表仍由 CommandInbox 持有。
import type { CommandAck, CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
} from "@lcode/shared/lcode-protocol-v4";
import type { CommandInboxHost } from "./command-inbox-host.js";

export function decideCommand(
  host: CommandInboxHost,
  envelope: CommandEnvelope,
): { kind: "execute"; ack: CommandAck } | { kind: "ack"; ack: CommandAck; remember: boolean } {
  const revision = envelope.sessionId === null ? 0 : host.getRevision(envelope.sessionId);
  if (revision === null || (envelope.type !== "createSession" && envelope.sessionId === null)) {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: "proto.sessionNotFound",
        revisionAtDecision: 0,
      },
    };
  }

  if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
    if (envelope.baseRevision === undefined) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "proto.missingBaseRevision",
          revisionAtDecision: revision,
        },
      };
    }
    const logEpoch = envelope.sessionId === null ? null : host.getLogEpoch(envelope.sessionId);
    if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch !== logEpoch) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleLogEpoch",
          revisionAtDecision: revision,
        },
      };
    }
    if (envelope.baseRevision !== revision) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: "proto.staleRevision",
          revisionAtDecision: revision,
        },
      };
    }
  }

  const targetDecision = host.validateRowTarget?.(envelope);
  if (targetDecision?.verdict === "stale") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "stale",
        reasonCode: targetDecision.reasonCode,
        message: targetDecision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (targetDecision?.verdict === "reject") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: targetDecision.reasonCode,
        message: targetDecision.message,
        revisionAtDecision: revision,
      },
    };
  }

  const decision = host.guard?.(envelope) ?? {
    verdict: "allow" as const,
  };
  if (decision.verdict === "stale") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "stale",
        reasonCode: decision.reasonCode,
        message: decision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (decision.verdict === "reject") {
    return {
      kind: "ack",
      remember: false,
      ack: {
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: decision.reasonCode,
        message: decision.message,
        revisionAtDecision: revision,
      },
    };
  }
  if (decision.verdict === "noop") {
    return {
      kind: "ack",
      remember: true,
      ack: {
        commandId: envelope.commandId,
        status: "noop",
        reasonCode: decision.reasonCode,
        revisionAtDecision: revision,
        result: decision.result,
      },
    };
  }
  return {
    kind: "execute",
    ack: {
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: revision,
    },
  };
}
