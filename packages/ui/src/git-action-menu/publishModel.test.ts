import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublishOptions,
  getTagSuggestions,
  isValidGitRefName,
  validatePublishOptions,
  freezePublishPlan,
  samePublishState,
} from "./publishModel.js";

const state = {
  headCommitHash: "a".repeat(40),
  branchName: "main",
  indexFingerprint: "index",
  worktreeFingerprint: "worktree",
};
const remotes = [
  { name: "origin", url: "local-origin" },
  { name: "backup", url: "local-backup" },
];
const tags = [{ name: "v1.2.3", commitHash: state.headCommitHash }];

test("publication defaults do not select remote side effects", () => {
  const options = createPublishOptions();
  assert.equal(options.pushBranch, false);
  assert.equal(options.tagMode, "none");
  assert.deepEqual(options.remotes, []);
  assert.equal(
    validatePublishOptions(options, { remotes, tags, state, withCommit: false }),
    "noSteps",
  );
});

test("version suggestions use highest plain v?semver, not lexical order or prereleases", () => {
  assert.deepEqual(getTagSuggestions(["v1.2.3", "v1.10.0", "v9.0.0-rc.1", "release-20.0.0"]), {
    base: "v1.10.0",
    patch: "v1.10.1",
    minor: "v1.11.0",
    major: "v2.0.0",
  });
  assert.equal(getTagSuggestions(["release", "v01.2.3", "1.2.3+build"]), null);
  assert.equal(getTagSuggestions(["2.3.4"])?.patch, "2.3.5");
});

test("Git ref validation rejects unsafe or conflicting names without banning nested tags", () => {
  for (const name of [
    "",
    " ",
    "v 1",
    "-tag",
    "a..b",
    ".hidden",
    "a/.b",
    "a.lock",
    "a.lock/b",
    "a@{b",
    "a//b",
    "a/",
    "a.",
    "a\\b",
    "a*b",
    "@",
    "a\n",
  ]) {
    assert.equal(isValidGitRefName(name), false, name);
  }
  assert.equal(isValidGitRefName("releases/v1.2.3"), true);
  assert.equal(isValidGitRefName("版本-1"), true);
});

test("tag-only plans need no branch push, remote or commit; existing same-HEAD tag is idempotent", () => {
  const options = { ...createPublishOptions(), tagMode: "create" as const, tagName: "v1.2.3" };
  assert.equal(
    validatePublishOptions(options, { remotes: [], tags, state, withCommit: false }),
    null,
  );
  assert.equal(
    validatePublishOptions(options, { remotes, tags, state, withCommit: true }),
    "tagExists",
  );
  assert.equal(
    validatePublishOptions(options, {
      remotes,
      tags,
      state: { ...state, headCommitHash: "other" },
      withCommit: false,
    }),
    "tagExists",
  );
});

test("non-commit tags reserve their names but never block unrelated publication choices", () => {
  const context = {
    remotes,
    tags,
    unsupportedTags: [{ name: "v99.0.0", objectType: "tree" as const }],
    state,
    withCommit: false,
  };
  const options = { ...createPublishOptions(), tagMode: "create" as const, tagName: "v99.0.0" };
  assert.equal(validatePublishOptions(options, context), "tagUnsupported");
  assert.equal(validatePublishOptions(options, { ...context, withCommit: true }), "tagUnsupported");
  assert.equal(validatePublishOptions({ ...options, tagName: "v1.2.4" }, context), null);
  assert.equal(
    validatePublishOptions(
      {
        ...options,
        tagMode: "push-existing",
        remotes: [{ name: "origin", branch: "main" }],
        existingTags: ["v99.0.0"],
      },
      context,
    ),
    "tagsRequired",
  );
});

test("push plans require explicit remotes, destination branch and existing tag selections", () => {
  let options = { ...createPublishOptions(), pushBranch: true };
  assert.equal(
    validatePublishOptions(options, { remotes, tags, state, withCommit: false }),
    "remoteRequired",
  );
  options = { ...options, remotes: [{ name: "origin", branch: "" }] };
  assert.equal(
    validatePublishOptions(options, { remotes, tags, state, withCommit: false }),
    "branchInvalid",
  );
  assert.equal(
    validatePublishOptions(
      { ...options, pushBranch: false, tagMode: "push-existing" },
      { remotes, tags, state, withCommit: false },
    ),
    "tagsRequired",
  );
});

test("confirmation plan copies and freezes targets and commit paths", () => {
  const options = {
    ...createPublishOptions(),
    pushBranch: true,
    remotes: [{ name: "origin", branch: "release" }],
    tagMode: "create-and-push" as const,
    tagName: "v1.2.4",
  };
  const paths = ["a.ts"];
  const plan = freezePublishPlan({
    request: { workspacePath: "/repo", workspaceIdentity: "scope" },
    options,
    state,
    tags,
    files: paths,
    commit: { workspacePath: "/repo", message: "feat: test", paths },
  });
  options.remotes[0]!.branch = "changed";
  paths.push("unreviewed.ts");
  assert.equal(plan.options.remotes[0]!.branch, "release");
  assert.deepEqual(plan.files, ["a.ts"]);
  assert.deepEqual(plan.commit?.paths, ["a.ts"]);
  assert.ok(Object.isFrozen(plan.options.remotes[0]));
  assert.equal(plan.commit?.expectedState?.headCommitHash, state.headCommitHash);
});

test("publish state compares HEAD, branch, index and worktree independently", () => {
  assert.equal(samePublishState(state, { ...state }), true);
  for (const field of Object.keys(state)) {
    assert.equal(samePublishState(state, { ...state, [field]: "changed" }), false, field);
  }
});
