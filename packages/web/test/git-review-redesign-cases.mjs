import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function runGitReviewRedesignCases(t, { page, url }) {
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  for (const width of [1280, 390]) {
    await t.test(`审核结果、可选推送和按钮层级 ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}?seedIntegration=up-to-date`);
      await fixture("executionMode", "worktree");
      await fixture("dirty", []);
      await page.getByTestId("git-action-trigger").click();
      const dialog = page.getByTestId("git-commit-dialog");
      const commit = dialog.getByTestId("git-commit-action-item-commit");
      assert.equal(await commit.evaluate((element) => element.tagName), "BUTTON");
      await dialog.getByTestId("git-review-stage-back").click();
      await dialog.getByTestId("worktree-flow-result").click();
      const result = dialog.getByTestId("worktree-completion-summary");
      await result.waitFor();
      assert.match(await result.innerText(), /无需合并|已包含/);
      assert.match(await result.innerText(), /未执行|待核实/);
      assert.equal(await dialog.getByTestId("git-publish-confirm").count(), 0);
      await dialog.press("Control+Enter");
      assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
      await dialog.getByTestId("worktree-flow-push").click();
      await dialog.getByTestId("git-publish-toggle").click();
      assert.equal(await dialog.getByTestId("git-publish-preview").count(), 1);
      await dialog.getByTestId("worktree-skip-push").click();
      assert.equal(await dialog.getByTestId("git-publish-preview").count(), 0);
      assert.equal(await result.isVisible(), true);
      const actions = await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls);
      assert.equal(actions.length, 0);
      assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      const close = await dialog.getByTestId("git-commit-close").boundingBox();
      assert.ok(close && close.y + close.height < 900);
      await page.getByTestId("git-review-dismiss").click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByTestId("git-action-trigger").click();
      assert.equal(await result.isVisible(), true);
      const output = new URL("../../../artifacts/git-review-redesign/", import.meta.url);
      await mkdir(output, { recursive: true });
      await page.mouse.move(0, 0);
      await page.screenshot({
        animations: "disabled",
        path: fileURLToPath(new URL(`result-${width}.png`, output)),
      });
    });
  }
  await t.test(
    "中英文、全部主题及两种宽度：结果易读、主按钮固定、未提交范围不能隐式合并",
    async () => {
      for (const english of [false, true])
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${url}${english ? "?english" : ""}`);
          await fixture("executionMode", "worktree");
          await fixture("dirty", ["a.ts", "b.ts"]);
          await page.getByTestId("git-action-trigger").click();
          const dialog = page.getByTestId("git-commit-dialog");
          await dialog.getByTestId("worktree-preflight").waitFor();
          const merge = dialog.getByTestId("worktree-integrate");
          assert.equal(await merge.isDisabled(), true);
          await dialog.getByTestId("worktree-exclude-uncommitted").check();
          assert.equal(await merge.isEnabled(), true);
          const themes = await fixture("themes");
          await dialog.evaluate((element) =>
            Promise.all(
              element.getAnimations().map((animation) => animation.finished.catch(() => {})),
            ),
          );
          for (const theme of themes.filter((item) => item.base !== "dynamic")) {
            await page.evaluate(({ id, base }) => {
              document.documentElement.className = `${base === "dark" ? "dark " : ""}theme-${id}`;
            }, theme);
            assert.ok(
              await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
            );
            await dialog.getByTestId("git-review-scroll").evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            const header = await dialog.getByTestId("git-commit-workflow-title").boundingBox();
            const footer = await dialog.getByTestId("git-review-footer").boundingBox();
            if (!(header.y >= 0 && footer.y + footer.height <= 900)) {
              const output = new URL("../../../artifacts/git-review-redesign/", import.meta.url);
              await page.screenshot({
                animations: "disabled",
                path: fileURLToPath(new URL(`overflow-${width}-${theme.id}.png`, output)),
              });
            }
            assert.ok(
              header.y >= 0 && footer.y + footer.height <= 900,
              JSON.stringify({
                width,
                english,
                theme,
                header,
                footer,
                layout: await dialog.evaluate((element) => ({
                  rect: element.getBoundingClientRect().toJSON(),
                  display: getComputedStyle(element).display,
                  maxHeight: getComputedStyle(element).maxHeight,
                  viewport: innerHeight,
                })),
              }),
            );
            assert.equal(
              await merge.evaluate(
                (element) => element.closest('[data-testid="git-review-footer"]') !== null,
              ),
              true,
            );
            await page.mouse.move(0, 0);
            if (process.env.LCODE_GIT_REVIEW_SCREENSHOTS) {
              const output = new URL("../../../artifacts/git-review-redesign/", import.meta.url);
              await mkdir(output, { recursive: true });
              await page.screenshot({
                animations: "disabled",
                path: fileURLToPath(
                  new URL(`review-${english ? "en" : "zh"}-${width}-${theme.id}.png`, output),
                ),
              });
            }
          }
          assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls), []);
          assert.deepEqual(
            await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls),
            [],
          );
          await page.getByTestId("git-review-dismiss").click();
          await dialog.waitFor({ state: "hidden" });
          await page.getByTestId("git-action-trigger").click();
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-testid="worktree-exclude-uncommitted"]')
                ?.getAttribute("data-state") === "checked",
          );
          assert.equal(await merge.isEnabled(), true);
          await fixture("switchSession", "b");
          await dialog.waitFor({ state: "hidden" });
          await page.getByTestId("git-action-trigger").click();
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-testid="worktree-exclude-uncommitted"]')
                ?.getAttribute("data-state") === "unchecked",
          );
          assert.equal(await merge.isDisabled(), true);
        }
    },
  );
}
