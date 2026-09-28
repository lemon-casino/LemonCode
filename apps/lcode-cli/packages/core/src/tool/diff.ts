import { structuredPatch } from "diff";
import type { DiffHunk } from "@lcode/contracts";

const CONTEXT_LINES = 3;
const DIFF_TIMEOUT_MS = 5_000;

export const createStructuredPatch = ({
  filePath,
  newContent,
  oldContent,
}: {
  filePath: string;
  newContent: string;
  oldContent: string;
}): DiffHunk[] => {
  const patch = structuredPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  );

  return patch?.hunks ?? [];
};

export const countPatchLines = (
  structuredPatch: DiffHunk[],
): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;

  for (const hunk of structuredPatch) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }

  return { additions, deletions };
};
