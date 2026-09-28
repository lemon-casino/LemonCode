import { structuredPatch } from "diff";
import type { DiffHunk, TurnFileChangeSummary } from "../deps.js";
import type { RuntimeTurnFileChangeMap } from "../types.js";

const DIFF_TIMEOUT_MS = 5_000;

export function recordTurnFileChange(
  changes: RuntimeTurnFileChangeMap,
  input: {
    afterContent?: string;
    beforeContent: string | null;
    path: string;
    structuredPatch: DiffHunk[];
    toolName: string;
  },
): void {
  const fallback = countPatchLines(input.structuredPatch);
  const existing = changes.get(input.path);
  if (!existing) {
    changes.set(input.path, {
      afterContent: input.afterContent,
      beforeContent: input.beforeContent,
      fallbackAdditions: fallback.additions,
      fallbackDeletions: fallback.deletions,
      path: input.path,
      toolNames: new Set([input.toolName]),
      writeCount: 1,
    });
    return;
  }

  existing.afterContent = input.afterContent ?? existing.afterContent;
  existing.fallbackAdditions += fallback.additions;
  existing.fallbackDeletions += fallback.deletions;
  existing.toolNames.add(input.toolName);
  existing.writeCount += 1;
}

export function buildTurnFileChangeSummary(
  changes: RuntimeTurnFileChangeMap,
): TurnFileChangeSummary | undefined {
  if (changes.size === 0) return undefined;

  const items = Array.from(changes.values())
    .map((entry) => {
      const stat =
        entry.afterContent === undefined
          ? {
              additions: entry.fallbackAdditions,
              deletions: entry.fallbackDeletions,
            }
          : diffLineStat(entry.beforeContent ?? "", entry.afterContent, entry.path);
      return {
        additions: stat.additions,
        deletions: stat.deletions,
        path: entry.path,
        toolNames: Array.from(entry.toolNames).sort(),
        writeCount: entry.writeCount,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    files: items.length,
    items,
  };
}

function diffLineStat(
  beforeContent: string,
  afterContent: string,
  filePath: string,
): { additions: number; deletions: number } {
  return countPatchLines(
    structuredPatch(filePath, filePath, beforeContent, afterContent, undefined, undefined, {
      timeout: DIFF_TIMEOUT_MS,
    })?.hunks ?? [],
  );
}

function countPatchLines(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }

  return { additions, deletions };
}
