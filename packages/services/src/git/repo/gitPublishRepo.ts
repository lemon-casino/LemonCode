import type {
  GitCreateTagRequest,
  GitCreateTagResult,
  GitPushRequest,
  GitPushResult,
  GitRemoteListResult,
  GitTagListResult,
  GitRepositoryRequest,
} from "@lcode/shared";
import type {
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import { DEFAULT_GIT_PUSH_OUTPUT_BYTES, DEFAULT_GIT_PUSH_TIMEOUT_MS } from "../config.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";
import type { GitCliRepo } from "./gitCliTypes.js";
import { GitPublishStateReader } from "./gitPublishState.js";
import { configureFirstUpstream } from "./gitPublishUpstream.js";

const detail = (error: unknown) => (error instanceof Error ? error.message : String(error));
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
type ResolvedTag =
  | { objectHash: string; objectType: "commit"; commitHash: string }
  | { objectHash: string; objectType: "tree" | "blob" };

function ensureExplicitPushSucceeded(result: GitCommandExecutionResult, stateWarning?: string) {
  try {
    ensureGitCommandSucceeded("git explicit push", result);
  } catch (error) {
    // 中文依据：porcelain 的拒绝原因在 stdout；保留公共错误的超时元数据后合并双通道，状态变化不能遮蔽失败。
    const messages = [detail(error)];
    for (const text of [
      result.outputTruncated ? "git explicit push output exceeded limit" : undefined,
      `exitCode=${result.exitCode ?? "null"}`,
      result.stdout,
      result.stderr,
      stateWarning,
    ]) {
      const value = text?.trim();
      if (value && !messages.some((message) => message.includes(value))) messages.push(value);
    }
    throw new Error(messages.join("\n"));
  }
}

export class GitPublishRepo {
  readonly state: GitPublishStateReader;
  constructor(
    private readonly repo: GitCliRepo,
    private readonly command: GitCommandProvider,
  ) {
    this.state = new GitPublishStateReader(repo, command);
  }

  private async validateRef(cwd: string, ref: string) {
    await this.state.git(cwd, ["check-ref-format", ref]);
  }

  private async pushUrls(cwd: string, name: string): Promise<string[]> {
    return (await this.state.git(cwd, ["remote", "get-url", "--push", "--all", "--", name]))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  }

  async listRemotes(params: GitRepositoryRequest): Promise<GitRemoteListResult> {
    const cwd = await this.state.root(params.workspacePath);
    const names = (await this.state.git(cwd, ["remote"])).split(/\r?\n/).filter(Boolean);
    const remotes = [];
    for (const name of names) {
      const url = (await this.pushUrls(cwd, name)).join("\n");
      remotes.push({ name, url });
    }
    return { remotes };
  }

  private async tag(cwd: string, name: string): Promise<ResolvedTag | null> {
    const ref = `refs/tags/${name}`;
    let result = await this.command.run({ cwd, args: ["show-ref", "--verify", "--hash", ref] });
    // 中文依据：先校验超时、截断与非缺失退出码，不能让 quiet 回退把读取失败变成可信 Tag。
    ensureGitCommandSucceeded("git selected tag", result, [0, 1, 128]);
    if (result.exitCode === 1) return null;
    // show-ref --verify uses 128 for absent refs on older Git; quiet distinguishes absence from corruption.
    if (result.exitCode === 128) {
      const missing = await this.command.run({
        cwd,
        args: ["show-ref", "--verify", "--quiet", ref],
      });
      ensureGitCommandSucceeded("git selected tag", missing, [0, 1]);
      if (missing.exitCode === 1) return null;
      // 中文依据：首次缺失后并发创建可能已成功；quiet=0 必须重读新 OID，不能沿用旧 128 报错破坏幂等。
      result = await this.command.run({ cwd, args: ["show-ref", "--verify", "--hash", ref] });
    }
    ensureGitCommandSucceeded("git selected tag", result);
    const objectHash = result.stdout.trim();
    if (!objectId.test(objectHash)) throw new Error("无法完整读取 Tag 对象 OID。");
    // 中文依据：从固定 OID 递归 peel 后查询真实类型，不按错误文案猜 tree/blob；annotated 原对象仍用于发布。
    const terminalHash = (
      await this.state.git(cwd, ["rev-parse", "--verify", `${objectHash}^{}`])
    ).trim();
    if (!objectId.test(terminalHash)) throw new Error("无法完整读取 Tag 目标 OID。");
    const objectType = (await this.state.git(cwd, ["cat-file", "-t", terminalHash])).trim();
    if (objectType === "commit") return { objectHash, objectType, commitHash: terminalHash };
    if (objectType === "tree" || objectType === "blob") return { objectHash, objectType };
    throw new Error("无法确认 Tag 目标对象类型。");
  }

  async listTags(params: GitRepositoryRequest): Promise<GitTagListResult> {
    const cwd = await this.state.root(params.workspacePath);
    const names = (
      await this.state.git(cwd, ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags/"])
    )
      .split(/\r?\n/)
      .filter(Boolean);
    const tags: GitTagListResult["tags"] = [];
    const unsupportedTags: NonNullable<GitTagListResult["unsupportedTags"]> = [];
    for (const name of names) {
      const value = await this.tag(cwd, name);
      if (!value) throw new Error("Tag 列表已变化，请重新读取。");
      if (value.objectType === "commit") tags.push({ name, commitHash: value.commitHash });
      else unsupportedTags.push({ name, objectType: value.objectType });
    }
    return { tags, ...(unsupportedTags.length ? { unsupportedTags } : {}) };
  }

  async createTag(params: GitCreateTagRequest): Promise<GitCreateTagResult> {
    const cwd = await this.state.root(params.workspacePath);
    const expected = params.expectedState ?? (await this.state.capture(params.workspacePath));
    await this.validateRef(cwd, `refs/tags/${params.name}`);
    if (!expected.headCommitHash) throw new Error("没有可创建 Tag 的 HEAD 提交。");
    if (params.ref && params.ref !== expected.headCommitHash)
      throw new Error("Tag 只能指向当前最终 HEAD 的完整提交哈希。");
    const existing = await this.tag(cwd, params.name);
    await this.state.assertCurrent(params.workspacePath, expected);
    const sameTarget = (value: ResolvedTag | null) => {
      // 中文依据：合法的 tree/blob Tag 也占用名称；仅 commit 同目标可幂等，绝不覆盖特殊 Tag。
      if (value?.objectType !== "commit" || value.commitHash !== expected.headCommitHash)
        throw new Error(`Tag ${params.name} 冲突，不能覆盖或移动。`);
      return value.commitHash;
    };
    if (existing) {
      return { name: params.name, commitHash: sameTarget(existing), created: false };
    }
    // 中文依据：空 old OID 是原子 create-if-absent，不能先检查后 git tag -f；并发同目标按已创建处理。
    const result = await this.command.run({
      cwd,
      args: ["update-ref", "--no-deref", `refs/tags/${params.name}`, expected.headCommitHash, ""],
    });
    const value = await this.tag(cwd, params.name);
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
      if (!value) ensureGitCommandSucceeded("git create tag", result);
      sameTarget(value);
    } else sameTarget(value);
    await this.state.assertCurrent(params.workspacePath, expected);
    return {
      name: params.name,
      commitHash: expected.headCommitHash,
      created: result.exitCode === 0,
    };
  }

  async push(params: GitPushRequest): Promise<GitPushResult> {
    if (!params.remote) {
      if (params.expectedState)
        await this.state.assertCurrent(params.workspacePath, params.expectedState);
      const result = await this.repo.push(params.workspacePath);
      if (params.expectedState) {
        try {
          await this.state.assertCurrent(params.workspacePath, params.expectedState);
        } catch (error) {
          result.warning = `推送已成功，但${detail(error)}`;
        }
      }
      return result;
    }
    const cwd = await this.state.root(params.workspacePath);
    const expected = params.expectedState ?? (await this.state.capture(params.workspacePath));
    const remotes = await this.listRemotes(params);
    if (!remotes.remotes.some(({ name }) => name === params.remote))
      throw new Error("所选 Git remote 不存在，不能使用任意 URL 推送。");
    const urls = await this.pushUrls(cwd, params.remote);
    if (urls.length !== 1)
      throw new Error("所选 remote 配置了多个或没有 push URL，请先明确唯一推送目的地。");
    const assertDestination = async () => {
      if (JSON.stringify(await this.pushUrls(cwd, params.remote!)) !== JSON.stringify(urls))
        throw new Error("远端推送 URL 已变化，请重新确认发布。");
    };
    await this.validateRef(cwd, `refs/remotes/${params.remote}/publication`);
    const target = params.branch ? `refs/heads/${params.branch}` : `refs/tags/${params.tag}`;
    await this.validateRef(cwd, target);
    if (!expected.headCommitHash) throw new Error("没有可推送的 HEAD 提交。");
    if (params.branch && !expected.branchName)
      throw new Error("Cannot push a branch while HEAD is detached.");
    const selected = params.tag ? await this.tag(cwd, params.tag) : null;
    if (params.tag && !selected) throw new Error("所选 Tag 不存在。");
    if (selected && selected.objectType !== "commit")
      throw new Error(`Tag ${params.tag} 指向 ${selected.objectType}，非提交目标不支持发布。`);
    if (params.tagCommitHash && selected?.commitHash !== params.tagCommitHash)
      throw new Error("Tag 目标已变化，请重新确认发布。");
    const beforeSummary = (await this.repo.getStatus(params.workspacePath)).summary;
    await this.state.assertCurrent(params.workspacePath, expected);
    await assertDestination();
    const source = selected?.objectHash ?? expected.headCommitHash;
    const result = await this.command.run({
      cwd,
      args: [
        "-c",
        `remote.${params.remote}.mirror=false`,
        "-c",
        "push.followTags=false",
        "-c",
        "push.autoSetupRemote=false",
        "push",
        "--porcelain",
        "--no-force",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "--",
        params.remote,
        `${source}:${target}`,
      ],
      timeoutMs: DEFAULT_GIT_PUSH_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_PUSH_OUTPUT_BYTES,
    });
    let stateWarning: string | undefined;
    try {
      await this.state.assertCurrent(params.workspacePath, expected);
      await assertDestination();
      if (params.tag && (await this.tag(cwd, params.tag))?.objectHash !== selected?.objectHash)
        throw new Error("所选 Tag 已变化，请重新确认发布。");
    } catch (error) {
      stateWarning = detail(error);
    }
    ensureExplicitPushSucceeded(result, stateWarning);
    let warning = stateWarning ? `推送已成功，但${stateWarning}` : undefined;
    let setUpstream = false;
    if (!warning && params.branch === expected.branchName) {
      try {
        setUpstream = await configureFirstUpstream(
          this.command,
          cwd,
          expected.branchName!,
          params.remote,
          () => this.state.assertCurrent(params.workspacePath, expected),
        );
        await this.state.assertCurrent(params.workspacePath, expected);
      } catch (error) {
        warning = `推送已成功，但上游配置未完成或状态已变化：${detail(error)}`;
      }
    }
    this.repo.invalidate(params.workspacePath);
    let summary = beforeSummary;
    try {
      summary = (await this.repo.getStatus(params.workspacePath)).summary;
    } catch (error) {
      warning ??= `推送已成功，但状态刷新失败：${detail(error)}`;
    }
    return {
      branchName: expected.branchName,
      trackingBranchName: summary.trackingBranchName,
      remoteName: params.remote,
      setUpstream,
      summary,
      ...(warning ? { warning } : {}),
    };
  }
}
