import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeLocalProjectFolderPaths,
  resolveDroppedLocalProjectFolders,
} from "./createProjectFolderDrop.js";

test("folder merge preserves order, normalizes paths, and ignores Windows duplicates", () => {
  const result = mergeLocalProjectFolderPaths(
    ["C:\\work\\primary\\"],
    ["c:/work/primary", "C:\\work\\second\\", "D:\\third"],
  );

  assert.deepEqual(result.paths, ["C:\\work\\primary", "C:\\work\\second", "D:\\third"]);
  assert.deepEqual(result.addedPaths, ["C:\\work\\second", "D:\\third"]);
  assert.equal(result.discardedForLimitCount, 0);
});

test("folder merge reports unique folders discarded by the project limit", () => {
  const result = mergeLocalProjectFolderPaths(["C:\\one"], ["C:\\two", "C:\\three"], 2);

  assert.deepEqual(result.paths, ["C:\\one", "C:\\two"]);
  assert.deepEqual(result.addedPaths, ["C:\\two"]);
  assert.equal(result.discardedForLimitCount, 1);
});

test("dropped items keep only resolvable directories", async () => {
  const files = ["folder", "regular-file", "missing-path", "stat-error"];
  const paths = new Map([
    ["folder", "C:\\folder"],
    ["regular-file", "C:\\notes.txt"],
    ["stat-error", "C:\\gone"],
  ]);

  const result = await resolveDroppedLocalProjectFolders(
    files,
    (file) => paths.get(file) ?? null,
    async (path) => {
      if (path === "C:\\gone") throw new Error("missing");
      return path === "C:\\folder" ? "directory" : "file";
    },
  );

  assert.deepEqual(result.folderPaths, ["C:\\folder"]);
  assert.equal(result.rejectedCount, 3);
});
