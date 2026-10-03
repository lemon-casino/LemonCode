import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
} from "@lcode/shared/lcode-protocol-v4";

export function worktreePreparationFingerprint(envelope: CommandEnvelope): string | undefined {
  if (envelope.type !== "createSession" || envelope.sessionId !== null) return undefined;
  const payload = envelope.payload as CommandPayloadMap["createSession"];
  if (payload.execution?.mode !== "worktree") return undefined;
  return JSON.stringify({ ...payload, execution: { ...payload.execution, retrySetup: undefined } });
}

export function isExplicitWorktreePreparationRetry(
  envelope: CommandEnvelope,
  ack: CommandAck,
  failedFingerprint?: string,
): boolean {
  if (
    ack.status !== "failed" ||
    ack.reasonCode !== "fault.command.worktreePreparationFailed" ||
    !failedFingerprint
  )
    return false;
  const payload = envelope.payload as CommandPayloadMap["createSession"];
  return (
    payload.execution?.retrySetup === true &&
    worktreePreparationFingerprint(envelope) === failedFingerprint
  );
}
