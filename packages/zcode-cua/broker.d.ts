export declare const BROKER_SOCKET_ENV: "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export declare const BROKER_UNAVAILABLE_ENV: "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
export declare const BROKER_CAPABILITY_ENV: "ZCODE_CUA_PERMISSION_BROKER_CAPABILITY";
export declare const BROKER_GENERATION_ENV: "ZCODE_CUA_PERMISSION_BROKER_GENERATION";

export declare const BROKER_PROTOCOL_ID: "zcode.cua/broker";
export declare const BROKER_PROTOCOL_VERSION: 1;
export declare const MAX_BROKER_REQUEST_BYTES: number;
export declare const MAX_BROKER_RESPONSE_BYTES: number;

export interface BrokerErrorOptions {
  code?: string;
  details?: unknown;
  possiblySent?: boolean;
  retryable?: boolean;
}

export declare class BrokerError extends Error {
  code: string;
  details?: unknown;
  possiblySent?: boolean;
  retryable?: boolean;
  constructor(message?: string, options?: BrokerErrorOptions);
}

export declare class CuaHelperError extends Error {
  code: string;
  details?: unknown;
  possiblySent?: boolean;
  retryable?: boolean;
  constructor(message?: string, options?: BrokerErrorOptions);
}

export declare function isCuaHelperError(value: unknown): value is CuaHelperError;

export interface HelperBootstrapRequest {
  protocol: "zcode-cua-windows-dev/v1";
  type: "bootstrap_request";
  pid: number;
  nonce: string;
}

export interface HelperBootstrapCredentials {
  protocol: "zcode-cua-windows-dev/v1";
  type: "bootstrap_credentials";
  pid: number;
  nonce: string;
  capability: string;
  generation: number;
}

export declare function createHelperBootstrapRequest(options: {
  pid: number;
  nonce?: string;
}): HelperBootstrapRequest;
export declare function parseHelperBootstrapRequest(
  value: unknown,
): HelperBootstrapRequest | undefined;
export declare function createHelperBootstrapCredentials(options: {
  pid: number;
  nonce: string;
  capability: string;
  generation: number;
}): HelperBootstrapCredentials;
export declare function parseHelperBootstrapCredentials(
  value: unknown,
): HelperBootstrapCredentials | undefined;

export declare const notAuthorized: (message?: string, details?: unknown) => BrokerError;
export declare const notSelectable: (message?: string, details?: unknown) => BrokerError;
export declare const notSettable: (message?: string, details?: unknown) => BrokerError;
export declare const elementUnavailable: (message?: string, details?: unknown) => BrokerError;
export declare const actionUnavailable: (message?: string, details?: unknown) => BrokerError;
export declare const foregroundRequired: (message?: string, details?: unknown) => BrokerError;

export type BrokerRequestId = string | number;
export type BrokerErrorCode = string;
export type CuaHelperErrorCode = string;
export type BrokerMethod =
  | "ping"
  | "broker_info"
  | "permission_status"
  | "execute"
  | "close_session"
  | "shutdown";
export type ReadOnlyBrokerMethod = "ping" | "broker_info" | "permission_status";

export interface BrokerRequest {
  id: BrokerRequestId;
  protocol: typeof BROKER_PROTOCOL_ID;
  version: typeof BROKER_PROTOCOL_VERSION;
  capability: string | null;
  generation: number | null;
  method: BrokerMethod;
  params: Record<string, unknown>;
}

export interface AuthenticatedBrokerRequest extends BrokerRequest {
  capability: string;
  generation: number;
}

export interface AnonymousBrokerRequest extends BrokerRequest {
  capability: null;
  generation: null;
  method: "ping" | "broker_info" | "permission_status";
}

export type BrokerResponseMeta = Record<string, unknown>;

export interface BrokerSuccessResponse<T = unknown> {
  id?: BrokerRequestId;
  ok: true;
  result: T;
  responseMeta?: BrokerResponseMeta;
}

export interface BrokerErrorPayload {
  code: BrokerErrorCode;
  message: string;
  details?: unknown;
  possibly_sent?: boolean;
  retryable?: boolean;
}

export interface BrokerFailureResponse {
  id?: BrokerRequestId;
  ok: false;
  error: BrokerErrorPayload;
}

export type BrokerResponse<T = unknown> = BrokerSuccessResponse<T> | BrokerFailureResponse;

interface CallBrokerMethodBaseArgs {
  socketPath: string;
  method: BrokerMethod;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CallBrokerMethodArgs = CallBrokerMethodBaseArgs &
  (
    | { capability: string; generation: number }
    | {
        method: "ping" | "broker_info" | "permission_status";
        capability?: never;
        generation?: never;
      }
  );

export declare function callBrokerMethod<T = unknown>(args: CallBrokerMethodArgs): Promise<T>;

export interface HelperHealth {
  bundleId: string | null;
  pid: number | null;
}

interface ProbeHelperHealthBaseOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  perTryTimeoutMs?: number;
  signal?: AbortSignal;
}

export type ProbeHelperHealthOptions = ProbeHelperHealthBaseOptions &
  ({ capability?: never; generation?: never } | { capability: string; generation: number });

export declare function probeHelperHealth(
  socketPath: string,
  options?: ProbeHelperHealthOptions,
): Promise<HelperHealth>;

export interface SocketPathOptions {
  dir?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
}

export declare function mintBrokerSocketPath(options?: SocketPathOptions): string;
export declare function resolveBrokerSocketPath(options?: SocketPathOptions): string;

export declare function parseRequestLine(line: string): BrokerRequest | undefined;

export interface SuccessResponseOptions {
  id?: BrokerRequestId;
  responseMeta?: BrokerResponseMeta;
}

export interface ErrorResponseOptions {
  id?: BrokerRequestId;
  code?: BrokerErrorCode;
  details?: unknown;
  possiblySent?: boolean;
  retryable?: boolean;
}

export declare function okResponse<T = unknown>(
  result: T,
  options?: SuccessResponseOptions,
): BrokerSuccessResponse<T>;
export declare function errorResponse(
  message: string,
  options?: ErrorResponseOptions,
): BrokerFailureResponse;
export declare function errorResponseFromException(
  error: unknown,
  options?: ErrorResponseOptions,
): BrokerFailureResponse;
export declare function serializeResponse(response: BrokerResponse): string;

export interface BrokerHandlerContext {
  request: BrokerRequest;
  anonymous: boolean;
  readOnly: boolean;
}

export interface BrokerDispatchEnvelope<T = unknown> {
  result: T;
  responseMeta: BrokerResponseMeta;
}

export interface BrokerHandler {
  (
    params: Record<string, unknown>,
    context: BrokerHandlerContext,
  ): unknown | BrokerDispatchEnvelope | Promise<unknown | BrokerDispatchEnvelope>;
}

export interface NativeAutomationBackend {
  authorize?: (request: AuthenticatedBrokerRequest) => boolean | Promise<boolean>;
  dispatch?: (
    method: BrokerMethod,
    params: Record<string, unknown>,
    context: BrokerHandlerContext,
  ) => unknown | BrokerDispatchEnvelope | Promise<unknown | BrokerDispatchEnvelope>;
  ping?: BrokerHandler;
  broker_info?: BrokerHandler;
  permission_status?: BrokerHandler;
  execute?: BrokerHandler;
  close_session?: BrokerHandler;
  shutdown?: BrokerHandler;
}

export declare function dispatchRequest(
  backend: NativeAutomationBackend,
  request: BrokerRequest,
): Promise<BrokerResponse>;
export declare function handleRequestLine(
  backend: NativeAutomationBackend,
  line: string,
): Promise<BrokerResponse>;

export declare function isBrokerMethod(method: unknown): method is BrokerMethod;
export declare function isReadOnlyBrokerMethod(method: unknown): method is ReadOnlyBrokerMethod;

export type CuaPermissionState = "granted" | "stale" | "denied" | "unknown";

export interface CuaPermissionStatus {
  available?: true;
  platform?: string;
  grantOwner: string | null;
  owner?: { display_name?: string } | null;
  accessibility: CuaPermissionState;
  accessibility_probe_ok?: boolean;
  accessibilityProbeOk?: boolean;
  grantOwnerDisplayName?: string | null;
  screenRecording: CuaPermissionState;
  screenCaptureProbeOk?: boolean;
  idle?: boolean;
  reason?: string;
}

export interface CuaPermissionStatusUnavailable {
  available: false;
  reason: string;
  idle?: boolean;
  grantOwnerDisplayName?: string | null;
}

export type CuaPermissionStatusResult = CuaPermissionStatus | CuaPermissionStatusUnavailable;

export interface CuaPermissionStatusQueryOptions {
  probeScreenCapture?: boolean;
  [key: string]: unknown;
}

export interface CuaPermissionRestartResult {
  ok: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface CuaPermissionRestartOptions {
  onboardingSessionId?: string;
  reason?: string;
  beforeFreshStart?: () => void;
  [key: string]: unknown;
}

export interface ICuaPermissionService {
  getStatus(
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CuaPermissionStatusQueryOptions,
  ): Promise<CuaPermissionStatusResult>;
  restartHelper(
    workspacePath?: string,
    workspaceIdentity?: string,
    options?: CuaPermissionRestartOptions,
  ): Promise<CuaPermissionRestartResult>;
}
