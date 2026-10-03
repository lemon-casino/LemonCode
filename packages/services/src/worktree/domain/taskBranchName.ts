/** 可读名称只用于 Git ref；稳定身份仍由 taskId/bindingId 提供。 */
export function taskBranchName(taskName?: string): string {
  const firstLine = (taskName ?? "").split(/[\r\n]/u, 1)[0] ?? "";
  // 原因：随机 ID 无法表达任务；直接用正文又会带入非法 ref 和路径字符。
  // 保留 Unicode 字母（含中文）和数字，按字符截断避免切断代理对。
  const normalized = firstLine.normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-");
  const name = Array.from(normalized.replace(/-+/gu, "-").replace(/^[-_]+|[-_]+$/gu, ""))
    .slice(0, 24)
    .join("")
    .replace(/[-_]+$/gu, "");
  return `lcode/task-${name || "新会话"}`;
}
