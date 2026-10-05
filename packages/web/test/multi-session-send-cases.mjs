import assert from "node:assert/strict";

export async function runMultiSessionSendCases(t, browser, url) {
  for (const width of [1280, 390]) {
    for (const [firstMode, secondMode] of [
      ["local", "local"],
      ["local", "worktree"],
      ["worktree", "local"],
      ["worktree", "worktree"],
    ]) {
      await t.test(`${width}px 多窗口 ${firstMode}/${secondMode} 的发送等待互不影响`, async () => {
        const first = await browser.newPage({ viewport: { width, height: 800 } });
        const second = await browser.newPage({ viewport: { width, height: 800 } });
        try {
          await first.goto(
            `${url}?existing&session=window-A&${firstMode === "worktree" ? "worktree" : ""}`,
          );
          await second.goto(
            `${url}?existing&session=window-B&${secondMode === "worktree" ? "worktree" : ""}`,
          );
          await first.evaluate(() => {
            globalThis.__sendFixture.hold = true;
          });
          const firstEditor = first.getByTestId("v4-composer-input");
          await firstEditor.fill("会话 A 正在提交");
          await firstEditor.press("Enter");
          await first.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
          const secondEditor = second.getByTestId("v4-composer-input");
          await secondEditor.fill("会话 B 独立发送");
          await secondEditor.press("Enter");
          await second
            .locator('[data-v4-timeline-message-layer="true"]')
            .getByText("会话 B 独立发送", { exact: true })
            .waitFor();
          assert.equal(await secondEditor.textContent(), "");
          assert.equal(await firstEditor.innerText(), "会话 A 正在提交");
          assert.equal(
            await first
              .locator('[data-v4-timeline-message-layer="true"]')
              .getByText("会话 B 独立发送", { exact: true })
              .count(),
            0,
          );
          await first.evaluate(() => {
            globalThis.__sendFixture.release();
          });
          await first
            .locator('[data-v4-timeline-message-layer="true"]')
            .getByText("会话 A 正在提交", { exact: true })
            .waitFor();
        } finally {
          await first.close();
          await second.close();
        }
      });
    }
  }
}
