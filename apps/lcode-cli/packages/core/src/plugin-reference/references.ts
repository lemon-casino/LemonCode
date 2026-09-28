// Plugin 对话引用的严格 canonical 解析。
// 契约：
// - 只接受 Markdown 链接 destination 形如 `plugin://stable-id`，协议名大小写敏感（仅小写）。
// - stable-id 必须是 `name@marketplace`，两段均匹配 [A-Za-z0-9][A-Za-z0-9._-]*，总长 ≤ 256。
// - 拒绝 query、fragment、credentials、空白、控制字符和 `%`（不做隐式 percent-decoding）。
// - 身份只来自 destination；label 永不参与解析。

const PLUGIN_REFERENCE_SCHEME = "plugin://";
// 与 mentionMarkdown 的链接语法保持一致：label 支持 \ 转义，destination 支持 <...> 或裸形式。
const MARKDOWN_LINK_PATTERN =
  /\[(?:\\.|[^\\\]])*\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)\s])*))\)/g;
const PLUGIN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MAX_PLUGIN_REFERENCES_PER_TURN = 8;
const MAX_PLUGIN_STABLE_ID_LENGTH = 256;

/**
 * 校验一个候选字符串是否为严格合法的 Plugin stable ID（`name@marketplace`）。
 * 该校验同时用于 parser 和 reminder 输出侧的防御（fail closed）。
 */
export function isValidPluginStableId(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_PLUGIN_STABLE_ID_LENGTH) {
    return false;
  }
  const separatorIndex = candidate.indexOf("@");
  if (separatorIndex <= 0 || separatorIndex !== candidate.lastIndexOf("@")) {
    return false;
  }
  const name = candidate.slice(0, separatorIndex);
  const marketplace = candidate.slice(separatorIndex + 1);
  // 段级字符集校验即完整安全边界：query/fragment/credentials/空白/控制字符/% 都不在
  // [A-Za-z0-9._-] 集合内，一律拒绝，不做任何隐式 percent-decoding 或宽容匹配。
  return PLUGIN_ID_SEGMENT_PATTERN.test(name) && PLUGIN_ID_SEGMENT_PATTERN.test(marketplace);
}

function parsePluginDestination(destination: string): string | null {
  // 协议名大小写敏感：`Plugin://`、`PLUGIN://` 都不接受。
  if (!destination.startsWith(PLUGIN_REFERENCE_SCHEME)) {
    return null;
  }
  const stableId = destination.slice(PLUGIN_REFERENCE_SCHEME.length);
  if (!isValidPluginStableId(stableId)) {
    return null;
  }
  return stableId;
}

function isPluginSchemeDestination(destination: string): boolean {
  // 只把"意图上是 plugin 协议"的 destination 计入 invalid 统计；
  // 大小写变体（Plugin:// 等）也算意图命中但解析失败，防 label 欺骗绕过统计。
  return /^plugin:\/\//i.test(destination);
}

export interface ExtractPluginReferencesResult {
  /** 按正文首次出现顺序、按 stable ID 去重后的引用。 */
  references: string[];
  /** 超过单轮上限被丢弃的引用次数（fail closed，调用侧记 debug truncated）。 */
  truncatedCount: number;
  /** 命中 plugin 协议意图但解析失败的 destination 数量（unknown 之前的格式级拒绝）。 */
  invalidCount: number;
}

/**
 * 从 canonical 用户文本中提取 Plugin 引用（stable ID）。
 * 身份只来自链接 destination；Markdown label 完全不参与。
 */
export function extractPluginReferences(input: string): ExtractPluginReferencesResult {
  const references: string[] = [];
  const seen = new Set<string>();
  let truncatedCount = 0;
  let invalidCount = 0;

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of input.matchAll(MARKDOWN_LINK_PATTERN)) {
    const destination = match[1] ?? match[2] ?? "";
    if (!isPluginSchemeDestination(destination)) {
      continue;
    }
    const stableId = parsePluginDestination(destination);
    if (stableId === null) {
      invalidCount++;
      continue;
    }
    if (seen.has(stableId)) {
      continue;
    }
    if (references.length >= MAX_PLUGIN_REFERENCES_PER_TURN) {
      truncatedCount++;
      continue;
    }
    seen.add(stableId);
    references.push(stableId);
  }

  return { references, truncatedCount, invalidCount };
}
