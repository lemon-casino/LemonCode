import assert from "node:assert/strict";
import test from "node:test";
import {
  commitDraftScopeKey,
  commitSubjectLength,
  insertConventionalType,
  filterExcludedCommitFiles,
} from "./commitDraft.js";
import { resolveGitActionMenuPrimaryAction } from "./display.js";

test("draft isolation includes identity, remote/session scope and path fallback", () => {
  assert.notEqual(
    commitDraftScopeKey("/repo", "host-a", "session"),
    commitDraftScopeKey("/repo", "host-b", "session"),
  );
  assert.notEqual(
    commitDraftScopeKey("/repo", "host-a", "session-a"),
    commitDraftScopeKey("/repo", "host-a", "session-b"),
  );
  assert.equal(commitDraftScopeKey("/repo", "  "), commitDraftScopeKey("/repo"));
});

test("subject hint counts Unicode before the first blank line only", () => {
  assert.equal(
    commitSubjectLength("feat: first\nsecond\n\nlong body"),
    "feat: first\nsecond".length,
  );
  assert.equal(commitSubjectLength("fix: 中文\r\n\r\n正文"), 7);
  assert.equal(commitSubjectLength("feat: 🙂"), 7);
});

test("Conventional shortcut inserts or replaces type without deleting scope/body", () => {
  assert.equal(insertConventionalType("message\n\nbody", "feat"), "feat: message\n\nbody");
  assert.equal(
    insertConventionalType("fix(api)!: message\n\nbody", "feat"),
    "feat(api)!: message\n\nbody",
  );
});

test("excluding every file remains empty rather than widening to the repository", () => {
  const files = [
    { stagePath: "a.ts", repoRelativePath: "src/a.ts" },
    { stagePath: "b.ts", repoRelativePath: "src/b.ts" },
  ];
  assert.deepEqual(filterExcludedCommitFiles(files, ["src/a.ts", "src/b.ts"]), []);
  assert.deepEqual(filterExcludedCommitFiles(files, ["src/a.ts"]), [files[1]]);
});

test("clean tracked repositories can deliberately open the same commit/publish dialog", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: false,
      pushEnabled: false,
    }),
    "publish",
  );
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: false,
      commitEnabled: false,
      pushEnabled: false,
    }),
    null,
  );
});
