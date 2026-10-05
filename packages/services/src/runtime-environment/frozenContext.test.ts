import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEnvironmentRecord, RuntimeEnvironmentStatus } from "@lcode/shared";
import { matchEnvironmentForCwd } from "./app/frozenContext.js";

function recordFor(
  index: number,
  scopePath: string,
  status: RuntimeEnvironmentStatus = "ready",
): RuntimeEnvironmentRecord {
  const id = index.toString(16).padStart(32, "0");
  return {
    environmentId: id,
    scope: { workspacePath: scopePath },
    purpose: "worktree",
    status,
    currentRevision: 1,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
}

test("matches cwd equal to the environment scope", () => {
  const records = [recordFor(1, "C:/proj")];
  assert.equal(
    matchEnvironmentForCwd(records, "C:/proj")?.environmentId,
    records[0]?.environmentId,
  );
});

test("matches cwd inside the environment scope at a separator boundary", () => {
  const records = [recordFor(1, "C:/proj")];
  assert.ok(matchEnvironmentForCwd(records, "C:/proj/src/sub"));
  // 前缀但非路径边界（proj2 不属于 proj）不命中。
  assert.equal(matchEnvironmentForCwd(records, "C:/proj2"), null);
});

test("longest scope prefix wins for nested environments", () => {
  const outer = recordFor(1, "C:/proj");
  const inner = recordFor(2, "C:/proj/nested");
  const matched = matchEnvironmentForCwd([outer, inner], "C:/proj/nested/src");
  assert.equal(matched?.environmentId, inner.environmentId);
});

test("non-consumable environments are skipped", () => {
  const failed = recordFor(1, "C:/proj", "failed");
  const restoring = recordFor(2, "C:/proj", "releasing");
  assert.equal(matchEnvironmentForCwd([failed, restoring], "C:/proj"), null);
  const ready = recordFor(3, "C:/proj", "ready");
  assert.equal(
    matchEnvironmentForCwd([failed, ready], "C:/proj")?.environmentId,
    ready.environmentId,
  );
});

test("no match returns null (non-managed semantics, not an error)", () => {
  assert.equal(matchEnvironmentForCwd([recordFor(1, "C:/proj")], "D:/other"), null);
  assert.equal(matchEnvironmentForCwd([], "C:/proj"), null);
});
