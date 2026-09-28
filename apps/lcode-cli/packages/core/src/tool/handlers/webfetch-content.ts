import type { ToolExecutionContext } from "../types.js";
import { MAX_MODEL_INPUT_CHARS, WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";
import { webFetchError } from "./webfetch-errors.js";
import { traceFromContext } from "./webfetch-trace.js";

export function extractReadableContent(body: Uint8Array, contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isTextLikeMime(mime)) {
    throw webFetchError("FetchFailed", `Unsupported WebFetch content type: ${mime || "unknown"}`, {
      contentType,
    });
  }

  const text = new TextDecoder().decode(body);
  if (mime === "text/html" || mime === "application/xhtml+xml" || contentType.includes("html")) {
    return htmlToMarkdown(text);
  }
  return text.trim();
}

export async function maybePersistRawContent(
  content: string,
  contentType: string,
  context: ToolExecutionContext,
): Promise<{ path?: string; uri: string } | undefined> {
  if (!context.artifactStore) return undefined;
  if (Buffer.byteLength(content, "utf8") <= MAX_MODEL_INPUT_CHARS) return undefined;

  const artifact = await context.artifactStore.writeToolResultArtifact(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      toolName: WEBFETCH_TOOL_NAME,
      content,
      contentType: contentType.includes("html") ? "text/markdown" : "text/plain",
      retention: "session",
      trace: traceFromContext(context),
    },
    { signal: context.abortSignal },
  );

  return { path: artifact.path, uri: artifact.uri };
}

export function truncateContentForModel(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_MODEL_INPUT_CHARS) {
    return { content, truncated: false };
  }

  const suffix = "\n\n[WebFetch content truncated before prompt processing]";
  const maxBodyChars = Math.max(0, MAX_MODEL_INPUT_CHARS - suffix.length);
  return {
    content: `${content.slice(0, maxBodyChars)}${suffix}`,
    truncated: true,
  };
}

function htmlToMarkdown(html: string): string {
  let content = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

  content = content
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(content)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function isTextLikeMime(mime: string): boolean {
  if (mime.length === 0) return true;
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}
