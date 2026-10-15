/** 进程入口持有的首次关闭事实；仅内部契约，不是客户端授权或 wire 元数据。 */
export interface ProtocolShutdownContext {
  readonly closeId: string;
  readonly origin:
    | "stdin_eof"
    | "stdin_close"
    | "input_error"
    | "output_error"
    | "output_close"
    | "signal"
    | "runtime_failure"
    | "command_completed";
  readonly requestedAt: number;
  readonly deadlineAt: number;
  readonly processId: number;
  readonly transportAvailable: boolean;
  readonly signal?: string;
}
