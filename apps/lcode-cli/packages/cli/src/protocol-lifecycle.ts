import { PassThrough } from "node:stream";
import { flushE2ECoverage } from "./shutdown.js";

const PROTOCOL_SHUTDOWN_TIMEOUT_MS = 1_500;
const PROTOCOL_INPUT_DRAIN_MS = 100;
const COVERAGE_FLUSH_ALLOWANCE_MS = 500;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/** CLI 入口的唯一退出 owner；在加载 runtime 之前安装，不依赖 run() 返回。 */
export function createProtocolProcessLifecycle(
  options: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    timeoutMs?: number;
    exitProcess?: (code: number) => void;
  } = {},
) {
  const source = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const input = new PassThrough();
  const controller = new AbortController();
  const exit = options.exitProcess ?? ((code: number) => process.exit(code));
  let deadlineAt: number | undefined;
  let exitCode = 0;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let completion: Promise<void> | undefined;

  const stop = (error?: Error, code = error ? 1 : 0) => {
    if (deadlineAt !== undefined) return;
    exitCode = code;
    const timeoutMs =
      options.timeoutMs ??
      PROTOCOL_SHUTDOWN_TIMEOUT_MS +
        (process.env.LCODE_E2E_COVERAGE === "1" ? COVERAGE_FLUSH_ALLOWANCE_MS : 0);
    deadlineAt = Date.now() + timeoutMs;
    // 保持 ref：即使初始化 Promise 永不 settle、已经没有 IO，也必须交付终态。
    deadlineTimer = setTimeout(() => exit(exitCode), timeoutMs);
    if (error) controller.abort(error);
    else
      drainTimer = setTimeout(
        () => controller.abort(new Error("Protocol input closed")),
        PROTOCOL_INPUT_DRAIN_MS,
      );
  };
  const onInputEnd = () => stop();
  const onIoError = (error: Error) => stop(error);
  const onOutputClose = () => stop(new Error("Protocol output closed"));
  const signals =
    process.platform === "win32"
      ? (["SIGINT", "SIGTERM"] as const)
      : (["SIGINT", "SIGTERM", "SIGHUP"] as const);
  for (const signal of signals) {
    const listener = () =>
      stop(new Error(`Protocol received ${signal}`), SIGNAL_EXIT_CODES[signal]);
    // on 而不是 once：重复信号不绕过清理，也不重置首次 deadline。
    process.on(signal, listener);
  }
  source.on("end", onInputEnd);
  source.on("close", onInputEnd);
  source.on("error", onIoError);
  output.on("error", onIoError);
  output.on("close", onOutputClose);
  input.on("error", onIoError);
  // 启动阶段就消费原始 stdin 来观察父端 EOF；背压缓冲保留尚未被协议消费的字节。
  source.pipe(input);
  if ((source as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded) onInputEnd();

  return {
    input,
    signal: controller.signal,
    get deadlineAt() {
      return deadlineAt;
    },
    requestShutdown: stop,
    complete(code: number): Promise<void> {
      completion ??= (async () => {
        stop(code === 0 ? undefined : new Error("Protocol command failed"), code);
        if (drainTimer) clearTimeout(drainTimer);
        controller.abort(new Error("Protocol command completed"));
        await Promise.all([flush(output), flush(stderr), flushE2ECoverage()]);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        exit(exitCode);
      })();
      return completion;
    },
  };
}

function flush(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    if (!stream.writable) return resolve();
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}
