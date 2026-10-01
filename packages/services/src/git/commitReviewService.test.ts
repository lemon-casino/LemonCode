import assert from "node:assert/strict";
import test from "node:test";
import { CommitReviewService } from "./commitReviewService.js";
import type { CommitReviewSnapshot } from "./repo/commitReviewRepo.js";
const file = { path: "x.ts", mode: "100644", headContent: "a", content: "ab" };
function fixture() {
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
    review: async (params: { groups: { id: string }[] }) => ({
      decision: "keep" as const,
      warnings: [],
      messages: params.groups.map((group) => ({ id: group.id, message: "feat: 增强功能" })),
      mergedMessage: "feat: 合并功能",
      providerId: "test",
      model: "test",
    }),
  };
  const service = new CommitReviewService(adapter, model, async () => ({
    complete: false,
    mutations: [],
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
