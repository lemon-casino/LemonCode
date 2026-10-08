import assert from "node:assert/strict";

export async function runGitPublishEditingCases(t, { page, url }) {
  const dialog = page.getByTestId("git-commit-dialog");
  const input = page.getByTestId("git-commit-message-input");
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  const calls = () => page.evaluate(() => globalThis.__gitCommitFixture.publish.calls);
  const check = async (id) => {
    const checkbox = page.getByTestId(id);
    if ((await checkbox.getAttribute("data-state")) !== "checked") await checkbox.click();
  };
  const tagMode = async (mode) => {
    await page.getByTestId("git-publish-tag-mode").click();
    await page.getByTestId(`git-publish-tag-mode-${mode}`).click();
  };
  const selectPreset = async () => {
    await openPresets();
    await page.getByTestId("git-publish-preset-select").click();
    await page.getByRole("option", { name: "发布预览", exact: true }).click();
  };
  const assertNoPreset = async () => {
    await openPresets();
    const selector = page.getByTestId("git-publish-preset-select");
    if ((await selector.count()) > 0 && (await selector.isEnabled())) {
      await selector.click();
      assert.equal(await page.getByRole("option", { name: "发布预览", exact: true }).count(), 0);
      await page.keyboard.press("Escape");
    }
  };
  const openPresets = async () => {
    const presets = page.getByTestId("git-publish-presets");
    if (!(await presets.evaluate((element) => element.open)))
      await presets.locator("summary").click();
  };
  const load = async (query = "") => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // 已出现整页 load 超时；审核开始条件是 DOM 与真实入口就绪，不能绑在外围资源加载上。
    await page.goto(url + query, { waitUntil: "domcontentloaded" });
    await page.getByTestId("git-action-trigger").waitFor();
  };
  const open = async () => {
    await page.getByTestId("git-action-trigger").click();
    await dialog.waitFor();
  };
  const options = async () => {
    await page.getByTestId("git-publish-toggle").click();
    await page.getByTestId("git-publish-remote-origin").waitFor();
  };
  const generated = async () => {
    await page.getByTestId("git-review-acknowledge").waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-commit-generate-button"]')?.disabled,
    );
  };

  await t.test("复制、主题长度、Conventional 类型及恢复上次生成文本", async () => {
    await load();
    await open();
    const message = `${"长".repeat(73)}\n\n正文不属于主题长度`;
    await input.fill(message);
    assert.match(await page.getByTestId("git-message-subject-length").innerText(), /73/);
    await page.getByTestId("git-message-copy").click();
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.clipboardCopies), [
      message,
    ]);
    await page.getByTestId("git-message-type-fix").click();
    assert.match(await input.inputValue(), /^fix/);
    const previous = await input.inputValue();
    await page.getByTestId("git-commit-generate-button").click();
    await generated();
    assert.notEqual(await input.inputValue(), previous);
    await page.getByTestId("git-message-restore").click();
    assert.equal(await input.inputValue(), previous);
    assert.deepEqual(await calls(), []);
  });

  await t.test("范围切换保留消息，但必须重新生成冻结审核", async () => {
    await load();
    await fixture("automatic");
    await generated();
    await input.fill("fix: 保留手工编辑");
    await page.getByTestId("git-commit-include-unstaged").click();
    assert.equal(await input.inputValue(), "fix: 保留手工编辑");
    assert.equal(await page.getByTestId("git-review-acknowledge").count(), 0);
    assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
    await input.press("Control+Enter");
    assert.deepEqual(await calls(), []);
  });

  await t.test("排除及恢复文件使旧审核失效，服务收到真实排除范围", async () => {
    await load();
    await open();
    await page.getByTestId("git-commit-generate-button").click();
    await generated();
    await input.fill("fix: 人工审核说明");
    await page.getByTestId("git-review-open-files").click();
    await page.getByTestId("git-review-exclude-a.ts").click();
    await page.getByTestId("code-viewer-return-review").click();
    assert.equal(await input.inputValue(), "fix: 人工审核说明");
    assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
    await page.getByTestId("git-commit-generate-button").click();
    await generated();
    const requests = await page.evaluate(() => globalThis.__gitCommitFixture.calls);
    assert.deepEqual(requests.at(-1).excludedFilePaths, ["a.ts"]);
    await page.getByTestId("git-scope-open-files").click();
    await page.getByTestId("git-review-restore-a.ts").click();
    await page.getByTestId("code-viewer-return-review").click();
    assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
    assert.equal(await page.getByTestId("git-review-acknowledge").count(), 0);
    assert.deepEqual(await calls(), []);
  });

  await t.test("分组导航不跳过提交游标，Tag 绑定最后一组提交", async () => {
    await load();
    await fixture("groups", true);
    await page.getByTestId("v4-composer-commit-summary").click();
    await generated();
    assert.match(await dialog.innerText(), /fixture-review-warning/);
    await page.getByTestId("git-review-next").click();
    assert.match(await dialog.innerText(), /审核组 2/);
    await page.getByTestId("git-review-prev").click();
    await page.getByTestId("git-review-open-files").click();
    await page.getByTestId("code-viewer-return-review").click();
    await check("git-review-acknowledge");
    await input.press("Control+Enter");
    await page.waitForFunction(() => globalThis.__gitCommitFixture.publish.calls.length === 1);
    assert.equal((await calls())[0].params.review.groupId, "first");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-commit-message-input"]')?.value ===
        "feat: 第二组修改",
    );
    await check("git-review-acknowledge");
    await options();
    await tagMode("create");
    await page.getByTestId("git-publish-tag-name").fill("v1.10.1");
    await page.getByTestId("git-publish-commit-preview").click();
    await page.getByTestId("git-publish-confirm").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-publish-results"]')?.getAttribute("aria-busy") ===
        "false",
    );
    const executed = await calls();
    assert.deepEqual(
      executed.map((call) => call.method),
      ["commit", "commit", "createTag"],
    );
    assert.equal(executed[1].params.review.groupId, "second");
    assert.equal(executed[2].params.ref, "2".padStart(40, "0"));
  });

  await t.test("命名预设可保存、应用和删除；同路径不同 identity 隔离且不执行", async () => {
    await load("?identity=fixture-preset-a");
    await page.evaluate(() => localStorage.clear());
    await open();
    await options();
    await check("git-publish-remote-origin");
    await check("git-publish-branch-enabled");
    await page.getByTestId("git-publish-branch-origin").fill("release/preview");
    await tagMode("create-and-push");
    await page.getByTestId("git-publish-tag-name").fill("v1.10.1");
    assert.equal(
      await page.getByTestId("git-publish-presets").evaluate((element) => element.open),
      false,
    );
    await openPresets();
    await page.getByTestId("git-publish-preset-name").fill("发布预览");
    await page.getByTestId("git-publish-preset-save").click();
    await load("?identity=fixture-preset-a");
    await open();
    await options();
    await selectPreset();
    await page.getByTestId("git-publish-preset-apply").click();
    assert.equal(
      await page.getByTestId("git-publish-branch-origin").inputValue(),
      "release/preview",
    );
    assert.match(await page.getByTestId("git-publish-tag-mode").innerText(), /创建.*推送/);
    assert.deepEqual(await calls(), []);
    await load("?identity=fixture-preset-b");
    await open();
    await options();
    await assertNoPreset();
    await load("?identity=fixture-preset-a");
    await open();
    await options();
    await selectPreset();
    await page.getByTestId("git-publish-preset-delete").click();
    await assertNoPreset();
    assert.deepEqual(await calls(), []);
  });

  await t.test("版本建议使用最高语义版本，非法 Tag 名不能确认", async () => {
    await load();
    await open();
    await options();
    await tagMode("create");
    for (const [kind, version] of [
      ["patch", "v1.10.1"],
      ["minor", "v1.11.0"],
      ["major", "v2.0.0"],
    ]) {
      await page.getByTestId(`git-publish-version-${kind}`).click();
      assert.equal(await page.getByTestId("git-publish-tag-name").inputValue(), version);
    }
    await page.getByTestId("git-publish-tag-name").fill("bad..tag");
    const preview = page.getByTestId("git-publish-preview");
    if (await preview.isEnabled()) await preview.click();
    assert.equal(await page.getByTestId("git-publish-confirm").count(), 0);
    assert.deepEqual(await calls(), []);
  });

  await t.test("目标读取期间变更审核范围，不让旧响应或加载状态锁死窗口", async () => {
    await load();
    await open();
    await input.fill("fix: 保留范围调整说明");
    await page.evaluate(() => globalThis.__gitCommitFixture.publish.holdList());
    await page.getByTestId("git-publish-toggle").click();
    await page.waitForFunction(() => globalThis.__gitCommitFixture.publish.listPending());
    await page.getByTestId("git-commit-include-unstaged").click();
    await page.getByTestId("git-publish-reload").click();
    await page.getByTestId("git-publish-remote-origin").waitFor();
    await page.evaluate(() => globalThis.__gitCommitFixture.publish.releaseList());
    assert.equal(await page.getByTestId("git-publish-reload").isEnabled(), true);
    assert.equal(await input.inputValue(), "fix: 保留范围调整说明");
    assert.deepEqual(await calls(), []);
  });

  await t.test("读取发布目标失败留窗，可显式重试，不产生 Git 副作用", async () => {
    await load();
    await open();
    await page.evaluate(() => globalThis.__gitCommitFixture.publish.failList());
    await page.getByTestId("git-publish-toggle").click();
    await dialog.getByText("fixture-publish-list-failure", { exact: false }).waitFor();
    await page.getByTestId("git-publish-reload").click();
    await page.getByTestId("git-publish-remote-origin").waitFor();
    assert.deepEqual(await calls(), []);
  });
}
