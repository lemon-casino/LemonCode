import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const proxyScreenshots = fileURLToPath(
  new URL("../../../.artifacts/ssh-proxy-boundaries/", import.meta.url),
);

test(
  "saved remote history removal commits without a tab and survives reload",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const [width, opened] of [
      [1280, false],
      [390, true],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?empty&saved-history${opened ? "&opened" : ""}`,
        { timeout: 30000 },
      );
      const row = page.getByRole("button", { name: "保存的远程项目", exact: true });
      await row.waitFor();
      await page.getByRole("button", { name: "另一台远程项目", exact: true }).waitFor();
      // 保存失败仍展示原项目；重试必须再次提交，不可被已修改的 owner ref 误判为成功。
      await page.evaluate(() => globalThis.__sidebarOrganization.rejectHistorySave(true));
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "移除", exact: true }).click();
      await page.getByText("项目移除失败，请重试。", { exact: true }).waitFor();
      await row.waitFor();
      await page.evaluate(() => globalThis.__sidebarOrganization.rejectHistorySave(false));
      if (opened) {
        await row.click({ button: "right" });
        await page.getByRole("menuitem", { name: "重新连接", exact: true }).click();
        await page.waitForFunction(() => globalThis.__sidebarOrganization.facts.connects === 1);
        await row.hover();
        await row
          .locator("xpath=ancestor::li[1]")
          .getByRole("button", { name: "更多", exact: true })
          .click();
      } else await row.click({ button: "right" });
      await mkdir(proxyScreenshots, { recursive: true });
      await page.screenshot({
        path: `${proxyScreenshots}/history-removal-${width}.png`,
      });
      await page.getByRole("menuitem", { name: "移除", exact: true }).click();
      await row.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "另一台远程项目", exact: true }).waitFor();
      await page.getByRole("button", { name: "网站项目", exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.__sidebarOrganization
              .settings()
              .lastWorkspaceSession.filter((entry) => entry.kind === "remote").length,
        ),
        1,
      );
      await page.evaluate(() => {
        globalThis.__sidebarOrganization.finishConnection();
        globalThis.__sidebarOrganization.finishCancellation();
      });
      if (opened)
        await page.waitForFunction(
          () => globalThis.__sidebarOrganization.facts.finishedReconnects === 1,
        );
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.__sidebarOrganization
              .settings()
              .lastWorkspaceSession.filter((entry) => entry.kind === "remote").length,
        ),
        1,
      );
      await page.reload();
      await page.getByRole("button", { name: "另一台远程项目", exact: true }).waitFor();
      assert.equal(await row.count(), 0);
      assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "disconnected projects without known dependencies can be removed after catalog errors",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?empty`);
      const remote = page.getByRole("button", { name: "远程服务", exact: true });
      await remote.waitFor();
      await page.evaluate(() =>
        globalThis.__sidebarOrganization.setReadError(
          true,
          'Unrecognized keys: "useProxy", "proxyProfileId"',
        ),
      );
      await page.getByRole("button", { name: "读取失败 · 远程服务", exact: true }).waitFor();
      await page.evaluate(() => globalThis.__sidebarOrganization.offline());
      await page.getByRole("button", { name: "重新连接", exact: true }).waitFor();
      await page.evaluate(() => {
        globalThis.__sidebarOrganization.holdNextRead();
        globalThis.__sidebarOrganization.setReadError(false, null);
      });
      await page.waitForFunction(() => globalThis.__sidebarOrganization.hasHeldRead());
      await remote.click({ button: "right" });
      const remove = page.getByRole("menuitem", { name: "移除", exact: true });
      assert.equal(await remove.isEnabled(), true);
      await mkdir(proxyScreenshots, { recursive: true });
      await page.screenshot({
        path: `${proxyScreenshots}/offline-removal-${width}.png`,
      });
      await remove.click();
      await remote.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "网站项目", exact: true }).waitFor();
      await page.evaluate(() => globalThis.__sidebarOrganization.releaseRead());
      assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 0);
      assert.equal(
        await page.evaluate(() =>
          globalThis.__sidebarOrganization.calls.some((call) => call.method === "delete"),
        ),
        false,
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "source failures stay on their own rows and reread never reconnects",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("登录优化", { exact: true }).waitFor();
    await page.evaluate(() => globalThis.__sidebarOrganization.offline());
    await page.getByRole("button", { name: "重新连接", exact: true }).waitFor();
    await page.getByRole("button", { name: "远程服务", exact: true }).click({ button: "right" });
    assert.equal(
      await page.getByRole("menuitem", { name: "移除", exact: true }).isDisabled(),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.getByText(/部分来源/).count(), 0);
    assert.equal(await page.getByTestId("sidebar-source-error").count(), 0);
    await page.evaluate(() => globalThis.__sidebarOrganization.online());
    await page.evaluate(() =>
      globalThis.__sidebarOrganization.setReadError(false, "EACCES: fixture permission denied"),
    );
    const localError = page.getByRole("button", { name: "读取失败 · 网站项目", exact: true });
    await localError.hover();
    await page
      .getByRole("tooltip")
      .getByText("EACCES: fixture permission denied", { exact: true })
      .waitFor();
    await page.getByRole("tooltip").getByText("/fixture/repo", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "读取失败 · 远程服务", exact: true }).count(),
      0,
    );
    assert.equal(await page.getByText("登录优化", { exact: true }).count(), 1);
    await localError.click();
    await page.evaluate(() => {
      globalThis.__sidebarOrganization.facts.sourceReads.length = 0;
    });
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.waitForFunction(() => globalThis.__sidebarOrganization.facts.sourceReads.length > 0);
    assert.deepEqual(
      await page.evaluate(() => globalThis.__sidebarOrganization.facts.sourceReads),
      ["/fixture/repo"],
    );
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 0);
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
      globalThis.__sidebarOrganization.setReadError(true, "Remote fixture read failed"),
    );
    await page.getByRole("button", { name: "读取失败 · 远程服务", exact: true }).waitFor();
    await page.evaluate(() => globalThis.__sidebarOrganization.setReadError(false, null));
    await localError.waitFor({ state: "hidden" });
    assert.equal(
      await page.getByRole("button", { name: "读取失败 · 远程服务", exact: true }).count(),
      1,
    );
    await page.evaluate(() => globalThis.__sidebarOrganization.offline());
    await page
      .getByRole("button", { name: "读取失败 · 远程服务", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(await page.getByText(/部分来源/).count(), 0);
    await page.evaluate(() => {
      globalThis.__sidebarOrganization.holdNextRead();
      globalThis.__sidebarOrganization.setReadError(false, null);
    });
    await page.waitForFunction(() => globalThis.__sidebarOrganization.hasHeldRead());
    await page.evaluate(() =>
      globalThis.__sidebarOrganization.setReadError(false, "newest fixture failure"),
    );
    await localError.hover();
    await page.getByRole("tooltip").getByText("newest fixture failure", { exact: true }).waitFor();
    await page.evaluate(() =>
      globalThis.__sidebarOrganization.releaseRead("stale fixture failure"),
    );
    await localError.hover();
    await page.getByRole("tooltip").getByText("newest fixture failure", { exact: true }).waitFor();
    assert.equal(await page.getByText("stale fixture failure", { exact: true }).count(), 0);
    await page.evaluate(() => globalThis.__sidebarOrganization.setReadError(false, null));
    await localError.waitFor({ state: "hidden" });
    await page.evaluate(() => {
      globalThis.__sidebarOrganization.online();
      globalThis.__sidebarOrganization.setReadError(false, "local pending retry");
      globalThis.__sidebarOrganization.setReadError(true, "remote pending retry");
    });
    const remoteError = page.getByRole("button", { name: "读取失败 · 远程服务", exact: true });
    await remoteError.waitFor();
    await localError.click();
    await page.evaluate(() => {
      globalThis.__sidebarOrganization.holdNextRead();
      globalThis.__sidebarOrganization.setReadError(false, null, false);
    });
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.waitForFunction(() => globalThis.__sidebarOrganization.hasHeldRead());
    await page.keyboard.press("Escape");
    await remoteError.click();
    await page.evaluate(() => globalThis.__sidebarOrganization.setReadError(true, null, false));
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await remoteError.waitFor({ state: "hidden" });
    assert.equal(await localError.count(), 1);
    await page.evaluate(() => globalThis.__sidebarOrganization.releaseRead());
    await localError.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 0);
    assert.equal(
      await page.evaluate(() => globalThis.__sidebarOrganization.facts.selected),
      "unchanged",
    );
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.drafts), 0);
    assert.deepEqual(errors, []);
    await page.close();
  },
);

test(
  "archive has a separate panel, frozen deletion scope and touch error details",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      await mkdir(".artifacts/sidebar-organization", { recursive: true });
      const context = await browser.newContext({
        viewport: { width, height: 950 },
        hasTouch: width === 390,
        isMobile: width === 390,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
      await page.getByText("本地项目会话", { exact: true }).waitFor();
      await page.getByRole("button", { name: "网站项目", exact: true }).click();
      await page.getByText("本地项目会话", { exact: true }).waitFor({ state: "hidden" });
      const archive = page.getByTestId("sidebar-archive-toggle");
      const organizeBox = await page.getByTestId("sidebar-organize").boundingBox();
      const archiveBox = await archive.boundingBox();
      assert.ok(archiveBox.x >= organizeBox.x + organizeBox.width - 1);
      if (width === 390) await archive.tap();
      else await archive.click();
      const panel = page.getByTestId("sidebar-archive-panel");
      await panel.getByText("已归档会话", { exact: true }).waitFor();
      await panel.getByText("已归档工作树会话", { exact: true }).waitFor();
      await page
        .getByTestId("sidebar")
        .screenshot({ path: `.artifacts/sidebar-organization/archive-${width}.png` });
      assert.equal(await archive.getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByText("登录优化", { exact: true }).count(), 0);
      await panel.getByRole("button", { name: "全部", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "工作树会话", exact: true }).click();
      await panel.getByText("已归档会话", { exact: true }).waitFor({ state: "hidden" });
      await panel.getByRole("button", { name: "归档 · 更多操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "删除当前范围的归档会话…", exact: true }).click();
      await page.getByRole("button", { name: /^删除所有归档任务/ }).click();
      await panel.getByText("已归档工作树会话", { exact: true }).waitFor({ state: "hidden" });
      assert.deepEqual(
        await page.evaluate(() =>
          globalThis.__sidebarOrganization.calls
            .filter((call) => call.method === "delete")
            .map((call) => call.params.taskId),
        ),
        ["archived-tree"],
      );
      await panel.getByRole("button", { name: "工作树会话", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "全部", exact: true }).click();
      await panel.getByText("已归档会话", { exact: true }).waitFor();
      await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
      await page.getByText("登录优化", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "网站项目", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
      assert.equal(await archive.getAttribute("aria-pressed"), "false");
      await page.evaluate(() =>
        globalThis.__sidebarOrganization.setReadError(true, "SSH fixture index read denied"),
      );
      const issue = page.getByRole("button", { name: "读取失败 · 远程服务", exact: true });
      if (width === 390) await issue.tap();
      else {
        await issue.focus();
        await page.keyboard.press("Enter");
      }
      const details = page.getByRole("dialog");
      await details.getByText("SSH fixture index read denied", { exact: true }).waitFor();
      await details.getByText("/fixture/repo", { exact: true }).waitFor();
      await details.getByText(/仅重新读取当前来源/).waitFor();
      await page.getByRole("tooltip").waitFor({ state: "hidden" });
      await page.screenshot({
        path: `.artifacts/sidebar-organization/source-error-${width}.png`,
        animations: "disabled",
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.evaluate(() => globalThis.__sidebarOrganization.facts.selected),
        "unchanged",
      );
      assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.drafts), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);
