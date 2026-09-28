import { Lexer } from "marked";

const MEMORY_INDEX_LINE_LIMIT = 200;
const MEMORY_INDEX_CHARACTER_LIMIT = 25_000;
const LEADING_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

export function formatProjectMemoryIndexContent(content: string): string {
  const withoutFrontmatter = content.replace(LEADING_FRONTMATTER_PATTERN, "");
  return formatMemoryIndexContent(stripTopLevelMarkdownHtmlComments(withoutFrontmatter));
}

export function formatMemoryIndexContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const characterCount = trimmed.length;
  const lineTruncated = lineCount > MEMORY_INDEX_LINE_LIMIT;
  const characterTruncated = characterCount > MEMORY_INDEX_CHARACTER_LIMIT;
  if (!lineTruncated && !characterTruncated) return trimmed;

  let truncated = lineTruncated ? lines.slice(0, MEMORY_INDEX_LINE_LIMIT).join("\n") : trimmed;
  if (truncated.length > MEMORY_INDEX_CHARACTER_LIMIT) {
    const finalNewline = truncated.lastIndexOf("\n", MEMORY_INDEX_CHARACTER_LIMIT);
    truncated = truncated.slice(0, finalNewline > 0 ? finalNewline : MEMORY_INDEX_CHARACTER_LIMIT);
  }

  const sizeDescription =
    characterTruncated && !lineTruncated
      ? `${formatBytes(characterCount)} (limit: ${formatBytes(MEMORY_INDEX_CHARACTER_LIMIT)}) — index entries are too long`
      : lineTruncated && !characterTruncated
        ? `${lineCount} lines (limit: ${MEMORY_INDEX_LINE_LIMIT})`
        : `${lineCount} lines and ${formatBytes(characterCount)}`;

  return `${truncated}\n\n> WARNING: MEMORY.md is ${sizeDescription}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

function formatBytes(value: number): string {
  const kilobytes = value / 1024;
  if (kilobytes < 1) return `${value} bytes`;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/u, "")}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(1).replace(/\.0$/u, "")}MB`;
  return `${(megabytes / 1024).toFixed(1).replace(/\.0$/u, "")}GB`;
}

function stripTopLevelMarkdownHtmlComments(content: string): string {
  if (!content.includes("<!--")) return content;

  let result = "";
  for (const token of new Lexer({ gfm: false }).lex(content)) {
    if (token.type === "html") {
      const trimmedToken = token.raw.trimStart();
      if (trimmedToken.startsWith("<!--") && trimmedToken.includes("-->")) {
        const withoutComments = token.raw.replace(HTML_COMMENT_PATTERN, "");
        // 只删除 Markdown lexer 识别到的顶层 HTML comment token；
        // list、blockquote、paragraph 和 code token 内的 comment 必须保持 provider-visible。
        if (withoutComments.trim().length > 0) result += withoutComments;
        continue;
      }
    }
    result += token.raw;
  }
  return result;
}
