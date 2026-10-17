import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "saved SSH/WSL/Docker configuration uses existing owners and survives attachment replacement",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const load = async (english = false) => {
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/remote-session-configuration.html${english ? "?english" : ""}`,
      );
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="configuration-provider"]')?.disabled === false,
      );
    };
    const choose = async (id, name) => {
      await page.waitForFunction(
        (id) => document.querySelector(`[data-testid="configuration-${id}"]`)?.disabled === false,
        id,
      );
      await page.getByTestId(`configuration-${id}`).click();
      await page.getByRole("option", { name, exact: true }).click();
      await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
      if (id !== "project")
        await page.waitForFunction(
          (id) => document.querySelector(`[data-testid="configuration-${id}"]`)?.disabled === false,
          id,
        );
    };
    const projectOption = async (kind) => {
      await page.getByTestId("configuration-project").click();
      const option = page.getByRole("option").filter({
        hasText: new RegExp(kind === "ssh" ? "SSH" : kind === "wsl" ? "WSL" : "Docker"),
      });
      assert.equal(await option.count(), 1);
      await option.click();
      await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
    };

    await t.test(
      "saved and registry-only projects are selectable at narrow and wide widths",
      async () => {
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 1100 });
          await load(width === 390);
          await page.getByTestId("configuration-project").click();
          assert.equal(await page.getByRole("option").count(), 5);
          await page.keyboard.press("Escape");
          await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
          const before = await page.evaluate(() =>
            structuredClone(window.__remoteSessionConfiguration.counts),
          );
          await projectOption("ssh");
          await page.getByRole("status").waitFor();
          assert.match(
            await page.getByRole("status").innerText(),
            width === 390 ? /configuration|defaults/i : /配置|默认/,
          );
          assert.equal(await page.getByTestId("session-configuration-form").count(), 0);
          const after = await page.evaluate(() => window.__remoteSessionConfiguration.counts);
          assert.equal(after.reads, before.reads);
          assert.deepEqual(after.modelReads, before.modelReads);
          assert.equal(after.connects, 0);
          await page.evaluate(() => window.__remoteSessionConfiguration.attach("ssh"));
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="configuration-provider"]')?.disabled === false,
          );
          await choose("provider", "SSH API · API");
          await choose("reasoning", width === 390 ? "Low" : "低");
          await choose("speed", width === 390 ? "Standard" : "标准");
          await choose("approval", width === 390 ? "Ask before changes" : "变更前确认");
          await choose("execution", width === 390 ? "Local directory" : "本地目录");
          await choose("review", width === 390 ? "Off" : "关闭");
          const settings = await page.evaluate(() => window.__remoteSessionConfiguration.settings);
          const entry = Object.values(settings.projectExecutionPreferences)[0];
          assert.equal(entry.defaultSessionModelSelection.modelId, "ssh-api-model");
          assert.equal(entry.defaultSessionModelSelection.options.reasoningLevel, "low");
          assert.equal(entry.defaultSessionModelSelection.options.speed, "standard");
          assert.equal(entry.defaultSessionApprovalMode, "build");
          assert.equal(entry.executionMode, "local");
          assert.equal(entry.gitCommitReviewMode, "off");
          assert.deepEqual(entry.setupCommands, ["fixture-setup"]);
          assert.equal(settings.projectExecutionPreferences["/fixture/repo"], undefined);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await mkdir("../../.tmp/remote-session-configuration", { recursive: true });
          await page.screenshot({
            path: `../../.tmp/remote-session-configuration/${width}.png`,
            fullPage: true,
          });
          await page.reload();
          await projectOption("ssh");
          await page.getByRole("status").waitFor();
          await page.evaluate(() => window.__remoteSessionConfiguration.attach("ssh"));
          await page.getByTestId("configuration-model").getByText("ssh-api-model").waitFor();
          await page.evaluate(() => window.__remoteSessionConfiguration.preview("ssh"));
          await page.waitForFunction(
            () =>
              JSON.parse(
                document.querySelector('[data-testid="remote-draft-probe"]')?.textContent || "{}",
              ).submission?.modelSelection.modelId === "ssh-api-model",
          );
          const draft = await page.getByTestId("remote-draft-probe").innerText();
          assert.equal(JSON.parse(draft).submission.modelSelection.options.reasoningLevel, "low");
          const startupCounts = await page.evaluate(
            () => window.__remoteSessionConfiguration.counts,
          );
          assert.equal(startupCounts.presentations, 0);
          assert.equal(startupCounts.prewarms, 0);
        }
      },
    );

    await t.test(
      "remote slash input hydrates the catalog only on demand without draft prewarm",
      async () => {
        await load();
        await projectOption("wsl");
        await page.evaluate(() => window.__remoteSessionConfiguration.preview("wsl"));
        await page.getByTestId("remote-draft-probe").waitFor();
        assert.equal(
          await page.evaluate(() => window.__remoteSessionConfiguration.counts.presentations),
          0,
        );
        await page.evaluate(() => window.__remoteSessionConfiguration.requestCatalog());
        await page.waitForFunction(
          () => window.__remoteSessionConfiguration.counts.presentations === 1,
        );
        assert.equal(
          await page.evaluate(() => window.__remoteSessionConfiguration.counts.prewarms),
          0,
        );
      },
    );

    await t.test("each environment supplies its own catalog and identity defaults", async () => {
      await load();
      await projectOption("wsl");
      await choose("provider", "WSL OAUTH · OAuth");
      await page.getByTestId("configuration-provider").click();
      assert.equal(
        await page
          .getByRole("option")
          .filter({ hasText: /LOCAL|SSH|DOCKER/ })
          .count(),
        0,
      );
      await page.keyboard.press("Escape");
      await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
      await projectOption("docker");
      await page.getByRole("status").waitFor();
      await page.evaluate(() => window.__remoteSessionConfiguration.attach("docker"));
      await choose("provider", "DOCKER API · API");
      await page.evaluate(() => window.__remoteSessionConfiguration.preview("docker"));
      await page.waitForFunction(
        () =>
          JSON.parse(
            document.querySelector('[data-testid="remote-draft-probe"]')?.textContent || "{}",
          ).submission?.modelSelection.modelId === "docker-api-model",
      );
      const configured = await page.evaluate(() =>
        structuredClone(window.__remoteSessionConfiguration.settings.projectExecutionPreferences),
      );
      await page.evaluate(() => window.__remoteSessionConfiguration.removeModel("docker"));
      await page.waitForFunction(
        () =>
          JSON.parse(
            document.querySelector('[data-testid="remote-draft-probe"]')?.textContent || "{}",
          ).submission?.modelSelection.modelId === "docker-oauth-model",
      );
      assert.deepEqual(
        await page.evaluate(
          () => window.__remoteSessionConfiguration.settings.projectExecutionPreferences,
        ),
        configured,
      );
      await choose("provider", "继承默认配置");
      const preferences = await page.evaluate(
        () => window.__remoteSessionConfiguration.settings.projectExecutionPreferences,
      );
      const docker = Object.entries(preferences).find(([key]) => key.includes("docker"))[1];
      assert.equal(docker.defaultSessionModelSelection, null);
      assert.equal(
        Object.values(preferences).some(
          (value) => value.defaultSessionModelSelection?.modelId === "wsl-oauth-model",
        ),
        true,
      );
    });

    await t.test(
      "same sessionId replacement retires pending UI state and old model subscriptions",
      async () => {
        await load();
        await projectOption("wsl");
        await choose("provider", "WSL API · API");
        await page.evaluate(() => {
          window.__remoteSessionConfiguration.holdNext = true;
        });
        await page.getByTestId("configuration-approval").click();
        await page.getByRole("option", { name: "完全访问", exact: true }).click();
        await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
        await page.waitForFunction(() => window.__remoteSessionConfiguration.pending);
        assert.equal(await page.getByTestId("configuration-approval").isDisabled(), true);
        await page.evaluate(() => window.__remoteSessionConfiguration.attach("wsl"));
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="configuration-approval"]')?.disabled === false,
        );
        await choose("approval", "变更前确认");
        await page.evaluate(() => window.__remoteSessionConfiguration.release());
        await page.waitForFunction(() => window.__remoteSessionConfiguration.failed);
        assert.equal(await page.getByRole("alert").count(), 0);
        const listeners = await page.evaluate(() =>
          window.__remoteSessionConfiguration.modelSubscriptions(),
        );
        assert.equal(listeners["wsl:0"], 0);
        assert.equal(listeners["wsl:1"], 1);
        const before = await page.evaluate(() => window.__remoteSessionConfiguration.writes.length);
        await page.evaluate(() => window.__remoteSessionConfiguration.detach("wsl"));
        await page.getByRole("status").waitFor();
        assert.equal(await page.getByTestId("session-configuration-form").count(), 0);
        assert.equal(
          await page.evaluate(() => window.__remoteSessionConfiguration.writes.length),
          before,
        );
        assert.equal(
          await page.evaluate(
            () =>
              window.__remoteSessionConfiguration.counts.connects +
              window.__remoteSessionConfiguration.counts.disposes,
          ),
          0,
        );
      },
    );
    assert.deepEqual(errors, []);
  },
);
