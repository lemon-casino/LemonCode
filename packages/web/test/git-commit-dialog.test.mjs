import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { chromium } from "playwright-core";
import { runGitPublishCases } from "./git-publish-cases.mjs";
import { runGitPublishEditingCases } from "./git-publish-editing-cases.mjs";
import { runGitReviewNavigationCases } from "./git-review-navigation-cases.mjs";
import { runGitReviewCrossPlatformCases } from "./git-review-cross-platform-cases.mjs";

// 实际共享组件 + 桩 Host 服务；不读取用户仓库、不调用模型、不提交 Git。
test("提交纪要手动入口、弹窗生命周期和确认控件浏览器回归", { timeout: 300_000 }, async (t) => {
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
  const visibleLogs = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("提交弹窗已显示")) visibleLogs.push(message.text());
  });
  const url = `http://127.0.0.1:${port}/test/fixtures/git-commit-dialog.html`;
  if (process.env.LCODE_GIT_REVIEW_TEST_CASES === "shared-host") {
    await runGitReviewCrossPlatformCases(t, { browser, url });
    assert.deepEqual(errors, []);
    return;
  }
  await runGitReviewNavigationCases(t, { page, url });
  await runGitReviewCrossPlatformCases(t, { browser, url });
  const button = page.getByTestId("v4-composer-commit-summary");
  const dialog = page.getByTestId("git-commit-dialog");
  const input = page.getByTestId("git-commit-message-input");
  const fixture = async (method, ...args) =>
    page.evaluate(
      ({ method, args }) => {
        return globalThis.__gitCommitFixture[method](...args);
      },
      { method, args },
    );
  const loaded = async () => {
    await page.goto(url);
    await button.waitFor();
  };
  const generated = async () => {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-commit-message-input"]')?.value.length > 0,
    );
  };
  const calls = () => page.evaluate(() => globalThis.__gitCommitFixture.calls);

  await t.test("本地与工作树文案跟随真实会话绑定，不跟随项目默认；中英文和手机均一致", async () => {
    for (const english of [false, true]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url + (english ? "?english" : ""));
      await button.waitFor();
      assert.equal(
        await button.getAttribute("aria-label"),
        english ? "Generate a commit draft and open review" : "生成提交草稿并打开审核",
      );
      const trigger = page.getByTestId("git-action-trigger");
      const title = page.getByTestId("git-commit-workflow-title");
      const summary = page.getByTestId("git-commit-execution-summary");
      await trigger.click();
      assert.equal(await title.innerText(), english ? "Commit review" : "提交审核");
      assert.match(
        await summary.innerText(),
        english ? /shared project directory/ : /共享项目目录/,
      );
      assert.equal(await page.getByTestId("commit-and-merge-control").count(), 0);
      assert.match(
        await page.getByTestId("git-commit-action-item-commit").innerText(),
        english ? /^Confirm commit/ : /^确认提交/,
      );
      await page.getByTestId("git-commit-close").click();
      await fixture("executionMode", "worktree");
      await page
        .getByRole("button", {
          name: english ? "Commit and merge review" : "提交与合并审核",
          exact: true,
        })
        .waitFor();
      await trigger.click();
      assert.equal(await title.innerText(), english ? "Commit and merge review" : "提交与合并审核");
      assert.match(await summary.innerText(), /\/fixture\/worktrees\/a/);
      assert.match(
        await page.getByTestId("git-commit-action-item-commit").innerText(),
        english ? /worktree changes only/ : /仅提交工作树更改/,
      );
      await page.getByTestId("commit-and-merge-control").waitFor();
      assert.match(await dialog.innerText(), english ? /Project target: L-GO/ : /原项目目标：L-GO/);
      await page.getByTestId("git-publish-toggle").click();
      assert.match(await dialog.innerText(), english ? /source worktree branch/ : /来源工作树分支/);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.getByTestId("git-commit-close").click();
      await fixture("executionMode", "local");
      await page
        .getByRole("button", { name: english ? "Commit review" : "提交审核", exact: true })
        .waitFor();
      await trigger.click();
      assert.equal(await title.innerText(), english ? "Commit review" : "提交审核");
      assert.match(await summary.innerText(), /\/fixture\/repo/);
      assert.equal(await page.getByTestId("commit-and-merge-control").count(), 0);
      assert.equal((await calls()).length, 0);
    }
  });

  await t.test("设置关闭隐藏；已完成会话切换不调用 AI，无关脏文件不显示", async () => {
    await loaded();
    assert.equal((await calls()).length, 0);
    await fixture("setting", false);
    await button.waitFor({ state: "hidden" });
    await fixture("setting", true);
    await button.waitFor();
    await fixture("switchSession", "b");
    await button.waitFor();
    assert.equal((await calls()).length, 0);
    await fixture("switchSession", "none");
    await button.waitFor({ state: "hidden" });
    await fixture("switchSession", "a");
    await button.waitFor();
    await fixture("dirty", ["b.ts"]);
    await button.waitFor({ state: "hidden" });
  });
  await t.test("手动只生成一次、限定会话、不改输入草稿，隐藏面板仍显示 Portal", async () => {
    await loaded();
    await fixture("hideMenu");
    await fixture("holdGeneration");
    await button.click();
    await dialog.waitFor();
    await page.waitForFunction(() => globalThis.__gitCommitFixture.calls.length === 1);
    assert.equal(await button.getAttribute("aria-label"), "正在生成提交草稿");
    assert.equal(await button.isDisabled(), true);
    await fixture("rerender");
    assert.equal((await calls()).length, 1);
    await fixture("release");
    await generated();
    const request = (await calls())[0];
    assert.deepEqual(request.currentSessionFilePaths, ["a.ts"]);
    assert.equal(request.conversationContext.sessionId, "a");
    assert.equal(await input.inputValue(), "修复 a 的布局适配");
    assert.equal(await page.getByTestId("composer-draft").inputValue(), "待发送的草稿不能改变");
    assert.equal(
      await page.getByTestId("git-commit-action-item-commit").getAttribute("aria-disabled"),
      "true",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await fixture("rerender");
    assert.equal((await calls()).length, 1);
    await fixture("switchSession", "b");
    await button.waitFor();
    await fixture("switchSession", "a");
    await button.waitFor();
    assert.equal((await calls()).length, 1);
    assert.equal(await dialog.count(), 0);
  });
  await t.test("工作流父会话无直接改动仍读取宿主子任务；生成上下文是父会话", async () => {
    await loaded();
    await fixture("switchSession", "workflow");
    await page.getByTestId("session").filter({ hasText: "workflow" }).waitFor();
    await button.waitFor();
    await button.click();
    await generated();
    const request = (await calls())[0];
    assert.deepEqual(request.currentSessionFilePaths, ["workflow.ts"]);
    assert.equal(request.conversationContext.sessionId, "workflow");
  });
  await t.test("生成期间关闭或切换会话，迟到结果不复活、不覆盖新窗口", async () => {
    await loaded();
    await fixture("holdGeneration");
    await button.click();
    await dialog.waitFor();
    await page.waitForFunction(() => globalThis.__gitCommitFixture.calls.length === 1);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await fixture("switchSession", "b");
    await button.waitFor();
    await button.click();
    await generated();
    assert.equal(await input.inputValue(), "修复 b 的布局适配");
    await fixture("release");
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-commit-generate-button"]')?.disabled,
    );
    assert.equal(await input.inputValue(), "修复 b 的布局适配");
    assert.equal((await calls()).length, 2);
  });
  await t.test("加载失败保留窗口及重试入口，不产生无提示空窗", async () => {
    await loaded();
    await fixture("failLoad");
    await button.click();
    await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.innerText(), /fixture-load-failure/);
    assert.equal((await calls()).length, 0);
    await dialog.getByRole("button", { name: "重试读取变更" }).click();
    await generated();
    assert.equal((await calls()).length, 1);
  });
  await t.test("目录占用错误显示中英文提示，保留其它失败细节且不自动调用模型", async () => {
    const busy = "Checkout is busy; wait for its current writer to finish";
    for (const english of [false, true]) {
      for (const [message, code] of [
        ["fixture-checkout-busy", "LCODE_CHECKOUT_BUSY"],
        [busy, undefined],
      ]) {
        await page.goto(url + (english ? "?english" : ""));
        await page.getByTestId("git-action-trigger").waitFor();
        await fixture("failLoad", message, code);
        await page.getByTestId("git-action-trigger").click();
        await dialog.getByRole("alert").waitFor();
        assert.match(
          await dialog.innerText(),
          english ? /directory is in use/ : /目录正被其他会话/,
        );
        assert.doesNotMatch(await dialog.innerText(), /fixture-checkout-busy|Checkout is busy/);
        await dialog
          .getByRole("button", {
            name: english ? "Retry loading changes" : "重试读取变更",
            exact: true,
          })
          .click();
        await page.getByTestId("git-commit-message-input").waitFor();
        assert.equal((await calls()).length, 0);
      }
      await page.goto(url + (english ? "?english" : ""));
      await page.getByTestId("git-action-trigger").waitFor();
      await fixture("failLoad", "fixture-detailed-failure", "OTHER_ERROR");
      await page.getByTestId("git-action-trigger").click();
      await dialog.getByRole("alert").waitFor();
      assert.match(await dialog.innerText(), /fixture-detailed-failure/);
      assert.equal((await calls()).length, 0);
    }
  });
  await t.test("生成失败保留原因并阻止未经审核提交；显式重试成功", async () => {
    await loaded();
    await fixture("failGenerate");
    await button.click();
    await page.getByTestId("git-commit-generate-button").waitFor();
    await page.waitForFunction(
      () =>
        globalThis.__gitCommitFixture.calls.length === 1 &&
        !document.querySelector('[data-testid="git-commit-generate-button"]').disabled,
    );
    assert.equal(
      await page.getByTestId("git-commit-action-item-commit").getAttribute("aria-disabled"),
      "true",
    );
    await page.getByTestId("git-commit-generate-button").click();
    await generated();
    assert.equal((await calls()).length, 2);
  });
  await t.test(
    "自动草稿在隐藏面板下显示且 StrictMode 不重复打开，已编辑内容不被新草稿覆盖",
    async () => {
      await loaded();
      await fixture("hideMenu");
      await fixture("automatic");
      await generated();
      assert.equal(await input.inputValue(), "自动生成的中文提交纪要");
      await input.fill("用户检查后的中文纪要");
      await fixture("automatic");
      assert.equal(await input.inputValue(), "用户检查后的中文纪要");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await fixture("rerender");
      assert.equal(await dialog.count(), 0);
      assert.equal((await calls()).length, 0);
    },
  );
  await t.test("统一审核模式控制自动开窗，保留草稿和关闭模式下的手动审核", async () => {
    for (const mode of ["off", "draft", "draft-and-review"]) {
      await page.goto(url + `?reviewMode=${mode}`);
      await page.getByTestId("git-action-trigger").waitFor();
      await page.waitForFunction(
        (mode) => document.querySelector('[data-testid="review-mode"]').textContent === mode,
        mode,
      );
      await fixture("automatic");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="automatic-ready"]').textContent.length > 0,
      );
      if (mode === "draft-and-review") {
        await generated();
      } else {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        assert.equal(await dialog.count(), 0);
        await page.getByTestId("git-action-trigger").click();
        await input.waitFor();
      }
      assert.equal(await input.inputValue(), "自动生成的中文提交纪要");
      assert.equal((await calls()).length, 0);
      await page.getByTestId("git-commit-close").click();
      await dialog.waitFor({ state: "hidden" });
      await fixture("reviewMode", "draft-and-review");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      assert.equal(await dialog.count(), 0);
      assert.equal((await calls()).length, 0);
      const writes = await page.evaluate(
        () =>
          globalThis.__gitCommitFixture.publish.calls.filter((call) =>
            ["commit", "push"].includes(call.method),
          ).length,
      );
      assert.equal(writes, 0);
    }
    await page.goto(url + "?reviewMode=draft");
    await page.getByTestId("git-action-trigger").waitFor();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="review-mode"]').textContent === "draft",
    );
    await fixture("automatic");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="automatic-ready"]').textContent.length > 0,
    );
    await fixture("reviewMode", "draft-and-review");
    await generated();
    assert.equal(await input.inputValue(), "自动生成的中文提交纪要");
    assert.equal((await calls()).length, 0);
  });
  await t.test("旧自动草稿滞留时切换会话或日志代次，不弹出、不带入消息与文件范围", async () => {
    for (const [method, value] of [
      ["switchSession", "b"],
      ["logEpoch", "epoch-b"],
    ]) {
      await loaded();
      await fixture("automatic");
      await generated();
      await fixture(method, value);
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      assert.equal(await dialog.count(), 0);
      assert.equal((await calls()).length, 0);
      await page.getByTestId("git-action-trigger").click();
      await input.waitFor();
      assert.equal(await input.inputValue(), "");
      assert.match(await dialog.innerText(), /3\s*个文件/);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await button.click();
      await generated();
      const session = method === "switchSession" ? "b" : "a";
      assert.equal(await input.inputValue(), `修复 ${session} 的布局适配`);
      assert.deepEqual((await calls())[0].currentSessionFilePaths, [`${session}.ts`]);
    }
  });
  await t.test("桌面/390px、浅/深色：复选框居中对齐首行，整行可点击且无横溢出", async () => {
    for (const width of [1280, 390])
      for (const theme of ["theme-zai-light", "dark theme-zai-dark"]) {
        await page.setViewportSize({ width, height: 844 });
        await loaded();
        await page.evaluate((theme) => {
          document.documentElement.className = theme;
        }, theme);
        await button.click();
        await generated();
        const checkbox = page.getByTestId("git-review-acknowledge");
        await checkbox.scrollIntoViewIfNeeded();
        const positions = await checkbox.evaluate((control) => {
          const box = control.getBoundingClientRect();
          const label = control.closest("label");
          const text = label.querySelector("span");
          const rect = text.getBoundingClientRect();
          const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
          return {
            difference: Math.abs(box.top + box.height / 2 - rect.top - lineHeight / 2),
            width: box.width,
            labelWidth: label.getBoundingClientRect().width,
            overflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        assert.ok(positions.difference < 1, JSON.stringify({ width, theme, ...positions }));
        assert.equal(positions.width, 16);
        assert.ok(positions.overflow <= 1);
        await checkbox.locator("..").getByText("我已检查冻结补丁", { exact: false }).click();
        assert.equal(await checkbox.getAttribute("data-state"), "checked");
      }
  });
  page.setDefaultTimeout(5_000);
  await t.test("桌面/手机：审核不可用仍预填自动/手动纪要，但按钮与快捷键不能提交", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const automatic of [true, false]) {
        await loaded();
        if (automatic) await fixture("automatic", true);
        else {
          await fixture("reviewUnavailable");
          await button.click();
        }
        await generated();
        assert.match(await input.inputValue(), /中文提交纪要|布局适配/);
        assert.match(await dialog.innerText(), /内容审核不可用/);
        assert.equal(
          await page.getByTestId("git-commit-action-item-commit").getAttribute("aria-disabled"),
          "true",
        );
        await page.keyboard.press("Control+Enter");
        assert.equal(await dialog.isVisible(), true);
        assert.equal(
          (
            await page.evaluate(() =>
              globalThis.__gitCommitFixture.publish.calls.filter(
                (call) => call.method === "commit",
              ),
            )
          ).length,
          0,
        );
        await input.fill("用户确认前保留的纪要");
        await fixture("automatic", true);
        assert.equal(await input.inputValue(), "用户确认前保留的纪要");
      }
    }
  });
  await runGitPublishCases(t, { page, url });
  await runGitPublishEditingCases(t, { page, url });
  assert.deepEqual(errors, []);
  assert.ok(visibleLogs.length > 0, "实际可见事件必须有日志，不用打开请求冒充已显示");
});
