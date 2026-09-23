export interface ComputerUseRuntimeContext {
  sessionId: string;
  runtimeScope: "main" | "subagent";
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  turnId?: string;
  clientMode?: "web-remote-replayable" | "desktop-continuous";
  deliveryKind?: "web-remote-replayable" | "desktop-continuous";
  trace?: Record<string, unknown>;
}

export interface ComputerUseRuntimeExecuteInput {
  toolName: string;
  arguments?: unknown;
  context: ComputerUseRuntimeContext;
  signal?: AbortSignal;
}

export interface ComputerUseRuntime {
  execute(input: ComputerUseRuntimeExecuteInput): Promise<unknown>;
  closeSession(context: ComputerUseRuntimeContext): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * 低频异常路径的可选日志注入点（结构兼容 @zcode/contracts 的 Logger）。
 * 缺省零日志；runtime 只落 warn（门拒绝、驱动动作异常、dispose 失败），禁 console。
 */
export interface ComputerUseRuntimeLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}

export interface ComputerUseRuntimeOptions {
  brokerSocketPath?: string;
  /** Helper broker 的进程级 capability；必须与 socket 同批下发。 */
  brokerCapability?: string;
  /** transport credential generation。缺省为兼容代次 0。 */
  brokerGeneration?: number;
  refreshMarkerPath?: string;
  ensureBrokerAvailable?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  logger?: ComputerUseRuntimeLogger;
  /** 仅供包内本地驱动 seam 使用；产品入口不会在 node_repl 进程执行驱动。 */
  isKnownKeyName?: (name: string) => boolean;
}

export declare function createComputerUseRuntime(
  options?: ComputerUseRuntimeOptions,
): ComputerUseRuntime;
