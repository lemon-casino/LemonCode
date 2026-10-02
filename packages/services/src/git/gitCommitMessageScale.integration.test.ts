import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { GitCommitMessageGenerator } from "./gitCommitMessageGenerator.js";
import { createGitService } from "./gitService.js";

const run = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-review-scale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd: root, windowsHide: true })).stdout;
  await git("init", "-q");
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.invalid"],
    ["core.autocrlf", "false"],
    ["core.hooksPath", join(root, "no-hooks")],
    ["commit.gpgsign", "false"],
    ["core.excludesFile", join(root, ".git", "empty-ignore")],
  ])
    await git("config", key!, value!);
  await writeFile(join(root, ".git", "empty-ignore"), "");
  await git("commit", "--allow-empty", "-qm", "initial");
  const prompts: string[] = [];
  let fail = false;
  let failReview = false;
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      readCurrentModel: async () => ({ providerId: "fixture", modelId: "fixture" }),
    },
    textGenerator: {
      generateText: async (params) => {
        prompts.push(params.prompt);
        if (fail) throw new Error("fixture-model-failure");
        const review = params.prompt.startsWith("Review these frozen");
        if (review && failReview) throw new Error("审核模型请求超时（测试桩）");
        const groups = review
          ? (JSON.parse(params.prompt.split("\n").at(-1)!) as { groups: { id: string }[] }).groups
          : [];
        return {
          selection: params.selection,
          text: review
            ? JSON.stringify({
                decision: "keep",
                warnings: [],
                messages: groups.map(({ id }) => ({ id, message: "feat: 完善工作流执行状态" })),
                mergedMessage: "feat: 完善工作流执行状态",
              })
            : "`feat: 完善工作流执行状态`\n\n保留已核对的工作流修改。",
        };
      },
    },
  });
  return {
    root,
    git,
    prompts,
    service: createGitService({ commitMessageGenerator: generator }),
    failModel: () => {
      fail = true;
    },
    failReview: () => {
      failReview = true;
    },
  };
}

test("105 个长中文/特殊文件名跨批审核，无数量限制且不改变真实 index/HEAD", async (t) => {
  const { root, git, prompts, service } = await fixture(t);
  const paths = Array.from({ length: 105 }, (_, i) => `${i}-中文 空格[特殊]${"x".repeat(115)}.ts`);
  await Promise.all(paths.map((path) => writeFile(join(root, path), "新增功能\n")));
  const head = await git("rev-parse", "HEAD");
  const draft = await service.generateCommitMessage({
    workspacePath: root,
    review: true,
    locale: "zh-CN",
    currentSessionFilePaths: paths,
  });
  assert.equal(draft.reviewError, undefined);
  assert.equal(draft.review?.groups[0]?.files.length, 105);
  assert.deepEqual(draft.review!.groups[0]!.files.map((f) => f.path).sort(), paths.sort());
  assert.match(draft.message, /完善工作流/);
  assert.equal(prompts.length, 1);
  assert.equal(await git("rev-parse", "HEAD"), head);
  assert.equal((await git("diff", "--cached", "--name-only")).trim(), "");
  await git("add", ".");
  const index = await readFile(join(root, ".git", "index"));
  const staged = await service.generateCommitMessage({
    workspacePath: root,
    review: true,
    locale: "zh-CN",
    includeUnstaged: false,
    currentSessionFilePaths: paths,
  });
  assert.equal(staged.reviewError, undefined);
  assert.equal(staged.review?.groups[0]?.files.length, 105);
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  assert.equal(await git("rev-parse", "HEAD"), head);
});

test("内容超限仍生成中文纪要，保留审核错误且不授予提交权限", async (t) => {
  const { root, git, prompts, service } = await fixture(t);
  const paths = ["large-a.ts", "large-b.ts", "large-c.ts"];
  await Promise.all(paths.map((path) => writeFile(join(root, path), "x\n".repeat(375_000))));
  const head = await git("rev-parse", "HEAD");
  const draft = await service.generateCommitMessage({
    workspacePath: root,
    review: true,
    locale: "zh-CN",
    currentSessionFilePaths: paths,
    conversationContext: {
      sessionId: "current",
      messages: [{ role: "user", content: "完善工作流" }],
    },
  });
  assert.equal(draft.review, undefined);
  assert.match(draft.reviewError!, /内容超限/);
  assert.match(draft.message, /完善工作流/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Chinese/);
  assert.match(prompts[0]!, /完善工作流/);
  assert.equal(await git("rev-parse", "HEAD"), head);
  assert.equal((await git("diff", "--cached", "--name-only")).trim(), "");
  assert.equal((await readFile(join(root, paths[0]!), "utf8")).length, 750_000);
});

test("模型不可用不伪造纪要；审核和消息失败均返回明确错误", async (t) => {
  const { root, failModel, service } = await fixture(t);
  await writeFile(join(root, "a.ts"), "新增功能\n");
  failModel();
  const draft = await service.generateCommitMessage({ workspacePath: root, review: true });
  assert.equal(draft.review, undefined);
  assert.equal(draft.message, "");
  assert.match(draft.reviewError!, /模型请求失败/);
  assert.match(draft.reviewError!, /提交纪要生成失败/);
});

test("审核请求失败后仍采用 Markdown 包装的有效中文纪要，但不能获得提交授权", async (t) => {
  const { root, git, failReview, prompts, service } = await fixture(t);
  await writeFile(join(root, "a.ts"), "新增功能\n");
  failReview();
  const head = await git("rev-parse", "HEAD");
  const draft = await service.generateCommitMessage({
    workspacePath: root,
    review: true,
    locale: "zh-CN",
  });
  assert.equal(draft.review, undefined);
  assert.equal(draft.message, "feat: 完善工作流执行状态\n\n保留已核对的工作流修改。");
  assert.match(draft.reviewError!, /模型请求失败/);
  assert.doesNotMatch(draft.reviewError!, /提交纪要生成失败/);
  assert.equal(prompts.length, 2);
  assert.equal(await git("rev-parse", "HEAD"), head);
  assert.equal((await git("diff", "--cached", "--name-only")).trim(), "");
});

test("1000 个文件的纪要请求按内容预算摘要而非文件数量拒绝", async () => {
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      readCurrentModel: async () => ({ providerId: "fixture", modelId: "fixture" }),
    },
    textGenerator: {
      generateText: async (params) => {
        assert.match(params.prompt, /1000/);
        assert.ok(params.prompt.length < 20_000);
        return { selection: params.selection, text: "feat: 完善大范围功能" };
      },
    },
  });
  const draft = await generator.generate({
    workspacePath: "/fixture",
    branchName: "main",
    locale: "zh-CN",
    files: Array.from({ length: 1000 }, (_, i) => ({
      path: `src/${i}.ts`,
      repoRelativePath: `src/${i}.ts`,
      workspaceRelativePath: `src/${i}.ts`,
      kind: "modified" as const,
      section: "unstaged" as const,
      added: 1,
      removed: 0,
      isStaged: false,
      isUntracked: false,
      isConflicted: false,
    })),
    diffs: [],
  });
  assert.match(draft.message, /大范围/);
});
