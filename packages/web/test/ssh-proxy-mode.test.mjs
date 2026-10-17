import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "SSH proxy mode selects a local Settings profile without a separate switch or credential inputs",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(new URL("../../../.artifacts/ssh-proxy-mode/", import.meta.url), {
      recursive: true,
    });
    for (const width of [1280, 390])
      for (const locale of ["en", "zh"]) {
        await t.test(`${width}px ${locale}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.goto(
              `http://127.0.0.1:${port}/test/fixtures/remote-connection.html?lang=${locale}`,
            );
            if (locale === "zh")
              await page.evaluate(() =>
                document.documentElement.classList.add("dark", "theme-zai-dark"),
              );
            await page.getByTestId("ssh-connect-trigger").click();
            await page
              .getByRole("button", { name: locale === "zh" ? "下一步" : "Next", exact: true })
              .click();
            const selection = page.getByTestId("ssh-proxy-mode");
            await selection.waitFor();
            assert.equal(await page.getByRole("switch").count(), 0);
            await selection.click();
            await page.getByRole("option", { name: /Office HTTP/ }).click();
            await selection.click();
            await page.getByRole("option", { name: /Home SOCKS5/ }).click();
            await selection.press("Space");
            await page.getByRole("option", { name: /Office HTTP/ }).click();
            await page
              .getByText(
                locale === "zh"
                  ? "选择设置中已保存的代理，自动复用地址及账号密码。"
                  : "Select a saved proxy from Settings to reuse its address and credentials.",
                { exact: true },
              )
              .waitFor();
            assert.equal(await page.locator('input[type="password"]').count(), 1);
            assert.equal(
              (await page.locator("body").innerText()).includes("fixture-secret"),
              false,
            );
            await page.getByTestId("ssh-host-input").fill("fixture.invalid");
            await page.getByTestId("ssh-username-input").fill("fixture");
            await page.getByTestId("ssh-password-input").fill("fixture-password");
            await selection.scrollIntoViewIfNeeded();
            assert.ok(
              await page
                .getByTestId("ssh-dialog")
                .evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
            );
            await page.screenshot({
              path: fileURLToPath(
                new URL(
                  `../../../.artifacts/ssh-proxy-mode/${width}-${locale}.png`,
                  import.meta.url,
                ),
              ),
              fullPage: true,
            });
            await page
              .getByRole("button", {
                name: locale === "zh" ? "开始连接" : "Start connection",
                exact: true,
              })
              .click();
            assert.equal(
              await page.evaluate(() => window.remoteConnectionFixture.attempts[0].target.useProxy),
              true,
            );
            assert.equal(
              await page.evaluate(
                () => window.remoteConnectionFixture.attempts[0].target.proxyProfileId,
              ),
              "fixture-http",
            );
          } finally {
            await page.close();
            assert.deepEqual(errors, []);
          }
        });
      }

    await t.test(
      "deleted selection is retained with an error and can be changed to direct",
      async () => {
        const page = await browser.newPage();
        try {
          await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
          await page.getByTestId("ssh-connect-trigger").click();
          await page.getByRole("button", { name: "Next", exact: true }).click();
          const selection = page.getByTestId("ssh-proxy-mode");
          await selection.click();
          await page.getByRole("option", { name: /Home SOCKS5/ }).click();
          await page.evaluate(() => window.remoteConnectionFixture.setProxies([]));
          await page
            .getByText("The selected proxy was deleted. Choose another proxy.", { exact: true })
            .waitFor();
          await selection.click();
          await page.getByRole("option", { name: "Direct (no proxy)", exact: true }).click();
          await page
            .getByText("No saved proxies. Add one in Settings to use it here.", { exact: true })
            .waitFor();
          await page.getByTestId("ssh-host-input").fill("fixture.invalid");
          await page.getByTestId("ssh-username-input").fill("fixture");
          await page.getByTestId("ssh-password-input").fill("fixture-password");
          await page.getByRole("button", { name: "Start connection", exact: true }).click();
          const target = await page.evaluate(
            () => window.remoteConnectionFixture.attempts[0].target,
          );
          assert.equal(target.useProxy, undefined);
          assert.equal(target.proxyProfileId, undefined);
        } finally {
          await page.close();
        }
      },
    );

    await t.test("local proxy library read failure can be retried", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
        await page.evaluate(() => window.remoteConnectionFixture.setProxyReadError(true));
        await page.getByTestId("ssh-connect-trigger").click();
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.getByText("Unable to load saved proxies.", { exact: true }).waitFor();
        await page.evaluate(() => window.remoteConnectionFixture.setProxyReadError(false));
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page.getByTestId("ssh-proxy-mode").click();
        await page.getByRole("option", { name: /Home SOCKS5/ }).click();
      } finally {
        await page.close();
      }
    });
  },
);
