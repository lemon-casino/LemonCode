import {
  PROVIDER_NETWORK_BACKEND_VERSION,
  getProviderNetworkDiagnostics,
} from "@lcode/provider-node/network";
import {
  LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS as NAME_MAX,
  LCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS as MESSAGE_MAX,
  LCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS as STACK_MAX,
  LCODE_PROCESS_DIAGNOSTIC_CAUSES_MAX as CAUSES_MAX,
  LCODE_PROCESS_DIAGNOSTIC_FRAMES_MAX as FRAMES_MAX,
  LCODE_PROCESS_DIAGNOSTIC_FRAME_MAX_CHARS as FRAME_MAX,
  LCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS as LINE_MAX,
  LCODE_PROCESS_DIAGNOSTIC_PREFIX as PREFIX,
  type LCodeProcessDiagnostic,
} from "@lcode/shared/process-diagnostic";

declare const __CLI_VERSION__: string | undefined;
const STACK_EXCERPT_CHARS = 3_000;

function readErrorField(reason: unknown, key: string): unknown {
  try {
    return reason instanceof Error ? Reflect.get(reason, key) : undefined;
  } catch {
    return undefined;
  }
}
function errorString(reason: unknown, key: string, fallback = ""): string {
  const value = readErrorField(reason, key);
  return typeof value === "string" ? value : fallback;
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) return errorString(reason, "message", "Unreadable process error");
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return "Unserializable process error";
  }
}
function detail(reason: unknown) {
  const allFrames =
    reason instanceof Error
      ? errorString(reason, "stack")
          .split("\n")
          .filter((line) => /^\s+at /.test(line))
      : [];
  const half = FRAMES_MAX / 2;
  const frames = (
    allFrames.length > FRAMES_MAX
      ? [...allFrames.slice(0, half), ...allFrames.slice(-half)]
      : allFrames
  ).map((frame) => frame.slice(0, FRAME_MAX));
  const code = readErrorField(reason, "code");
  return {
    name: (errorString(reason, "name", "Error") || "Error").slice(0, NAME_MAX),
    message: errorText(reason).slice(0, MESSAGE_MAX),
    ...(typeof code === "string" || typeof code === "number"
      ? { code: String(code).slice(0, NAME_MAX) }
      : {}),
    frames,
    framesTruncated:
      allFrames.length > FRAMES_MAX || allFrames.some((frame) => frame.length > FRAME_MAX),
  };
}

/** 压缩断言的源码不能挤掉调用栈；先独立提取 frames，再裁剪中间摘录。 */
export function createProcessDiagnostic(
  errorId: string,
  kind: "uncaughtException" | "unhandledRejection",
  origin: string,
  reason: unknown,
): LCodeProcessDiagnostic {
  const { framesTruncated, ...root } = detail(reason);
  const rawStack = errorString(reason, "stack");
  const stack =
    rawStack.length <= STACK_MAX
      ? rawStack
      : `${root.name}: ${root.message}\n${rawStack.slice(0, STACK_EXCERPT_CHARS)}\n[stack excerpt truncated]\n${root.frames.join("\n")}`.slice(
          0,
          STACK_MAX,
        );
  const seen = new Set<unknown>([reason]);
  const causes: Array<Omit<ReturnType<typeof detail>, "framesTruncated">> = [];
  let causesTruncated = false;
  const pending: unknown[] = [];
  const enqueueCauses = (error: unknown) => {
    const cause = readErrorField(error, "cause");
    if (cause !== undefined) pending.push(cause);
    // 清理层使用 AggregateError 保存独立资源故障；只读 cause 会丢掉全部底层错误码。
    const errors = error instanceof AggregateError ? readErrorField(error, "errors") : undefined;
    if (Array.isArray(errors)) {
      pending.push(...errors.slice(0, CAUSES_MAX));
      if (errors.length > CAUSES_MAX) causesTruncated = true;
    }
  };
  enqueueCauses(reason);
  while (pending.length && causes.length < CAUSES_MAX) {
    const cause = pending.shift();
    if (seen.has(cause)) {
      causesTruncated = true;
      continue;
    }
    seen.add(cause);
    const { framesTruncated: _truncated, ...item } = detail(cause);
    causes.push(item);
    enqueueCauses(cause);
  }
  const diagnostic: Extract<LCodeProcessDiagnostic, { version: 2 }> = {
    version: 2,
    errorId,
    kind,
    origin: origin === "unhandledRejection" ? origin : "uncaughtException",
    ...root,
    ...(stack ? { stack } : {}),
    causes,
    truncated: {
      messageChars: errorText(reason).length,
      stackChars: rawStack.length,
      frames: framesTruncated,
      causes: causesTruncated || pending.length > 0,
    },
    runtime: {
      node: process.versions.node,
      ...(process.versions.electron ? { electron: process.versions.electron } : {}),
      undici: PROVIDER_NETWORK_BACKEND_VERSION,
      cli: typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "source",
    },
    occurredAt: Date.now(),
    network: getProviderNetworkDiagnostics(),
  };
  // 字段限长不能限制 JSON 转义后的帧长；保留原长度元数据，按实际 wire 大小收敛。
  while (PREFIX.length + JSON.stringify(diagnostic).length > LINE_MAX) {
    if ((diagnostic.stack?.length ?? 0) > 1_024)
      diagnostic.stack = diagnostic.stack!.slice(0, diagnostic.stack!.length / 2);
    else if (diagnostic.causes.length) {
      diagnostic.causes.pop();
      diagnostic.truncated.causes = true;
    } else if (diagnostic.frames.length > 2) {
      diagnostic.frames = [diagnostic.frames[0]!, diagnostic.frames.at(-1)!];
      diagnostic.truncated.frames = true;
    } else diagnostic.message = diagnostic.message.slice(0, diagnostic.message.length / 2);
  }
  return diagnostic;
}
