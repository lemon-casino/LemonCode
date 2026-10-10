import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "saved summary references use the real Composer submission and draft recovery",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    page.setDefaultNavigationTimeout(30_000);
    const url = `http://127.0.0.1:${port}/test/fixtures/conversation-send.html`;
    const id = "capsule_" + "a".repeat(32);
    for (const width of [1280, 390]) {
      await t.test(`${width}px freezes and deduplicates typed refs`, async () => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(url + "?existing");
        const editor = page.getByTestId("v4-composer-input");
        await editor.fill(`Continue with saved context\n#${id}\n#${id}`);
        await page.getByTestId("capsule-reference-notice").waitFor();
        await page.getByTestId("v4-composer-send").click();
        await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
        const calls = await page.evaluate(() => globalThis.__sendFixture.calls);
        assert.deepEqual(calls[0].options.contextCapsuleRefs, [
          { kind: "context_capsule", capsule_id: id },
        ]);
        assert.equal(calls[0].options.contextAttachmentCount, 1);
      });
    }
    await t.test("rejected send preserves the reference draft", async () => {
      await page.goto(url + "?existing");
      await page.getByTestId("v4-composer-input").waitFor();
      await page.evaluate(() => {
        globalThis.__sendFixture.fail = true;
      });
      await page.getByTestId("v4-composer-input").fill(`#${id}`);
      await page.getByTestId("v4-composer-send").click();
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByTestId("v4-composer-input").innerText(), new RegExp(id));
    });
    await t.test(
      "code examples stay plain text in both the notice and frozen submission",
      async () => {
        for (const draft of [
          `    #${id}`,
          ["~~~md", "~~~not-a-close", `#${id}`, "~~~"].join("\n"),
        ]) {
          await page.goto(url + "?existing");
          await page.getByTestId("v4-composer-input").fill(draft);
          assert.equal(await page.getByTestId("capsule-reference-notice").count(), 0);
          await page.getByTestId("v4-composer-send").click();
          await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
          const calls = await page.evaluate(() => globalThis.__sendFixture.calls);
          assert.equal(calls[0].options.contextCapsuleRefs, undefined);
        }
      },
    );
    await t.test("new sessions and more than four summaries do not submit", async () => {
      for (const [query, draft] of [
        ["", `#${id}`],
        ["?existing", ["a", "b", "c", "d", "e"].map((c) => "#capsule_" + c.repeat(32)).join("\n")],
      ]) {
        await page.goto(url + query);
        await page.getByTestId("v4-composer-input").fill(draft);
        await page.getByTestId("v4-composer-send").click();
        await page.getByRole("alert").first().waitFor();
        assert.equal((await page.evaluate(() => globalThis.__sendFixture.calls)).length, 0);
        assert.match(await page.getByTestId("v4-composer-input").innerText(), /capsule_/);
      }
    });
    await t.test(
      "CLI strict syntax is rejected without clearing or submitting the draft",
      async () => {
        for (const query of ["", "?existing"]) {
          await page.goto(url + query);
          const draft = "/goal replace strict acceptance.json implement feature";
          await page.getByTestId("v4-composer-input").fill(draft);
          await page.getByTestId("v4-composer-send").click();
          await page.getByRole("alert").first().waitFor();
          assert.equal((await page.evaluate(() => globalThis.__sendFixture.calls)).length, 0);
          assert.equal(await page.getByTestId("v4-composer-input").innerText(), draft);
        }
      },
    );
  },
);
