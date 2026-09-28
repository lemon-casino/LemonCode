import { InternalChannels, type RemoteTarget } from "@lcode/shared";

export interface RemoteWorkspaceServicePortRegistration {
  attachmentId: string;
  port: MessagePort;
  sessionId: string;
  target: RemoteTarget;
}

export function parseRemoteWorkspaceServicePortMessage(
  event: MessageEvent,
): RemoteWorkspaceServicePortRegistration | null {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    !("type" in event.data) ||
    event.data.type !== InternalChannels.ScopedServicePort
  ) {
    return null;
  }
  const port = event.ports[0];
  const attachmentId = typeof event.data.attachmentId === "string" ? event.data.attachmentId : null;
  const sessionId = typeof event.data.sessionId === "string" ? event.data.sessionId : null;
  const target = "target" in event.data ? (event.data.target as RemoteTarget | null) : null;
  if (!port || !attachmentId || !sessionId || !target) return null;
  return { attachmentId, port, sessionId, target };
}

export function notifyRemoteWorkspaceServicePortReady(
  payload: Pick<RemoteWorkspaceServicePortRegistration, "attachmentId" | "sessionId">,
  postMessage: (message: unknown, targetOrigin: string) => void = window.postMessage.bind(window),
): void {
  postMessage(
    {
      type: InternalChannels.ScopedServicePortReady,
      attachmentId: payload.attachmentId,
      sessionId: payload.sessionId,
    },
    "*",
  );
}
