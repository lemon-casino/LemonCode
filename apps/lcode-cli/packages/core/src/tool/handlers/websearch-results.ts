import {
  WebSearchOutputSchema,
  modelMessageContentToText,
  type ModelSource,
  type ModelTextResult,
  type ModelToolResult,
  type ModelUsage,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchResultItem,
  type WebSearchSource,
} from "@lcode/contracts";

const MAX_SOURCE_LINKS = 20;

export function buildWebSearchOutput(
  input: WebSearchInput,
  result: ModelTextResult,
  startedAt: number,
): WebSearchOutput {
  const results = dedupeResults(extractResults(result.toolResults));
  const summary = result.text.trim() || undefined;
  const sources = dedupeSources([
    ...extractSourcesFromModelSources(result.sources),
    ...extractSourcesFromResults(results),
    ...extractSourcesFromToolResults(result.toolResults),
    ...extractSourcesFromSummary(summary),
  ]);
  const modelUsage = hasModelUsage(result.usage) ? result.usage : undefined;

  return {
    query: input.query,
    results,
    sources,
    summary,
    durationMs: Date.now() - startedAt,
    webSearchRequests: result.usage.serverToolUse?.webSearchRequests,
    modelUsage,
  };
}

export function formatWebSearchModelContent(output: unknown): string {
  const parsed = WebSearchOutputSchema.safeParse(output);
  if (!parsed.success) return modelMessageContentToText(JSON.stringify(output) ?? "");

  const data = parsed.data;
  const links = dedupeSources([
    ...data.sources,
    ...extractSourcesFromResults(data.results),
  ]).slice(0, MAX_SOURCE_LINKS);
  const lines = [`Web search results for query: "${data.query}"`, ""];

  if (data.summary) {
    lines.push("Summary:", data.summary, "");
  }

  if (links.length > 0) {
    lines.push("Links:");
    for (const source of links) {
      lines.push(`- [${source.title ?? source.url}](${source.url})`);
    }
  } else {
    lines.push("Links:", "- No links found.");
  }

  lines.push(
    "",
    "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
  );
  return lines.join("\n").trim();
}

function extractResults(toolResults: ModelToolResult[] | undefined): WebSearchResultItem[] {
  return (toolResults ?? []).flatMap((toolResult) => collectResults(toolResult.output));
}

function collectResults(value: unknown): WebSearchResultItem[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectResults(item));
  if (!isRecord(value)) return [];

  const url = stringValue(value.url);
  const type = stringValue(value.type);
  if (url && (!type || type === "web_search_result" || type === "url")) {
    return [{ url, title: nullableString(value.title), pageAge: nullableString(value.pageAge) }];
  }

  if (Array.isArray(value.content)) {
    return value.content.flatMap((item) => collectResults(item));
  }
  if (Array.isArray(value.sources)) return value.sources.flatMap((source) => collectResults(source));
  return [];
}

function extractSourcesFromModelSources(sources: ModelSource[] | undefined): WebSearchSource[] {
  return (sources ?? [])
    .filter((source) => source.sourceType === "url" && typeof source.url === "string")
    .map((source) => ({ url: source.url!, title: source.title }));
}

function extractSourcesFromResults(results: WebSearchResultItem[]): WebSearchSource[] {
  return results.map((result) => ({ url: result.url, title: result.title }));
}

function extractSourcesFromToolResults(
  toolResults: ModelToolResult[] | undefined,
): WebSearchSource[] {
  return (toolResults ?? []).flatMap((toolResult) => collectSources(toolResult.output));
}

function extractSourcesFromSummary(summary: string | undefined): WebSearchSource[] {
  if (!summary) return [];

  // WebSearch 内部请求改为流式后，provider 的引用有时只出现在
  // summary markdown 中，而不会经过 ModelStreamEvent 暴露为 sources/toolResults。
  const sources: WebSearchSource[] = [];
  const markdownLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of summary.matchAll(markdownLinkPattern)) {
    if (match.index !== undefined && summary[match.index - 1] === "!") {
      continue;
    }
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (!url) continue;
    sources.push({ url, title: title || undefined });
  }

  return sources;
}

function collectSources(value: unknown): WebSearchSource[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectSources(item));
  if (!isRecord(value)) return [];

  const url = stringValue(value.url);
  if (url) return [{ url, title: nullableString(value.title) }];
  if (Array.isArray(value.content)) {
    return value.content.flatMap((item) => collectSources(item));
  }
  if (Array.isArray(value.sources)) return value.sources.flatMap((source) => collectSources(source));
  return [];
}

function dedupeResults(results: WebSearchResultItem[]): WebSearchResultItem[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSources(sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasModelUsage(usage: ModelUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.serverToolUse?.webSearchRequests !== undefined ||
    usage.serverToolUse?.webFetchRequests !== undefined
  );
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
