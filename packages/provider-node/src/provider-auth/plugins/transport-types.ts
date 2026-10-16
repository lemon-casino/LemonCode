import type { AuthDriverContext, AuthGrant } from "../driver.js";
import type { ProviderAuthorizationDiagnostic } from "@lcode/shared";
export interface PendingCall {
  /** Node Request 的取消 controller 使用弱引用；只持有 signal 不够，须保留 Request 到流结算。 */
  readonly requestOwner?: Request;
  observeAuthorization?: (diagnostic: ProviderAuthorizationDiagnostic) => void;
  resolve(value: unknown): void;
  reject(error: Error): void;
  context?: AuthDriverContext;
  cleanup(): void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  settled: boolean;
  aborted: boolean;
}

export type WorkerMessage = {
  kind:
    | "result"
    | "response"
    | "chunk"
    | "end"
    | "error"
    | "credential"
    | "disposed"
    | "refresh-end"
    | "authorization-diagnostic";
  id: number;
  value?: unknown;
  error?: {
    message: string;
    name?: string;
    signIn?: string;
    diagnostic?: ProviderAuthorizationDiagnostic;
  };
  diagnostic?: unknown;
  action?: "read" | "write" | "signin" | "refresh-begin";
  admitted?: boolean;
  signIn?: "expired" | "kept" | "renewed";
  grant?: AuthGrant;
  callId?: number;
  operationId?: number;
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  bytes?: Uint8Array;
};
