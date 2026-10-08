import assert from "node:assert/strict";

export async function runRuntimeEnvironmentComposerCases({ t, page, url }) {
  await t.test(
    "real Composer appends environment diagnostic without creating session or losing image",
    async () => {
      for (const existing of [false, true]) {
        await page.setViewportSize({ width: existing ? 1280 : 390, height: 900 });
        await page.goto(`${url}?handoff&environmentFailure${existing ? "&existing" : ""}`);
        const editor = page.getByTestId("v4-composer-input");
        await editor.fill("保留真实输入框的原正文");
        await editor.evaluate((element) => {
          const clipboardData = new DataTransfer();
          clipboardData.items.add(
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
            new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
          );
        });
        await page.waitForFunction(() => globalThis.__sendFixture.uploads.length === 1);
        await page.getByRole("img", { name: "keep.png", exact: true }).waitFor();
        await page.getByTestId("git-failure-to-composer").click();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-testid="v4-composer-input"]')
            .textContent.includes("dependency-install-failed"),
        );
        const text = await editor.innerText();
        assert.ok(text.startsWith("保留真实输入框的原正文"));
        assert.match(text, /"manifestDigest": "fixture-manifest"/);
        assert.doesNotMatch(text, /fixture-private/);
        assert.equal(await page.getByRole("img", { name: "keep.png", exact: true }).count(), 1);
        assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 0);
        assert.equal(
          await page.getByTestId("session-list").textContent(),
          existing ? "existing-session" : "",
        );
      }
    },
  );
  await t.test(
    "initial preparation runtimeError reaches the unsent Composer through the existing draft receiver",
    async () => {
      await page.goto(`${url}?worktree&handoff&preparationFailure`);
      await page.evaluate(() =>
        Object.assign(globalThis.__sendFixture, { prepare: true, hold: true, fail: true }),
      );
      const editor = page.getByTestId("v4-composer-input");
      await editor.fill("首发原正文");
      await editor.press("Enter");
      await page.getByTestId("worktree-preparation-card").waitFor();
      await page.evaluate(() => {
        const fixture = globalThis.__sendFixture;
        fixture.preparation.status = "failed";
        fixture.preparation.preparation.stage = "failed";
        fixture.preparation.preparation.runtimeError = {
          code: "dependency-install-failed",
          stage: "preparingDependencies",
          retryable: true,
          message: "fixture initial preparation failure",
          diagnostic: {
            purpose: "worktree",
            environmentId: "a".repeat(32),
            revision: 0,
            command: "pnpm install",
            exitCode: 1,
            manifestDigest: "initial-manifest",
          },
        };
        fixture.release();
      });
      await page.getByTestId("git-failure-to-composer").click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="v4-composer-input"]')
          .textContent.includes("initial-manifest"),
      );
      assert.ok((await editor.innerText()).startsWith("首发原正文"));
      assert.equal(await page.getByTestId("session-list").textContent(), "");
      assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 1);
    },
  );
}
