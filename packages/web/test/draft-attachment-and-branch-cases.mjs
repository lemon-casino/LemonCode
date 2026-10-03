import assert from "node:assert/strict";

export async function runDraftAttachmentCases({ t, page, url, calls, select }) {
  await t.test("草稿图片上传不触发准备；新任务清空附件，首次发送才创建工作树", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}?worktree`);
      const editor = page.getByTestId("v4-composer-input");
      await editor.fill("未发送草稿");
      const paste = () =>
        editor.evaluate((element) => {
          const transfer = new DataTransfer();
          transfer.items.add(
            new File(
              [
                Uint8Array.from(
                  atob(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
                  ),
                  (char) => char.charCodeAt(0),
                ),
              ],
              "pasted.png",
              { type: "image/png" },
            ),
          );
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      await paste();
      await page.waitForFunction(() => globalThis.__sendFixture.uploads.length === 1);
      const state = await page.evaluate(() => ({
        calls: globalThis.__sendFixture.calls,
        uploads: globalThis.__sendFixture.uploads,
      }));
      assert.equal(state.calls.length, 0);
      assert.ok(state.uploads[0].draftId);
      assert.equal(state.uploads[0].sessionId, undefined);
      assert.equal(await page.getByTestId("worktree-preparation-card").count(), 0);
      await page.evaluate(() => globalThis.__sendFixture.newTask());
      await page.waitForFunction(
        () => document.querySelector('[data-testid="v4-composer-input"]').textContent === "",
      );
      assert.equal(await page.getByText("pasted.png", { exact: true }).count(), 0);
      await editor.fill("带图片首次发送");
      await paste();
      await page.waitForFunction(() => globalThis.__sendFixture.uploads.length === 2);
      await page.evaluate(() =>
        Object.assign(globalThis.__sendFixture, { prepare: true, hold: true }),
      );
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="v4-composer-send"]').disabled,
      );
      await editor.press("Enter");
      await page.getByTestId("worktree-preparation-card").waitFor();
      assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 1);
      assert.equal(
        await page.evaluate(() => globalThis.__sendFixture.calls[0].options.attachments.length),
        1,
      );
    }
  });
}

export async function runBranchDeletionCases({ t, page, url, calls, select }) {
  await t.test("基线删除需确认，占用分支不能删除，手机也可操作", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await select("draft-execution-mode", "独立工作树");
    await page.getByTestId("worktree-base-trigger").click();
    const remove = (name) =>
      page.locator(`[data-testid="git-branch-delete"][data-branch-name="${name}"]`);
    await remove("feature").waitFor();
    await page.getByRole("button", { name: "feature", exact: true }).click();
    await page.getByTestId("worktree-base-trigger").click();
    assert.equal(await remove("L-GO").isEnabled(), false);
    await remove("feature").click();
    const dialog = page.getByTestId("git-branch-delete-dialog");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await calls()).filter((call) => call.method === "deleteBranch").length, 0);
    await page.getByTestId("worktree-base-trigger").click();
    await remove("feature").click();
    await dialog.getByRole("button", { name: "删除分支", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const deletes = (await calls()).filter((call) => call.method === "deleteBranch");
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].params.branchName, "feature");
    assert.equal(deletes[0].params.workspacePath, "/fixture/repo");
    assert.match(await page.getByTestId("worktree-base-trigger").innerText(), /L-GO/);
    await page.getByTestId("worktree-base-trigger").click();
    assert.equal(await remove("feature").count(), 0);
  });
}
