import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "./index.js";
import type { GitTagListResult, GitUnsupportedTagInfo } from "./index.js";
import {
  gitCommitRequestSchema,
  gitCreateTagRequestSchema,
  gitCreateTagResultSchema,
  gitGenerateCommitMessageRequestSchema,
  gitPublishStateSchema,
  gitPushRequestSchema,
  gitRemoteListResultSchema,
  gitRepositoryRequestSchema,
  gitTagListResultSchema,
} from "./index.js";

const state = {
  headCommitHash: "a".repeat(40),
  branchName: "main",
  indexFingerprint: "b".repeat(64),
  worktreeFingerprint: "c".repeat(64),
};

test("Git publishing schemas preserve the public frozen contract", () => {
  const base = { workspacePath: "/repo", workspaceIdentity: "remote:fixture" };
  assert.deepEqual(gitRepositoryRequestSchema.parse(base), base);
  assert.deepEqual(gitPublishStateSchema.parse(state), state);
  assert.deepEqual(
    gitPushRequestSchema.parse({
      ...base,
      remote: "origin",
      branch: "release/one",
      expectedState: state,
    }),
    {
      ...base,
      remote: "origin",
      branch: "release/one",
      expectedState: state,
    },
  );
  assert.ok(gitPushRequestSchema.safeParse(base).success);
  assert.ok(
    gitPushRequestSchema.safeParse({
      ...base,
      remote: "origin",
      tag: "v1.0.0",
      tagCommitHash: state.headCommitHash,
    }).success,
  );
  assert.ok(
    gitCreateTagRequestSchema.safeParse({
      ...base,
      name: "v1.0.0",
      ref: state.headCommitHash,
      expectedState: state,
    }).success,
  );
  assert.ok(
    gitCommitRequestSchema.safeParse({ ...base, message: "feat: publish", expectedState: state })
      .success,
  );
  assert.ok(
    gitGenerateCommitMessageRequestSchema.safeParse({
      ...base,
      review: true,
      excludedFilePaths: ["src/a.ts"],
    }).success,
  );
  assert.ok(
    gitRemoteListResultSchema.safeParse({ remotes: [{ name: "origin", url: "/tmp/remote.git" }] })
      .success,
  );
  assert.ok(
    gitTagListResultSchema.safeParse({
      tags: [{ name: "v1.0.0", commitHash: state.headCommitHash }],
    }).success,
  );
  assert.ok(
    gitCreateTagResultSchema.safeParse({
      name: "v1.0.0",
      commitHash: state.headCommitHash,
      created: false,
    }).success,
  );
});

test("tag catalog preserves optional unsupported tag types without weakening commit-backed tags", () => {
  const legacy: GitTagListResult = {
    tags: [{ name: "v1.0.0", commitHash: state.headCommitHash }],
  };
  assert.deepEqual(gitTagListResultSchema.parse(legacy), legacy);
  const unsupportedTags: GitUnsupportedTagInfo[] = [
    { name: "tree-tag", objectType: "tree" },
    { name: "blob-tag", objectType: "blob" },
  ];
  const catalog: GitTagListResult = { ...legacy, unsupportedTags };
  assert.deepEqual(gitTagListResultSchema.parse(catalog), catalog);
  assert.ok(shared.gitUnsupportedTagInfoSchema, "unsupported tag schema is publicly exported");
  for (const tag of unsupportedTags)
    assert.deepEqual(shared.gitUnsupportedTagInfoSchema.parse(tag), tag);
  for (const tag of [
    { name: "bad", objectType: "commit" },
    { name: "bad", objectType: "tag" },
    { name: "bad", objectType: "unknown" },
    { name: "", objectType: "tree" },
    { name: "bad", objectType: "blob", commitHash: state.headCommitHash },
    { name: "bad" },
  ]) {
    assert.equal(shared.gitUnsupportedTagInfoSchema.safeParse(tag).success, false);
    assert.equal(
      gitTagListResultSchema.safeParse({ ...legacy, unsupportedTags: [tag] }).success,
      false,
    );
  }
  for (const commitHash of [undefined, null, "", "tree", "a".repeat(7)])
    assert.equal(
      gitTagListResultSchema.safeParse({ tags: [{ name: "normal", commitHash }] }).success,
      false,
    );
  assert.equal(
    gitTagListResultSchema.safeParse({ ...legacy, unsupportedTags: null }).success,
    false,
  );
});

test("Git publishing rejects unknown keys, force, ambiguous targets and revision expressions", () => {
  const base = { workspacePath: "/repo", remote: "origin", branch: "main" };
  for (const value of [
    { ...base, force: true },
    { ...base, mirror: true },
    { ...base, all: true },
    { ...base, tag: "v1" },
    { workspacePath: "/repo", remote: "origin" },
    { workspacePath: "/repo", branch: "main" },
    { ...base, tagCommitHash: state.headCommitHash },
  ])
    assert.equal(gitPushRequestSchema.safeParse(value).success, false, JSON.stringify(value));
  for (const name of [
    "",
    "--all",
    "+main",
    ":main",
    "HEAD:other",
    "a..b",
    "a@{1}",
    "a.lock",
    ".hidden",
    "a//b",
    "a/",
    "a\\b",
    "a?b",
    "a*b",
    "a[b",
    "a b",
    "a\nb",
    "https://example.invalid/repo",
  ]) {
    assert.equal(gitPushRequestSchema.safeParse({ ...base, branch: name }).success, false, name);
    assert.equal(gitPushRequestSchema.safeParse({ ...base, remote: name }).success, false, name);
    assert.equal(
      gitCreateTagRequestSchema.safeParse({ workspacePath: "/repo", name }).success,
      false,
      name,
    );
  }
  for (const ref of ["HEAD", "HEAD~1", "--all", "a".repeat(7)]) {
    assert.equal(
      gitCreateTagRequestSchema.safeParse({ workspacePath: "/repo", name: "v1", ref }).success,
      false,
    );
  }
  assert.equal(
    gitCreateTagRequestSchema.safeParse({ workspacePath: "/repo", name: "v1", force: true })
      .success,
    false,
  );
  assert.equal(
    gitCommitRequestSchema.safeParse({
      workspacePath: "/repo",
      message: "x",
      expectedState: { ...state, unknown: true },
    }).success,
    false,
  );
  assert.equal(
    gitGenerateCommitMessageRequestSchema.safeParse({
      workspacePath: "/repo",
      excludedFilePaths: [""],
    }).success,
    false,
  );
});
