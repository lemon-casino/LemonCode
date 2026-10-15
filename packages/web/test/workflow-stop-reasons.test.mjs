import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "stop attribution remains distinct across locale, theme and desktop/phone",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${port}/test/fixtures/workflow-execution-progress.html`);
        for (const locale of ["zh-CN", "en-US"]) {
          const toggle = page.getByRole("button", { name: /^(?:zh-CN|en-US)$/ });
          if ((await toggle.innerText()) !== locale) await toggle.click();
          for (const dark of [false, true]) {
            const theme = page.getByRole("button", { name: /^(?:Light|Dark)$/ });
            if ((await theme.innerText()) !== (dark ? "Dark" : "Light")) await theme.click();
            for (const [reason, zh, en] of [
              ["user", "你停止的", "by you"],
              ["model", "代理停止的", "by the agent"],
              ["superseded", "已被替代", "superseded"],
              ["interrupted", "进程已退出", "process exited"],
            ]) {
              const label = page.getByTestId(`fixture-stop-${reason}-reason`);
              await label.waitFor();
              assert.ok((await label.innerText()).includes(locale === "zh-CN" ? zh : en));
              assert.equal(
                await page.getByTestId(`fixture-stop-${reason}-resumable`).count(),
                reason === "superseded" ? 0 : 1,
              );
            }
            assert.doesNotMatch(
              await page.getByTestId("fixture-stop-interrupted-reason").innerText(),
              /by you|by the agent|你停止的|代理停止的/,
            );
            const owner = page.getByTestId("fixture-owner-recovery");
            await owner.getByTestId("workflow-run-resume").click();
            const refusal = await owner.getByTestId("workflow-run-rejection").innerText();
            assert.match(
              refusal,
              locale === "zh-CN" ? /原会话.*重试/ : /original conversation.*retry/i,
            );
            assert.doesNotMatch(refusal, /owner_unavailable|fault\.command/);
          }
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  },
);
