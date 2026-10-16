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
    assert.deepEqual(readSidebarTaskPreferences(storage), {
      organizeBy,
      sortBy: "updated",
      focus: "all",
    });
  }
});

test("focus migrates safely and is preserved when only sort preferences change", () => {
  let value = '{"organizeBy":"project","sortBy":"created","focus":"invalid"}';
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
  assert.equal(readSidebarTaskPreferences(storage).focus, "all");
  for (const focus of ["all", "projects", "worktrees", "chats"] as const) {
    persistSidebarTaskPreferences({ organizeBy: "project", sortBy: "updated", focus }, storage);
    persistSidebarTaskPreferences({ organizeBy: "chronological", sortBy: "created" }, storage);
    assert.equal(readSidebarTaskPreferences(storage).focus, focus);
  }
  assert.equal(
    readSidebarTaskPreferences({ getItem: () => "null", setItem: () => {} }).focus,
    "all",
  );
});
