const EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";

/**
 * 空工具名恢复只服务于模型 continuation，不应物化为用户可见工具行。
 * 固定占位字符串也可能是 registry / MCP / alias 的合法工具名，不能单独作为隐藏依据。
 * live 只识别原始空名；cold/legacy 还要求占位名与持久化原名 metadata 同时存在。
 */
export function shouldHideInvalidToolCallFromProduct(
  toolName: unknown,
  metadata?: Record<string, unknown>,
): boolean {
  if (typeof toolName !== "string") return false;
  if (toolName.trim().length === 0) return true;

  const providerToolName = metadata?.providerToolName;
  return (
    toolName === EMPTY_TOOL_NAME_PLACEHOLDER &&
    providerToolName !== undefined &&
    typeof providerToolName === "string" &&
    providerToolName.trim().length === 0
  );
}
