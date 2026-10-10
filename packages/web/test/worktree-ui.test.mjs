import { runWorktreePublicationCase } from "./worktree-publication-cases.mjs";
import { runBranchDeletionCases } from "./draft-attachment-and-branch-cases.mjs";
import { runBranchPickerCases } from "./branch-picker-cases.mjs";
import assert from "node:assert/strict";
import { runWorktreeDeletionCases } from "./worktree-deletion-cases.mjs";
import { runWorktreeDiscardPendingCase } from "./worktree-discard-pending-cases.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { chromium } from "playwright-core";
import {
  runWorktreeWorkflowCases,
  runWorktreeManagementCases,
} from "./worktree-workflow-cases.mjs";
import { runWorktreeReviewSettingsCases } from "./worktree-review-settings-cases.mjs";
import { runForkPreparationCases } from "./worktree-fork-preparation-cases.mjs";

// 使用真实共享组件和真实 hook，只有 Host 边界替换为确定性服务桩。
test("工作树选择、策略、生命周期与实际文件目录交互", { timeout: 240_000 }, async (t) => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const server = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json"))),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      windowsHide: true,
      stdio: "pipe",
    },
  );
  let output = "";
  server.stdout.on("data", (data) => {
    output += data.toString();
  });
  server.stderr.on("data", (data) => {
    output += data.toString();
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    if (process.platform === "win32") {
      const stop = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await once(stop, "exit");
    } else {
      server.kill("SIGTERM");
      if (server.exitCode === null) await once(server, "exit");
    }
  });
  const ready = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 45_000);
    const check = () => {
      // Vite 在支持颜色的终端中会在 Local 与冒号之间插入 ANSI，不能误判已启动服务。
      if (stripVTControlCharacters(output).includes("Local:")) {
        clearTimeout(timeout);
        resolve(true);
      }
    };
    server.stdout.on("data", check);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    check();
  });
  assert.ok(ready, output);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.LCODE_TEST_BROWSER_PATH
      ? { executablePath: process.env.LCODE_TEST_BROWSER_PATH }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    t.diagnostic(error.stack ?? error.message);
  });
  const url = `http://127.0.0.1:${port}/test/fixtures/worktree-ui.html`;
  if (process.env.LCODE_WORKTREE_TEST_CASES === "preparation-fork") {
    await runForkPreparationCases({
      t,
      page,
      url,
      calls: () => page.evaluate(() => globalThis.__worktreeFixture.calls),
    });
    assert.deepEqual(errors, []);
    return;
  }
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__worktreeFixture[method](...args), {
      method,
      args,
    });
  const configure = (values) =>
    page.evaluate((values) => Object.assign(globalThis.__worktreeFixture, values), values);
  const calls = () => page.evaluate(() => globalThis.__worktreeFixture.calls);
  const openProjectWorktrees = async () => {
    await page.getByTestId("project-menu-trigger").click();
    await page.getByRole("menuitem", { name: "项目工作树", exact: true }).click();
  };
  const select = async (testId, name) => {
    await page.getByTestId(testId).click();
    await page.getByRole("option", { name, exact: true }).click();
    await page.waitForFunction(
      (id) => !document.querySelector(`[data-testid="${id}"]`).disabled,
      testId,
    );
  };
  const load = async (suffix = "") => {
    await page.goto(url + suffix);
    if (suffix.includes("sidebar")) {
      await page.getByTestId("sidebar-rows").waitFor();
      return;
    }
    await page.getByTestId("draft-execution-mode").waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="draft-execution-mode"]').disabled,
    );
  };

  if (process.env.LCODE_WORKTREE_TEST_CASES === "workflow") {
    await runWorktreeWorkflowCases({ t, page, url, calls, configure, select });
    assert.deepEqual(errors, []);
    return;
  }

  if (process.env.LCODE_WORKTREE_TEST_CASES === "publication") {
    await runWorktreePublicationCase({ t, page, load, openProjectWorktrees, calls, configure });
    assert.deepEqual(errors, []);
    return;
  }
  if (process.env.LCODE_WORKTREE_TEST_CASES === "branch-picker") {
    await runBranchDeletionCases({ t, page, url, calls, select });
    await runBranchPickerCases({ t, page, url, calls, select });
    assert.deepEqual(errors, []);
    return;
  }

  await runWorktreeDeletionCases({ t, page, load, configure, calls, openProjectWorktrees });
  await runWorktreeDiscardPendingCase({ t, page, load, configure, calls, openProjectWorktrees });
  if (process.env.LCODE_WORKTREE_TEST_CASES === "deletion") {
    assert.deepEqual(errors, []);
    return;
  }

  await t.test("模式保存项目值、基线保存草稿，不创建树、不切分支；读取失败可重试", async () => {
    await load();
    assert.match(await page.getByTestId("draft-execution-mode").innerText(), /本地/);
    await select("draft-execution-mode", "独立工作树");
    await configure({ failBranches: true });
    await page.getByTestId("worktree-base-trigger").click();
    await page.getByText("fixture-branches-failed").waitFor();
    await configure({ failBranches: false });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.locator('[data-testid="git-branch-row"][data-branch-name="feature"]').click();
    assert.match(await page.getByTestId("worktree-base-trigger").innerText(), /feature/);
    assert.equal(
      (await calls()).some((call) => ["prepare", "switchBranch"].includes(call.method)),
      false,
    );
    await fixture("chooseScope", "remote-b");
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="draft-execution-mode"]')
        .textContent.includes("本地目录"),
    );
    await fixture("chooseScope");
    await page.getByTestId("worktree-base-trigger").waitFor();
    assert.match(await page.getByTestId("worktree-base-trigger").innerText(), /feature/);
    await fixture("begin");
    assert.equal(await page.getByTestId("draft-execution-mode").isDisabled(), true);
    assert.equal(await page.getByTestId("worktree-base-trigger").isDisabled(), true);
    await fixture("fail");
    await page
      .getByTestId("fixture-conversation-stream")
      .getByRole("button", { name: "重试准备", exact: true })
      .click();
    assert.equal((await fixture("draft")).retryRevision, 1);
    assert.equal((await fixture("draft")).baseRef, "feature");
  });
  await t.test(
    "全局默认与项目覆盖独立；移除技术表单但保留旧配置，设置失败可重试且仅发字段补丁",
    async () => {
      await load("?legacySetup");
      await select("global-execution-mode", "独立工作树");
      await page.getByTestId("worktree-base-trigger").waitFor();
      await select("draft-execution-mode", "本地目录");
      await page.getByTestId("worktree-base-trigger").waitFor({ state: "hidden" });
      await select("project-policy-gitCommitReviewMode", "仅生成草稿");
      assert.equal(await page.getByText("工作树准备与验证", { exact: true }).count(), 0);
      assert.equal(await page.getByTestId("project-policy-setupCommands").count(), 0);
      assert.equal(await page.getByTestId("project-policy-copyIgnoredPaths").count(), 0);
      assert.equal(await page.getByTestId("project-policy-validationCommands").count(), 0);
      await configure({ failSave: true });
      await select("project-policy-gitCommitReviewMode", "生成并打开审核");
      await page.getByText("fixture-save-failed").waitFor();
      assert.match(
        await page.getByTestId("project-policy-gitCommitReviewMode").innerText(),
        /仅生成草稿/,
      );
      await configure({ failSave: false });
      await select("project-policy-gitCommitReviewMode", "生成并打开审核");
      const settings = await fixture("settings");
      assert.match(await page.getByTestId("draft-execution-mode").innerText(), /本地目录/);
      assert.match(
        await page.getByTestId("project-policy-effective-gitCommitReviewMode").innerText(),
        /生成并打开审核/,
      );
      assert.match(
        await page.getByTestId("project-execution-policy").innerText(),
        /任务完成后的提交审核/,
      );
      assert.equal(settings.projectExecutionPreferences.other.executionMode, "worktree");
      assert.deepEqual(settings.projectExecutionPreferences["/fixture/repo"], {
        executionMode: "local",
        gitCommitReviewMode: "draft-and-review",
        setupCommands: ["pnpm install", "pnpm build"],
        copyIgnoredPaths: ["cache/data"],
        validationCommands: ["pnpm test"],
      });
      const last = (await calls())
        .filter((call) => call.method === "settings.update")
        .at(-1).params;
      assert.deepEqual(Object.keys(last.projectExecutionPreferences), ["/fixture/repo"]);
      assert.deepEqual(Object.keys(last.projectExecutionPreferences["/fixture/repo"]).sort(), [
        "gitCommitReviewMode",
      ]);
    },
  );
  await runWorktreeReviewSettingsCases({ t, page, load, select, fixture, configure, calls });
  await runWorktreeManagementCases({ t, page, load, openProjectWorktrees, calls, fixture });
  await t.test("切换会话读取实际工作树，多根文件搜索不回原目录；刷新失败禁用入口", async () => {
    await load();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="actual-location"]').textContent === "/fixture/repo",
    );
    await fixture("chooseTask", "orphan");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="actual-location"]').textContent ===
        "/fixture/worktrees/task",
    );
    assert.equal(await page.getByTestId("task-worktree-badge").count(), 1);
    assert.equal(
      await page.getByTestId("file-entry").getAttribute("data-workspace"),
      "/fixture/worktrees/task",
    );
    await page.waitForFunction(() =>
      globalThis.__worktreeFixture.calls.some(
        (call) =>
          call.method === "fileSearch" && call.params.rootPath === "/fixture/worktrees/task/tools",
      ),
    );
    await configure({ holdRead: true });
    await fixture("invalidate");
    await page.getByTestId("file-entry").waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("actual-location").innerText(), "pending");
    await configure({ failRead: true, holdRead: false });
    await fixture("releaseRead");
    await page.getByText("fixture-read-failed").waitFor();
    assert.equal(await page.getByTestId("actual-location").innerText(), "unavailable");
    assert.equal(await page.getByTestId("file-entry").count(), 0);
    await configure({ failRead: false });
    await fixture("chooseTask", "local");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="actual-location"]').textContent === "/fixture/repo",
    );
    assert.equal(await page.getByTestId("task-worktree-badge").count(), 0);
  });
  await t.test("英文手机宽度下模式、项目配置无横向溢出", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await load("?english");
    await select("draft-execution-mode", "Worktree");
    assert.equal(await page.getByText("Worktree setup and validation", { exact: true }).count(), 0);
    assert.match(
      await page.getByTestId("project-execution-policy").innerText(),
      /Commit review after task completion/,
    );
    assert.equal(
      await page.getByTestId("settings-git-commit-review-mode-select").getAttribute("aria-label"),
      "Commit review after task completion",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.match(await page.getByTestId("worktree-base-trigger").innerText(), /L-GO/);
  });
  await runWorktreePublicationCase({ t, page, load, openProjectWorktrees, calls, configure });
  await runBranchDeletionCases({ t, page, url, calls, select });
  await runBranchPickerCases({ t, page, url, calls, select });
  await runWorktreeWorkflowCases({ t, page, url, calls, configure, select });
  await runForkPreparationCases({ t, page, url, calls });
  assert.deepEqual(errors, []);
});
