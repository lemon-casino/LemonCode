function comparableCheckoutPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  // Git 的 worktreepath 在 Windows 使用正斜线；POSIX 路径仍需保留大小写，不能匹配另一目录。
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function findBranchWorktree<T extends { branch: string; checkoutPath: string }>(
  bindings: T[],
  branchName: string,
  checkedOutPath: string | null | undefined,
): T | undefined {
  if (!checkedOutPath) return undefined;
  const expected = comparableCheckoutPath(checkedOutPath);
  return bindings.find(
    (binding) =>
      binding.branch === branchName && comparableCheckoutPath(binding.checkoutPath) === expected,
  );
}
