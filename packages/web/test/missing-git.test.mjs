import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "缺少 Git 的安装提示与模型失败归因在桌面/手机均可见并可恢复",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [390, 1280])
      for (const english of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/missing-git.html${english ? "?english" : ""}`,
        );
        const installation = english
          ? "Install Git on the computer running LCode"
          : "请在运行 LCode 的电脑上安装 Git";
        const generic = english ? "Model configuration failed to load." : "模型配置加载失败。";
        const alert = page.getByRole("alert");
        await page.getByText(installation, { exact: false }).waitFor();
        assert.equal(await alert.count(), 1);
        const bounds = await alert.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
        const draft = page.getByRole("textbox", { name: "Draft" });
        await draft.fill("fixture draft remains editable");
        const draftBounds = await draft.boundingBox();
        assert.ok(draftBounds && draftBounds.y >= bounds.y + bounds.height);
        assert.ok((await alert.innerText()).includes("git --version"));
        assert.equal(await page.getByText(generic, { exact: true }).count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await mkdir("../../.tmp/missing-git", { recursive: true });
        await page.screenshot({
          path: `../../.tmp/missing-git/${width}-${english ? "en" : "zh"}.png`,
          fullPage: true,
        });

        const scenario = async (value) => {
          await page.evaluate((next) => window.__missingGitFixture.scenario(next), value);
        };
        for (const value of ["loading", "unread", "unavailable", "stale", "old-path", "present"]) {
          await scenario(value);
          await alert.waitFor({ state: "detached" });
        }
        await scenario("missing");
        await page.getByText(installation, { exact: false }).waitFor();

        await scenario("model-git");
        const retry = page.getByRole("button", { name: english ? "Retry" : "重试", exact: true });
        await retry.waitFor();
        assert.equal(await alert.count(), 1);
        assert.ok((await alert.innerText()).includes(installation));
        assert.equal(await page.getByText(generic, { exact: true }).count(), 0);
        await page.evaluate(() => {
          window.__missingGitFixture.recovered = true;
        });
        await retry.click();
        await page.getByTestId("model-status").getByText("ready", { exact: true }).waitFor();
        await alert.waitFor({ state: "detached" });

        for (const value of ["model-other", "model-message-only"]) {
          await scenario(value);
          await page.getByText(generic, { exact: true }).waitFor();
          assert.equal(await page.getByText(installation, { exact: false }).count(), 0);
        }
        assert.deepEqual(errors, []);
        assert.equal(await draft.inputValue(), "fixture draft remains editable");
        await page.close();
      }
  },
);
