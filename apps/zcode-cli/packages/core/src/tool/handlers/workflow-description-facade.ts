/**
 * 工具描述每轮都会进入模型上下文，而编译器 facade 里的长 JSDoc 已由按需加载的 workflow skill
 * 详细解释。这里只保留同源的声明形状；编译仍使用原始 facade，因此不会形成第二套 API 合同。
 */
export function compactWorkflowFacadeForDescription(source: string): string {
  return source
    .replace(/\/\*\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
