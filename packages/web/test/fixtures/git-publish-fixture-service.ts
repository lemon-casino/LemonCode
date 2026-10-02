import type { IGitService } from "@lcode/services";
import type { GitPublishState, GitRepositorySummary, GitUnsupportedTagInfo } from "@lcode/shared";

type Mutation = "commit" | "push" | "createTag" | "stagePaths";
interface FixtureCall {
  method: Mutation;
  params: unknown;
}

export function createPublishFixture(summary: () => GitRepositorySummary) {
  let state: GitPublishState = {
    headCommitHash: "a".repeat(40),
    branchName: "fixture",
    indexFingerprint: "c".repeat(64),
    worktreeFingerprint: "d".repeat(64),
  };
  let commitCount = 0;
  let holdRemote: string | null = null;
  let releasePush: (() => void) | null = null;
  let mutateAfterPush = false;
  let failList = false;
  let holdList = false;
  let releaseList: (() => void) | null = null;
  const failures = new Map<string, string>();
  let unsupportedTags: GitUnsupportedTagInfo[] = [];
  const calls: FixtureCall[] = [];
  const tags = new Map([
    ["v1.2.3", "b".repeat(40)],
    ["v1.10.0", state.headCommitHash!],
  ]);
  const assertCurrent = (expected?: GitPublishState) => {
    if (expected && JSON.stringify(expected) !== JSON.stringify(state)) {
      throw new Error("fixture-state-changed: Git 内容已变化，请重新确认。");
    }
  };
  const mutate = (field: keyof GitPublishState = "headCommitHash") => {
    state = {
      ...state,
      [field]:
        field === "branchName" ? "external" : "e".repeat(field === "headCommitHash" ? 40 : 64),
    };
  };
  const service = {
    async getPublishState() {
      return { ...state };
    },
    async listRemotes() {
      if (holdList) {
        holdList = false;
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
      }
      if (failList) {
        failList = false;
        throw new Error("fixture-publish-list-failure");
      }
      return {
        remotes: [
          { name: "origin", url: "https://example.invalid/fixture.git" },
          { name: "backup", url: "https://example.invalid/backup.git" },
        ],
      };
    },
    async listTags() {
      return {
        tags: [...tags].map(([name, commitHash]) => ({ name, commitHash })),
        ...(unsupportedTags.length ? { unsupportedTags } : {}),
      };
    },
    async stagePaths(params) {
      calls.push({ method: "stagePaths", params });
      state = { ...state, indexFingerprint: "f".repeat(64) };
    },
    async commit(params) {
      calls.push({ method: "commit", params });
      assertCurrent(params.expectedState);
      const commitHash = (++commitCount).toString(16).padStart(40, "0");
      state = {
        ...state,
        headCommitHash: commitHash,
        indexFingerprint: commitHash.padStart(64, "0"),
      };
      return { commitHash, summary: summary(), publishState: { ...state } };
    },
    async createTag(params) {
      calls.push({ method: "createTag", params });
      assertCurrent(params.expectedState);
      if (params.ref && params.ref !== state.headCommitHash)
        throw new Error("fixture-tag-target-changed");
      if (unsupportedTags.some((tag) => tag.name === params.name))
        throw new Error("fixture-unsupported-tag-conflict");
      const prior = tags.get(params.name);
      if (prior && prior !== state.headCommitHash) throw new Error("fixture-local-tag-conflict");
      tags.set(params.name, state.headCommitHash!);
      return { name: params.name, commitHash: state.headCommitHash!, created: !prior };
    },
    async push(params) {
      calls.push({ method: "push", params });
      assertCurrent(params.expectedState);
      if (holdRemote === params.remote) {
        holdRemote = null;
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      }
      const key = `${params.remote}/${params.tag ?? "branch"}`;
      const failure = failures.get(key);
      if (failures.delete(key)) throw new Error(failure);
      if (params.tag && params.tagCommitHash && tags.get(params.tag) !== params.tagCommitHash) {
        throw new Error("fixture-tag-moved");
      }
      if (mutateAfterPush) {
        mutateAfterPush = false;
        mutate();
      }
      return {
        branchName: state.branchName,
        trackingBranchName: null,
        remoteName: params.remote ?? "origin",
        setUpstream: false,
        summary: summary(),
      };
    },
  } satisfies Pick<
    IGitService,
    "getPublishState" | "listRemotes" | "listTags" | "stagePaths" | "commit" | "createTag" | "push"
  >;
  return {
    service,
    controls: {
      calls,
      state: () => ({ ...state }),
      tags: () => [...tags].map(([name, commitHash]) => ({ name, commitHash })),
      failPush: (remote: string, tag = "branch", message?: string) =>
        failures.set(`${remote}/${tag}`, message ?? `fixture-push-rejected: ${remote}/${tag}`),
      unsupportedTags: (values: GitUnsupportedTagInfo[]) => {
        unsupportedTags = values;
      },
      holdPush: (remote: string) => {
        holdRemote = remote;
      },
      releasePush: () => {
        releasePush?.();
        releasePush = null;
      },
      mutate,
      mutateAfterPush: () => {
        mutateAfterPush = true;
      },
      failList: () => {
        failList = true;
      },
      holdList: () => {
        holdList = true;
      },
      listPending: () => releaseList !== null,
      releaseList: () => {
        releaseList?.();
        releaseList = null;
      },
    },
  };
}
