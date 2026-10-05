import { runMultiSessionSendCases } from "./multi-session-send-cases.mjs";
import { runDraftAttachmentCases } from "./draft-attachment-and-branch-cases.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";

test("真实 ConversationComposer 的新旧会话回车及按钮发送", { timeout: 240_000 }, async (t) => {
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
    { cwd: fileURLToPath(new URL("../", import.meta.url)), windowsHide: true, stdio: "pipe" },
  );
  let output = "";
  let browser;
  server.stdout.on("data", (data) => {
    output += data.toString();
  });
  server.stderr.on("data", (data) => {
    output += data.toString();
  });
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
    const timer = setTimeout(() => resolve(false), 45_000);
    const check = () => {
      if (output.includes("Local:")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    server.stdout.on("data", check);
    server.once("exit", () => {
      clearTimeout(timer);
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(7_000);
  // 首次访问会触发 Vite 编译共享 UI；页面加载与发送交互分别设置等待边界。
  page.setDefaultNavigationTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    process.stdout.write(`${error.stack}\n`);
  });
  const url = `http://127.0.0.1:${port}/test/fixtures/conversation-send.html`;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const mode of ["local", "worktree"]) {
      for (const existing of [false, true]) {
        for (const trigger of ["Enter", "button"]) {
          await t.test(
            `${width}px ${mode} ${existing ? "旧会话" : "新会话"} ${trigger}`,
            async () => {
              await page.goto(
                `${url}?${existing ? "existing&" : ""}${mode === "worktree" ? "worktree" : ""}`,
              );
              const editor = page.getByTestId("v4-composer-input");
              await editor.fill("发送回归测试");
              await page.waitForFunction(() => {
                const button = document.querySelector('[data-testid="v4-composer-send"]');
                return button && !button.disabled;
              });
              if (trigger === "Enter") await editor.press("Enter");
              else await page.getByTestId("v4-composer-send").click();
              await page
                .locator('[data-v4-timeline-message-layer="true"]')
                .getByText("发送回归测试", { exact: true })
                .waitFor();
              assert.equal(
                await page.getByTestId("session-list").innerText(),
                existing ? "existing-session" : "created-session",
              );
              assert.equal(await editor.textContent(), "");
              const calls = await page.evaluate(() => globalThis.__sendFixture.calls);
              assert.equal(calls.length, 1);
              assert.deepEqual(calls[0].options.submission.modelSelection, {
                providerId: "custom",
                modelId: "demo",
                options: { reasoningLevel: "high", speed: "fast" },
              });
            },
          );
        }
      }
    }
  }
  await runMultiSessionSendCases(t, browser, url);
  await t.test("发送失败保留原输入，明确错误后可以重试", async () => {
    await page.goto(url);
    await page.getByTestId("v4-composer-input").waitFor();
    await page.evaluate(() => {
      globalThis.__sendFixture.fail = true;
    });
    const editor = page.getByTestId("v4-composer-input");
    await editor.fill("失败时保留内容");
    await editor.press("Enter");
    await page.getByRole("alert").waitFor();
    assert.equal(await editor.innerText(), "失败时保留内容");
    await page.evaluate(() => {
      globalThis.__sendFixture.fail = false;
    });
    await page.getByTestId("v4-composer-send").click();
    await page
      .locator('[data-v4-timeline-message-layer="true"]')
      .getByText("失败时保留内容", { exact: true })
      .waitFor();
  });
  await t.test("等待发送结果期间不重复发送，也不清除新输入", async () => {
    await page.goto(`${url}?existing`);
    const editor = page.getByTestId("v4-composer-input");
    await editor.waitFor();
    await page.evaluate(() => {
      globalThis.__sendFixture.hold = true;
    });
    await editor.fill("等待结果的消息");
    await editor.press("Enter");
    await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
    assert.equal(await page.getByTestId("v4-composer-send").isDisabled(), true);
    await editor.fill("发送期间的新输入");
    await page.evaluate(() => globalThis.__sendFixture.release());
    await page
      .locator('[data-v4-timeline-message-layer="true"]')
      .getByText("等待结果的消息", { exact: true })
      .waitFor();
    assert.equal(await editor.innerText(), "发送期间的新输入");
    assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 1);
  });
  for (const width of [1280, 390]) {
    for (const english of [false, true]) {
      await t.test(
        `${width}px ${english ? "英文" : "中文"} 工作树首发在聊天区准备，成功后只保留真实消息`,
        async () => {
          await page.setViewportSize({ width, height: 800 });
          await page.goto(`${url}?worktree${english ? "&english" : ""}`);
          await page.evaluate(() => {
            Object.assign(globalThis.__sendFixture, { prepare: true, hold: true });
          });
          const editor = page.getByTestId("v4-composer-input");
          await editor.fill("工作树聊天区首发");
          await editor.press("Enter");
          const card = page.getByTestId("worktree-preparation-card");
          await card.locator('[data-step="environment"][data-state="running"]').waitFor();
          // contenteditable 空段落的 innerText 含换行，按可见正文断言空草稿。
          assert.equal((await editor.innerText()).trim(), "");
          assert.equal(await editor.getAttribute("contenteditable"), "true");
          await editor.fill("准备期间编辑的下一条草稿");
          await editor.press("Enter");
          assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 1);
          await page
            .getByTestId("worktree-pending-input")
            .getByText("工作树聊天区首发", { exact: true })
            .waitFor();
          assert.equal(await page.getByTestId("fixture-welcome").count(), 0);
          assert.equal(
            await page
              .locator('[data-v4-composer-dock] [data-testid="worktree-preparation-card"]')
              .count(),
            0,
          );
          assert.equal(
            await card.locator('xpath=ancestor::*[@data-v4-timeline-message-layer="true"]').count(),
            1,
          );
          assert.equal(await page.getByTestId("session-list").textContent(), "");
          await card.getByRole("button", { name: english ? "More details" : "更多详情" }).click();
          await page
            .getByTestId("worktree-preparation-log")
            .getByText(/Installing dependencies/)
            .waitFor();
          if (!english && process.env.LCODE_TEST_ARTIFACT_DIR) {
            await mkdir(process.env.LCODE_TEST_ARTIFACT_DIR, { recursive: true });
            await page.screenshot({
              path: join(process.env.LCODE_TEST_ARTIFACT_DIR, `chat-preparation-${width}.png`),
            });
          }
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.evaluate(() => {
            const f = globalThis.__sendFixture;
            f.preparation.status = "ready";
            f.preparation.preparation.stage = "ready";
            f.release();
          });
          await page
            .getByTestId("session-list")
            .getByText("created-session", { exact: true })
            .waitFor();
          await page.getByTestId("worktree-pending-input").waitFor({ state: "hidden" });
          await card
            .getByText(english ? "Worktree created" : "已创建工作树", { exact: true })
            .waitFor();
          await page.getByTestId("worktree-task-location").waitFor();
          assert.equal(await card.count(), 1);
          assert.equal((await editor.innerText()).trimEnd(), "准备期间编辑的下一条草稿");
          await page.getByTestId("worktree-task-location").getByRole("button").click();
          await page.getByTestId("worktree-task-dialog").waitFor();
          await page.getByTestId("git-review-dismiss").click();
          assert.equal(await card.count(), 1);
          assert.equal(
            await page
              .locator('[data-v4-timeline-message-layer="true"]')
              .getByText("工作树聊天区首发", { exact: true })
              .count(),
            1,
          );
          assert.equal(await card.locator('xpath=ancestor::*[@data-row-id="1"]').count(), 1);
          await editor.fill("工作树续发");
          await page.evaluate(() => {
            globalThis.__sendFixture.hold = false;
          });
          await editor.press("Enter");
          await page
            .locator('[data-v4-timeline-message-layer="true"]')
            .getByText("工作树续发", { exact: true })
            .waitFor();
          assert.equal(await card.count(), 1);
          assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 2);
          await page.evaluate(() => globalThis.__sendFixture.hideStart());
          await card.waitFor({ state: "hidden" });
          await page.evaluate(() => globalThis.__sendFixture.showStart());
          await card
            .getByText(english ? "Worktree created" : "已创建工作树", { exact: true })
            .waitFor();
          await page.evaluate(() => globalThis.__sendFixture.forkSame());
          await card.waitFor({ state: "hidden" });
        },
      );
    }
  }
  await t.test("准备失败保留首发；同 commandId 重试继续读取 Host 阶段", async () => {
    await page.goto(`${url}?worktree`);
    await page.evaluate(() => {
      Object.assign(globalThis.__sendFixture, { prepare: true, hold: true });
    });
    const editor = page.getByTestId("v4-composer-input");
    await editor.fill("失败后保留首发");
    await editor.press("Enter");
    const card = page.getByTestId("worktree-preparation-card");
    await card.locator('[data-step="environment"][data-state="running"]').waitFor();
    const requestId = await page.evaluate(() => globalThis.__sendFixture.preparation.requestId);
    await page.evaluate(() => {
      const f = globalThis.__sendFixture;
      f.preparation.status = "failed";
      f.preparation.preparation.stage = "failed";
      f.fail = true;
      f.release();
    });
    await card.getByText("worktreePreparationFailed", { exact: true }).waitFor();
    assert.equal(await editor.innerText(), "失败后保留首发");
    await card.getByRole("button", { name: "重试准备", exact: true }).click();
    await page.evaluate(() => globalThis.__sendFixture.restartPreparation());
    await card.getByText("工作树准备失败", { exact: true }).waitFor();
    await page.evaluate(() => {
      const f = globalThis.__sendFixture;
      f.preparation.status = "preparing";
      f.preparation.preparation.stage = "checkout";
      f.preparation.preparation.activeStep = "checkout";
    });
    await card.locator('[data-step="checkout"][data-state="running"]').waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.__sendFixture.preparation.requestId),
      requestId,
    );
    await page
      .getByTestId("worktree-pending-input")
      .getByText("失败后保留首发", { exact: true })
      .waitFor();
  });
  await t.test("准备失败不能覆盖等待期间新写的下一条草稿", async () => {
    await page.goto(`${url}?worktree`);
    await page.evaluate(() => {
      Object.assign(globalThis.__sendFixture, { prepare: true, hold: true });
    });
    const editor = page.getByTestId("v4-composer-input");
    await editor.fill("准备中的首发");
    await editor.press("Enter");
    await page
      .getByTestId("worktree-preparation-card")
      .locator('[data-step="environment"][data-state="running"]')
      .waitFor();
    await editor.fill("继续修复下一条草稿");
    await page.evaluate(() => {
      const f = globalThis.__sendFixture;
      f.preparation.status = "failed";
      f.preparation.preparation.stage = "failed";
      f.fail = true;
      f.release();
    });
    await page.getByText("fixture-send-failed", { exact: true }).waitFor();
    assert.equal(await editor.innerText(), "继续修复下一条草稿");
    assert.equal(await editor.getAttribute("contenteditable"), "true");
    assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 1);
  });
  await t.test("聊天区改用本地等待取消结算，保留输入且不创建侧栏会话", async () => {
    await page.goto(`${url}?worktree`);
    await page.evaluate(() => {
      Object.assign(globalThis.__sendFixture, { prepare: true, hold: true });
    });
    const editor = page.getByTestId("v4-composer-input");
    await editor.fill("改用本地后重新发送");
    await editor.press("Enter");
    const card = page.getByTestId("worktree-preparation-card");
    await card.locator('[data-step="environment"][data-state="running"]').waitFor();
    await card.getByRole("button", { name: "改用本地目录", exact: true }).click();
    await page.waitForFunction(() => globalThis.__sendFixture.updates.length === 1);
    await page.evaluate(() => globalThis.__sendFixture.release());
    await page.getByRole("alert").waitFor();
    await card.waitFor({ state: "hidden" });
    assert.equal(await editor.innerText(), "改用本地后重新发送");
    assert.equal(await page.getByTestId("session-list").textContent(), "");
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__sendFixture.updates[0].projectExecutionPreferences["/fixture/origin"]
            .executionMode,
      ),
      "local",
    );
  });

  await t.test("Git 失败转交使用真实 Composer 追加并保留图片，桌面与窄屏均不自动发送", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}?existing&handoff`);
      const editor = page.getByTestId("v4-composer-input");
      await editor.fill("已有的下一条草稿");
      await editor.evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(
            [
              Uint8Array.from(
                atob(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
                ),
                (char) => char.charCodeAt(0),
              ),
            ],
            "keep.png",
            { type: "image/png" },
          ),
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      });
      await page.waitForFunction(() => globalThis.__sendFixture.uploads.length === 1);
      await page.getByTestId("git-failure-to-composer").click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="v4-composer-input"]')
          ?.textContent.includes("src/button.ts:12"),
      );
      const text = await editor.innerText();
      assert.ok(text.startsWith("已有的下一条草稿"));
      assert.match(text, /L-GO/);
      assert.equal(text.split("请协助处理以下 Git 操作问题").length, 2);
      assert.equal(await page.getByRole("img", { name: "keep.png", exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 0);
    }
  });
  await runDraftAttachmentCases({ t, page, url });
  assert.deepEqual(errors, []);
});
