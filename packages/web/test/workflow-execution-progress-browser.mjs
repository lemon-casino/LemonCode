import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { chromium } from "playwright-core";

// 启动与清理独立于场景断言，仍只持有本测试自己的浏览器和 Vite 进程。
export async function startWorkflowProgressBrowser(t) {
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
  let browser;
  let output = "";
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    output += chunk;
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
    const timeout = setTimeout(() => resolve(false), 45_000);
    // Vite 在终端开启颜色时会在 Local 与冒号间插入 ANSI；就绪判定必须读可见文本。
    const check = () => {
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
  return { browser, port };
}

/** 关闭当前详情并完成它自己的卸载、还焦，之后才允许下一场景切换。 */
export async function closeWorkflowActivityDetails(page, activityPopover, diagnostic) {
  assert.equal(await activityPopover.count(), 1, "one activity popover must be open");
  const contentId = await activityPopover.getAttribute("id");
  assert.ok(contentId, "opened activity popover must have an id");
  const quotedId = JSON.stringify(contentId);
  const portal = page.locator(`[data-slot="popover-content"][id=${quotedId}]`);
  const triggerSelector = `[aria-controls=${quotedId}]`;
  const trigger = page.locator(triggerSelector);
  assert.equal(await trigger.count(), 1, "popover must identify one original trigger");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  diagnostic(`workflow activity close ${contentId}: open`);
  // 实测 Escape 返回时旧层仍在 closed 动画内且焦点尚未归还；open 消失不等于关闭完成。
  await page.keyboard.press("Escape");
  await page.locator(`${triggerSelector}[aria-expanded="false"]`).waitFor({ state: "attached" });
  diagnostic(`workflow activity close ${contentId}: closed`);
  await portal.waitFor({ state: "detached" });
  // Radix 卸载之后才还焦；等原触发器的真实状态，不用延时或重试掩盖跨阶段切换。
  await page
    .locator(`${triggerSelector}[aria-expanded="false"]:focus`)
    .waitFor({ state: "attached" });
  assert.equal(await portal.count(), 0, "closed activity portal must be detached");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  diagnostic(`workflow activity close ${contentId}: detached and focus restored`);
}
