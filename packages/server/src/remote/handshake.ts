import type { HelloMessage, HelloAckMessage } from "@lcode/shared";
import { LCODE_VERSION, formatZodError, helloMessageSchema } from "@lcode/shared";
import type { StdioStream } from "./backend.js";

const MAX_HANDSHAKE_DIAGNOSTIC_CHARS = 2048;

export interface HandshakeResult {
  hello: HelloMessage;
  /** Remaining data after the handshake line (to be fed into RPC) */
  remaining: Buffer | null;
}

/**
 * Perform the client-side handshake:
 * 1. Read lines from stdout until we find a lcode-hello JSON
 *    (skip SSH banner/motd lines)
 * 2. Send a lcode-hello-ack to stdin
 * 3. Return the hello info and any remaining data
 */
export function performHandshake(
  stream: StdioStream,
  clientId: string,
  timeoutMs = 10_000,
): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stdoutText = "";
    let stderrText = "";
    let settled = false;

    const rejectWithDiagnostics = (message: string, exitCode?: number) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        new Error(
          formatHandshakeFailure(message, {
            exitCode,
            stdout: stdoutText,
            stderr: stderrText,
          }),
        ),
      );
    };

    const timeout = setTimeout(() => {
      rejectWithDiagnostics("Handshake timeout: no lcode-hello received within timeout");
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      buffer += text;
      stdoutText = appendLimited(stdoutText, text);

      // Process line by line
      while (true) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) break;

        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        // Try to parse as hello message
        if (line.startsWith("{")) {
          try {
            const rawValue = JSON.parse(line);
            const result = helloMessageSchema.safeParse(rawValue);
            if (result.success) {
              if (settled) {
                return;
              }
              settled = true;
              cleanup();

              // Send ack
              const ack: HelloAckMessage = {
                type: "lcode-hello-ack",
                version: LCODE_VERSION,
                clientId,
              };
              stream.stdin.write(JSON.stringify(ack) + "\n");

              resolve({
                hello: result.data as HelloMessage,
                remaining: buffer.length > 0 ? Buffer.from(buffer, "utf-8") : null,
              });
              return;
            }
            if (
              rawValue &&
              typeof rawValue === "object" &&
              "type" in rawValue &&
              (rawValue as { type?: unknown }).type === "lcode-hello"
            ) {
              rejectWithDiagnostics(`Invalid lcode-hello: ${formatZodError(result.error)}`);
              return;
            }
          } catch {
            // Not JSON, skip (SSH banner line)
          }
        }
        // Non-JSON lines are treated as SSH banner/motd — skip
      }
    };

    const onStderrData = (chunk: Buffer) => {
      stderrText = appendLimited(stderrText, chunk.toString("utf-8"));
    };

    stream.stdout.on("data", onData);
    stream.stderr.on("data", onStderrData);

    const closeDisposable = stream.onClose((code) => {
      rejectWithDiagnostics("Stream closed before handshake completed", code);
    });

    const cleanup = () => {
      clearTimeout(timeout);
      stream.stdout.removeListener("data", onData);
      stream.stderr.removeListener("data", onStderrData);
      closeDisposable.dispose();
    };
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_HANDSHAKE_DIAGNOSTIC_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - MAX_HANDSHAKE_DIAGNOSTIC_CHARS);
}

function formatHandshakeFailure(
  message: string,
  diagnostics: {
    exitCode?: number;
    stdout: string;
    stderr: string;
  },
): string {
  const parts = [message];
  if (diagnostics.exitCode !== undefined) {
    parts.push(`exit code ${diagnostics.exitCode}`);
  }
  const stderr = diagnostics.stderr.trim();
  if (stderr.length > 0) {
    parts.push(`stderr: ${JSON.stringify(stderr)}`);
  }
  const stdout = diagnostics.stdout.trim();
  if (stdout.length > 0) {
    // 远端 server 在 hello 前退出时，真正原因只存在 stdout/stderr。
    // 如果错误只保留“握手关闭”，SSH 启动失败会在 host/main 日志中被压成无上下文的 {}。
    parts.push(`stdout: ${JSON.stringify(stdout)}`);
  }
  return parts.length === 1 ? message : `${message} (${parts.slice(1).join("; ")})`;
}
