import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTransport } from "./adapter-types.js";

export const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;

export function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
      }
    },
    read() {
      return value;
    },
  };
}

export function sanitizeMcpStdioStderr(text: string): string {
  const sensitiveKey = String.raw`(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  result = result.replace(
    new RegExp(`(["']${sensitiveKey}["']\\s*:\\s*)(["'])(?:(?!\\2).)*\\2`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}

export function getStdioTransportPid(transport?: McpTransport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) return undefined;
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function getStdioTransportExitInfo(transport?: McpTransport):
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | undefined {
  return transport instanceof ProcessTreeStdioClientTransport ? transport.processExit : undefined;
}

export function isStdioTransportProcessAlive(transport?: McpTransport): boolean {
  return transport instanceof ProcessTreeStdioClientTransport && transport.processAlive;
}
