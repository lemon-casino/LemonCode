import assert from "node:assert/strict";

export async function runGitPublishCases(t, { page, url }) {
  const dialog = page.getByTestId("git-commit-dialog");
  const input = page.getByTestId("git-commit-message-input");
  const control = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture.publish[method](...args), {
      method,
      args,
    });
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  const calls = () => page.evaluate(() => globalThis.__gitCommitFixture.publish.calls);
  const load = async (query = "") => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url + query);
    await page.getByTestId("git-action-trigger").waitFor();
  };
  const open = async () => {
    await page.getByTestId("git-action-trigger").click();
    await dialog.waitFor();
    await page.getByTestId("git-publish-toggle").waitFor();
  };
  const publishOptions = async () => {
    await page.getByTestId("git-publish-toggle").click();
    await page.getByTestId("git-publish-remote-origin").waitFor();
  };
  const check = async (id) => {
    const checkbox = page.getByTestId(id);
    if ((await checkbox.getAttribute("data-state")) !== "checked") await checkbox.click();
  };
  const tagMode = async (mode) => {
    await page.getByTestId("git-publish-tag-mode").click();
    await page.getByTestId(`git-publish-tag-mode-${mode}`).click();
  };
  const configureBranches = async () => {
    await check("git-publish-remote-origin");
    await check("git-publish-remote-backup");
    await check("git-publish-branch-enabled");
  };
  const preview = async (commit = false) => {
    await page.getByTestId(commit ? "git-publish-commit-preview" : "git-publish-preview").click();
    await page.getByTestId("git-publish-summary").waitFor();
  };
  const settle = async () => {
    await page.getByTestId("git-publish-results").waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-publish-results"]')?.getAttribute("aria-busy") ===
        "false",
    );
  };
  const confirm = async () => {
    await page.getByTestId("git-publish-confirm").click();
    await settle();
  };

  await t.test("关闭保留编辑草稿，重新打开不复活冻结审核与发布结果", async () => {
    await load();
    await fixture("automatic");
    await input.waitFor();
    await input.fill("fix: 用户保留的提交纪要");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await open();
    assert.equal(await input.inputValue(), "fix: 用户保留的提交纪要");
    assert.equal(await page.getByTestId("git-review-acknowledge").count(), 0);
    assert.equal(await page.getByTestId("git-publish-results").count(), 0);
    assert.deepEqual(await calls(), []);
  });

  await t.test("一次提交、多远端分步结果；失败重试不重复提交或创建 Tag", async () => {
    await load();
    await fixture("automatic");
    await input.waitFor();
    await check("git-review-acknowledge");
    await publishOptions();
    await configureBranches();
    await page.getByTestId("git-publish-branch-backup").fill("release/fixture");
    await tagMode("create-and-push");
    await page.getByTestId("git-publish-tag-name").fill("v1.10.1");
    await control("failPush", "backup");
    await preview(true);
    assert.match(await page.getByTestId("git-publish-summary").innerText(), /origin/);
    assert.match(await page.getByTestId("git-publish-summary").innerText(), /release\/fixture/);
    assert.deepEqual(await calls(), []);
    await confirm();
    const executed = await calls();
    assert.deepEqual(
      executed.map((call) => call.method),
      ["commit", "push", "push", "createTag", "push", "push"],
    );
    assert.equal(executed[0].params.expectedState.headCommitHash, "a".repeat(40));
    const finalHash = executed[1].params.expectedState.headCommitHash;
    assert.notEqual(finalHash, "a".repeat(40));
    assert.equal(executed[3].params.ref, finalHash);
    assert.equal(executed[4].params.tagCommitHash, finalHash);
    assert.match(
      await page.getByTestId("git-publish-results").innerText(),
      /fixture-push-rejected/,
    );
    assert.equal(
      await page.getByTestId("git-publish-result-branch-origin").getAttribute("data-status"),
      "success",
    );
    assert.equal(
      await page.getByTestId("git-publish-result-branch-backup").getAttribute("data-status"),
      "failed",
    );
    await page.getByTestId("git-publish-retry-branch-backup").click();
    await settle();
    const retried = await calls();
    assert.equal(retried.length, 7);
    assert.equal(retried[6].method, "push");
    assert.equal(retried[6].params.remote, "backup");
    assert.equal(retried[6].params.branch, "release/fixture");
    assert.equal(retried[6].params.expectedState.headCommitHash, finalHash);
    assert.equal(await input.inputValue(), "");
  });

  await t.test("干净仓库可仅创建本地 Tag，无提交和远程推送", async () => {
    await load();
    await fixture("dirty", []);
    await fixture("tracked");
    await open();
    await publishOptions();
    await tagMode("create");
    await page.getByTestId("git-publish-tag-name").fill("v1.10.1");
    await preview();
    assert.deepEqual(await calls(), []);
    await confirm();
    assert.deepEqual(
      (await calls()).map((call) => call.method),
      ["createTag"],
    );
    const tags = await control("tags");
    assert.equal(tags.find((tag) => tag.name === "v1.10.1").commitHash, "a".repeat(40));
    assert.match(
      await page.getByTestId("git-publish-result-create-tag-v1.10.1").innerText(),
      /已新建本地 Tag/,
    );
  });

  await t.test("相同提交的已有 Tag 明确显示幂等成功，之后仍可推送", async () => {
    await load();
    await open();
    await publishOptions();
    await check("git-publish-remote-origin");
    await tagMode("create-and-push");
    await page.getByTestId("git-publish-tag-name").fill("v1.10.0");
    await preview();
    await confirm();
    const row = page.getByTestId("git-publish-result-create-tag-v1.10.0");
    assert.equal(await row.getAttribute("data-status"), "success");
    assert.match(await row.innerText(), /Tag 已存在且指向同一提交/);
    assert.match(await row.innerText(), new RegExp("a".repeat(40)));
    assert.deepEqual(
      (await calls()).map((call) => call.method),
      ["createTag", "push"],
    );
    assert.equal((await control("tags")).filter((tag) => tag.name === "v1.10.0").length, 1);
  });

  await t.test("非提交 Tag 单独提示但不阻断正常 Tag，不进入版本建议或发布范围", async () => {
    await load();
    await page.setViewportSize({ width: 390, height: 844 });
    await control("unsupportedTags", [
      { name: "v99.0.0", objectType: "tree" },
      { name: "blob-backup", objectType: "blob" },
    ]);
    await open();
    await publishOptions();
    const notice = page.getByTestId("git-publish-unsupported-tags");
    await notice.waitFor();
    assert.match(await notice.innerText(), /v99\.0\.0.*tree/s);
    assert.match(await notice.innerText(), /blob-backup.*blob/s);
    assert.match(await notice.innerText(), /非提交目标.*不支持发布/);
    for (const theme of ["theme-zai-light", "dark theme-zai-dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.className = theme;
      }, theme);
      assert.ok(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth <= 1));
    }
    await tagMode("create");
    await page.getByTestId("git-publish-version-patch").click();
    assert.equal(await page.getByTestId("git-publish-tag-name").inputValue(), "v1.10.1");
    await page.getByTestId("git-publish-tag-name").fill("v99.0.0");
    await page.getByTestId("git-publish-preview").click();
    await dialog.getByRole("alert").filter({ hasText: "非提交目标" }).waitFor();
    assert.equal(await page.getByTestId("git-publish-confirm").count(), 0);
    assert.deepEqual(await calls(), []);
    await tagMode("push-existing");
    assert.equal(await page.getByTestId("git-publish-existing-tag-v99.0.0").count(), 0);
    await check("git-publish-remote-origin");
    await check("git-publish-existing-tag-v1.10.0");
    await preview();
    await confirm();
    assert.deepEqual(
      (await calls()).map((call) => [call.method, call.params.tag]),
      [["push", "v1.10.0"]],
    );
  });

  await t.test("推送拒绝的逐引用原因和远端详情同时显示，重试仅发失败项", async () => {
    await load();
    await open();
    await publishOptions();
    await configureBranches();
    await control(
      "failPush",
      "origin",
      "branch",
      "git explicit push failed: remote: protected branch\n!\\tHEAD:refs/heads/fixture\\t[rejected] (non-fast-forward)",
    );
    await preview();
    await confirm();
    const row = page.getByTestId("git-publish-result-branch-origin");
    assert.match(await row.innerText(), /protected branch/);
    assert.match(await row.innerText(), /non-fast-forward/);
    await page.getByTestId("git-publish-retry-branch-origin").click();
    await settle();
    assert.deepEqual(
      (await calls()).map((call) => call.params.remote),
      ["origin", "backup", "origin"],
    );
  });

  await t.test("390px 干净仓库 mini 状态面板仍能展开提交发布入口", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${url}?panel=1`);
    await page.getByTestId("session").waitFor();
    await fixture("dirty", []);
    await fixture("tracked");
    const expand = page.getByRole("button", { name: "展开状态", exact: true });
    await expand.waitFor();
    assert.match(await expand.innerText(), /提交与发布/);
    await expand.click();
    await open();
    await publishOptions();
    await tagMode("create");
    await page.getByTestId("git-publish-tag-name").fill("v1.10.1");
    await preview();
    assert.deepEqual(await calls(), []);
  });

  await t.test("已有多个 Tag 仅推送选中引用，不创建新提交或 Tag", async () => {
    await load();
    await open();
    await publishOptions();
    await check("git-publish-remote-origin");
    await tagMode("push-existing");
    await check("git-publish-existing-tag-v1.2.3");
    await check("git-publish-existing-tag-v1.10.0");
    await preview();
    await confirm();
    const executed = await calls();
    assert.deepEqual(
      executed.map((call) => call.method),
      ["push", "push"],
    );
    assert.deepEqual(executed.map((call) => call.params.tag).sort(), ["v1.10.0", "v1.2.3"]);
    assert.ok(executed.every((call) => call.params.branch === undefined));
  });

  await t.test("确认前外部修改拒绝执行；推送中 HEAD 变化停止所有剩余步骤", async () => {
    await load();
    await open();
    await publishOptions();
    await configureBranches();
    await preview();
    await control("mutate", "worktreeFingerprint");
    await confirm();
    assert.deepEqual(await calls(), []);
    await load();
    await open();
    await publishOptions();
    await configureBranches();
    await tagMode("create-and-push");
    await page.getByTestId("git-publish-tag-name").fill("v1.10.1");
    await control("mutateAfterPush");
    await preview();
    await confirm();
    const executed = await calls();
    assert.equal(executed.length, 1);
    assert.equal(executed[0].method, "push");
    assert.equal(executed[0].params.remote, "origin");
    assert.equal(
      (await control("tags")).some((tag) => tag.name === "v1.10.1"),
      false,
    );
  });

  await t.test("推送在途切换会话，迟到响应不执行后续远端或关闭新弹窗", async () => {
    await load();
    await open();
    await publishOptions();
    await configureBranches();
    await control("holdPush", "origin");
    await preview();
    await page.getByTestId("git-publish-confirm").click();
    await page.waitForFunction(() => globalThis.__gitCommitFixture.publish.calls.length === 1);
    await fixture("switchSession", "b");
    await dialog.waitFor({ state: "hidden" });
    await open();
    await input.fill("fix: 新会话草稿");
    await control("releasePush");
    await page.getByTestId("git-publish-toggle").waitFor();
    assert.equal(await input.inputValue(), "fix: 新会话草稿");
    assert.equal((await calls()).length, 1);
  });

  await t.test("默认快捷键只提交，勾选发布选项也不会隐式推送", async () => {
    await load();
    await fixture("automatic");
    await input.waitFor();
    await check("git-review-acknowledge");
    await publishOptions();
    await configureBranches();
    await input.press("Control+Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      (await calls()).map((call) => call.method),
      ["commit"],
    );
  });

  await t.test("发布选项和执行摘要适配 390px，浅深色都无横向溢出", async () => {
    for (const theme of ["theme-zai-light", "dark theme-zai-dark"]) {
      await load();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate((theme) => {
        document.documentElement.className = theme;
      }, theme);
      await open();
      await publishOptions();
      await configureBranches();
      await page
        .getByTestId("git-publish-branch-backup")
        .fill("release/very-long-target-branch-name-with-several-components");
      await tagMode("create-and-push");
      await page.getByTestId("git-publish-tag-name").fill("v1.10.1");
      await preview();
      const size = await dialog.evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        viewport: innerWidth,
        overflow: element.scrollWidth - element.clientWidth,
      }));
      assert.ok(
        size.left >= 0 && size.right <= size.viewport && size.overflow <= 1,
        JSON.stringify(size),
      );
      assert.deepEqual(await calls(), []);
    }
  });
}
