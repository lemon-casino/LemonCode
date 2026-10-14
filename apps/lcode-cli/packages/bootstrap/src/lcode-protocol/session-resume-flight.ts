import type { MessageWithParts, SessionInfo } from "@lcode/contracts";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export interface ActivatedSessionForResume {
  record: LCodeProtocolSessionRecord;
  knownSession?: SessionInfo;
  persistedMessages?: MessageWithParts[];
}

/** context 是唯一执行 owner；projection READY 水位仍由 gateway 管理。 */
export function withSessionResumeFlight(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  activate: () => Promise<ActivatedSessionForResume>,
): Promise<ActivatedSessionForResume> {
  const flights = (context.sessionResumeFlights ??= new Map());
  const existing = flights.get(sessionId);
  if (existing) return existing;
  const flight = Promise.resolve()
    .then(activate)
    .finally(() => {
      if (flights.get(sessionId) === flight) flights.delete(sessionId);
    });
  flights.set(sessionId, flight);
  return flight;
}
