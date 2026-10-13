import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "Codex credential JSON uses a fixed multiline field and submits the exact edited text",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.addInitScript(() => {
      window.__providerAuthorizationChannels = [
        {
          id: "codex",
          name: "Codex",
          methods: [
            {
              id: "json",
              label: "Credential JSON",
              type: "oauth",
              kind: "credentials",
              fields: [
                { key: "credentials", label: "Credential JSON", type: "password", format: "json" },
              ],
            },
          ],
        },
      ];
    });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html`);
    await page.getByTestId("oauth-channel-codex").click();
    const dialog = page.getByRole("dialog", { name: "Codex", exact: true });
    const input = dialog.getByLabel("凭据 JSON", { exact: true });
    await input.waitFor();
    await dialog.evaluate((element) =>
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    assert.equal(await input.evaluate((element) => element.tagName), "TEXTAREA");
    const height = (await input.boundingBox()).height;
    const json =
      '{\n  "tokens": {\n    "access_token": "fixture-only-token",\n    "refresh_token": "fixture-only-refresh"\n  }\n}';
    await input.fill(json);
    await input.press("End");
    await input.press("Enter");
    const edited = await input.inputValue();
    assert.equal(edited, json + "\n");
    assert.equal((await input.boundingBox()).height, height);
    assert.equal(await page.evaluate(() => window.__providerAccounts.starts.length), 0);
    await dialog.getByRole("button", { name: "显示 JSON", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__providerAccounts.starts.length), 0);
    await dialog.getByRole("button", { name: "开始授权", exact: true }).click();
    await page.waitForFunction(() => window.__providerAccounts.starts.length === 1);
    assert.equal(
      await page.evaluate(() => window.__providerAccounts.starts[0].inputs.credentials),
      edited,
    );
  },
);
