import type { Event, IDisposable } from "@lcode/rpc";
import type { LCodeProtocolMessage } from "@lcode/shared";

export type LCodeProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface LCodeProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface LCodeProtocolTransport extends IDisposable {
  readonly kind: LCodeProtocolTransportKind;
  readonly onMessage: Event<LCodeProtocolMessage>;
  readonly onClose: Event<LCodeProtocolTransportClosedEvent>;
  send(message: LCodeProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
