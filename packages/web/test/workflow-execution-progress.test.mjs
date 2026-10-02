import assert from "node:assert/strict";
import test from "node:test";
import {
  closeWorkflowActivityDetails,
  startWorkflowProgressBrowser,
} from "./workflow-execution-progress-browser.mjs";

// Uses the real shared timeline, phase list, permission block and projection store.
// No workflow/model calls are started by this fixture.
test(
  "workflow activity, retry explanations and recovery remain accurate on desktop and phone",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const errors = [];
    for (const width of [1280, 390]) {
      const caseInfo = { width, locale: "zh-CN", dark: false, scenario: "model" };
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${port}/test/fixtures/workflow-execution-progress.html`);
        const card = page.getByTestId("fixture-card");
        const pane = page.getByTestId("fixture-details");
        const panel = page.getByTestId("fixture-status-panel");
        const statusActivity = panel.getByTestId("workflow-status-activity");
        const staticRoster = page.getByTestId("fixture-static-roster");
        const progress = pane.locator('[data-phase-id="A"]').first();
        const select = async (value) => {
          caseInfo.scenario = value;
          t.diagnostic(`workflow activity case ${JSON.stringify(caseInfo)}`);
          await page.getByLabel("Scenario", { exact: true }).selectOption(value);
        };
        const activate = (locator) => (width === 390 ? locator.tap() : locator.click());
        // 关闭动画会暂留旧内容，必须定位打开的弹层，不能任选一个详情来断言。
        const activityPopover = page.locator('[data-slot="popover-content"][data-state="open"]');
        const activityDetails = activityPopover.getByTestId("workflow-activity-details");
        const closeDetails = () =>
          closeWorkflowActivityDetails(page, activityPopover, (message) => t.diagnostic(message));
        const openDetails = async () => {
          await activate(progress.getByTestId("workflow-activity-open").first());
          const details = activityDetails;
          await details.waitFor();
          return details;
        };
        await progress.locator('[data-activity-kind="model"]').waitFor();
        for (const locale of ["zh-CN", "en-US"]) {
          caseInfo.locale = locale;
          if (locale === "en-US")
            await activate(page.getByRole("button", { name: "zh-CN", exact: true }));
          for (const dark of [false, true]) {
            const theme = page.getByRole("button", { name: dark ? "Light" : "Dark", exact: true });
            if (await theme.count()) {
              await activate(theme);
              caseInfo.dark = !caseInfo.dark;
            }
            await select("model");
            const hidden = await openDetails();
            assert.match(
              await hidden.innerText(),
              locale === "zh-CN"
                ? /模型请求处理中，尚无可见输出/
                : /Model request in progress; no visible output yet/,
            );
            assert.doesNotMatch(
              await hidden.innerText(),
              /正在输出思考|Streaming reasoning|0 token\/s/,
            );
            await closeDetails();
            for (const kind of ["reasoning", "text", "tool"]) {
              await select(kind);
              await progress.locator(`[data-activity-kind="${kind}"]`).waitFor();
              const details = await openDetails();
              const expected =
                kind === "reasoning"
                  ? locale === "zh-CN"
                    ? /正在输出思考/
                    : /Streaming reasoning/
                  : kind === "text"
                    ? locale === "zh-CN"
                      ? /正在输出正文/
                      : /Streaming text/
                    : /Read/;
              assert.match(await details.innerText(), expected);
              await closeDetails();
            }
            await select("slot");
            assert.match(
              await (await openDetails()).innerText(),
              locale === "zh-CN" ? /等待并发槽位/ : /Waiting for a concurrency slot/,
            );
            await closeDetails();
            await select("backoff");
            const retry = await openDetails();
            assert.match(await retry.innerText(), locale === "zh-CN" ? /第 1 次重试/ : /Retry 1/);
            assert.match(
              await retry.innerText(),
              locale === "zh-CN" ? /流式输出中断/ : /Output stream interrupted/,
            );
            assert.match(
              await retry.innerText(),
              locale === "zh-CN" ? /预计 \d+ 秒后继续/ : /Expected to continue in \d+s/,
            );
            assert.doesNotMatch(await retry.innerText(), /最多 0|maximum 0|死锁|deadlock/);
            const bounds = await activityPopover.boundingBox();
            assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
            if (process.env.LCODE_TEST_SCREENSHOT_DIR)
              await page.screenshot({
                path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/workflow-progress-${width}-${locale}-${dark ? "dark" : "light"}.png`,
              });
            await closeDetails();
            for (const [scenario, expected] of [
              [
                "actor-fifo",
                locale === "zh-CN"
                  ? /等待同一代理的前序任务/
                  : /Waiting for this agent’s earlier task/,
              ],
              [
                "run-capacity",
                locale === "zh-CN" ? /等待工作流并发名额/ : /Waiting for workflow capacity/,
              ],
              [
                "dispatched",
                locale === "zh-CN"
                  ? /正在准备，尚未确认模型请求启动/
                  : /Preparing; model request not confirmed yet/,
              ],
            ]) {
              await select(scenario);
              const queue = await openDetails();
              assert.match(await queue.innerText(), expected);
              assert.match(await statusActivity.innerText(), expected);
              assert.match(await staticRoster.innerText(), expected);
              assert.doesNotMatch(
                await staticRoster.innerText(),
                /Running tool|正在执行工具|Waiting for a concurrency slot|等待并发槽位/,
              );
              assert.equal(
                await queue.getByTestId("workflow-activity-waitSince").count(),
                scenario === "dispatched" ? 0 : 1,
              );
              await closeDetails();
            }
            await select("concurrent-retry");
            const concurrent = await openDetails();
            for (const text of [
              locale === "zh-CN" ? /第 1 次重试/ : /Retry 1/,
              locale === "zh-CN" ? /正在执行工具：Read/ : /Running tool: Read/,
              locale === "zh-CN" ? /最近活动/ : /Last activity/,
              locale === "zh-CN" ? /最近成功请求/ : /Last successful request/,
              locale === "zh-CN" ? /成功请求数/ : /Successful requests/,
            ]) {
              assert.match(await concurrent.innerText(), text);
              assert.match(await staticRoster.innerText(), text);
            }
            assert.equal(await concurrent.getByTestId("workflow-activity-waitSince").count(), 1);
            assert.equal(await concurrent.getByTestId("workflow-activity-waitedFor").count(), 1);
            const fixedRoster = await staticRoster.innerText();
            await closeDetails();
            await activate(page.getByRole("button", { name: "Advice none", exact: true }));
            assert.equal(
              await staticRoster.innerText(),
              fixedRoster,
              "a UI rerender must not advance a generated observation",
            );
            await activate(page.getByRole("button", { name: "Advice valid", exact: true }));
            for (const scenario of ["next-ask", "next-phase", "truncated"]) {
              await select(scenario);
              const phase = pane
                .locator(`[data-phase-id="${scenario === "next-phase" ? "B" : "A"}"]`)
                .first();
              await activate(phase.getByTestId("workflow-activity-open").first());
              const delivery = activityDetails;
              await delivery.waitFor();
              assert.equal(await delivery.getByTestId("workflow-activity-deliveredAt").count(), 1);
              assert.equal(
                await delivery.getByTestId("workflow-activity-requestsCompleted").innerText(),
                "0",
              );
              assert.match(
                await staticRoster.innerText(),
                locale === "zh-CN" ? /已观察的最近交付/ : /Latest observed delivery/,
              );
              if (scenario === "truncated")
                assert.match(
                  await statusActivity.innerText(),
                  locale === "zh-CN" ? /仅已观察窗口/ : /Observed window only/,
                );
              await closeDetails();
            }
            await select("mixed");
            const summary = await statusActivity.innerText();
            assert.match(
              summary,
              locale === "zh-CN" ? /2 位代理：模型处理中/ : /2 agents: Model request in progress/,
            );
            assert.match(
              summary,
              locale === "zh-CN" ? /1 位代理：退避重试中/ : /1 agent: Waiting to retry/,
            );
            assert.match(
              summary,
              locale === "zh-CN"
                ? /1 位代理：等待工作流并发名额/
                : /1 agent: Waiting for workflow capacity/,
            );
            const summaryBounds = await statusActivity.boundingBox();
            assert.ok(
              summaryBounds &&
                summaryBounds.x >= 0 &&
                summaryBounds.x + summaryBounds.width <= width + 1,
            );
            await activate(panel.locator('[data-workflow-run-details-trigger="true"]'));
            assert.match(
              await page.getByTestId("fixture-opened").innerText(),
              /status run details/,
            );
            await activate(
              panel.getByRole("button", {
                name: locale === "zh-CN" ? "停止运行中的后台任务" : "Stop running background task",
                exact: true,
              }),
            );
            assert.match(
              await page.getByTestId("fixture-cancelled").innerText(),
              /fixture-progress/,
            );
            assert.match(
              await page.getByTestId("fixture-opened").innerText(),
              /status run details/,
            );
            await select("recovered");
            await progress.locator('[data-activity-kind="model"]').waitFor();
            const recovered = await openDetails();
            assert.equal(await recovered.getByTestId("workflow-activity-reason").count(), 0);
            assert.equal(await recovered.getByTestId("workflow-activity-nextRetryAt").count(), 0);
            await closeDetails();
            assert.equal(await page.locator("button button").count(), 0);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
            await activate(
              progress.getByRole("button", {
                name:
                  locale === "zh-CN" ? "打开 Reader 的会话记录" : "Open the transcript of Reader",
                exact: true,
              }),
            );
            assert.match(await page.getByTestId("fixture-opened").innerText(), /actor actor#1@1/);
          }
        }
        for (const [value, kind] of [
          ["unstarted", "not-started"],
          ["created", "created"],
          ["queued", "queued"],
          ["actor-fifo", "actor-fifo"],
          ["run-capacity", "run-capacity"],
          ["dispatched", "dispatched"],
          ["paused", "paused"],
          ["legacy", "unknown"],
          ["completed", "ended"],
          ["failed", "ended"],
          ["stopped", "ended"],
          ["cached", "ended"],
        ]) {
          await select(value);
          await progress.locator(`[data-activity-kind="${kind}"]`).waitFor();
          const details = await openDetails();
          assert.doesNotMatch(
            await details.innerText(),
            /Streaming (?:reasoning|text)|Expected to continue|deadlock/,
          );
          if (
            [
              "unstarted",
              "created",
              "queued",
              "actor-fifo",
              "run-capacity",
              "dispatched",
              "legacy",
            ].includes(value)
          ) {
            assert.equal(
              await details.getByTestId("workflow-activity-requestsCompleted").count(),
              0,
            );
            assert.equal(await details.getByTestId("workflow-activity-toolCalls").count(), 0);
          }
          assert.equal(
            await details.getByTestId("workflow-activity-deliveredAt").count(),
            value === "completed" ? 1 : 0,
          );
          if (["completed", "failed", "stopped", "cached", "paused"].includes(value)) {
            assert.equal(await details.getByTestId("workflow-activity-waitedFor").count(), 0);
            assert.equal(await details.getByTestId("workflow-activity-nextRetryAt").count(), 0);
            assert.doesNotMatch(
              await staticRoster.innerText(),
              /Streaming (?:reasoning|text)|Running tool|Expected to continue/,
            );
          }
          await closeDetails();
          if (["completed", "failed", "stopped", "cached"].includes(value)) {
            assert.equal(await statusActivity.count(), 0);
            await activate(panel.getByTestId("workflow-run-directory-trigger"));
            assert.match(
              await page.getByTestId("fixture-opened").innerText(),
              /status run directory/,
            );
          }
        }
        await select("question");
        await progress.getByTestId("workflow-run-question").waitFor();
        assert.match(await progress.innerText(), /Waiting for the main agent/);
        assert.match(
          await progress.getByTestId("workflow-run-question").innerText(),
          /Which file should be reviewed/,
        );
        for (const profile of ["desktop-continuous", "web-remote-replayable"]) {
          await page.getByLabel("Profile", { exact: true }).selectOption(profile);
          await select("backoff");
          const before = await page.getByTestId("fixture-projection-state").innerText();
          await activate(page.getByRole("button", { name: "Begin sync", exact: true }));
          await pane.getByTestId("workflow-connection-notice").waitFor();
          assert.match(await card.innerText(), /Syncing; showing the last known state/);
          assert.match(await statusActivity.innerText(), /Syncing; showing the last known state/);
          assert.doesNotMatch(
            await statusActivity.innerText(),
            /Waiting to retry|Expected to continue/,
          );
          const syncing = await openDetails();
          assert.doesNotMatch(await syncing.innerText(), /Expected to continue|Retry 1/);
          assert.equal(await syncing.getByTestId("workflow-activity-waitedFor").count(), 0);
          assert.equal(await syncing.getByTestId("workflow-activity-nextRetryAt").count(), 0);
          await closeDetails();
          await activate(page.getByRole("button", { name: "Stale frame", exact: true }));
          assert.match(await progress.innerText(), /Activity cannot be confirmed/);
          await activate(page.getByRole("button", { name: "Finish sync", exact: true }));
          await pane.getByTestId("workflow-connection-notice").waitFor({ state: "hidden" });
          assert.match(await statusActivity.innerText(), /Waiting to retry/);
          assert.equal(await page.getByTestId("fixture-projection-state").innerText(), before);
        }
        await activate(page.getByRole("button", { name: "Connection error", exact: true }));
        await pane.getByTestId("workflow-connection-notice").waitFor();
        assert.match(await pane.innerText(), /Connection unavailable/);
        assert.match(await statusActivity.innerText(), /Connection unavailable/);
        await activate(page.getByRole("button", { name: "Reconnect", exact: true }));
        await pane.getByTestId("workflow-connection-notice").waitFor({ state: "hidden" });
        await select("dense");
        await activate(pane.getByTestId("workflow-roster-more-row"));
        const roll = pane.getByTestId("workflow-roster-roll");
        await roll.waitFor();
        const denseRetry = roll.locator('[data-activity-kind="backoff"]');
        await activate(denseRetry.getByTestId("workflow-activity-open"));
        assert.match(await activityDetails.innerText(), /Retry 1|Network connection interrupted/);
        await closeDetails();
        assert.equal(await page.locator("button button").count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        const permission = page.getByTestId("fixture-permission");
        assert.match(
          await permission.getByTestId("workflow-orchestration-advice").innerText(),
          /does not block confirmation|FIFO/,
        );
        await activate(page.getByRole("button", { name: "Advice stale", exact: true }));
        assert.equal(await permission.getByTestId("workflow-orchestration-advice").count(), 0);
        await activate(page.getByRole("button", { name: "Advice none", exact: true }));
        assert.equal(await permission.getByTestId("workflow-orchestration-advice").count(), 0);
      } catch (error) {
        if (error instanceof Error)
          error.message = `[workflow activity ${JSON.stringify(caseInfo)}] ${error.message}`;
        t.diagnostic(
          `workflow activity failure ${JSON.stringify(caseInfo)}; pageErrors=${JSON.stringify(errors)}`,
        );
        throw error;
      } finally {
        await context.close();
      }
    }
    assert.deepEqual(errors, []);
  },
);
