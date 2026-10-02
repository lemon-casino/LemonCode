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
  const subjectEnd = message.search(/\r?\n/);
  const rawSubject = (subjectEnd < 0 ? message : message.slice(0, subjectEnd)).trim();
  // 中文依据：真实模型会把正确标题包为 Markdown 行内代码/加粗；仅去掉成对首行包装，
  // 不扫描解释性正文找标题、不补造 type，正文中的代码和格式必须保持原样。
  const inlineCode = /^(`{1,2})([^`\r\n]+)\1$/.exec(rawSubject);
  const bold = /^\*\*([^\r\n]+)\*\*$/.exec(rawSubject);
  const subject = (inlineCode?.[2] ?? bold?.[1] ?? rawSubject).trim();
  if (!CONVENTIONAL_COMMIT_RE.test(subject))
    return { ok: false, reason: "invalid", preview: subject || message.slice(0, 120) };
  return { ok: true, message: subject + (subjectEnd < 0 ? "" : message.slice(subjectEnd)) };
}
