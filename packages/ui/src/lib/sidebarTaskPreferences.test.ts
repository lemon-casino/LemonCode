import assert from "node:assert/strict";
import test from "node:test";
import {
  readSidebarTaskPreferences,
  persistSidebarTaskPreferences,
} from "./sidebarTaskPreferences.js";
test("worktree sidebar mode restores without changing previous project/timeline preferences", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  for (const organizeBy of ["grouped", "project", "chronological", "worktrees"] as const) {
    persistSidebarTaskPreferences({ organizeBy, sortBy: "updated" }, storage);
    assert.deepEqual(readSidebarTaskPreferences(storage), { organizeBy, sortBy: "updated" });
  }
});
