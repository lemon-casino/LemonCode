import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
test(
  "preflight source errors expose the exact missing base directory on its own row",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    const page = await context.newPage();
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?bases&sets&missing-base`,
    );
    await page.getByRole("button", { name: "冻结选择", exact: true }).click();
    const preparation = page.getByTestId("draft-execution-set-preparation");
    await preparation.getByText("/fixture/repo/contracts", { exact: true }).waitFor();
    await preparation.getByTestId("sidebar-source-error").hover();
    await page
      .getByRole("tooltip")
      .filter({ hasText: "/fixture/repo/contracts: folder is absent from the selected Git base" })
      .waitFor();
    assert.equal(await page.getByText("部分来源不可用", { exact: true }).count(), 0);
  },
);
test(
  "collaboration bases group repository members, retain remote scope and freeze submitted choices",
  { timeout: 90000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const remote of [false, true]) {
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?bases&sets${remote ? "&remote-bases" : ""}`,
      );
      await page.getByTestId("collaboration-base-trigger").click();
      const repositories = page.getByTestId("collaboration-base-repository");
      assert.equal(
        await repositories.count(),
        2,
        "frontend and contracts share a single source repository",
      );
      await repositories.nth(0).getByTestId("worktree-base-trigger").click();
      await page
        .getByTestId("worktree-base-picker")
        .getByText("frontend-base", { exact: true })
        .click();
      await repositories.nth(1).getByTestId("worktree-base-trigger").click();
      await page
        .getByTestId("worktree-base-picker")
        .getByText("backend-base", { exact: true })
        .click();
      assert.deepEqual(JSON.parse(await page.getByTestId("base-selection").innerText()), {
        "member-0": "frontend-base",
        "member-1": "frontend-base",
        "member-2": "backend-base",
      });
      const calls = await page.evaluate(() =>
        globalThis.__sidebarOrganization.calls.filter((call) => call.method === "baseBranches"),
      );
      assert.equal(calls.length, 2);
      assert.equal(Boolean(calls[0].params.workspaceIdentity), remote);
      if (remote)
        assert.ok(calls.every((call) => call.params.workspaceIdentity.includes("fixture.invalid")));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "冻结选择", exact: true }).click();
      assert.equal(await page.getByTestId("collaboration-base-trigger").isDisabled(), true);
      await page.getByRole("button", { name: "使用已有工作集", exact: true }).click();
      const shared = page.getByTestId("draft-execution-shared-files");
      await shared.waitFor();
      assert.match(await shared.innerText(), /共享文件/);
      assert.match(await shared.getAttribute("title"), /共享实际文件.*并行/);
    }
    assert.deepEqual(errors, []);
  },
);
