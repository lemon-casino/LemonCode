import assert from "node:assert/strict";
import test from "node:test";
import { createPublishOptions } from "../git-action-menu/publishModel.js";
import { executePublishPlan } from "../git-action-menu/publishExecution.js";
import { worktreePublicationPlan } from "./worktreePublicationPlan.js";

function fixture() {
  return {
    operation: {
      status: "published" as const,
      targetPath: "/project",
      targetBranch: "L-GO",
      candidateHead: "a".repeat(40),
    },
    workspaceIdentity: "remote:project",
    state: {
      headCommitHash: "b".repeat(40),
      branchName: "L-GO",
      indexFingerprint: "i",
      worktreeFingerprint: "w",
    },
    options: {
      ...createPublishOptions(),
      pushBranch: true,
      remotes: [{ name: "origin", branch: "L-GO" }],
      tagMode: "create-and-push" as const,
      tagName: "v1.2.3",
    },
    remotes: [{ name: "origin", url: "https://example.invalid/project.git" }],
    tags: [],
  };
}

test("合并后新增提交允许重新预览，推送和 Tag 都使用原项目最新 HEAD 且不再提交", async () => {
  const input = fixture();
  const result = worktreePublicationPlan(input);
  assert.ok(result.plan);
  const { plan } = result;
  assert.deepEqual(plan.request, {
    workspacePath: "/project",
    workspaceIdentity: "remote:project",
    sourceBranch: "L-GO",
  });
  assert.equal(plan.state.headCommitHash, "b".repeat(40));
  assert.equal(plan.commit, null);
  const calls: string[] = [];
  const check = (request: {
    workspacePath: string;
    workspaceIdentity?: string;
    expectedState?: unknown;
  }) => {
    assert.equal(request.workspacePath, "/project");
    assert.equal(request.workspaceIdentity, "remote:project");
    assert.deepEqual(request.expectedState, input.state);
  };
  const run = await executePublishPlan({
    plan,
    isCurrent: () => true,
    onUpdate: () => {},
    service: {
      getPublishState: async (request) => {
        assert.deepEqual(request, plan.request);
        return input.state;
      },
      commit: async () => {
        throw new Error("cannot commit source");
      },
      push: async (request) => {
        check(request);
        if (request.tag) assert.equal(request.tagCommitHash, "b".repeat(40));
        else assert.equal(request.branch, "L-GO");
        calls.push(request.tag ? "tag" : "branch");
        return {} as never;
      },
      createTag: async (request) => {
        check(request);
        assert.equal(request.ref, "b".repeat(40));
        calls.push("createTag");
        return { name: request.name, commitHash: request.ref!, created: true };
      },
    },
  });
  assert.deepEqual(calls, ["branch", "createTag", "tag"]);
  assert.ok(run.outcomes.every((row) => row.status === "success"));
});

test("不能从任务分支或无 HEAD 的目录发布合并目标，也不能把未完成合并当作结果", () => {
  const input = fixture();
  for (const state of [
    { ...input.state, branchName: "lcode/task-任务" },
    { ...input.state, headCommitHash: null },
  ])
    assert.equal(
      worktreePublicationPlan({ ...input, state }).error,
      "worktree.publishTargetChanged",
    );
  assert.equal(
    worktreePublicationPlan({ ...input, operation: { ...input.operation, status: "ready" } }).error,
    "worktree.publishTargetChanged",
  );
});

test("新预览仍遵守 Tag 冲突规则；预览之后目标变化不产生任何副作用", async () => {
  const input = fixture();
  assert.equal(
    worktreePublicationPlan({ ...input, tags: [{ name: "v1.2.3", commitHash: "c".repeat(40) }] })
      .error,
    "git.publish.error.tagExists",
  );
  const { plan } = worktreePublicationPlan(input);
  assert.ok(plan);
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected mutation");
  };
  const run = await executePublishPlan({
    plan,
    isCurrent: () => true,
    onUpdate: () => {},
    service: {
      getPublishState: async () => ({ ...input.state, headCommitHash: "c".repeat(40) }),
      commit: unexpected,
      push: unexpected,
      createTag: unexpected,
    },
  });
  assert.equal(run.stopReason, "stateChanged");
});
