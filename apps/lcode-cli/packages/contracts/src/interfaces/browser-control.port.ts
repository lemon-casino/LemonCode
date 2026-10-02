import type { TraceContext } from "../tracing/tracer.js";
import type { BrowserCommand } from "./browser-control/commands.js";
import type { BrowserBackendDescriptor } from "./browser-control/context.js";
import type { BrowserCommandResult } from "./browser-control/results.js";

export interface BrowserControlExecuteInput {
  /** 精确 runtime backend id；不能只传 iab/extension/cdp family。 */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlPort {
  /** 父 runtime 派生受控子作用域；保留子资源身份，路由与撤销由端口所有者负责。 */
  createChildScope?(input: { parentSessionId: string; sessionId: string }): BrowserControlPort;
  /** 只返回完成握手且当前 context 可达的 backend，不允许伪造 stub。 */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** turn 结束时取消该 turn 尚未完成的 IAB 请求，不跨 session 清 tab。 */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** session 关闭时释放 browser guest、pending request 与 lease。 */
  closeSession?(input: BrowserControlListInput): Promise<void>;
}

export { BROWSER_VIEWPORT_LIMITS } from "./browser-control/context.js";

export type {
  BrowserBackendType,
  BrowserCapabilityDescriptor,
  BrowserBackendDescriptor,
  BrowserBackendListResult,
  BrowserClientMode,
  BrowserSessionContextKind,
  BrowserViewportSize,
  BrowserDiscoveryContext,
  BrowserSessionContext,
  BrowserMouseButton,
  BrowserKeyModifier,
  BrowserPoint,
} from "./browser-control/context.js";

export type {
  BrowserPlaywrightModifier,
  BrowserPlaywrightLocatorOperation,
  BrowserPlaywrightAction,
  BrowserRecordingAction,
  BrowserRecordingOptions,
  BrowserRecordingArtifact,
  BrowserRecordingJob,
} from "./browser-control/actions.js";

export type { BrowserCommandMethod, BrowserCommand } from "./browser-control/commands.js";

export type {
  BrowserErrorCode,
  BrowserPageState,
  BrowserSnapshotElement,
  BrowserSnapshotDomNode,
  BrowserSnapshot,
  BrowserTabSummary,
  BrowserUserTabInfo,
  BrowserResponseMeta,
  BrowserDialog,
  BrowserCommandResult,
} from "./browser-control/results.js";
