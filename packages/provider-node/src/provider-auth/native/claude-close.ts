import type { ChildProcessWithoutNullStreams } from "node:child_process";

const GRACEFUL_CLOSE_MS = 150;
const FORCE_CLOSE_MS = 350;

/** 只操作原 child；stdin EOF 给 CLI 机会落盘，实际 close 后才允许删 profile。 */
export function closeClaudeChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.on("error", () => {});
  child.stdin.end();
  const terminate = setTimeout(() => child.kill(), GRACEFUL_CLOSE_MS);
  const force = setTimeout(() => child.kill("SIGKILL"), FORCE_CLOSE_MS);
  const clear = () => {
    clearTimeout(terminate);
    clearTimeout(force);
  };
  void closed.then(clear, clear);
}
