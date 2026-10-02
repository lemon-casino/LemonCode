import { parse as parseYaml } from "yaml";

import { MEMORY_RECALL_TYPES, type MemoryRecallType } from "./types.js";

export interface ParsedMemoryDocument {
  body: string;
  description?: string;
  type?: MemoryRecallType;
  /** Valid metadata.lcode.validUntil as UTC epoch milliseconds; parsing does not filter. */
  validUntilMs?: number;
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
  const lcode = isRecord(metadata?.lcode) ? metadata.lcode : undefined;
  const validUntilMs = parseValidUntil(lcode?.validUntil);

  return {
    body: lines
      .slice(end + 1)
      .join("\n")
      .trimStart(),
    ...(rawDescription ? { description: rawDescription } : {}),
    ...(type ? { type } : {}),
    ...(validUntilMs === undefined ? {} : { validUntilMs }),
  };
}

const ISO_EXPIRY =
  /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/u;

function parseValidUntil(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = ISO_EXPIRY.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // Date.parse 会把 2 月 30 日归一到 3 月；非法旧字段不能意外让稳定偏好过期。
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryRecallType(value: unknown): value is MemoryRecallType {
  return typeof value === "string" && (MEMORY_RECALL_TYPES as readonly string[]).includes(value);
}
