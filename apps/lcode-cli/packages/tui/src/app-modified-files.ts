import { formatToolFilePath } from "./app-tool-path-display.js";
import { asRecord, numberField, stringField } from "./state.js";

const FILE_DIFF_DISPLAY_KIND = "file_diff";
const FILE_DIFFS_DISPLAY_KIND = "file_diffs";
const MAX_SESSION_MODIFIED_FILES = 100;

export type ModifiedFileStat = {
  additions: number;
  deletions: number;
  filePath: string;
};

export function modifiedFileStatsFromToolResultPayload(
  payload: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ModifiedFileStat[] {
  const result = asRecord(payload.result);
  const display = asRecord(result.display);
  const kind = stringField(display, "kind");

  if (kind === FILE_DIFF_DISPLAY_KIND) {
    return compactStats([modifiedFileStatFromDisplay(display, workspaceDirectory)]);
  }

  if (kind === FILE_DIFFS_DISPLAY_KIND) {
    const files = Array.isArray(display.files) ? display.files : [];
    return compactStats(
      files.map((file) => modifiedFileStatFromDisplay(asRecord(file), workspaceDirectory)),
    );
  }

  return [];
}

export function applyModifiedFileStats(
  current: ModifiedFileStat[],
  incoming: ModifiedFileStat[],
): ModifiedFileStat[] {
  let next = current;
  for (const stat of incoming) {
    next = upsertModifiedFileStat(next, stat);
  }
  return next.slice(0, MAX_SESSION_MODIFIED_FILES);
}

function upsertModifiedFileStat(
  current: ModifiedFileStat[],
  incoming: ModifiedFileStat,
): ModifiedFileStat[] {
  const existing = current.find((stat) => stat.filePath === incoming.filePath);
  const updated: ModifiedFileStat = {
    additions: (existing?.additions ?? 0) + incoming.additions,
    deletions: (existing?.deletions ?? 0) + incoming.deletions,
    filePath: incoming.filePath,
  };

  return [updated, ...current.filter((stat) => stat.filePath !== incoming.filePath)];
}

function modifiedFileStatFromDisplay(
  display: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ModifiedFileStat | undefined {
  const rawPath = stringField(display, "filePath");
  const filePath = formatToolFilePath(rawPath, workspaceDirectory);
  if (!filePath) return undefined;

  return {
    additions: nonNegativeCount(numberField(display, "additions")),
    deletions: nonNegativeCount(numberField(display, "deletions")),
    filePath,
  };
}

function nonNegativeCount(value: number | undefined): number {
  if (value === undefined || value < 0) return 0;
  return Math.floor(value);
}

function compactStats(
  stats: Array<ModifiedFileStat | undefined>,
): ModifiedFileStat[] {
  return stats.filter((stat): stat is ModifiedFileStat => stat !== undefined);
}
