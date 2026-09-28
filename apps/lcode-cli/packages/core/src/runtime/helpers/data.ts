import type { DiffHunk } from "../deps.js";

export function isRuntimeDiffHunk(value: unknown): value is DiffHunk {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.keys(value).slice(0, 20);
}

export function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
