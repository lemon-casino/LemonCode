import type { PipSessionEvent, PipSessionSnapshot } from "./pip-session.d.ts";

export interface PipSessionApplyResult {
  applied: boolean;
  reason?: string;
}

export interface PipSessionClientOptions {
  socketPath?: string;
  capability?: string;
  generation?: number;
  timeoutMs?: number;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
  getSnapshot?: () => PipSessionSnapshot | Promise<PipSessionSnapshot>;
  peerChecker?: (peer: unknown) => boolean;
  onDiagnostic?: (diagnostic: { code: string; message?: string }) => void;
}

export interface PipSessionClient {
  enabled: boolean;
  connect(): Promise<void>;
  send(event: PipSessionEvent): Promise<PipSessionApplyResult>;
  close(): void;
}

export declare function createPipSessionClient(options?: PipSessionClientOptions): PipSessionClient;
