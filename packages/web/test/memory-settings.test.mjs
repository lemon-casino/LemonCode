import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "memory storage settings use committed values and preserve both catalog locations",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const screenshots = fileURLToPath(
      new URL("../../../.lcode/component-quality/memory-settings/", import.meta.url),
    );
    await mkdir(screenshots, { recursive: true });
    async function pageFor(width = 1280) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/memory-settings.html`);
      await page.getByTestId("settings-memory-storage-location").waitFor();
      t.after(async () => {
        assert.deepEqual(errors, [], diagnostics());
        await page.close();
      });
      return page;
    }
    async function choose(page, name) {
      await page.getByTestId("settings-memory-storage-location").click();
      await page.getByRole("option", { name, exact: true }).click();
    }
    await t.test(
      "copies once, keeps the old value while busy, refreshes both source catalogs",
      async () => {
        const page = await pageFor();
        await page.getByTestId("settings-memory-count").waitFor();
        await page.getByTestId("fixture-hold").click();
        await choose(page, "项目主文件夹（.lcode/memory）");
        assert.equal(await page.getByTestId("settings-memory-storage-location").isDisabled(), true);
        assert.match(
          await page.getByTestId("settings-memory-storage-location").innerText(),
          /本机资料目录/,
        );
        assert.equal(await page.getByTestId("fixture-committed-location").innerText(), "profile");
        assert.equal(await page.getByTestId("fixture-change-count").innerText(), "1");
        await page.getByTestId("settings-memory-storage-location").dispatchEvent("click");
        assert.equal(await page.getByTestId("fixture-change-count").innerText(), "1");
        await page.getByTestId("fixture-release").click();
        await page
          .getByTestId("fixture-committed-location")
          .filter({ hasText: "workspace" })
          .waitFor();
        await page
          .getByTestId("settings-memory-storage-feedback")
          .getByRole("status")
          .filter({ hasText: "已切换" })
          .waitFor();
        assert.match(
          await page.getByTestId("settings-memory-storage-feedback").innerText(),
          /复制 1 个文件.*1 个同名内容冲突保留目标版本.*原文件已保留/s,
        );
        await page.getByTestId("settings-memory-scope-trigger").click();
        await page.getByRole("menuitemradio", { name: /项目主文件夹/ }).click();
        await page.getByRole("menu").waitFor({ state: "detached" });
        assert.match(
          await page.getByTestId("settings-memory-storage-source").innerText(),
          /项目主文件夹.*\.lcode\/memory/s,
        );
        await page
          .locator(".space-y-6")
          .screenshot({ path: `${screenshots}/desktop-1280-zh-dark.png` });
        await page.getByTestId("settings-memory-scope-trigger").click();
        await page.getByRole("menuitemradio", { name: /本机资料目录/ }).click();
        assert.match(
          await page.getByTestId("settings-memory-storage-source").innerText(),
          /user-profile/,
        );
        await page.getByTestId("fixture-external-profile").click();
        await page
          .getByTestId("settings-memory-storage-location")
          .filter({ hasText: "本机资料目录" })
          .waitFor();
      },
    );
    await t.test("failed copy keeps the prior setting and can retry", async () => {
      const page = await pageFor();
      await page.getByTestId("fixture-fail").click();
      await choose(page, "项目主文件夹（.lcode/memory）");
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").innerText(), /切换未能确认.*read-only/);
      assert.equal(await page.getByTestId("fixture-committed-location").innerText(), "profile");
      assert.match(
        await page.getByTestId("settings-memory-storage-location").innerText(),
        /本机资料目录/,
      );
      await choose(page, "项目主文件夹（.lcode/memory）");
      await page.getByTestId("settings-memory-storage-feedback").getByRole("status").waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.getByTestId("fixture-change-count").innerText(), "2");
    });
    await t.test("empty and error catalog states retain their refresh action", async () => {
      const page = await pageFor();
      await page.getByTestId("settings-memory-count").waitFor();
      await page.getByLabel("Catalog", { exact: true }).selectOption("empty");
      await page.getByTestId("settings-memory-refresh").click();
      await page.getByText("暂无已保存的工作区记忆", { exact: true }).waitFor();
      await page.getByLabel("Catalog", { exact: true }).selectOption("error");
      await page.getByTestId("settings-memory-refresh").click();
      await page.getByText("Fixture catalog unavailable", { exact: true }).waitFor();
      await page.getByLabel("Catalog", { exact: true }).selectOption("ready");
      await page.getByTestId("settings-memory-refresh").click();
      await page.getByTestId("settings-memory-count").waitFor();
    });
    await t.test("390px English/light keyboard selection works with memory disabled", async () => {
      const page = await pageFor(390);
      await page.getByLabel("Language", { exact: true }).selectOption("en-US");
      await page.getByLabel("Theme", { exact: true }).selectOption("zai-light");
      await page.getByTestId("settings-memory-switch").click();
      const select = page.getByTestId("settings-memory-storage-location");
      assert.equal(await select.isDisabled(), false);
      await select.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("option", { name: "Project primary folder (.lcode/memory)", exact: true })
        .waitFor();
      await page.keyboard.press("End");
      await page
        .getByRole("option", { name: "Project primary folder (.lcode/memory)", exact: true })
        .locator(":scope:focus")
        .waitFor();
      await page.keyboard.press("Enter");
      await page.getByTestId("settings-memory-storage-feedback").getByRole("status").waitFor();
      assert.match(await select.innerText(), /Project primary folder/);
      assert.match(
        await page.getByTestId("settings-memory-storage-feedback").innerText(),
        /Source files were kept.*new or reopened sessions/s,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await page
        .locator(".space-y-6")
        .screenshot({ path: `${screenshots}/mobile-390-en-light.png` });
      for (const theme of [
        "zai-dark",
        "zai-light",
        "sepia-light",
        "midnight-blue",
        "forest-dark",
        "cinnabar",
        "inkpurple",
      ]) {
        await page.getByLabel("Theme", { exact: true }).selectOption(theme);
        assert.equal(
          await page.evaluate(
            (id) => document.documentElement.classList.contains(`theme-${id}`),
            theme,
          ),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        assert.equal(await select.isVisible(), true);
      }
      await page.getByLabel("Theme", { exact: true }).selectOption("zai-light");
      await page.getByTestId("settings-memory-switch").click();
      await page.getByTestId("settings-memory-count").waitFor();
      const sectionBounds = await page.locator(".space-y-6").boundingBox();
      const searchBounds = await page.getByTestId("settings-memory-search-input").boundingBox();
      assert.ok(
        searchBounds.width >= 200 &&
          searchBounds.x + searchBounds.width <= sectionBounds.x + sectionBounds.width + 1,
        "memory catalog search remains usable inside its narrow section",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        "memory catalog must fit 390px",
      );
      await page.getByTestId("settings-memory-scope-trigger").click();
      await page.getByRole("menuitemradio", { name: /Project primary folder/ }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
      await page
        .locator(".space-y-6")
        .screenshot({ path: `${screenshots}/mobile-390-en-light-catalog.png` });
      await page.getByTestId("fixture-availability").click();
      assert.equal(await select.isDisabled(), true);
      await page.getByText(/Memory details are available only/).waitFor();
    });
    await t.test(
      "unmounted pending UI does not overwrite the service result on reopen",
      async () => {
        const page = await pageFor();
        await page.getByTestId("fixture-hold").click();
        await choose(page, "项目主文件夹（.lcode/memory）");
        await page.getByTestId("fixture-unmount").click();
        await page.getByTestId("fixture-release").click();
        await page
          .getByTestId("fixture-committed-location")
          .filter({ hasText: "workspace" })
          .waitFor();
        assert.equal(await page.getByTestId("fixture-catalog-reads").innerText(), "1");
        await page.getByTestId("fixture-unmount").click();
        await page
          .getByTestId("settings-memory-storage-location")
          .filter({ hasText: "项目主文件夹" })
          .waitFor();
        assert.equal(await page.getByTestId("fixture-change-count").innerText(), "1");
      },
    );
    await t.test("postcommit broadcast failure still reports a saved location", async () => {
      const page = await pageFor();
      await page.getByTestId("fixture-fail-sync").click();
      await choose(page, "项目主文件夹（.lcode/memory）");
      await page
        .getByTestId("settings-memory-storage-location")
        .filter({ hasText: "项目主文件夹" })
        .waitFor();
      await page
        .getByTestId("settings-memory-storage-feedback")
        .getByRole("status")
        .filter({ hasText: "已切换" })
        .waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.getByTestId("fixture-committed-location").innerText(), "workspace");
    });
    await t.test("a precommit settings read cannot become the postcommit snapshot", async () => {
      const page = await pageFor();
      await page.getByTestId("fixture-hold-read").click();
      await page.getByTestId("fixture-external-profile").click();
      await page.locator('[data-testid="fixture-release-read"]:enabled').waitFor();
      await choose(page, "项目主文件夹（.lcode/memory）");
      await page
        .getByTestId("fixture-committed-location")
        .filter({ hasText: "workspace" })
        .waitFor();
      await page.getByTestId("fixture-release-read").click();
      await page
        .getByTestId("settings-memory-storage-feedback")
        .getByRole("status")
        .filter({ hasText: "已切换" })
        .waitFor();
      assert.match(
        await page.getByTestId("settings-memory-storage-location").innerText(),
        /项目主文件夹/,
      );
      assert.equal(await page.getByTestId("fixture-change-count").innerText(), "1");
    });
    await t.test(
      "postcommit read failure reports uncertainty until settings can be reopened",
      async () => {
        const page = await pageFor();
        await page.getByTestId("fixture-fail-saved-read").click();
        await choose(page, "项目主文件夹（.lcode/memory）");
        await page.getByRole("alert").waitFor();
        assert.match(await page.getByRole("alert").innerText(), /切换未能确认.*cannot be read/);
        assert.equal(await page.getByTestId("fixture-committed-location").innerText(), "workspace");
        assert.equal(
          await page.getByTestId("settings-memory-storage-feedback").getByRole("status").count(),
          0,
        );
        assert.match(
          await page.getByTestId("settings-memory-storage-location").innerText(),
          /本机资料目录/,
        );
        await page.getByTestId("fixture-resume-read").click();
        await page.getByTestId("fixture-unmount").click();
        await page.getByTestId("fixture-unmount").click();
        await page
          .getByTestId("settings-memory-storage-location")
          .filter({ hasText: "项目主文件夹" })
          .waitFor();
        assert.equal(await page.getByRole("alert").count(), 0);
      },
    );
    await t.test(
      "multiple afterPending refreshes share the new read after the old one",
      async () => {
        const page = await pageFor();
        await page.getByTestId("fixture-hold-read").click();
        await page.getByTestId("fixture-external-profile").click();
        await page.locator('[data-testid="fixture-release-read"]:enabled').waitFor();
        const priorReads = Number(await page.getByTestId("fixture-settings-reads").innerText());
        await page.getByTestId("fixture-concurrent-refresh").click();
        await page.getByTestId("fixture-release-read").click();
        await page.getByTestId("fixture-concurrent-refresh").filter({ hasText: "true" }).waitFor();
        assert.equal(
          Number(await page.getByTestId("fixture-settings-reads").innerText()),
          priorReads + 1,
        );
      },
    );
    await t.test(
      "a receiving window refreshes after an old read without broadcasting back",
      async () => {
        const page = await pageFor();
        await page.getByTestId("fixture-hold-read").click();
        await page.getByTestId("fixture-external-profile").click();
        await page.locator('[data-testid="fixture-release-read"]:enabled').waitFor();
        const priorReads = Number(await page.getByTestId("fixture-settings-reads").innerText());
        await page.getByTestId("fixture-other-window-workspace").click();
        await page.getByTestId("fixture-settings-notification").click();
        await page.getByTestId("fixture-release-read").click();
        await page
          .getByTestId("settings-memory-storage-location")
          .filter({ hasText: "项目主文件夹" })
          .waitFor();
        assert.equal(
          Number(await page.getByTestId("fixture-settings-reads").innerText()),
          priorReads + 1,
        );
        assert.equal(await page.getByTestId("fixture-settings-syncs").innerText(), "0");
        assert.equal(await page.getByTestId("fixture-change-count").innerText(), "0");
        await choose(page, "本机资料目录（默认）");
        await page
          .getByTestId("settings-memory-storage-feedback")
          .getByRole("status")
          .filter({ hasText: "已切换" })
          .waitFor();
        assert.equal(await page.getByTestId("fixture-change-count").innerText(), "1");
        assert.equal(await page.getByTestId("fixture-settings-syncs").innerText(), "1");
      },
    );
  },
);
