import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "远控侧栏真实重新连接按钮委托桌面 owner，反馈等待/失败且允许重试",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/remote-workspace-reconnect.html${width === 390 ? "?english" : ""}`,
      );
      await page
        .getByTestId("row-ssh")
        .waitFor()
        .catch(async (error) => {
          t.diagnostic(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
          throw error;
        });
      const label = width === 390 ? "Reconnect" : "重新连接";
      const catalogTargets = await page.evaluate(() => window.__reconnectFixture.catalogTargets());
      for (const target of catalogTargets) {
        assert.equal("useProxy" in target, false);
        assert.equal("proxyProfileId" in target, false);
      }
      const sshTarget = await page.evaluate(() =>
        window.__reconnectFixture.desktopTargets().find((target) => target.kind === "ssh"),
      );
      assert.equal(sshTarget.useProxy, true);
      assert.equal(sshTarget.proxyProfileId, "fixture-profile");
      const click = async (kind) => {
        const row = page.getByTestId(`row-${kind}`);
        await row.hover();
        await row.getByRole("button", { name: label, exact: true }).click();
      };
      const active = await page.evaluate(() => window.__reconnectFixture.desktopActive());
      for (const [index, kind] of ["ssh", "wsl", "docker"].entries()) {
        await click(kind);
        await page.waitForFunction(
          (count) => window.__reconnectFixture.desktopCalls.length === count,
          index + 1,
        );
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="pending"]').textContent).length === 1,
        );
        assert.equal(
          await page
            .getByTestId(`row-${kind}`)
            .getByRole("button", { name: label, exact: true })
            .count(),
          0,
        );
        await page.evaluate(() => window.__reconnectFixture.release());
        await page
          .getByTestId(`session-${kind}`)
          .getByText(`${kind}-ready-2`, { exact: true })
          .waitFor();
        await page.getByTestId("pending").getByText("[]", { exact: true }).waitFor();
      }
      const calls = await page.evaluate(() => window.__reconnectFixture.desktopCalls);
      assert.equal(new Set(calls.map((call) => call.key)).size, 3);
      for (const call of calls)
        assert.deepEqual(call.options, {
          activateWorkspaceAfterReconnect: false,
          showErrorToast: false,
          throwOnFailure: true,
        });
      assert.equal(await page.evaluate(() => window.__reconnectFixture.browserDirectCalls), 0);
      assert.equal(await page.evaluate(() => window.__reconnectFixture.settingWrites), 0);
      assert.equal(await page.evaluate(() => window.__reconnectFixture.desktopActive()), active);
      assert.equal(await page.getByTestId("session-local").textContent(), "offline");
      const targets = await page.evaluate(() => window.__reconnectFixture.requestTargets);
      for (const target of targets)
        assert.deepEqual(Object.keys(target).sort(), ["workspaceIdentity", "workspacePath"]);

      await page.evaluate(() => {
        window.__reconnectFixture.disconnect("ssh");
        window.__reconnectFixture.fail = true;
        window.__reconnectFixture.nativeReconnect("ssh");
      });
      await page.waitForFunction(() => window.__reconnectFixture.desktopCalls.length === 4);
      await click("ssh");
      await page.waitForFunction(() => window.__reconnectFixture.requestTargets.length === 4);
      await page.evaluate(() => window.__reconnectFixture.release());
      await page.getByText("fixture reconnect failed", { exact: true }).waitFor();
      await page.getByTestId("pending").getByText("[]", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__reconnectFixture.nativeSettled), 1);
      assert.equal(await page.evaluate(() => window.__reconnectFixture.desktopCalls.length), 4);
      await page.evaluate(() => {
        window.__reconnectFixture.fail = false;
      });
      await click("ssh");
      await page.waitForFunction(() => window.__reconnectFixture.desktopCalls.length === 5);
      await page.evaluate(() => window.__reconnectFixture.release());
      await page.getByTestId("session-ssh").getByText("ssh-ready-3", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("session-wsl").textContent(), "wsl-ready-2");
      await page.evaluate(() => {
        window.__reconnectFixture.disconnect("docker");
        window.__reconnectFixture.removeDesktop("docker");
      });
      await click("docker");
      await page
        .getByText(width === 390 ? /no longer in the desktop window/ : /该远端项目已不在桌面窗口中/)
        .waitFor();
      assert.equal(await page.evaluate(() => window.__reconnectFixture.desktopCalls.length), 5);
      await page.evaluate(() => {
        window.__reconnectFixture.disconnect("wsl");
      });
      await click("wsl");
      await page.waitForFunction(() => window.__reconnectFixture.desktopCalls.length === 6);
      await page.evaluate(() => window.__reconnectFixture.stopDesktop());
      await page
        .getByText(
          width === 390
            ? /desktop window cannot reconnect right now/
            : /桌面窗口暂时无法处理重新连接/,
        )
        .waitFor();
      await page.getByTestId("pending").getByText("[]", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await mkdir("../../.tmp/remote-workspace-reconnect", { recursive: true });
      await page.screenshot({
        path: `../../.tmp/remote-workspace-reconnect/${width}.png`,
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);
