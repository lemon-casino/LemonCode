import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createGitService } from "./gitService.js";
import { GitCommitMessageGenerator } from "./gitCommitMessageGenerator.js";

const run = promisify(execFile);
async function fixture(t: TestContext, stale = false, crlf = false) {
  const root = await mkdtemp(join(tmpdir(), "lcode-review-service-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd: root, windowsHide: true })).stdout;
  await git("init", "-q");
  for (const [name, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.invalid"],
    ["core.autocrlf", crlf ? "true" : "false"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", join(root, "no-hooks")],
  ])
    await git("config", name!, value!);
  await writeFile(join(root, ".git", "empty-ignore"), "");
  await git("config", "core.excludesFile", join(root, ".git", "empty-ignore"));
  const source = (text: string) => (crlf ? text.replace(/\n/g, "\r\n") : text);
  await writeFile(join(root, "x.ts"), source("a\nb\n"));
  await git("add", ".");
  await git("commit", "-qm", "initial");
  await writeFile(join(root, "x.ts"), source("A\nB\n"));
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      readCurrentModel: async () => ({ providerId: "fixture", modelId: "fixture" }),
    },
    textGenerator: {
      generateText: async (params) => {
        const data = JSON.parse(params.prompt.split("\n").at(-1)!) as { groups: { id: string }[] };
        if (stale) await writeFile(join(root, "x.ts"), "Z\nB\n");
        return {
          text: JSON.stringify({
            decision: "keep",
            warnings: [],
            messages: data.groups.map((group) => ({
              id: group.id,
              message: `feat: 增强 ${group.id}`,
            })),
            mergedMessage: "feat: 合并增强",
          }),
          selection: params.selection,
        };
      },
    },
  });
  const service = createGitService({
    commitMessageGenerator: generator,
    mutationJournalReader: async () => ({
      complete: true,
      mutations: [
        {
          id: "write-A",
          sessionId: "A",
          sessionTitle: "功能 A",
          path: join(root, "x.ts"),
          beforeContent: source("a\nb\n"),
          afterContent: source("A\nb\n"),
          toolName: "Edit",
          createdAt: 1,
        },
        {
          id: "write-B",
          sessionId: "B",
          sessionTitle: "增强 B",
          path: join(root, "x.ts"),
          beforeContent: source("A\nb\n"),
          afterContent: source("A\nB\n"),
          toolName: "Edit",
          createdAt: 2,
        },
      ],
    }),
  });
  return { root, git, service };
}
test("公开 Git 服务完成冻结、AI 审核与两组真实提交，不猜作者且重试不重复提交", async (t) => {
  const { root, git, service } = await fixture(t);
  const draft = await service.generateCommitMessage({
    workspacePath: root,
    workspaceIdentity: "fixture",
    review: true,
    locale: "zh-CN",
    currentSessionFilePaths: [join(root, "x.ts")],
  });
  assert.equal(draft.review?.mode, "ordered");
  assert.deepEqual(
    draft.review?.groups.map((group) => group.sessionIds),
    [["A"], ["B"]],
  );
  const selection = (groupId: string) => ({ id: draft.review!.id, groupId, acknowledged: true });
  await assert.rejects(
    service.commit({
      workspacePath: root,
      workspaceIdentity: "fixture",
      message: "feat: B",
      review: selection("B"),
    }),
    /顺序/,
  );
  const result = await service.commit({
    workspacePath: root,
    workspaceIdentity: "fixture",
    message: draft.review!.groups[0]!.message,
    review: selection("A"),
  });
  assert.equal(await git("show", "HEAD:x.ts"), "A\nb\n");
  assert.equal(await readFile(join(root, "x.ts"), "utf8"), "A\nB\n");
  const retry = await service.commit({
    workspacePath: root,
    workspaceIdentity: "fixture",
    message: "feat: A",
    review: selection("A"),
  });
  assert.equal(retry.commitHash, result.commitHash);
  await service.commit({
    workspacePath: root,
    workspaceIdentity: "fixture",
    message: draft.review!.groups[1]!.message,
    review: selection("B"),
  });
  assert.equal(await git("show", "HEAD:x.ts"), "A\nB\n");
  assert.equal((await git("rev-list", "--count", "HEAD")).trim(), "3");
});

test("公开审核服务执行 Hook；post-commit 失败仍记录成功，重试不再提交或运行 Hook", async (t) => {
  const { root, git, service } = await fixture(t);
  await mkdir(join(root, "no-hooks"));
  for (const [name, body] of [
    ["pre-commit", "echo checked >> .git/pre-ran"],
    ["post-commit", "echo notified >> .git/post-ran\necho post-failed >&2\nexit 1"],
  ]) {
    const path = join(root, "no-hooks", name!);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  }
  const draft = await service.generateCommitMessage({
    workspacePath: root,
    workspaceIdentity: "fixture",
    review: true,
    currentSessionFilePaths: [join(root, "x.ts")],
  });
  assert.equal(draft.review?.mode, "ordered", draft.reviewError);
  const params = {
    workspacePath: root,
    workspaceIdentity: "fixture",
    message: "feat: A",
    review: { id: draft.review!.id, groupId: "A", acknowledged: true },
  };
  const committed = await service.commit(params);
  assert.match(committed.warning!, /post-commit.*post-failed/s);
  const retry = await service.commit(params);
  assert.equal(retry.commitHash, committed.commitHash);
  assert.equal((await git("rev-parse", "HEAD")).trim(), committed.commitHash);
  assert.equal((await git("rev-list", "--count", "HEAD")).trim(), "2");
  assert.equal(await readFile(join(root, ".git", "pre-ran"), "utf8"), "checked\n");
  assert.equal(await readFile(join(root, ".git", "post-ran"), "utf8"), "notified\n");
  await assert.rejects(
    service.commit({
      ...params,
      review: { ...params.review, groupId: "B" },
    }),
    /重新审核/,
  );
});

test("AI 审核过程中同样行数的新写入使审核失效，但仍返回不可提交的弹窗提示", async (t) => {
  const { root, git, service } = await fixture(t, true);
  const head = await git("rev-parse", "HEAD");
  const draft = await service.generateCommitMessage({ workspacePath: root, review: true });
  assert.equal(draft.review, undefined);
  assert.match(draft.reviewError!, /变化/);
  assert.equal(await git("rev-parse", "HEAD"), head);
});

test("Windows autocrlf 的原文证据与 Git LF 版本匹配，拆分提交不改变 CRLF 工作区", async (t) => {
  const { root, git, service } = await fixture(t, false, true);
  const draft = await service.generateCommitMessage({ workspacePath: root, review: true });
  assert.equal(draft.review?.mode, "ordered", draft.reviewError);
  await service.commit({
    workspacePath: root,
    message: "feat: A",
    review: { id: draft.review!.id, groupId: "A", acknowledged: true },
  });
  assert.equal(await git("show", "HEAD:x.ts"), "A\nb\n");
  assert.equal(await readFile(join(root, "x.ts"), "utf8"), "A\r\nB\r\n");
});

test("外部 clean filter 无法作为逐次归属规则，保守转为需确认的合并审核", async (t) => {
  const { root, service } = await fixture(t);
  await writeFile(join(root, ".gitattributes"), "x.ts filter=custom-review-test\n");
  const draft = await service.generateCommitMessage({
    workspacePath: root,
    review: true,
    currentSessionFilePaths: [join(root, "x.ts")],
  });
  assert.equal(draft.review?.mode, "merged", draft.reviewError);
  assert.equal(draft.review?.groups[0]?.requiresConfirmation, true);
});

test("大中文 UTF-8 文件跨 Git 管道块仍生成中文审核，生成不改变真实 Git 状态", async (t) => {
  const { root, git, service } = await fixture(t);
  const before = "中文🙂验证读取\n".repeat(16_000);
  await writeFile(join(root, "zh.ts"), before);
  await git("add", "zh.ts");
  await git("commit", "-qm", "initial Chinese");
  const content = before + "新增中文配置\n";
  await writeFile(join(root, "zh.ts"), content);
  const head = await git("rev-parse", "HEAD");
  const index = await readFile(join(root, ".git", "index"));
  const draft = await service.generateCommitMessage({
    workspacePath: root,
    review: true,
    locale: "zh-CN",
    currentSessionFilePaths: [join(root, "zh.ts")],
  });
  assert.equal(draft.reviewError, undefined);
  assert.ok(draft.review, "有效大中文文本不能被误判为二进制");
  assert.match(draft.message, /^feat: 增强/);
  assert.match(draft.review.groups[0]!.files[0]!.patch, /新增中文配置/);
  assert.equal(await git("rev-parse", "HEAD"), head);
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  assert.equal(await readFile(join(root, "zh.ts"), "utf8"), content);
});
