import assert from "node:assert/strict";
import test from "node:test";
import type { IGitService } from "@lcode/services";
import { createPublishOptions, freezePublishPlan } from "./publishModel.js";
import { executePublishPlan, retryPublishStep } from "./publishExecution.js";

function fixture(withCommit = true) {
  let state = {
    headCommitHash: "a".repeat(40),
    branchName: "main",
    indexFingerprint: "i",
    worktreeFingerprint: "w",
  };
  const calls: string[] = [];
  const fail = new Set<string>();
  let afterPush = () => {};
  let current = true;
  const summary = {} as Awaited<ReturnType<IGitService["getRepositorySummary"]>>;
  const service: Pick<IGitService, "getPublishState" | "commit" | "createTag" | "push"> = {
    getPublishState: async () => ({ ...state }),
    commit: async (request) => {
      assert.deepEqual(request.expectedState, state);
      calls.push("commit");
      state = { ...state, headCommitHash: "b".repeat(40), indexFingerprint: "next" };
      return { commitHash: state.headCommitHash, summary, publishState: { ...state } };
    },
    createTag: async (request) => {
      calls.push(`create:${request.name}`);
      assert.equal(request.ref, state.headCommitHash);
      assert.deepEqual(request.expectedState, state);
      return { name: request.name, commitHash: state.headCommitHash, created: true };
    },
    push: async (request) => {
      assert.deepEqual(request.expectedState, state);
      const id = `${request.remote}:${request.tag ?? request.branch}`;
      calls.push(id);
      afterPush();
      if (fail.has(id)) throw new Error(`rejected ${id}`);
      return {
        branchName: "main",
        trackingBranchName: "origin/main",
        remoteName: request.remote ?? null,
        setUpstream: false,
        summary,
      };
    },
  };
  const plan = freezePublishPlan({
    request: { workspacePath: "/repo", workspaceIdentity: "identity" },
    options: {
      ...createPublishOptions(),
      pushBranch: true,
      remotes: [
        { name: "origin", branch: "main" },
        { name: "backup", branch: "release" },
      ],
      tagMode: "create-and-push",
      tagName: "v1.2.4",
    },
    state,
    tags: [],
    files: withCommit ? ["a.ts"] : [],
    commit: withCommit
      ? { workspacePath: "/repo", message: "feat: reviewed", paths: ["a.ts"] }
      : null,
  });
  return {
    service,
    plan,
    calls,
    fail,
    isCurrent: () => current,
    change: () => {
      state = { ...state, worktreeFingerprint: "external" };
    },
    close: () => {
      current = false;
    },
    afterPush: (fn: () => void) => {
      afterPush = fn;
    },
  };
}

test("one commit, sequential remote branches, one tag creation, then per-remote tag push", async () => {
  const f = fixture();
  const result = await executePublishPlan({ ...f, onUpdate: () => {} });
  assert.deepEqual(f.calls, [
    "commit",
    "origin:main",
    "backup:release",
    "create:v1.2.4",
    "origin:v1.2.4",
    "backup:v1.2.4",
  ]);
  assert.ok(result.outcomes.every((row) => row.status === "success"));
  assert.equal(result.state.headCommitHash, "b".repeat(40));
});

test("tag creation outcomes retain the Host-created fact for new and existing same-target tags", async () => {
  for (const created of [true, false]) {
    const f = fixture(false);
    const createTag = f.service.createTag;
    f.service.createTag = async (request) => ({ ...(await createTag(request)), created });
    const run = await executePublishPlan({ ...f, onUpdate: () => {} });
    const outcome = run.outcomes.find((row) => row.kind === "create-tag");
    assert.equal(outcome?.status, "success");
    assert.equal(outcome?.commitHash, f.plan.state.headCommitHash);
    assert.equal(outcome?.tagCreated, created);
    assert.equal(run.stopReason, undefined);
    assert.deepEqual(f.calls.slice(-2), ["origin:v1.2.4", "backup:v1.2.4"]);
    assert.equal(f.calls.filter((call) => call.startsWith("create:")).length, 1);
  }
});

test("an isolated remote failure preserves successes; single retry never recommits or recreates", async () => {
  const f = fixture();
  f.fail.add("origin:main");
  const run = await executePublishPlan({ ...f, onUpdate: () => {} });
  assert.equal(run.outcomes.find((row) => row.id === "branch-origin")?.status, "failed");
  assert.equal(run.outcomes.find((row) => row.id === "tag-backup-v1.2.4")?.status, "success");
  const priorCalls = f.calls.length;
  f.fail.clear();
  const retried = await retryPublishStep({
    ...f,
    run,
    stepId: "branch-origin",
    onUpdate: () => {},
  });
  assert.deepEqual(f.calls.slice(priorCalls), ["origin:main"]);
  assert.ok(retried.outcomes.every((row) => row.status === "success"));
});

test("external worktree mutation after a successful push stops every remaining side effect", async () => {
  const f = fixture(false);
  f.afterPush(f.change);
  const run = await executePublishPlan({ ...f, onUpdate: () => {} });
  assert.deepEqual(f.calls, ["origin:main"]);
  assert.equal(run.stopReason, "stateChanged");
  assert.equal(run.outcomes[0]!.status, "success");
  assert.ok(run.outcomes.slice(1).every((row) => row.status === "skipped"));
});

test("closing during await prevents remaining commands and stale UI updates", async () => {
  const f = fixture(false);
  f.afterPush(f.close);
  let staleUpdates = 0;
  await executePublishPlan({
    ...f,
    onUpdate: () => {
      if (!f.isCurrent()) staleUpdates++;
    },
  });
  assert.deepEqual(f.calls, ["origin:main"]);
  assert.equal(staleUpdates, 0);
});

test("changed frozen state prevents retry and preserves original successes", async () => {
  const f = fixture(false);
  f.fail.add("origin:main");
  const run = await executePublishPlan({ ...f, onUpdate: () => {} });
  f.change();
  const count = f.calls.length;
  const next = await retryPublishStep({ ...f, run, stepId: "branch-origin", onUpdate: () => {} });
  assert.equal(f.calls.length, count);
  assert.equal(next.stopReason, "stateChanged");
  assert.equal(next.outcomes.find((row) => row.id === "branch-backup")?.status, "success");
});

test("push success with warning remains success but terminates publication", async () => {
  const f = fixture(false);
  const push = f.service.push;
  f.service.push = async (request) => ({
    ...(await push(request)),
    warning: "postcheck could not verify",
  });
  const run = await executePublishPlan({ ...f, onUpdate: () => {} });
  assert.deepEqual(f.calls, ["origin:main"]);
  assert.equal(run.outcomes[0]!.status, "success");
  assert.equal(run.outcomes[0]!.message, "postcheck could not verify");
  assert.equal(run.stopReason, "warning");
});

test("committed warning or missing next version never publishes and preserves commit fact", async () => {
  for (const warning of ["hook changed state", undefined]) {
    const f = fixture();
    const commit = f.service.commit;
    f.service.commit = async (request) => ({
      ...(await commit(request)),
      publishState: undefined,
      warning,
    });
    const run = await executePublishPlan({ ...f, onUpdate: () => {} });
    assert.deepEqual(f.calls, ["commit"]);
    assert.equal(run.outcomes[0]!.status, "success");
    assert.ok(run.stopReason);
  }
});

test("remote/tag names containing separators have unique outcomes and retry only the failed tuple", async () => {
  const f = fixture(false);
  const tags = [
    { name: "backup-v1", commitHash: "old" },
    { name: "v1", commitHash: "new" },
  ];
  const plan = freezePublishPlan({
    request: f.plan.request,
    options: {
      ...createPublishOptions(),
      remotes: [
        { name: "origin", branch: "main" },
        { name: "origin-backup", branch: "main" },
      ],
      tagMode: "push-existing",
      existingTags: tags.map((tag) => tag.name),
    },
    state: f.plan.state,
    tags,
    files: [],
    commit: null,
  });
  f.fail.add("origin-backup:v1");
  const run = await executePublishPlan({ ...f, plan, onUpdate: () => {} });
  assert.equal(new Set(run.outcomes.map((row) => row.id)).size, run.outcomes.length);
  const success = run.outcomes.find(
    (row) => row.remote === "origin" && row.target === "backup-v1",
  )!;
  const failed = run.outcomes.find((row) => row.remote === "origin-backup" && row.target === "v1")!;
  assert.equal(success.status, "success");
  assert.equal(success.commitHash, "old");
  assert.equal(failed.status, "failed");
  assert.equal(failed.commitHash, "new");
  f.fail.clear();
  const count = f.calls.length;
  await retryPublishStep({ ...f, run, stepId: failed.id, onUpdate: () => {} });
  assert.deepEqual(f.calls.slice(count), ["origin-backup:v1"]);
});

test("multiple existing tags push their original frozen hashes without commit or creation", async () => {
  const f = fixture(false);
  const tags = [
    { name: "v1.0.0", commitHash: "old" },
    { name: "v1.1.0", commitHash: "newer" },
  ];
  const plan = freezePublishPlan({
    request: f.plan.request,
    options: {
      ...createPublishOptions(),
      remotes: [{ name: "origin", branch: "main" }],
      tagMode: "push-existing",
      existingTags: tags.map((tag) => tag.name),
    },
    state: f.plan.state,
    tags,
    files: [],
    commit: null,
  });
  const hashes: string[] = [];
  const push = f.service.push;
  f.service.push = async (request) => {
    hashes.push(request.tagCommitHash!);
    return push(request);
  };
  await executePublishPlan({ ...f, plan, onUpdate: () => {} });
  assert.deepEqual(f.calls, ["origin:v1.0.0", "origin:v1.1.0"]);
  assert.deepEqual(hashes, ["old", "newer"]);
});
