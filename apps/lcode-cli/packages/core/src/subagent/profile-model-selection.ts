import { parseSubagentMarkdownSelection, type ModelSelection } from "@lcode/shared";

/** Host/Agent 共用正式 Markdown codec；Provider 迁移必须先在用户存储边界完成。 */
export function resolveProfileModelSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  return parseSubagentMarkdownSelection(frontmatter);
}
