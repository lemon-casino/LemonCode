import { parse as parseYaml } from "yaml";

import { MEMORY_RECALL_TYPES, type MemoryRecallType } from "./types.js";

export interface ParsedMemoryDocument {
  body: string;
  description?: string;
  type?: MemoryRecallType;
}

export function parseMemoryDocument(content: string): ParsedMemoryDocument {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return { body: normalized };

  const end = lines.indexOf("---", 1);
  if (end < 0) return { body: normalized };

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    return { body: normalized };
  }
  if (!isRecord(parsed))
    return {
      body: lines
        .slice(end + 1)
        .join("\n")
        .trimStart(),
    };

  const rawDescription =
    typeof parsed.description === "string" ? parsed.description.trim() : undefined;
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;
  const typeCandidate = metadata?.type ?? parsed.type;
  const type = isMemoryRecallType(typeCandidate) ? typeCandidate : undefined;

  return {
    body: lines
      .slice(end + 1)
      .join("\n")
      .trimStart(),
    ...(rawDescription ? { description: rawDescription } : {}),
    ...(type ? { type } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryRecallType(value: unknown): value is MemoryRecallType {
  return typeof value === "string" && (MEMORY_RECALL_TYPES as readonly string[]).includes(value);
}
