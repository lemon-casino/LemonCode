import assert from "node:assert/strict";
import test from "node:test";
import { CommitReviewService } from "./commitReviewService.js";
import { parseCommitReviewModelOutput } from "./commitReviewModel.js";
import { gitCommitReviewSchema, type GitCommitReviewGroup } from "@lcode/shared";
import type { CommitReviewSnapshot } from "./repo/commitReviewRepo.js";
const file = { path: "x.ts", mode: "100644", headContent: "a", content: "ab" };
function fixture(withMessageWarnings = false) {
  let commits = 0,
    stale = false;
  const adapter = {
    canonicalizeJournal: async (
      _snapshot: CommitReviewSnapshot,
      journal: import("@lcode/shared").GitFileMutationJournal,
    ) => journal,
    capture: async () =>
      ({
        files: [file],
        resolution: { repoRoot: "/repo", workspacePath: "/repo" },
        summary: {},
        paths: ["x.ts"],
        version: "v1",
      }) as CommitReviewSnapshot,
    assertCurrent: async () => {
      if (stale) throw new Error("stale");
    },
    describe: async () => [{ path: "x.ts", patch: "+ab", added: 1, removed: 1 }],
    commit: async () => {
      commits++;
      return { commitHash: "hash" };
    },
  };
  const model = {
    review: async (params: { groups: GitCommitReviewGroup[] }) => ({
      ...parseCommitReviewModelOutput(
        JSON.stringify({
          decision: "keep",
          warnings: [],
          messages: params.groups.map((group) => ({
            id: group.id,
            message: "feat: 增强功能",
            ...(withMessageWarnings ? { warnings: ["请核对功能依赖"] } : {}),
          })),
          mergedMessage: "feat: 合并功能",
        }),
        params.groups,
      ),
      providerId: "test",
      model: "test",
    }),
  };
  const service = new CommitReviewService(adapter, model, async () => ({
    complete: withMessageWarnings,
    mutations: withMessageWarnings
      ? [
          {
            id: "edit-A",
            sessionId: "A",
            path: "/repo/x.ts",
            beforeContent: "a",
            afterContent: "ab",
            toolName: "Edit",
            createdAt: 1,
          },
        ]
      : [],
  }));
  return {
    service,
    stale: () => {
      stale = true;
    },
    count: () => commits,
  };
}
test("合并候选需人工确认；identity 不匹配不能提交；并发重试幂等", async () => {
  const f = fixture();
  const generated = await f.service.generate({
    workspacePath: "/repo",
    workspaceIdentity: "one",
    paths: ["x.ts"],
    includeUnstaged: true,
  });
  assert.equal(generated.review.mode, "merged");
  assert.equal(
    f.service.read({
      workspacePath: "/repo",
      workspaceIdentity: "one",
      reviewId: generated.review.id,
    })?.position,
    0,
  );
  assert.equal(
    f.service.read({
      workspacePath: "/repo",
      workspaceIdentity: "two",
      reviewId: generated.review.id,
    }),
    null,
  );
  assert.equal(
    f.service.read({
      workspacePath: "/other",
      workspaceIdentity: "one",
      reviewId: generated.review.id,
    }),
    null,
  );
  const request = {
    workspacePath: "/repo",
    workspaceIdentity: "one",
    message: generated.message,
    review: { id: generated.review.id, groupId: "merged", acknowledged: true },
  };
  await assert.rejects(f.service.commit({ ...request, workspaceIdentity: "two" }));
  await assert.rejects(
    f.service.commit({ ...request, review: { ...request.review, acknowledged: false } }),
  );
  await Promise.all([f.service.commit(request), f.service.commit(request)]);
  assert.equal(f.count(), 1);
  assert.equal(
    f.service.read({
      workspacePath: "/repo",
      workspaceIdentity: "one",
      reviewId: generated.review.id,
    })?.position,
    1,
  );
});
test("审核期间文件变化时不发布 review，也不调用 commit", async () => {
  const f = fixture();
  f.stale();
  await assert.rejects(
    f.service.generate({ workspacePath: "/repo", paths: ["x.ts"], includeUnstaged: true }),
    /stale/,
  );
  assert.equal(f.count(), 0);
});

test("候选警告保留在既有审核协议并强制确认，不被格式兼容提升为无确认提交", async () => {
  const f = fixture(true);
  const draft = await f.service.generate({
    workspacePath: "/repo",
    paths: ["x.ts"],
    includeUnstaged: true,
  });
  assert.equal(draft.message, "feat: 增强功能");
  assert.equal(draft.review.mode, "split");
  assert.deepEqual(draft.review.warnings, ["[A] 请核对功能依赖"]);
  assert.equal(draft.review.groups[0]!.requiresConfirmation, true);
  assert.deepEqual(gitCommitReviewSchema.parse(draft.review), draft.review);
  const request = {
    workspacePath: "/repo",
    message: draft.message,
    review: { id: draft.review.id, groupId: "A", acknowledged: false },
  };
  await assert.rejects(f.service.commit(request), /请先确认/);
  assert.equal(f.count(), 0);
  await f.service.commit({ ...request, review: { ...request.review, acknowledged: true } });
  assert.equal(f.count(), 1);
});
