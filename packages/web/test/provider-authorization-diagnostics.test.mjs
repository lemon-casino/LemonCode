import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
for (const [width, locale] of [
  [1280, "zh-CN"],
  [390, "en-US"],
])
  test(
    "PC-03 authorization diagnostic and saved warning " + locale,
    { timeout: 90000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(6000);
      page.setDefaultNavigationTimeout(30000);
      await page.goto(
        "http://127.0.0.1:" + port + "/test/fixtures/provider-accounts.html?locale=" + locale,
      );
      await page.getByRole("tab", { name: "OAuth", exact: true }).click();
      await page.getByTestId("oauth-channel-fixture").click();
      await page.evaluate(() => {
        window.__providerAccounts.authorizationDiagnostic = {
          phase: "identity",
          code: "timeout",
          credentialsSaved: false,
          retryable: true,
        };
        window.__providerAccounts.completionFailure = "OAUTH_AUTHORIZATION_FAILED";
      });
      await page
        .getByRole("button", {
          name: locale === "zh-CN" ? "开始授权" : "Start authorization",
          exact: true,
        })
        .click();
      const input = page.getByLabel(locale === "zh-CN" ? "授权码" : "Authorization code", {
        exact: true,
      });
      await input.fill("fixture");
      await page
        .getByRole("button", {
          name: locale === "zh-CN" ? "完成授权" : "Complete authorization",
          exact: true,
        })
        .click();
      const diagnostic = page.getByTestId("oauth-authorization-diagnostic");
      await diagnostic.waitFor();
      assert.match(
        await diagnostic.innerText(),
        locale === "zh-CN" ? /账号校验.*超时/s : /account verification.*timed out/is,
      );
      await page.evaluate(() => {
        window.__providerAccounts.authorizationDiagnostic = {
          phase: "post-login",
          credentialsSaved: true,
          followupPending: true,
        };
      });
      await page
        .getByRole("button", {
          name: locale === "zh-CN" ? "开始授权" : "Start authorization",
          exact: true,
        })
        .click();
      await input.fill("fixture-success");
      await page
        .getByRole("button", {
          name: locale === "zh-CN" ? "完成授权" : "Complete authorization",
          exact: true,
        })
        .click();
      await page.getByTestId("oauth-account-account-1").waitFor({ state: "attached" });
      await page
        .getByRole("tab", { name: locale === "zh-CN" ? "登录授权" : "Authorization", exact: true })
        .click();
      assert.match(
        await diagnostic.innerText(),
        locale === "zh-CN" ? /凭据已保存/ : /credentials saved/i,
      );
      // Host 先确认保存，后续目录在下一次轮询才失败；完成视图仍必须接收安全告警。
      await page.evaluate(() => {
        window.__providerAccounts.authorizationDiagnostic = {
          phase: "post-login",
          code: "network",
          credentialsSaved: true,
          followupPending: false,
        };
      });
      await page.waitForFunction((english) => {
        const text =
          document.querySelector('[data-testid="oauth-authorization-diagnostic"]')?.textContent ??
          "";
        return english ? /network/i.test(text) : /网络/.test(text);
      }, locale !== "zh-CN");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    },
  );
