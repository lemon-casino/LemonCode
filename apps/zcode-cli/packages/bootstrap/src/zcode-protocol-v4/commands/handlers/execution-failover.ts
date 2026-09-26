import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

const ACTIVE_EXECUTION_CHANGED = "guard.activeExecutionChanged";

async function setExecutionFailoverTarget(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setExecutionFailoverTarget"];
  const record = requireRecord(host, envelope.sessionId);
  const result = await record.app.runtime.setExecutionFailoverTarget({
    sourceCommandId: envelope.commandId,
    modelSelection: payload.modelSelection,
    observedTargets: payload.observedTargets,
    traceContext: record.traceContext,
  });
  if (result === "stale") {
    throw new V4CommandNoopError(ACTIVE_EXECUTION_CHANGED);
  }
  return undefined;
}

export const executionFailoverHandlers = { setExecutionFailoverTarget };
