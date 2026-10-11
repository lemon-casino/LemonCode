import { stripVTControlCharacters } from "node:util";
import type { ClaudeSpawner } from "./claude-process.js";
import { record, text } from "./common.js";
import { claudeQuotaReset } from "./claude-quota-time.js";

interface ClaudeQuota {
  windows: { name: string; used: number; resetsAt?: string }[];
  error?: "request_failed";
  supported?: false;
}
const denied =
  /\b(?:401|403)\b|not (?:logged|signed) in|signed out|sign-in (?:has )?expired|unauthorized|forbidden|authentication (?:failed|required)|invalid (?:access )?token|(?:session|usage) limit|hit your limit|using your overages/iu;

/** Only parsed allowance facts leave the CLI boundary; no raw stdout or stderr escapes. */
export function parseClaudeUsage(raw: string, now = Date.now()): ClaudeQuota {
  const lines = stripVTControlCharacters(raw)
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (lines.some((line) => denied.test(line))) return { windows: [], error: "request_failed" };
  if (
    lines.some((line) =>
      /(?:unknown|unrecognized|unsupported) (?:slash )?command[^\n]*\/?usage/iu.test(line),
    )
  )
    return { windows: [], supported: false };
  const windows: ClaudeQuota["windows"] = [];
  for (const line of lines) {
    const match =
      /^Current (session|week(?: \(([A-Za-z][A-Za-z0-9 ._-]{0,40})\))?):\s*([0-9.]+)% used(?:\s*·\s*resets (.+))?$/iu.exec(
        line,
      );
    if (!match) continue;
    const used = Number(match[3]);
    if (!Number.isFinite(used) || used < 0 || used > 100) continue;
    const weekly = match[1]!.toLowerCase() !== "session",
      scope = match[2]?.trim();
    const name = weekly
      ? `7 days${scope && scope.toLowerCase() !== "all models" ? ` · ${scope}` : ""}`
      : "5 hours";
    if (windows.some((w) => w.name === name)) continue;
    const reset = match[4]
      ? claudeQuotaReset(match[4], now, weekly ? 604800000 : 18000000)
      : undefined;
    windows.push({ name, used, ...(reset ? { resetsAt: reset } : {}) });
  }
  return { windows };
}

export async function runClaudeQuota(
  spawn: ClaudeSpawner,
  dir: string,
  signal: AbortSignal,
  timeoutMs = 25000,
): Promise<ClaudeQuota> {
  signal.throwIfAborted();
  let child: Awaited<ReturnType<ClaudeSpawner>>;
  try {
    child = await spawn(
      [
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
      ],
      dir,
      {
        // 默认调用桥会关闭非必要流量；/usage必须允许它自己的额度请求，显式用户环境设置仍保留。
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
          process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    );
  } catch {
    signal.throwIfAborted();
    return { windows: [], supported: false };
  }
  const result = await new Promise<{ code: number | null; out: string; failed: boolean }>(
    (resolve) => {
      let size = 0,
        failed = false;
      const chunks: Buffer[] = [];
      const stop = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, timeoutMs);
      const collect = (chunk: Buffer | string, stdout: boolean) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 262144) {
          stop();
          return;
        }
        if (stdout) chunks.push(bytes);
      };
      child.stdout.on("data", (chunk) => collect(chunk, true));
      child.stderr.on("data", (chunk) => collect(chunk, false));
      child.once("error", stop);
      signal.addEventListener("abort", stop, { once: true });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        child.removeListener("error", stop);
        resolve({ code, out: failed ? "" : Buffer.concat(chunks).toString("utf8"), failed });
      });
      child.stdin.end();
      if (signal.aborted) stop();
    },
  );
  signal.throwIfAborted();
  if (result.failed || result.code !== 0) return { windows: [], error: "request_failed" };
  let output: unknown;
  try {
    output = JSON.parse(result.out);
  } catch {
    return { windows: [] };
  }
  // 消费方仍使用 ES2022 lib；复制后倒序查找保留最后一个 result 的语义，不依赖 findLast。
  const response = record(
    Array.isArray(output)
      ? output
          .slice()
          .reverse()
          .find((value: unknown) => record(value).type === "result")
      : output,
  );
  if (response.is_error === true) return { windows: [], error: "request_failed" };
  return parseClaudeUsage(text(response.result));
}
