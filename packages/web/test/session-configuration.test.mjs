import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { runSessionConfigurationProjectCases } from "./session-configuration-project-cases.mjs";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "project session configuration uses OAuth/API models and initializes real Composer drafts",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${port}/test/fixtures/session-configuration.html`;
    const load = async (query = "") => {
      await page.goto(url + query);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.getByTestId("configuration-provider").waitFor();
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="configuration-provider"]').disabled,
      );
    };
    const choose = async (id, name) => {
      const trigger = page.getByTestId(`configuration-${id}`);
      await trigger.click();
      await page.getByRole("option", { name, exact: true }).click();
      await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
      await page.waitForFunction(
        (id) => !document.querySelector(`[data-testid="configuration-${id}"]`).disabled,
        id,
      );
    };
    const probe = async () => JSON.parse(await page.getByTestId("draft-probe").innerText());
    const defaults = {
      providerId: "oauth-provider",
      modelId: "oauth-model",
      options: { reasoningLevel: "low", speed: "standard" },
    };

    await t.test(
      "global configuration preserves chosen effort/speed, survives reload and seeds a submission",
      async () => {
        await load();
        await choose("provider", "OAuth Provider · OAuth");
        await choose("reasoning", "低");
        await choose("speed", "标准");
        await choose("approval", "自动编辑");
        await page.getByTestId("global-execution-mode").click();
        await page.getByRole("option", { name: "独立工作树", exact: true }).click();
        await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
        await page.getByTestId("settings-git-commit-review-mode-select").click();
        await page.getByRole("option", { name: "仅生成草稿", exact: true }).click();
        await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
        await page.reload();
        await page.getByTestId("configuration-provider").waitFor();
        await page.getByTestId("show-probe").click();
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
              ?.mode === "edit",
        );
        assert.deepEqual((await probe()).submission.modelSelection, defaults);
        assert.match(await page.getByTestId("global-execution-mode").innerText(), /独立工作树/);
        assert.match(
          await page.getByTestId("settings-git-commit-review-mode-select").innerText(),
          /仅生成草稿/,
        );
        await mkdir("../../.artifacts/session-configuration", { recursive: true });
        await page.screenshot({
          path: "../../.artifacts/session-configuration/desktop.png",
          fullPage: true,
        });
      },
    );

    await t.test("project overrides keep other scopes and reset to inheritance", async () => {
      await choose("project", "Project One");
      await choose("provider", "API Provider · API");
      await choose("reasoning", "低");
      await choose("speed", "标准");
      await choose("approval", "变更前确认");
      await choose("execution", "本地目录");
      await choose("review", "关闭");
      await page.evaluate(() => window.__sessionConfiguration.resetDraft());
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "api-provider",
      );
      assert.equal((await probe()).submission.mode, "build");
      await choose("project", "Project Two");
      assert.match(await page.getByTestId("configuration-provider").innerText(), /继承默认配置/);
      await choose("approval", "完全访问");
      await choose("project", "Project One");
      await choose("provider", "继承默认配置");
      await choose("approval", "继承默认配置");
      const settings = await page.evaluate(() => window.__sessionConfiguration.settings.local);
      assert.deepEqual(settings.projectExecutionPreferences["/fixture/repo"].setupCommands, [
        "pnpm install",
      ]);
      assert.equal(
        settings.projectExecutionPreferences["/fixture/other"].defaultSessionApprovalMode,
        "yolo",
      );
      assert.deepEqual(settings.defaultSessionModelSelection, defaults);
      await page.evaluate(() => window.__sessionConfiguration.resetDraft());
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "oauth-provider",
      );
    });

    await t.test(
      "manual drafts and existing sessions keep their configuration when defaults change",
      async () => {
        await page.evaluate(() => window.__sessionConfiguration.selectManual());
        await choose("project", "默认配置");
        await choose("reasoning", "低");
        assert.equal((await probe()).draft.thought, "high");
        await page.evaluate(() => window.__sessionConfiguration.existing());
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).draft
              .mode === "build",
        );
        await choose("approval", "完全访问");
        assert.equal((await probe()).draft.mode, "build");
        assert.equal((await probe()).draft.thought, "high");
      },
    );

    await t.test(
      "same-path remote projects route to their attachment and disconnected projects cannot write locally",
      async () => {
        await choose("project", "Remote A");
        assert.match(await page.getByTestId("configuration-provider").innerText(), /继承默认配置/);
        await choose("provider", "API Provider · API");
        const result = await page.evaluate(() => window.__sessionConfiguration);
        assert.equal(result.calls.at(-1).owner, "remote-a");
        assert.equal(
          result.settings["remote-a"].projectExecutionPreferences["remote-a"]
            .defaultSessionModelSelection.providerId,
          "api-provider",
        );
        assert.equal(result.settings.local.projectExecutionPreferences["remote-a"], undefined);
        await choose("project", "Remote B");
        assert.equal(await page.getByTestId("session-configuration-form").count(), 0);
        await choose("project", "Remote A");
        await page.evaluate(() => window.__sessionConfiguration.disconnect());
        await page.getByRole("status").waitFor();
        assert.equal(await page.getByTestId("session-configuration-form").count(), 0);
      },
    );

    await t.test(
      "save failures keep accepted values and late failures stay in their original project",
      async () => {
        await choose("project", "Project One");
        await page.evaluate(() => {
          window.__sessionConfiguration.fail = true;
        });
        await choose("provider", "API Provider · API");
        await page.getByRole("alert").getByText("fixture-save-failed").waitFor();
        assert.match(await page.getByTestId("configuration-provider").innerText(), /继承默认配置/);
        await page.evaluate(() => {
          window.__sessionConfiguration.hold = true;
        });
        await page.getByTestId("configuration-approval").click();
        await page.getByRole("option", { name: "完全访问", exact: true }).click();
        await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
        await page.waitForFunction(
          () => document.querySelector('[data-testid="configuration-approval"]').disabled,
        );
        await choose("project", "Project Two");
        await page.evaluate(() => window.__sessionConfiguration.release());
        await page.waitForFunction(() => window.__sessionConfiguration.failedWrites === 2);
        await page.evaluate(() => {
          window.__sessionConfiguration.fail = false;
          window.__sessionConfiguration.hold = false;
        });
        assert.equal(await page.getByRole("alert").count(), 0);
        await choose("approval", "变更前确认");
      },
    );

    await t.test(
      "deleted defaults fall back to the recent supplier without rewriting settings",
      async () => {
        await load();
        await choose("provider", "OAuth Provider · OAuth");
        const configured = await page.evaluate(
          () => window.__sessionConfiguration.settings.local.defaultSessionModelSelection,
        );
        await page.evaluate(() => window.__sessionConfiguration.seedRecent());
        await page.getByTestId("show-probe").click();
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
              ?.modelSelection.providerId === "oauth-provider",
        );
        await page.evaluate(() => window.__sessionConfiguration.removeDefault());
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
              ?.modelSelection.providerId === "api-provider",
        );
        assert.equal((await probe()).submission.modelSelection.modelId, "api-model");
        await page.evaluate(() => window.__sessionConfiguration.removeRecentModel());
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
              ?.modelSelection.modelId === "basic-model",
        );
        assert.equal((await probe()).submission.modelSelection.providerId, "api-provider");
        assert.deepEqual(
          await page.evaluate(
            () => window.__sessionConfiguration.settings.local.defaultSessionModelSelection,
          ),
          configured,
        );
        await page
          .getByTestId("configuration-provider")
          .getByText(/不可用/)
          .waitFor();
      },
    );
    await runSessionConfigurationProjectCases({ t, page, load, probe });
    await t.test("model capabilities, keyboard, translations and narrow layouts", async () => {
      for (const english of [false, true]) {
        await page.setViewportSize({ width: 390, height: 1000 });
        await load(english ? "?english&dark" : "");
        await page.getByTestId("configuration-provider").click();
        assert.equal(
          await page
            .getByRole("option", { name: "Empty Provider · API", exact: true })
            .getAttribute("aria-disabled"),
          "true",
        );
        await page.keyboard.press("Escape");
        await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
        await choose("provider", "API Provider · API");
        await choose("model", "basic-model");
        assert.equal(await page.getByTestId("configuration-speed").isDisabled(), true);
        assert.match(
          await page.getByTestId("configuration-speed").innerText(),
          english ? /Not supported/ : /不支持/,
        );
        await page.getByTestId("configuration-reasoning").focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
        await page.keyboard.press("Home");
        await page.waitForFunction(
          (label) => document.activeElement?.textContent === label,
          english ? "Low" : "低",
        );
        await page.keyboard.press("Enter");
        await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
        await page.waitForFunction(
          () =>
            window.__sessionConfiguration.settings.local.defaultSessionModelSelection.options
              .reasoningLevel === "low",
        );
        await choose("approval", english ? "Ask before changes" : "变更前确认");
        await page.getByTestId("settings-git-commit-review-mode-select").click();
        await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
        const lastLabel = await page.getByRole("option").last().textContent();
        await page.keyboard.press("End");
        await page.waitForFunction(
          (label) => document.activeElement?.textContent === label,
          lastLabel,
        );
        await page.keyboard.press("Enter");
        await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
        await page.waitForFunction(
          () =>
            window.__sessionConfiguration.settings.local.gitCommitReviewMode === "draft-and-review",
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        if (!english)
          await page.screenshot({
            path: "../../.artifacts/session-configuration/mobile.png",
            fullPage: true,
          });
        await page.evaluate(() => window.__sessionConfiguration.removeProvider());
        await page
          .getByTestId("configuration-provider")
          .getByText(english ? /Unavailable/ : /不可用/)
          .waitFor();
      }
    });
    assert.deepEqual(errors, []);
  },
);
