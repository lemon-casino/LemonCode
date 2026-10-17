import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const createId = "create-project-dialog";
const rowAt = (dialog, path) => dialog.locator(`[data-project-member="${path}"]`);
async function editPurpose(dialog, path, english = false) {
  const row = rowAt(dialog, path);
  await row.getByRole("button", { name: /用途和说明|Purpose/ }).click();
  const input = row.getByRole("textbox", { name: english ? "Purpose" : "用途和说明", exact: true });
  await input.waitFor();
  return input;
}
async function settledBounds(dialog) {
  // 中文依据：等待真实入场动画结束，再检查原位输入不会改变弹框尺寸。
  await dialog.evaluate(async (node) => {
    await Promise.allSettled(node.getAnimations().map((animation) => animation.finished));
  });
  return dialog.boundingBox();
}
async function sameBounds(dialog, before) {
  const after = await dialog.boundingBox();
  for (const key of ["x", "y", "width", "height"])
    assert.ok(Math.abs(after[key] - before[key]) < 1, `${key}: ${before[key]} -> ${after[key]}`);
}

test(
  "inline purpose keeps one draft through blur, switching, direct submission, failure and reload",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/project-form.html`);
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    const dialog = page.getByTestId(createId);
    await dialog.getByTestId("create-project-add-folder").click();
    await dialog.getByTestId("create-project-add-folder").click();
    await dialog.getByLabel("项目名称", { exact: true }).fill("前后端一体项目");
    assert.equal(await dialog.getByLabel("项目说明", { exact: true }).count(), 0);
    const bounds = await settledBounds(dialog);
    let input = await editPurpose(dialog, "/fixture/frontend");
    assert.equal(await input.inputValue(), "");
    assert.match(await input.getAttribute("placeholder"), /^例如：/);
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    await sameBounds(dialog, bounds);
    assert.equal(await page.getByRole("dialog").count(), 1);
    assert.equal(await dialog.getByTestId("project-member-details").count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "完成", exact: true }).count(), 0);
    await input.fill("页面和交互");
    await dialog.getByRole("heading", { name: "新建项目", exact: true }).click();
    assert.equal(await rowAt(dialog, "/fixture/frontend").getByRole("textbox").count(), 0);
    await rowAt(dialog, "/fixture/frontend").getByText("页面和交互", { exact: true }).waitFor();
    input = await editPurpose(dialog, "/fixture/frontend");
    assert.equal(await input.inputValue(), "页面和交互");
    await page.keyboard.press("Escape");
    assert.equal(
      await rowAt(dialog, "/fixture/frontend")
        .getByRole("button", { name: /用途和说明/ })
        .evaluate((node) => node === document.activeElement),
      true,
    );
    input = await editPurpose(dialog, "/fixture/frontend");
    const backend = await editPurpose(dialog, "/fixture/backend");
    assert.equal(await input.count(), 0, "switching folders closes the previous input");
    await backend.fill("数据服务：接口与持久化");
    const included = rowAt(dialog, "/fixture/backend").getByRole("checkbox", {
      name: "默认参与",
      exact: true,
    });
    await included.uncheck();
    await included.check();
    await editPurpose(dialog, "/fixture/backend");
    assert.equal(
      await page.evaluate(() => globalThis.__sidebarOrganization.settings().localProjects.length),
      1,
    );
    await sameBounds(dialog, bounds);
    await mkdir(".artifacts/project-form", { recursive: true });
    await page.screenshot({ path: ".artifacts/project-form/inline-create.png" });
    await page.evaluate(() => globalThis.__sidebarOrganization.failNextProjectSave());
    await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Fixture save failed" }).waitFor();
    input = await editPurpose(dialog, "/fixture/backend");
    assert.equal(await input.inputValue(), "数据服务：接口与持久化");
    await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const saved = await page.evaluate(() =>
      globalThis.__sidebarOrganization
        .settings()
        .projectDefinitions.projects.find((project) => project.name === "前后端一体项目"),
    );
    assert.equal(saved.description ?? "", "");
    assert.deepEqual(
      saved.members.map(({ role, description }) => ({ role, description })),
      [
        { role: "", description: "页面和交互" },
        { role: "", description: "数据服务：接口与持久化" },
      ],
    );
    await page.reload();
    const open = async () => {
      await page.getByText("前后端一体项目", { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "编辑项目…", exact: true }).click();
      await page
        .getByTestId("sidebar-project-editor")
        .getByLabel("项目名称", { exact: true })
        .waitFor();
      return page.getByTestId("sidebar-project-editor");
    };
    let editor = await open();
    const editorBounds = await settledBounds(editor);
    input = await editPurpose(editor, "/fixture/backend");
    assert.equal(await input.inputValue(), "数据服务：接口与持久化");
    await input.fill("保存时的最新用途");
    await sameBounds(editor, editorBounds);
    await page.screenshot({ path: ".artifacts/project-form/inline-edit.png" });
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    editor = await open();
    input = await editPurpose(editor, "/fixture/backend");
    assert.equal(await input.inputValue(), "保存时的最新用途");
    await input.fill("仅保留为草稿");
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    editor = await open();
    input = await editPurpose(editor, "/fixture/backend");
    assert.equal(await input.inputValue(), "保存时的最新用途");
    await input.fill("");
    assert.match(await input.getAttribute("placeholder"), /^例如：/);
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    editor = await open();
    input = await editPurpose(editor, "/fixture/backend");
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(errors, []);
  },
);

test(
  "removing and readding folders resets only that purpose while duplicate picks retain it",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/project-form.html`);
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    const dialog = page.getByTestId(createId);
    await dialog.getByTestId("create-project-add-folder").click();
    await dialog.getByTestId("create-project-add-folder").click();
    let input = await editPurpose(dialog, "/fixture/frontend");
    await input.fill("原目录说明");
    await page.evaluate(() =>
      globalThis.__sidebarOrganization.selectCreationFolders([
        "/fixture/frontend",
        "/fixture/frontend",
      ]),
    );
    await dialog.getByTestId("create-project-add-folder").click();
    assert.equal(await dialog.locator("[data-project-member]").count(), 2);
    input = await editPurpose(dialog, "/fixture/frontend");
    assert.equal(await input.inputValue(), "原目录说明");
    await dialog.getByRole("button", { name: "frontend · 移除目录", exact: true }).click();
    await dialog.getByTestId("create-project-add-folder").click();
    input = await editPurpose(dialog, "/fixture/frontend");
    assert.equal(await input.inputValue(), "");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(
      await page.evaluate(() => globalThis.__sidebarOrganization.settings().localProjects.length),
      1,
    );
  },
);

test(
  "inline purpose and default inclusion work at mobile sizes, large text and both languages",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(".artifacts/project-form", { recursive: true });
    for (const [width, height, english] of [
      [390, 640, false],
      [1280, 850, true],
      [844, 390, false],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/project-form.html?theme=${english ? "zai-light" : "zai-dark"}${english ? "&english" : ""}`,
      );
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "20px"),
      );
      const submit = english ? "New project" : "新建项目";
      await page.getByRole("button", { name: submit, exact: true }).click();
      const dialog = page.getByTestId(createId);
      await dialog.getByTestId("create-project-add-folder").click();
      const input = await editPurpose(dialog, "/fixture/frontend", english);
      await input.pressSequentially(english ? "Design system" : "设计系统");
      await input.press("Enter");
      await input.pressSequentially(english ? "Shared components" : "共享组件");
      assert.equal(
        await input.inputValue(),
        english ? "Design system\nShared components" : "设计系统\n共享组件",
      );
      assert.equal(await input.getAttribute("maxLength"), "1200");
      const row = rowAt(dialog, "/fixture/frontend");
      const checkbox = row.getByRole("checkbox", {
        name: english ? "Include by default" : "默认参与",
        exact: true,
      });
      await checkbox.uncheck();
      assert.equal(await input.count(), 0);
      const label = row.getByRole("button", { name: /用途和说明|Purpose/ });
      const labelBox = await label.boundingBox();
      const checkboxBox = await checkbox.boundingBox();
      assert.ok(checkboxBox.x > labelBox.x, "default inclusion follows purpose on the same row");
      assert.ok(Math.abs(checkboxBox.y - labelBox.y) < 20);
      assert.equal(
        await dialog.getByRole("button", { name: submit, exact: true }).isDisabled(),
        true,
      );
      await checkbox.check();
      assert.equal(
        await dialog.getByRole("button", { name: submit, exact: true }).isEnabled(),
        true,
      );
      assert.equal(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth), false);
      await page.screenshot({ path: `.artifacts/project-form/inline-${width}.png` });
      const submitBox = await dialog
        .getByRole("button", { name: submit, exact: true })
        .boundingBox();
      assert.ok(submitBox.y >= 0 && submitBox.y + submitBox.height <= height);
      await context.close();
    }
  },
);

test(
  "opening legacy purpose preserves metadata; actual edits merge without truncation and preserve project description",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(45000);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("网站项目", { exact: true }).waitFor();
    await page.evaluate(() => {
      const project = globalThis.__sidebarOrganization.settings().localProjects[0];
      project.description = "历史项目说明";
      project.members = [
        {
          id: "legacy",
          path: project.primaryFolderPath,
          label: "旧目录别名",
          role: "用".repeat(80),
          description: "明".repeat(1000),
          enabled: true,
        },
      ];
      project.memberOrder = ["legacy"];
    });
    await page.getByText("网站项目", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "编辑项目…", exact: true }).click();
    const editor = page.getByTestId("sidebar-project-editor");
    const row = rowAt(editor, "/fixture/repo");
    await row.waitFor();
    assert.equal(await row.getByText("旧目录别名", { exact: true }).count(), 0);
    const input = await editPurpose(editor, "/fixture/repo");
    const purpose = "用".repeat(80) + "\n" + "明".repeat(1000);
    assert.equal(await input.inputValue(), purpose);
    await editor.getByRole("heading", { name: "编辑项目", exact: true }).click();
    assert.equal(
      await editor.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => globalThis.__sidebarOrganization.settings().localProjects[0].members[0].role.length,
      ),
      80,
    );
    await editPurpose(editor, "/fixture/repo");
    await input.fill(purpose + "补充");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    const saved = await page.evaluate(
      () => globalThis.__sidebarOrganization.settings().localProjects[0],
    );
    assert.equal(saved.members[0].description, purpose + "补充");
    assert.equal(saved.members[0].role, "");
    assert.equal(saved.members[0].label, "");
    assert.equal(saved.description, "历史项目说明");
  },
);
