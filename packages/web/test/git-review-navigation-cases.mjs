import assert from "node:assert/strict";

export async function runGitReviewNavigationCases(t, { page, url }) {
  const dialog = page.getByTestId("git-commit-dialog");
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });

  await t.test("历史阶段返回后可选择新目标，旧发布仍绑定 L-GO，epoch 重建不重放合并", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${url}?seedIntegration=published`);
    await fixture("executionMode", "worktree");
    await fixture("dirty", []);
    await page.getByTestId("git-action-trigger").click();
    await dialog.getByTestId("git-review-stage-back").click();
    await dialog.getByTestId("worktree-completed-evidence").locator("summary").first().click();
    await dialog.getByTestId("worktree-stage-back").click();
    await dialog.getByTestId("worktree-current-stage").click();
    await dialog.getByTestId("worktree-remote-publication").waitFor();
    assert.match(await dialog.innerText(), /发布 L-GO/);
    await dialog.getByTestId("git-review-stage-back").click();
    await dialog.getByTestId("worktree-target-branch").click();
    await page.getByRole("option", { name: "main", exact: true }).click();
    const prepare = dialog.getByTestId("worktree-integrate");
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="worktree-integrate"]').disabled,
    );
    assert.equal(await prepare.isEnabled(), true);
    await prepare.click();
    await dialog.getByTestId("worktree-integration-status").waitFor();
    assert.equal(
      (await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls)).at(-1).targetBranch,
      "main",
    );
    const before = await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls.length);
    await fixture("logEpoch", "new-epoch");
    await page.getByTestId("git-action-trigger").click();
    await dialog.getByTestId("worktree-integration-status").waitFor();
    assert.match(await dialog.innerText(), /main/);
    assert.equal(
      await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls.length),
      before,
    );
  });
  await t.test("本地审核读取失败及远端部分失败可转交，草稿保留且没有隐式 Git 操作", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await fixture("failLoad", "fixture-error src/button.ts:12");
      await page.getByTestId("git-action-trigger").click();
      await dialog.getByTestId("git-failure-to-composer").click();
      await dialog.waitFor({ state: "hidden" });
      const draft = await page.getByTestId("composer-draft").inputValue();
      assert.ok(draft.startsWith("待发送的草稿不能改变"));
      assert.match(draft, /src\/button.ts:12/);
      assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
      await page.goto(url);
      await page.getByTestId("git-action-trigger").click();
      await dialog.getByTestId("git-publish-toggle").click();
      await dialog.getByTestId("git-publish-remote-origin").check();
      await dialog.getByTestId("git-publish-remote-backup").check();
      await dialog.getByTestId("git-publish-branch-enabled").check();
      await page.evaluate(() => globalThis.__gitCommitFixture.publish.failPush("backup"));
      await dialog.getByTestId("git-publish-preview").click();
      await dialog.getByTestId("git-publish-confirm").click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="git-publish-results"]')
            ?.getAttribute("aria-busy") === "false",
      );
      const calls = await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls);
      await dialog.getByTestId("git-failure-to-composer").click();
      await dialog.waitFor({ state: "hidden" });
      const report = await page.getByTestId("composer-draft").inputValue();
      assert.match(report, /origin.*success/);
      assert.match(report, /backup.*failed/);
      assert.deepEqual(
        await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls),
        calls,
      );
    }
  });
  await t.test("干净来源明确进入目标合并结果发布，来源与目标视图无混淆或隐式写入", async () => {
    for (const width of [1280, 390]) {
      for (const english of [false, true]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${url}?seedIntegration=published${english ? "&english" : ""}`);
        await fixture("executionMode", "worktree");
        await fixture("dirty", []);
        await page.getByTestId("git-action-trigger").click();
        const navigate = dialog.getByTestId("git-review-stage-back");
        await navigate.waitFor();
        assert.equal(
          await navigate.innerText(),
          english ? "View merge result and publish L-GO" : "查看合并结果并发布 L-GO",
        );
        await dialog.getByTestId("git-publish-toggle").click();
        await dialog.getByTestId("git-publish-commit-unavailable").waitFor();
        assert.equal(await dialog.getByTestId("git-publish-commit-preview").isDisabled(), true);
        assert.equal(await dialog.getByTestId("git-publish-preview").isEnabled(), true);
        await navigate.click();
        const targetPublish = dialog.getByTestId("worktree-remote-publication");
        await targetPublish.waitFor();
        assert.equal(
          await targetPublish.getByTestId("git-publish-toggle").innerText(),
          english ? "Publish L-GO" : "发布 L-GO",
        );
        assert.equal(await dialog.getByTestId("git-commit-execution-summary").count(), 0);
        await targetPublish.getByTestId("git-publish-toggle").click();
        assert.equal(
          await targetPublish.getByTestId("git-publish-preview").innerText(),
          english ? "Preview publishing L-GO" : "预览发布 L-GO",
        );
        assert.equal(await targetPublish.getByTestId("git-publish-commit-preview").count(), 0);
        assert.ok(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        );
        await navigate.click();
        await dialog.getByTestId("git-commit-execution-summary").waitFor();
        assert.deepEqual(
          await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls),
          [],
        );
        assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls), []);
      }
    }
  });
  await t.test(
    "历史取消、失败和完成记录恢复来源入口；活动合并保留只读来源和空结果入口",
    async () => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const status of [
          "cancelled",
          "failed",
          "source-commit-failed",
          "published",
          "ready",
        ]) {
          await page.goto(`${url}?seedIntegration=${status}`);
          await fixture("executionMode", "worktree");
          await fixture("dirty", ["a.ts", "b.ts"]);
          await page.getByTestId("git-action-trigger").click();
          await dialog.waitFor();
          if (status === "ready") {
            await page.getByTestId("git-merge-open-source-files").waitFor();
            await page.getByTestId("git-merge-open-source-files").click();
            await page.getByTestId("review-file-workspace").waitFor();
            assert.equal(await page.getByTestId("review-exclude-page").count(), 0);
            await page.getByTestId("code-viewer-return-review").click();
            await page.getByTestId("worktree-open-diff").waitFor();
            await page.getByTestId("git-review-stage-back").click();
            await page.getByTestId("git-scope-open-files").waitFor();
            assert.equal(await page.getByTestId("git-commit-message-input").isDisabled(), true);
          } else {
            await page.getByTestId("git-scope-open-files").waitFor();
            assert.equal(await page.getByTestId("git-commit-message-input").isDisabled(), false);
            assert.equal(await page.getByTestId("git-merge-open-source-files").count(), 0);
            if (status === "published") {
              assert.equal(
                await page.getByTestId("git-review-stage-back").innerText(),
                "查看合并结果并发布 L-GO",
              );
              await page.getByTestId("git-commit-message-input").fill("fix: new source work");
              await page.getByTestId("git-scope-open-files").click();
              await page.getByTestId("review-exclude-page").click();
              await page.getByTestId("code-viewer-return-review").click();
              assert.equal(
                await page.getByTestId("git-commit-action-item-commit").isDisabled(),
                true,
              );
              await page.getByTestId("git-review-stage-back").click();
              await page.getByTestId("worktree-remote-publication").waitFor();
              assert.equal(
                await page
                  .getByTestId("worktree-remote-publication")
                  .getByTestId("git-publish-toggle")
                  .isEnabled(),
                true,
              );
              await page.getByTestId("git-commit-dialog").press("Control+Enter");
              assert.deepEqual(
                await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls),
                [],
              );
            }
          }
          assert.equal(await page.getByText("保存快照并归档", { exact: true }).count(), 0);
        }
      }
    },
  );
  await t.test("本地审核优先显示文件范围，发布折叠，差异返回保留草稿", async () => {
    for (const width of [1280, 390]) {
      for (const locale of ["zh-CN", "en-US"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(url + (locale === "en-US" ? "?english" : ""));
        await fixture("dirty", ["a.ts", "b.ts"]);
        await page.getByTestId("git-action-trigger").click();
        const scope = page.getByTestId("git-scope-open-files");
        const message = page.getByTestId("git-commit-message-input");
        await scope.waitFor();
        assert.ok((await scope.boundingBox()).y < (await message.boundingBox()).y);
        assert.equal(
          await page.getByTestId("git-publish-toggle").getAttribute("aria-expanded"),
          "false",
        );
        await message.fill("fix: local review draft");
        await scope.click();
        await page.getByTestId("review-file-workspace").waitFor();
        await page.getByTestId("review-exclude-page").click();
        await page.getByTestId("code-viewer-return-review").click();
        assert.equal(await message.inputValue(), "fix: local review draft");
        assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
      }
    }
  });
  await t.test("遮罩不关闭，X 与手动重开保留冻结审核及编辑内容", async () => {
    for (const english of [false, true]) {
      await page.setViewportSize({ width: english ? 390 : 1280, height: 900 });
      await page.goto(url + (english ? "?english" : ""));
      await fixture("automatic");
      await page.getByTestId("git-review-acknowledge").waitFor();
      await page.getByTestId("git-commit-message-input").fill("fix: keep reviewed draft");
      await page.getByTestId("git-review-acknowledge").click();
      await page.mouse.click(5, 5);
      assert.equal(await dialog.isVisible(), true);
      await page.getByTestId("git-review-dismiss").click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByTestId("git-action-trigger").click();
      assert.equal(
        await page.getByTestId("git-commit-message-input").inputValue(),
        "fix: keep reviewed draft",
      );
      assert.equal(
        await page.getByTestId("git-review-acknowledge").getAttribute("data-state"),
        "checked",
      );
      assert.equal(await dialog.locator("pre").count(), 0);
    }
  });
  await t.test("冻结差异使用已有查看器，返回保留阶段且切换会话使旧返回失效", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await fixture("automatic");
    await page.getByTestId("git-review-acknowledge").waitFor();
    await page.getByTestId("git-commit-message-input").fill("fix: reviewed once");
    const calls = await page.evaluate(() => globalThis.__gitCommitFixture.calls.length);
    await page.getByTestId("git-review-open-files").click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("code-viewer-return-review").waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.__gitCommitFixture.previewSource.type),
      "patch",
    );
    assert.equal(
      await page.evaluate(() => globalThis.__gitCommitFixture.previewSource.reviewFiles[0].patch),
      "+fixture",
    );
    await page.getByTestId("code-viewer-return-review").click();
    assert.equal(
      await page.getByTestId("git-commit-message-input").inputValue(),
      "fix: reviewed once",
    );
    assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.calls.length), calls);
    await page.getByTestId("git-review-open-files").click();
    await fixture("switchSession", "b");
    await page.getByTestId("code-viewer-return-review").waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), false);
  });
  await t.test("一万文件只在独立区域分页渲染；搜索及批量排除作用于当前页", async () => {
    await page.goto(url);
    await fixture(
      "dirty",
      Array.from({ length: 10_000 }, (_, index) => `src/file-${String(index).padStart(5, "0")}.ts`),
    );
    await page.getByTestId("git-action-trigger").click();
    await page.getByTestId("git-scope-open-files").waitFor();
    assert.equal(await dialog.locator("li").count(), 0);
    await page.getByTestId("git-scope-open-files").click();
    const list = page.getByTestId("review-workspace-files");
    await list.waitFor();
    assert.equal(await list.locator("li").count(), 50);
    assert.match(await page.getByTestId("review-file-pagination").innerText(), /10,000|10000/);
    await page.getByTestId("review-exclude-page").click();
    assert.equal(await list.getByText("已排除的审核文件", { exact: true }).count(), 50);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    assert.equal(await list.locator("li").count(), 50);
    assert.equal(await list.getByText("已排除的审核文件", { exact: true }).count(), 0);
    await page.getByRole("textbox", { name: "搜索文件路径" }).fill("file-09999");
    assert.equal(await list.locator("li").count(), 1);
    await page.getByTestId("review-exclude-matching").click();
    await page.getByRole("textbox", { name: "搜索文件路径" }).fill("src/");
    await page.getByTestId("review-exclude-matching").click();
    await page.getByTestId("code-viewer-return-review").click();
    assert.match(await page.getByTestId("git-commit-scope-counts").innerText(), /已选 0/);
    assert.equal(await page.getByTestId("git-commit-generate-button").isDisabled(), true);
    await page.getByTestId("git-scope-open-files").click();
    await page.getByTestId("review-restore-all").click();
    await page.getByTestId("code-viewer-return-review").click();
    assert.match(await page.getByTestId("git-commit-scope-counts").innerText(), /已排除 0/);
    assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.calls.length), 0);
  });
  await t.test("提交与合并使用单个窗口；上一步不重放来源提交，关闭重开保留候选确认", async () => {
    await page.goto(url);
    await fixture("executionMode", "worktree");
    await fixture("automatic");
    await page.getByTestId("git-commit-and-merge").waitFor();
    await page.getByTestId("commit-and-merge-control").getByRole("checkbox").check();
    await page.getByTestId("git-commit-and-merge").click();
    await page.getByTestId("worktree-approve-candidate").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 1);
    await page.getByTestId("worktree-approve-candidate").check();
    await page.getByTestId("git-review-stage-back").click();
    assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
    await page.getByTestId("git-review-stage-back").click();
    await page.getByTestId("git-review-dismiss").click();
    await page.getByTestId("git-action-trigger").click();
    assert.equal(
      await page.getByTestId("worktree-approve-candidate").getAttribute("data-state"),
      "checked",
    );
    assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls.length), 1);
  });
  await t.test("真实右侧面板按原项目显示本地与工作树审核，差异仍读取实际执行目录", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const { mode, identity, executionIdentity } of [
        { mode: "local", identity: undefined, executionIdentity: undefined },
        { mode: "worktree", identity: undefined, executionIdentity: undefined },
        {
          mode: "worktree",
          identity: "remote:ssh:fixture.example.invalid:22:fixture:/fixture/repo",
          executionIdentity: "remote:ssh:fixture.example.invalid:22:fixture:/fixture/worktrees/a",
        },
      ]) {
        const query = new URLSearchParams({ shellPreview: "" });
        if (identity) query.set("identity", identity);
        else query.set("pathOnly", "");
        await page.goto(`${url}?${query}`);
        await fixture("executionMode", mode);
        await fixture("dirty", ["a.ts", "b.ts"]);
        await page.getByTestId("git-action-trigger").click();
        await page.getByTestId("git-commit-message-input").fill("fix: retain reviewed scope");
        await page.getByTestId("git-scope-open-files").click();
        await dialog.waitFor({ state: "hidden" });
        await page.getByTestId("review-file-workspace").waitFor();
        await page.getByTestId("code-viewer-return-review").waitFor();
        assert.equal(await page.getByTestId("review-workspace-files").locator("li").count(), 2);
        assert.equal(await page.getByText("打开标签页", { exact: true }).isVisible(), false);
        await page.waitForFunction(() => globalThis.__gitCommitFixture.diffQueries.length > 0);
        const diff = await page.evaluate(() => globalThis.__gitCommitFixture.diffQueries[0]);
        assert.equal(
          diff.workspacePath,
          mode === "worktree" ? "/fixture/worktrees/a" : "/fixture/repo",
        );
        assert.equal(diff.workspaceIdentity, executionIdentity);
        assert.equal(
          await page.evaluate(
            () => globalThis.__gitCommitFixture.previewSource.workspaceRemoteSessionId,
          ),
          identity ? "fixture-preview-attachment" : undefined,
        );
        if (width === 390) {
          assert.equal(
            await page
              .getByTestId("review-file-workspace")
              .evaluate((element) => Boolean(element.closest('[role="dialog"]'))),
            true,
            "窄屏沿用生产抽屉",
          );
        }
        await page.getByTestId("review-exclude-page").click();
        await page.getByTestId("code-viewer-return-review").click();
        assert.equal(
          await page.getByTestId("git-commit-message-input").inputValue(),
          "fix: retain reviewed scope",
        );
        assert.match(await page.getByTestId("git-commit-scope-counts").innerText(), /已排除 2/);
        await page.getByTestId("git-scope-open-files").click();
        await page.getByTestId("review-restore-all").click();
        await page.getByTestId("code-viewer-return-review").click();
        assert.match(await page.getByTestId("git-commit-scope-counts").innerText(), /已排除 0/);
        assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.calls.length), 0);
        assert.equal(
          await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls.length),
          0,
        );
      }
    }
  });
  await t.test("真实工作树变更页切换会话后隔离，切回恢复标签但旧审核返回入口失效", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${url}?shellPreview`);
    await fixture("executionMode", "worktree");
    await page.getByTestId("git-action-trigger").click();
    await page.getByTestId("git-scope-open-files").click();
    await page.getByTestId("review-file-workspace").waitFor();
    await fixture("switchSession", "b");
    await page.getByTestId("review-file-workspace").waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("code-viewer-return-review").isVisible(), false);
    await page.getByText("打开标签页", { exact: true }).waitFor();
    await fixture("switchSession", "a");
    await page.getByTestId("review-file-workspace").waitFor();
    assert.equal(await page.getByTestId("code-viewer-return-review").isVisible(), false);
  });
}
