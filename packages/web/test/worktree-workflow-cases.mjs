import assert from "node:assert/strict";

export async function runWorktreeWorkflowCases({ t, page, url, calls, configure, select }) {
  await t.test("合并准备、冲突、验证、落地和远端失败均可转交当前草稿，不重复执行", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const phase of ["prepare", "conflict", "validate", "apply", "remote"]) {
        await page.goto(url + "?scenario=review");
        await configure({
          failIntegration: phase === "prepare",
          conflicted: phase === "conflict",
          failValidation: phase === "validate",
          failPublication: phase === "apply",
        });
        const dialog = page.getByTestId("worktree-task-dialog");
        await dialog.getByTestId("worktree-integrate").click();
        if (["validate", "apply", "remote"].includes(phase)) {
          await dialog.getByTestId("worktree-approve-candidate").check();
          await dialog.getByTestId("worktree-validate").click();
        }
        if (["apply", "remote"].includes(phase))
          await dialog.getByTestId("worktree-publish").click();
        if (phase === "remote") {
          const publish = dialog.getByTestId("worktree-remote-publication");
          await publish.getByTestId("git-publish-toggle").click();
          await publish.getByTestId("git-publish-remote-origin").check();
          await publish.getByTestId("git-publish-remote-backup").check();
          await publish.getByTestId("git-publish-branch-enabled").check();
          await publish.getByTestId("git-publish-preview").click();
          await publish.getByTestId("git-publish-confirm").click();
          await publish.getByText("fixture-remote-offline").waitFor();
        }
        const handoff = dialog.getByTestId("git-failure-to-composer");
        await handoff.waitFor();
        await page.waitForFunction(
          () => !document.querySelector('[data-testid="git-failure-to-composer"]').disabled,
        );
        const before = (await calls()).filter((call) =>
          ["integrate", "continueIntegration", "publishIntegration", "push"].includes(call.method),
        );
        await handoff.click();
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() =>
          document
            .querySelector('[data-testid="failure-composer-draft"]')
            .value.includes("请协助处理以下 Git 操作问题"),
        );
        const draft = await page.getByTestId("failure-composer-draft").inputValue();
        assert.ok(draft.startsWith("原有的后续修改草稿"));
        assert.match(draft, /L-GO/);
        assert.match(draft, phase === "remote" ? /\/fixture\/repo/ : /worktree\/task/);
        if (phase === "conflict") assert.match(draft, /file\.txt/);
        if (phase === "validate") assert.match(draft, /src\/button\.ts:12/);
        if (phase === "remote") {
          assert.match(draft, /origin.*success/);
          assert.match(draft, /backup.*failed/);
          assert.match(draft, /merged into L-GO/);
        }
        assert.deepEqual(
          (await calls()).filter((call) =>
            ["integrate", "continueIntegration", "publishIntegration", "push"].includes(
              call.method,
            ),
          ),
          before,
        );
      }
    }
  });
  await t.test("阶段回退只读，关闭重开及外部差异往返保留候选确认", async () => {
    await page.goto(url + "?scenario=review");
    const dialog = page.getByTestId("worktree-task-dialog");
    await page.getByTestId("worktree-integrate").click();
    await page.getByTestId("worktree-approve-candidate").waitFor();
    await page.getByTestId("worktree-stage-back").click();
    assert.equal(await page.getByTestId("worktree-integrate").isDisabled(), true);
    await page.getByTestId("worktree-current-stage").click();
    await page.getByTestId("worktree-approve-candidate").check();
    await page.mouse.click(5, 5);
    assert.equal(await dialog.isVisible(), true);
    await page.getByTestId("git-review-dismiss").click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("worktree-task-location").getByRole("button").click();
    assert.equal(
      await page.getByTestId("worktree-approve-candidate").getAttribute("data-state"),
      "checked",
    );
    const before = (await calls()).filter((call) =>
      ["integrate", "continue", "publish"].includes(call.method),
    );
    await page.getByTestId("worktree-open-diff").click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("review-file-workspace").waitFor();
    await page.getByTestId("code-viewer-return-review").click();
    assert.equal(
      await page.getByTestId("worktree-approve-candidate").getAttribute("data-state"),
      "checked",
    );
    assert.deepEqual(
      (await calls()).filter((call) => ["integrate", "continue", "publish"].includes(call.method)),
      before,
    );
  });
  await t.test("提交并合并需单独审核；失败重试复用请求，提交路径指向工作树", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url + "?scenario=commit");
    const control = page.getByTestId("commit-and-merge-control");
    await control.waitFor();
    const submit = control.getByTestId("git-commit-and-merge");
    assert.equal(await submit.isDisabled(), true);
    await control.getByRole("checkbox").check();
    await select("worktree-target-branch", "feature");
    assert.equal(await submit.isDisabled(), true);
    await select("worktree-target-branch", "L-GO");
    await control.getByRole("checkbox").check();
    await page.getByTestId("scenario-message").fill("changed message");
    assert.equal(await submit.isDisabled(), true);
    await control.getByRole("checkbox").check();
    await configure({ failIntegration: true });
    await submit.click();
    await control.getByText("fixture-integration-unavailable").waitFor();
    await configure({ failIntegration: false });
    await submit.click();
    await page.getByTestId("worktree-validate").waitFor();
    const integrated = (await calls()).filter((call) => call.method === "integrate");
    assert.equal(integrated.length, 2);
    assert.equal(integrated[0].params.requestId, integrated[1].params.requestId);
    const commands = integrated[1].params.sourceCommits;
    assert.deepEqual(
      commands.map((command) => command.message),
      ["changed message", "message B"],
    );
    assert.equal(
      commands.every(
        (command) =>
          command.workspacePath === "/fixture/worktrees/task" && command.review.acknowledged,
      ),
      true,
    );
    assert.equal(await page.getByTestId("scenario-committed").innerText(), "true");
    assert.equal(
      (await calls()).some((call) => call.method === "publishIntegration"),
      false,
    );
  });
  await t.test("冲突入口显示文件；人工继续和 AI 修复后都必须重新审核候选", async () => {
    for (const ai of [false, true]) {
      await page.goto(url + "?scenario=conflict");
      const dialog = page.getByTestId("worktree-task-dialog");
      await configure({ conflicted: true });
      await dialog.getByTestId("worktree-integrate").click();
      await dialog.getByText("file.txt", { exact: true }).waitFor();
      assert.equal(await dialog.getByTestId("worktree-publish").count(), 0);
      await dialog
        .getByRole("button", { name: ai ? "让 AI 解决冲突" : "已处理冲突，继续审核", exact: true })
        .click();
      await dialog.getByTestId("worktree-validate").waitFor();
      assert.equal(await dialog.getByTestId("worktree-validate").isDisabled(), true);
      assert.equal(
        (await calls()).some((call) => call.method === "publishIntegration"),
        false,
      );
      assert.equal(
        (await calls()).some((call) => call.method === "resolveWithAI"),
        ai,
      );
    }
  });
  await t.test("取消保留候选和来源；旧审批不能继续发布，可创建新集成", async () => {
    await page.goto(url + "?scenario=conflict");
    const dialog = page.getByTestId("worktree-task-dialog");
    await dialog.getByTestId("worktree-integrate").click();
    await dialog.getByTestId("worktree-validate").waitFor();
    await dialog.getByTestId("worktree-stage-back").click();
    assert.equal(await dialog.getByTestId("worktree-integrate").isDisabled(), true);
    assert.equal(await dialog.getByTestId("worktree-target-branch").isDisabled(), true);
    await dialog.getByTestId("worktree-current-stage").click();
    await dialog.getByTestId("worktree-cancel-integration").click();
    await dialog.getByText("已取消，提交和集成目录已保留").waitFor();
    assert.equal(await dialog.getByTestId("worktree-validate").count(), 0);
    assert.equal(await dialog.getByTestId("worktree-integrate").isDisabled(), false);
    assert.equal(
      (await calls()).some((call) => call.method === "publishIntegration"),
      false,
    );
    await dialog.getByTestId("worktree-integrate").click();
    await dialog.getByTestId("worktree-validate").waitFor();
  });
  await t.test("万级冲突与遗漏清单在独立区域分页，遗漏路径不读取文件内容", async () => {
    await page.goto(url + "?scenario=conflict");
    await configure({ conflicted: true, conflictCount: 10_000 });
    const dialog = page.getByTestId("worktree-task-dialog");
    await dialog.getByTestId("worktree-integrate").click();
    assert.equal(await dialog.locator("li").count(), 20);
    await dialog.getByTestId("worktree-open-diff").click();
    await page.getByRole("textbox", { name: "搜索文件路径" }).fill("file-");
    assert.equal(await page.getByTestId("review-workspace-files").locator("li").count(), 50);
    await page.getByTestId("code-viewer-return-review").click();
    await page.goto(url + "?scenario=management");
    await configure({ ignoredCount: 10_000 });
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "保存快照并释放目录", exact: true }).click();
    await dialog.getByTestId("worktree-ignored-omissions").locator("summary").click();
    assert.equal(await dialog.locator("li").count(), 0);
    await dialog.getByTestId("worktree-open-omissions").click();
    assert.equal(await page.getByTestId("review-workspace-files").locator("li").count(), 50);
    assert.equal((await calls()).filter((call) => call.method === "diff").length, 0);
    await page.getByTestId("code-viewer-return-review").click();
  });
}

export async function runWorktreeManagementCases({
  t,
  page,
  load,
  openProjectWorktrees,
  calls,
  fixture,
}) {
  await t.test("管理只显示生命周期，提交入口打开当前会话统一审核且不执行 Git 写入", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await load();
      await openProjectWorktrees();
      await page
        .getByTestId("project-worktree-list")
        .getByRole("button", { name: "工作树管理", exact: true })
        .click();
      const management = page.getByTestId("project-worktree-management-dialog");
      await management.getByTestId("worktree-management-content").waitFor();
      assert.equal(await management.getByTestId("worktree-integrate").count(), 0);
      assert.equal(await management.getByTestId("worktree-approve-candidate").count(), 0);
      const before = (await calls()).filter((call) =>
        ["integrate", "publishIntegration", "archive", "restore"].includes(call.method),
      );
      await management.getByTestId("worktree-open-commit-review").click();
      await management.waitFor({ state: "hidden" });
      const review = page.getByTestId("git-commit-dialog");
      await review.getByTestId("git-scope-open-files").waitFor();
      assert.equal(
        await page.evaluate(() => globalThis.__worktreeFixture.lastReviewNavigation.sessionId),
        "orphan",
      );
      assert.equal(await page.getByRole("dialog").count(), 1);
      assert.equal(await review.getByTestId("worktree-management-content").count(), 0);
      assert.deepEqual(
        (await calls()).filter((call) =>
          ["integrate", "publishIntegration", "archive", "restore"].includes(call.method),
        ),
        before,
      );
      await page.getByTestId("git-review-dismiss").click();
    }
  });
  await t.test(
    "释放工作树目录保留可管理快照，列表说明状态，不归档会话，关闭重开可恢复",
    async () => {
      await load();
      await fixture("hideDraft");
      assert.equal(await page.getByTestId("draft-composer-header").count(), 0);
      await openProjectWorktrees();
      await page
        .getByTestId("project-worktree-list")
        .getByRole("button", { name: "工作树管理", exact: true })
        .click();
      const dialog = page.getByTestId("project-worktree-management-dialog");
      assert.equal(await page.getByRole("dialog").count(), 1);
      await dialog.getByRole("button", { name: "返回项目工作树", exact: true }).click();
      await page
        .getByTestId("project-worktree-list")
        .getByRole("button", { name: "工作树管理", exact: true })
        .click();
      assert.equal(await page.getByRole("dialog").count(), 1);
      await dialog.waitFor();
      await dialog.getByText(/同一工作树的所有会话/).waitFor();
      await dialog.getByRole("button", { name: "保存快照并释放目录", exact: true }).click();
      await dialog.getByText("Ignored files require explicit acknowledgement").waitFor();
      assert.equal(
        (await calls()).find((call) => call.method === "archive").params.acknowledgeIgnoredFiles,
        false,
      );
      await dialog.getByRole("checkbox").last().check();
      await dialog.getByRole("button", { name: "保存快照并释放目录", exact: true }).click();
      await dialog.getByRole("button", { name: "恢复工作树目录", exact: true }).waitFor();
      await dialog
        .getByTestId("worktree-snapshot-summary")
        .getByText("snapshot", { exact: true })
        .waitFor();
      await dialog.getByRole("button", { name: "返回项目工作树", exact: true }).click();
      await page
        .getByTestId("project-worktree-list")
        .getByText("目录已释放，快照可恢复", { exact: true })
        .waitFor();
      await page.getByTestId("project-worktrees-close").click();
      await openProjectWorktrees();
      await page
        .getByTestId("project-worktree-list")
        .getByRole("button", { name: "工作树管理", exact: true })
        .click();
      await dialog.getByTestId("worktree-snapshot-summary").waitFor();
      await dialog.getByRole("button", { name: "恢复工作树目录", exact: true }).click();
      await dialog.getByRole("button", { name: "保存快照并释放目录", exact: true }).waitFor();
      assert.equal((await calls()).filter((call) => call.method === "restore").length, 1);
      assert.equal(
        (await calls()).some((call) => call.method === "archiveTask"),
        false,
      );
    },
  );
}
