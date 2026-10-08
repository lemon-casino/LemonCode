import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitReviewWorkspaceSnapshot,
  gitReviewWorkspaceSnapshotSchema,
  gitReviewWorkspacePatchSchema,
} from "./gitReviewWorkspace.js";
import { worktreeIntegrationPreflightSchema } from "./worktreeIntegration.js";

test("旧审核快照迁移只补新增浏览字段版本，保留草稿和原阶段；patch 不隐式重置视图", () => {
  const snapshot = createGitReviewWorkspaceSnapshot({ workspacePath: "/repo", scopeId: "session" });
  snapshot.data.draft.message = "keep this draft";
  const legacy = JSON.parse(JSON.stringify(snapshot));
  delete legacy.fieldRevisions.publicationView;
  delete legacy.data.publicationView;
  const migrated = gitReviewWorkspaceSnapshotSchema.parse(legacy);
  assert.equal(migrated.fieldRevisions.publicationView, 0);
  assert.equal(migrated.data.draft.message, "keep this draft");
  assert.deepEqual(gitReviewWorkspacePatchSchema.parse({ browsePosition: 1 }), {
    browsePosition: 1,
  });
  assert.throws(() =>
    gitReviewWorkspacePatchSchema.parse({
      publicationView: { operationId: "o", view: "push", approved: true },
    }),
  );
});

test("预检查拒绝无效 Git 引用、统计和未声明字段", () => {
  const facts = {
    bindingId: "a".repeat(32),
    targetBranch: "main",
    sourceHead: "b".repeat(40),
    targetHead: "c".repeat(40),
    sourceCommitCount: 1,
    uncommittedFileCount: 0,
    alreadyContained: false,
  };
  assert.deepEqual(worktreeIntegrationPreflightSchema.parse(facts), facts);
  for (const patch of [
    { sourceHead: "missing" },
    { sourceCommitCount: -1 },
    { uncommittedFileCount: 1.2 },
    { alreadyContained: 1 },
    { approved: true },
  ])
    assert.throws(() => worktreeIntegrationPreflightSchema.parse({ ...facts, ...patch }));
});
