import type { DeclarationIssue, ProjectDeclarations } from "./declarations.js";
import { checkEnginesConstraint } from "./engines.js";

/**
 * 工具选择纯逻辑（spec §6.1/§6.2）：声明优先级、应用默认回退、engines 检查、冲突汇总。
 * 纯函数无 IO；service 只消费结果。
 */

export interface SelectedTool {
  key: string;
  version: string;
  source: "project-declaration" | "app-default";
}

export function selectToolsForFreeze(
  declarations: ProjectDeclarations,
  appDefaults: ReadonlyArray<{ key: string; version: string }>,
): {
  tools: SelectedTool[];
  issues: DeclarationIssue[];
} {
  const issues = [...declarations.issues];
  // 非精确声明（如 "22" 范围）不进冻结清单；范围→确切版本的解析在 M2（spec §6.1 范围解析持久化）。
  const exact = declarations.tools.filter((tool) => tool.exact);
  const keys = new Set<string>([
    ...exact.map((tool) => tool.key),
    ...appDefaults.map((tool) => tool.key),
  ]);
  const tools: SelectedTool[] = [...keys].map((key) => {
    const declared = exact.find((tool) => tool.key === key);
    const fallback = appDefaults.find((tool) => tool.key === key);
    return {
      key,
      version: declared ? declared.constraint : (fallback?.version ?? "0.0.0"),
      source: declared ? "project-declaration" : "app-default",
    };
  });
  const node = tools.find((tool) => nodeKeyMatches(tool) && tool.source === "project-declaration");
  if (declarations.engines && node) {
    const violation = checkEnginesConstraint(node.version, declarations.engines);
    if (violation) issues.push(violation);
  }
  return { tools, issues };
}

function nodeKeyMatches(tool: SelectedTool): boolean {
  return tool.key === "node";
}
