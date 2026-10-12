import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "memory settings select worktree memories from both storage locations",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const screenshots = fileURLToPath(
      new URL("../../../.lcode/component-quality/worktree-memory/", import.meta.url),
    );
    await mkdir(screenshots, { recursive: true });
    for (const width of [1280, 390]) {
      await t.test(
        `${width}px worktree scopes show independent paths and survive refresh`,
        async () => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          page.setDefaultTimeout(10_000);
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          t.after(async () => {
            assert.deepEqual(errors, [], diagnostics());
            await page.close();
          });
          await page.goto(
            `http://127.0.0.1:${port}/test/fixtures/memory-settings.html?worktree-memory`,
          );
          await page.getByTestId("settings-memory-count").waitFor();
          for (const [source, path] of [
            ["本机资料目录", "/fixture/user-profile/cli/memories/projects/checkout-hash/memory"],
            ["项目主文件夹", "/fixture/custom worktrees/checkout/.lcode/memory"],
          ]) {
            await page.getByTestId("settings-memory-scope-trigger").click();
            await page
              .getByRole("menuitemradio", {
                name: `local-project / lcode/task-memory-worktree · ${source}`,
                exact: true,
              })
              .click();
            await page.getByRole("menu").waitFor({ state: "detached" });
            const detail = page.getByTestId("settings-memory-storage-source");
            assert.ok((await detail.innerText()).includes(path));
            assert.match(
              await page.getByTestId("settings-memory-scope-trigger").innerText(),
              /lcode\/task-memory-worktree/,
            );
            assert.equal(await page.getByTestId("settings-memory-file-MEMORY.md").count(), 1);
            await page.getByTestId("settings-memory-refresh").click();
            await page
              .getByTestId("settings-memory-refresh")
              .locator(":scope:enabled")
              .waitFor({ state: "attached" });
            assert.ok((await detail.innerText()).includes(path));
            assert.equal(await page.getByTestId("fixture-change-count").innerText(), "0");
          }
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
            false,
          );
          await page
            .locator(".space-y-6")
            .screenshot({ path: `${screenshots}/${width}px-worktree.png` });
        },
      );
    }
  },
);
