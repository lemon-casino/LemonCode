import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";

// 实际共享组件 + 桩 Host 服务；不读取用户仓库、不调用模型、不提交 Git。
test("提交纪要手动入口、弹窗生命周期和确认控件浏览器回归", { timeout: 120_000 }, async (t) => {
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
      if (output.includes("Local:")) {
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
  const button = page.getByTestId("v4-composer-commit-summary");
  const dialog = page.getByTestId("git-commit-dialog");
  const input = page.getByTestId("git-commit-message-input");
  const fixture = async (method, ...args) =>
    page.evaluate(
      ({ method, args }) => {
        globalThis.__gitCommitFixture[method](...args);
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
  assert.deepEqual(errors, []);
  assert.ok(visibleLogs.length > 0, "实际可见事件必须有日志，不用打开请求冒充已显示");
});
