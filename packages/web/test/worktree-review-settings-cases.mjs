import assert from "node:assert/strict";

export async function runWorktreeReviewSettingsCases({
  t,
  page,
  load,
  select,
  fixture,
  configure,
  calls,
}) {
  await t.test(
    "侧栏各布局按真实绑定显示图标；只更新 bindingId 即时刷新，项目默认及 fork 不冒充工作树",
    async () => {
      for (const english of [false, true]) {
        await page.setViewportSize({ width: 390, height: 900 });
        await load(english ? "?sidebar&english" : "?sidebar");
        assert.equal(await page.getByTestId("task-worktree-badge").count(), 0);
        await page.evaluate(() => globalThis.__worktreeSidebarRows.setBindingId("actual-binding"));
        await page.waitForFunction(
          () => document.querySelectorAll('[data-testid="task-worktree-badge"]').length === 5,
        );
        await select("global-execution-mode", english ? "Worktree" : "独立工作树");
        assert.equal(await page.getByTestId("task-worktree-badge").count(), 5);
        assert.equal(
          await page.getByTestId("sidebar-local-row").getByTestId("task-worktree-badge").count(),
          0,
        );
        for (const kind of ["default", "pinned", "timeline", "grouped", "overlay"]) {
          const row = page.getByTestId(`sidebar-row-${kind}`);
          const badge = row.getByTestId("task-worktree-badge");
          assert.equal(await badge.getAttribute("aria-label"), english ? "Worktree" : "独立工作树");
          assert.equal(await badge.getAttribute("role"), "img");
          assert.equal(await badge.isVisible(), true);
          assert.equal(
            await badge.evaluate((element) =>
              element.nextElementSibling?.textContent.includes("Sidebar worktree session"),
            ),
            true,
          );
          await row.hover();
          assert.equal(await badge.isVisible(), true);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.evaluate(() => globalThis.__worktreeSidebarRows.setBindingId(undefined));
        await page.waitForFunction(
          () => document.querySelectorAll('[data-testid="task-worktree-badge"]').length === 0,
        );
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
  await t.test(
    "唯一执行入口记忆项目、保留其他 scope，失败不改有效值且冻结请求不受新默认影响",
    async () => {
      await load();
      const mode = page.getByTestId("draft-execution-mode");
      assert.equal(await mode.innerText(), "本地目录");
      assert.equal(await page.getByTestId("project-policy-executionMode").count(), 0);
      await mode.click();
      assert.deepEqual(await page.getByRole("option").allTextContents(), [
        "本地目录",
        "独立工作树",
      ]);
      assert.match(await page.getByTestId("draft-execution-mode-source").innerText(), /全局默认/);
      await page.keyboard.press("Escape");
      await configure({ failSave: true });
      await select("draft-execution-mode", "独立工作树");
      await page.getByRole("alert").getByText("fixture-save-failed", { exact: true }).waitFor();
      assert.equal(await mode.innerText(), "本地目录");
      assert.equal(
        (await fixture("settings")).projectExecutionPreferences["/fixture/repo"],
        undefined,
      );
      await fixture("chooseScope", "remote-b");
      assert.equal(await page.getByText("fixture-save-failed", { exact: true }).count(), 0);
      await fixture("chooseScope");
      await configure({ failSave: false });
      await select("draft-execution-mode", "独立工作树");
      assert.equal(await mode.innerText(), "独立工作树");
      assert.equal((await fixture("draft"))?.mode, undefined);
      await fixture("chooseDraft", { mode: "local" });
      assert.equal(await mode.innerText(), "独立工作树");
      await fixture("resetDraft");
      assert.equal(await mode.innerText(), "独立工作树");
      const updates = (await calls()).filter((call) => call.method === "settings.update");
      assert.deepEqual(updates.at(-1).params, {
        projectExecutionPreferences: { "/fixture/repo": { executionMode: "worktree" } },
      });
      assert.equal(
        (await fixture("settings")).projectExecutionPreferences.other.executionMode,
        "worktree",
      );
      await fixture("begin");
      await fixture("externalMode", "local");
      await select("global-execution-mode", "独立工作树");
      assert.equal(await mode.innerText(), "独立工作树");
      assert.equal(await mode.isDisabled(), true);
      await fixture("fail");
      assert.equal(await mode.isDisabled(), true);
      await fixture("resetDraft");
      assert.equal(await mode.innerText(), "本地目录");
      assert.equal(
        (await calls()).some(({ method }) => ["prepare", "switchBranch"].includes(method)),
        false,
      );
    },
  );
  await t.test("执行方式保存中禁用；切换身份后迟到失败只属于原项目", async () => {
    await load();
    await configure({ holdSave: true, failSave: true });
    const mode = page.getByTestId("draft-execution-mode");
    await mode.click();
    await page.getByRole("option", { name: "独立工作树", exact: true }).click();
    assert.equal(await mode.isDisabled(), true);
    await fixture("chooseScope", "remote-b");
    await fixture("releaseSave");
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="draft-execution-mode"]').disabled,
    );
    assert.equal(await page.getByText("fixture-save-failed", { exact: true }).count(), 0);
    assert.equal(await mode.innerText(), "本地目录");
    assert.equal((await fixture("settings")).projectExecutionPreferences["remote-b"], undefined);
  });
  await t.test("项目、执行方式与基线靠左，仅设置靠右；双语、主题和窄屏支持长基线", async () => {
    const longBase = "feature/" + "long-branch-".repeat(25);
    for (const width of [1280, 390]) {
      for (const english of [false, true]) {
        for (const dark of [false, true]) {
          await page.setViewportSize({ width, height: 900 });
          await load(english ? "?english" : "");
          await page.evaluate(
            (dark) => document.documentElement.classList.toggle("dark", dark),
            dark,
          );
          await select("draft-execution-mode", english ? "Worktree" : "独立工作树");
          await fixture("chooseDraft", { baseRef: longBase });
          const mode = page.getByTestId("draft-execution-mode");
          const base = page.getByTestId("worktree-base-trigger");
          const header = await page.getByTestId("draft-composer-header").boundingBox();
          const project = await page.getByTestId("draft-project-entry").boundingBox();
          const modeBox = await mode.boundingBox();
          const baseBox = await base.boundingBox();
          const settingsBox = await page.getByTestId("project-execution-settings").boundingBox();
          assert.ok(Math.abs(settingsBox.x + settingsBox.width - header.x - header.width) < 2);
          assert.ok(
            modeBox.x >= project.x + project.width - 1 &&
              modeBox.x <= project.x + project.width + 2,
          );
          assert.ok(
            baseBox.x >= modeBox.x + modeBox.width - 1 &&
              baseBox.x + baseBox.width <= settingsBox.x,
          );
          assert.equal(await base.locator("span").getAttribute("title"), longBase);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.equal(await mode.innerText(), english ? "Worktree" : "独立工作树");
          await mode.click();
          assert.match(
            await page.getByTestId("draft-execution-mode-source").innerText(),
            english ? /saved choice/ : /已保存的选择/,
          );
          const options = page.getByRole("listbox");
          const box = await options.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width);
          await page.keyboard.press("Escape");
          await page.getByTestId("project-execution-settings").click();
          assert.equal(await page.getByTestId("project-policy-executionMode").count(), 0);
          assert.equal(await page.getByTestId("project-worktree-list").count(), 0);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          await page.keyboard.press("Escape");
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  await t.test("统一审核设置的三档、项目继承、保存失败与旧配置映射", async () => {
    const globalId = "settings-git-commit-review-mode-select";
    const projectId = "project-policy-gitCommitReviewMode";
    const effective = page.getByTestId("project-policy-effective-gitCommitReviewMode");
    await load();
    assert.match(await page.getByTestId(globalId).innerText(), /关闭/);
    assert.equal(await page.getByTestId("global-auto-open-review").count(), 0);
    assert.equal(await page.getByTestId("project-policy-autoGenerateGitCommitMessage").count(), 0);
    await select(globalId, "生成并打开审核");
    assert.match(await effective.innerText(), /生成并打开审核/);
    await select(projectId, "仅生成草稿");
    await select(globalId, "关闭");
    assert.match(await effective.innerText(), /仅生成草稿/);
    await select(projectId, "继承全局");
    assert.match(await effective.innerText(), /关闭/);
    await configure({ failSave: true });
    await select(globalId, "仅生成草稿");
    await page.getByText("fixture-save-failed").waitFor();
    assert.match(await page.getByTestId(globalId).innerText(), /关闭/);
    await configure({ failSave: false });
    await select(globalId, "仅生成草稿");
    assert.match(await effective.innerText(), /仅生成草稿/);
    const updates = (await calls()).filter((call) => call.method === "settings.update");
    assert.ok(
      updates.every(
        ({ params }) =>
          !Object.hasOwn(params, "autoGenerateGitCommitMessage") &&
          !Object.hasOwn(params, "autoOpenGitCommitReview"),
      ),
    );
    const saved = await fixture("settings");
    assert.equal(saved.projectExecutionPreferences.other.executionMode, "worktree");
    await load("?legacyReview");
    assert.match(await page.getByTestId(globalId).innerText(), /仅生成草稿/);
    assert.match(await page.getByTestId(projectId).innerText(), /生成并打开审核/);
    await select(projectId, "继承全局");
    assert.match(await effective.innerText(), /仅生成草稿/);
    const migrated = await fixture("settings");
    assert.equal(
      migrated.projectExecutionPreferences["/fixture/repo"].autoOpenGitCommitReview,
      "enabled",
    );
    assert.equal(
      migrated.projectExecutionPreferences["/fixture/repo"].gitCommitReviewMode,
      "inherit",
    );
  });
  await t.test("中英文桌面与手机均可键盘选择审核模式且不横向溢出", async () => {
    for (const width of [1280, 390]) {
      for (const english of [false, true]) {
        await page.setViewportSize({ width, height: 900 });
        await load(english ? "?english" : "");
        const trigger = page.getByTestId("settings-git-commit-review-mode-select");
        const name = english ? "Generate and open review" : "生成并打开审核";
        await trigger.focus();
        await page.keyboard.press("Enter");
        const option = page.getByRole("option", { name, exact: true });
        await option.waitFor();
        await option.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          () => globalThis.__worktreeFixture.settings().gitCommitReviewMode === "draft-and-review",
        );
        assert.match(
          await page.getByTestId("project-policy-effective-gitCommitReviewMode").innerText(),
          new RegExp(name),
        );
        await select("project-policy-gitCommitReviewMode", english ? "Draft only" : "仅生成草稿");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(
          await trigger.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
}
