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
  await t.test("两种分支列表的长名称和删除入口完整显示，列表末尾可操作", async () => {
    const longName = `lcode/task-${"中文English功能".repeat(12)}`;
    for (const [width, height] of [
      [1280, 900],
      [1143, 723],
      [390, 844],
      [320, 640],
    ]) {
      await page.setViewportSize({ width, height });
      for (const english of [false, true]) {
        for (const worktree of [true, false]) {
          await page.goto(`${url}?longBranches${english ? "&english" : ""}`);
          await page.evaluate((dark) => {
            document.documentElement.classList.remove("dark", "theme-zai-dark", "theme-zai-light");
            document.documentElement.classList.add(dark ? "theme-zai-dark" : "theme-zai-light");
            if (dark) document.documentElement.classList.add("dark");
            document.documentElement.style.setProperty("--ui-font-size", "18px");
          }, english);
          if (worktree) await select("draft-execution-mode", english ? "Worktree" : "独立工作树");
          const trigger = page.getByTestId(
            worktree ? "worktree-base-trigger" : "git-branch-switcher-trigger",
          );
          await trigger.click();
          const picker = page.getByTestId(worktree ? "worktree-base-picker" : "git-branch-picker");
          const list = page.getByTestId(worktree ? "worktree-base-list" : "git-branch-list");
          const remove = (name) =>
            picker.locator(`[data-testid="git-branch-delete"][data-branch-name="${name}"]`);
          await remove(longName).waitFor();
          assert.equal(await remove("L-GO").getAttribute("data-branch-action"), "in-use");
          assert.equal(await remove("occupied").getAttribute("data-branch-action"), "in-use");
          const row = picker.locator(
            `[data-testid="git-branch-row"][data-branch-name="${longName}"]`,
          );
          const label = row.getByTestId("git-branch-name");
          await label.scrollIntoViewIfNeeded();
          const geometry = await row.evaluate((element) => {
            const name = element.querySelector('[data-testid="git-branch-name"]');
            const button = element.querySelector('[data-testid="git-branch-delete"]');
            const container = element.closest('[data-slot="popover-content"]');
            const rowBox = element.getBoundingClientRect();
            const actionBox = button.getBoundingClientRect();
            const popupBox = container.getBoundingClientRect();
            return {
              nameFits:
                name.scrollWidth <= name.clientWidth + 1 &&
                name.scrollHeight <= name.clientHeight + 1,
              actionFits: actionBox.left >= rowBox.left && actionBox.right <= rowBox.right + 1,
              popupFits:
                popupBox.left >= -1 &&
                popupBox.right <= innerWidth + 1 &&
                popupBox.top >= -1 &&
                popupBox.bottom <= innerHeight + 1,
              label: name.textContent,
              whiteSpace: getComputedStyle(name).whiteSpace,
            };
          });
          assert.equal(geometry.label, longName);
          assert.equal(geometry.nameFits, true, JSON.stringify(geometry));
          assert.equal(geometry.actionFits, true, JSON.stringify(geometry));
          assert.equal(geometry.popupFits, true, JSON.stringify(geometry));
          assert.notEqual(geometry.whiteSpace, "nowrap");
          assert.equal(
            await picker.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
            true,
            JSON.stringify(
              await picker.evaluate((element) => ({
                width: element.clientWidth,
                scrollWidth: element.scrollWidth,
                children: [...element.children].map((child) => ({
                  tag: child.tagName,
                  width: child.clientWidth,
                  scrollWidth: child.scrollWidth,
                })),
              })),
            ),
          );
          await list.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const last = remove("lcode/task-列表末尾功能-29");
          assert.equal(
            await last.evaluate((element) => {
              const list = element.closest(
                '[data-testid="worktree-base-list"], [data-testid="git-branch-list"]',
              );
              const action = element.getBoundingClientRect();
              const viewport = list.getBoundingClientRect();
              return action.top >= viewport.top - 1 && action.bottom <= viewport.bottom + 1;
            }),
            true,
          );
          await last.click();
          const dialog = page.getByTestId("git-branch-delete-dialog");
          await dialog.waitFor();
          assert.match(await dialog.innerText(), /lcode\/task-列表末尾功能-29/);
          assert.equal(
            (await calls()).some((call) => ["deleteBranch", "switchBranch"].includes(call.method)),
            false,
          );
          await dialog
            .getByRole("button", { name: english ? "Cancel" : "取消", exact: true })
            .click();
          if (worktree) assert.match(await trigger.innerText(), /L-GO/);
        }
      }
    }
  });
  await t.test("基线删除需确认，占用分支不能删除，手机也可操作", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await select("draft-execution-mode", "独立工作树");
    await page.getByTestId("worktree-base-trigger").click();
    const remove = (name) =>
      page.locator(`[data-testid="git-branch-delete"][data-branch-name="${name}"]`);
    await remove("feature").waitFor();
    await page.locator('[data-testid="git-branch-row"][data-branch-name="feature"]').click();
    await page.getByTestId("worktree-base-trigger").click();
    await remove("L-GO").click();
    const occupied = page.getByTestId("git-branch-in-use-dialog");
    await occupied.waitFor();
    assert.equal(await occupied.getByRole("button", { name: "删除分支", exact: true }).count(), 0);
    await occupied.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByTestId("worktree-base-trigger").click();
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
