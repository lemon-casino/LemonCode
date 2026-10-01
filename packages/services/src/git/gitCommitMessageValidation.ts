const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/;
export function validateGeneratedGitCommitMessage(
  rawMessage: string,
): { ok: true; message: string } | { ok: false; reason: "empty" | "invalid"; preview?: string } {
  const trimmed = rawMessage.trim();
  const fence = /^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  let message = (fence?.[1] ?? trimmed).replace(/^commit message:\s*/i, "").trim();
  if (
    (message.startsWith('"') && message.endsWith('"')) ||
    (message.startsWith("'") && message.endsWith("'"))
  )
    message = message.slice(1, -1);
  message = message.trim().slice(0, 1000).trim();
  if (!message) return { ok: false, reason: "empty" };
  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!CONVENTIONAL_COMMIT_RE.test(subject))
    return { ok: false, reason: "invalid", preview: subject || message.slice(0, 120) };
  return { ok: true, message };
}
