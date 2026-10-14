import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "远控真实 hooks 展示同路径四类项目、工作树与分组，刷新和断线换代保持隔离",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(".tmp/remote-workspace-catalog", { recursive: true });
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-workspace-catalog.html`);
      await page
        .getByTestId("project-local")
        .waitFor()
        .catch(async (error) => {
          t.diagnostic(
            JSON.stringify({
              errors,
              body: (await page.locator("body").innerText()).slice(0, 2000),
            }),
          );
          throw error;
        });
      for (const kind of ["local", "ssh", "wsl", "docker"]) {
        await page.getByTestId(`project-${kind}`).waitFor();
        await page.getByTestId("worktrees").getByText(`${kind}-tree`, { exact: true }).waitFor();
        await page.getByRole("button", { name: `${kind} group`, exact: true }).waitFor();
      }
      await page.getByTestId("project-wsl").click();
      await page.getByTestId("active-task").getByText("wsl-task", { exact: true }).waitFor();
      const identity = await page.getByTestId("active-identity").textContent();
      assert.notEqual(identity, "local");
      await page.reload();
      await page.waitForFunction(
        (identity) =>
          document.querySelector('[data-testid="active-identity"]')?.textContent === identity,
        identity,
      );
      await page.getByTestId("active-task").getByText("wsl-task", { exact: true }).waitFor();
      const reads = await page.evaluate(() => window.__catalogFixture.reads);
      assert.ok(reads.includes("stat:wsl"));
      assert.ok(!reads.includes("stat:local"));
      await page.getByRole("button", { name: "ssh group", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__catalogFixture.writes), [
        "ssh:same-group",
      ]);
      await page.evaluate(() => window.__catalogFixture.disconnect());
      await page.waitForFunction(
        () => document.querySelector('[data-testid="session-wsl"]')?.textContent === "offline",
      );
      await page
        .getByTestId("errors")
        .getByText("remote-workspace-disconnected", { exact: true })
        .waitFor();
      assert.equal(await page.getByTestId("session-ssh").textContent(), "session-0");
      assert.equal(await page.getByTestId("session-docker").textContent(), "session-2");
      await page.evaluate(() => window.__catalogFixture.reconnect());
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="session-wsl"]')?.textContent === "wsl-replacement",
      );
      await page.getByTestId("worktrees").getByText("wsl-tree", { exact: true }).waitFor();
      await page.getByRole("button", { name: "wsl group reconnected", exact: true }).waitFor();
      assert.equal(await page.getByTestId("active-identity").textContent(), identity);
      await page.screenshot({ path: `.tmp/remote-workspace-catalog/${width}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);
