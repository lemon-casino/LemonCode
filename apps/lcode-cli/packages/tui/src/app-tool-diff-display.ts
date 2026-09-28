import type {
  ToolResultDisplay,
  ToolResultDisplayHunk,
  ToolResultDisplayLine,
} from "./app-model.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { asRecord, booleanField, numberField, stringField } from "./state.js";

const MAX_DIFF_LINES = 12;
const MAX_DIFF_LINE_WIDTH = 100;

export function formatFileDiffDisplay(display: Record<string, unknown>): ToolResultDisplay {
  const structuredPatch = structuredPatchField(display);
  const lines = formatUnifiedDiffLines(structuredPatch);
  const sourceLineCount = diffSourceLineCount(structuredPatch);
  const truncated = booleanField(display, "truncated") || sourceLineCount > lines.length;

  if (truncated) {
    appendTruncationLine(lines);
  }

  const filePath = stringField(display, "filePath");
  return {
    diff: formatUnifiedPatch(display),
    filePath,
    lines,
    structuredPatch,
    truncated,
  };
}

function appendDiffLine(
  lines: ToolResultDisplayLine[],
  text: string,
  tone: ToolResultDisplayLine["tone"],
): void {
  if (lines.length >= MAX_DIFF_LINES) return;
  lines.push({ text: truncateDisplay(text, MAX_DIFF_LINE_WIDTH), tone });
}

function formatUnifiedDiffLines(structuredPatch: ToolResultDisplayHunk[]): ToolResultDisplayLine[] {
  const lines: ToolResultDisplayLine[] = [];

  for (const hunk of structuredPatch) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const rawLine of hunk.lines) {
      const marker = diffMarker(rawLine);
      const lineLabel = marker === "+" ? String(newLine) : String(oldLine);
      // 窄屏只保留一列行号，避免旧/新双行号把正文挤出可读区域。
      appendDiffLine(lines, `${lineLabel.padStart(4)} ${rawLine}`, toneForDiffMarker(marker));
      if (marker !== "+") oldLine += 1;
      if (marker !== "-") newLine += 1;
    }
  }

  return lines;
}

function appendTruncationLine(lines: ToolResultDisplayLine[]): void {
  if (lines.length >= MAX_DIFF_LINES) {
    lines[MAX_DIFF_LINES - 1] = { text: "... diff truncated", tone: "meta" };
    return;
  }
  appendDiffLine(lines, "... diff truncated", "meta");
}

function diffMarker(line: string): string {
  return line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ";
}

function toneForDiffMarker(marker: string): ToolResultDisplayLine["tone"] {
  if (marker === "+") return "addition";
  if (marker === "-") return "deletion";
  return "context";
}

function diffSourceLineCount(structuredPatch: ToolResultDisplayHunk[]): number {
  return structuredPatch.reduce<number>((count, hunk) => count + hunk.lines.length, 0);
}

function formatUnifiedPatch(display: Record<string, unknown>): string | undefined {
  const hunks = arrayField(display, "structuredPatch");
  if (hunks.length === 0) return undefined;

  const filePath = sanitizePatchPath(stringField(display, "filePath") ?? "file");
  const patchLines = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const hunk of hunks) {
    const hunkRecord = asRecord(hunk);
    const oldStart = numberField(hunkRecord, "oldStart") ?? 0;
    const oldLines = numberField(hunkRecord, "oldLines") ?? 0;
    const newStart = numberField(hunkRecord, "newStart") ?? 0;
    const newLines = numberField(hunkRecord, "newLines") ?? 0;
    patchLines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    patchLines.push(...stringArrayField(hunkRecord, "lines"));
  }

  return patchLines.join("\n");
}

function sanitizePatchPath(filePath: string): string {
  return filePath.replace(/[\r\n]/gu, " ");
}

function structuredPatchField(record: Record<string, unknown>): ToolResultDisplayHunk[] {
  return arrayField(record, "structuredPatch").flatMap((hunk) => {
    const hunkRecord = asRecord(hunk);
    const oldStart = numberField(hunkRecord, "oldStart");
    const oldLines = numberField(hunkRecord, "oldLines");
    const newStart = numberField(hunkRecord, "newStart");
    const newLines = numberField(hunkRecord, "newLines");
    const lines = stringArrayField(hunkRecord, "lines");
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    ) {
      return [];
    }
    return [
      {
        lines,
        newLines,
        newStart,
        oldLines,
        oldStart,
      },
    ];
  });
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((item): item is string => typeof item === "string");
}
