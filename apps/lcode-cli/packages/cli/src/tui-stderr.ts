import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";

const MAX_BUFFERED_CHARACTERS = 64 * 1024;

interface TuiStderrInterceptor {
  readonly bufferedOutput: string;
  readonly passthrough: NodeJS.WriteStream;
  restore(options?: { flush?: boolean }): void;
}

export function isTuiInvocation(argv: readonly string[]): boolean {
  let parsed: ReturnType<typeof parseGlobalArgs>;

  try {
    // 与 run 共享参数定义，包括 locale/browser/force-mcs 和多值工具限制。
    parsed = parseGlobalArgs(extractDisallowedToolsArgs(argv).args);
  } catch {
    return false;
  }

  if (
    parsed.values.help === true ||
    parsed.values.version === true ||
    typeof parsed.values.prompt === "string" ||
    typeof parsed.values.target === "string"
  ) {
    return false;
  }

  return (parsed.positionals[0] ?? "tui") === "tui";
}

export function interceptTuiStderr(stderr: NodeJS.WriteStream): TuiStderrInterceptor {
  const originalWrite = stderr.write;
  let bufferedOutput = "";
  let restored = false;
  const passthrough = Object.create(stderr) as NodeJS.WriteStream;
  type WriteCallback = (err?: Error | null) => void;

  const writeOriginal = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    if (typeof encodingOrCallback === "function") {
      return originalWrite.call(stderr, chunk, undefined, encodingOrCallback);
    }

    if (typeof encodingOrCallback === "string") {
      return originalWrite.call(stderr, chunk, encodingOrCallback, callback);
    }

    return originalWrite.call(stderr, chunk);
  };

  passthrough.write = writeOriginal as NodeJS.WriteStream["write"];

  // TUI owns the full terminal. Raw stderr emitted during startup, including
  // Node runtime warnings from static imports, corrupts the screen.
  stderr.write = ((chunk, encodingOrCallback, callback) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    bufferedOutput = (bufferedOutput + stringifyChunk(chunk, encoding)).slice(
      -MAX_BUFFERED_CHARACTERS,
    );

    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (writeCallback) queueMicrotask(() => writeCallback());

    return true;
  }) as NodeJS.WriteStream["write"];

  return {
    get bufferedOutput() {
      return bufferedOutput;
    },
    passthrough,
    restore(options = {}) {
      if (restored) return;
      restored = true;
      stderr.write = originalWrite;

      if (options.flush === true && bufferedOutput.length > 0) {
        originalWrite.call(stderr, bufferedOutput);
      }
    },
  };
}

function stringifyChunk(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
}
