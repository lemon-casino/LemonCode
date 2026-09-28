import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileEntry } from "@lcode/shared";
import { mergeProjectFileEntries } from "./projectFileSearch.js";

function file(path: string, relativePath: string): WorkspaceFileEntry {
  return {
    type: "file",
    name: relativePath.split("/").at(-1) ?? relativePath,
    path,
    relativePath,
  };
}

test("multi-folder file search interleaves roots and removes overlapping duplicates", () => {
  const primaryPath = "C:\\work\\app";
  const duplicate = file("C:\\work\\app\\shared.ts", "shared.ts");
  const result = mergeProjectFileEntries(
    [
      {
        rootPath: primaryPath,
        entries: [duplicate, file("C:\\work\\app\\main.ts", "main.ts")],
      },
      {
        rootPath: "C:\\work\\app\\packages",
        entries: [duplicate, file("C:\\work\\app\\packages\\ui.ts", "ui.ts")],
      },
    ],
    primaryPath,
    3,
  );

  assert.deepEqual(
    result.map(({ entry, primary }) => ({ path: entry.path, primary })),
    [
      { path: duplicate.path, primary: true },
      { path: "C:\\work\\app\\main.ts", primary: true },
      { path: "C:\\work\\app\\packages\\ui.ts", primary: false },
    ],
  );
});
