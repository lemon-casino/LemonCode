/** 只识别 Host 的固定依赖错误码；RPC/厂商错误正文可能含私有数据，禁止原样展示。 */
export function getProviderAccountDependencyError(
  cause: unknown,
): "claudeCliRequired" | "grokCliRequired" | null {
  const value =
    typeof cause === "string"
      ? cause
      : cause && typeof cause === "object" && "message" in cause
        ? cause.message
        : undefined;
  if (value === "OAUTH_CLAUDE_CLI_REQUIRED") return "claudeCliRequired";
  if (value === "OAUTH_GROK_CLI_REQUIRED") return "grokCliRequired";
  return null;
}
