import type {
  GitCommitRequest,
  GitPublishState,
  GitRemoteInfo,
  GitRepositoryRequest,
  GitTagInfo,
  GitUnsupportedTagInfo,
} from "@lcode/shared";

export const TAG_MODES = ["none", "create", "create-and-push", "push-existing"] as const;
export const TAG_STRATEGIES = ["custom", "patch", "minor", "major"] as const;
export interface PublishOptions {
  remotes: { name: string; branch: string }[];
  pushBranch: boolean;
  tagMode: (typeof TAG_MODES)[number];
  tagName: string;
  existingTags: string[];
  tagStrategy: (typeof TAG_STRATEGIES)[number];
}
export interface PublishPlan {
  request: GitRepositoryRequest;
  options: PublishOptions;
  state: GitPublishState;
  tags: GitTagInfo[];
  files: string[];
  commit: GitCommitRequest | null;
}

export function createPublishOptions(): PublishOptions {
  return {
    remotes: [],
    pushBranch: false,
    tagMode: "none",
    tagName: "",
    existingTags: [],
    tagStrategy: "custom",
  };
}

export function getTagSuggestions(names: readonly string[]) {
  let highest: { name: string; prefix: string; parts: [number, number, number] } | null = null;
  for (const name of names) {
    const match = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(name);
    if (!match) continue;
    const parts: [number, number, number] = [Number(match[2]), Number(match[3]), Number(match[4])];
    if (parts.some((part) => !Number.isSafeInteger(part) || part >= Number.MAX_SAFE_INTEGER))
      continue;
    if (
      !highest ||
      parts[0] > highest.parts[0] ||
      (parts[0] === highest.parts[0] && parts[1] > highest.parts[1]) ||
      (parts[0] === highest.parts[0] &&
        parts[1] === highest.parts[1] &&
        parts[2] > highest.parts[2])
    ) {
      highest = { name, prefix: match[1] ?? "", parts };
    }
  }
  if (!highest) return null;
  const {
    prefix,
    parts: [major, minor, patch],
  } = highest;
  return {
    base: highest.name,
    patch: `${prefix}${major}.${minor}.${patch + 1}`,
    minor: `${prefix}${major}.${minor + 1}.0`,
    major: `${prefix}${major + 1}.0.0`,
  };
}

export function isValidGitRefName(name: string): boolean {
  return Boolean(
    name &&
    name !== "@" &&
    !name.startsWith("-") &&
    !Array.from(name).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
    !/[\s~^:?*[\\]/.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.endsWith(".") &&
    name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock")),
  );
}

export function validatePublishOptions(
  options: PublishOptions,
  context: {
    remotes: readonly GitRemoteInfo[];
    tags: readonly GitTagInfo[];
    unsupportedTags?: readonly GitUnsupportedTagInfo[];
    state: GitPublishState;
    withCommit: boolean;
  },
): string | null {
  const { state, withCommit, tags, remotes } = context;
  const creates = options.tagMode === "create" || options.tagMode === "create-and-push";
  const publishes =
    options.pushBranch ||
    options.tagMode === "create-and-push" ||
    options.tagMode === "push-existing";
  if (!options.pushBranch && options.tagMode === "none") return "noSteps";
  if (!withCommit && !state.headCommitHash) return "headRequired";
  if (publishes && !options.remotes.length) return "remoteRequired";
  if (
    publishes &&
    options.remotes.some((remote) => !remotes.some((known) => known.name === remote.name))
  )
    return "remoteMissing";
  if (new Set(options.remotes.map((remote) => remote.name)).size !== options.remotes.length)
    return "remoteMissing";
  if (
    options.pushBranch &&
    (!state.branchName || options.remotes.some((remote) => !isValidGitRefName(remote.branch)))
  )
    return "branchInvalid";
  if (creates) {
    if (!isValidGitRefName(options.tagName)) return "tagInvalid";
    if (context.unsupportedTags?.some((tag) => tag.name === options.tagName))
      return "tagUnsupported";
    const existing = tags.find((tag) => tag.name === options.tagName);
    if (existing && (withCommit || existing.commitHash !== state.headCommitHash))
      return "tagExists";
  }
  if (
    options.tagMode === "push-existing" &&
    (!options.existingTags.length ||
      options.existingTags.some((name) => !tags.some((tag) => tag.name === name)))
  )
    return "tagsRequired";
  return null;
}

export function freezePublishPlan(input: {
  request: GitRepositoryRequest;
  options: PublishOptions;
  state: GitPublishState;
  tags: readonly GitTagInfo[];
  files: readonly string[];
  commit?: GitCommitRequest | null;
}): PublishPlan {
  const state = Object.freeze({ ...input.state });
  const options = {
    ...input.options,
    remotes: input.options.remotes.map((remote) => Object.freeze({ ...remote })),
    existingTags: [...input.options.existingTags],
  };
  Object.freeze(options.remotes);
  Object.freeze(options.existingTags);
  const commit = input.commit
    ? {
        ...input.commit,
        ...input.request,
        expectedState: state,
        ...(input.commit.paths ? { paths: [...input.commit.paths] } : {}),
        ...(input.commit.review ? { review: Object.freeze({ ...input.commit.review }) } : {}),
      }
    : null;
  if (commit?.paths) Object.freeze(commit.paths);
  if (commit) Object.freeze(commit);
  const files = [...input.files];
  const tags = input.tags
    .filter((tag) => options.existingTags.includes(tag.name))
    .map((tag) => Object.freeze({ ...tag }));
  Object.freeze(tags);
  Object.freeze(files);
  return Object.freeze({
    request: Object.freeze({ ...input.request }),
    options: Object.freeze(options),
    state,
    tags,
    files,
    commit,
  });
}

export function samePublishState(a: GitPublishState, b: GitPublishState): boolean {
  return (
    a.headCommitHash === b.headCommitHash &&
    a.branchName === b.branchName &&
    a.indexFingerprint === b.indexFingerprint &&
    a.worktreeFingerprint === b.worktreeFingerprint
  );
}
