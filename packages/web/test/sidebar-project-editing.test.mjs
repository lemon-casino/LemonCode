import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "project and section editors preserve scope, drafts, remote routing and responsive UI",
  { timeout: 240000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(45000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => {
      if (errors.length) t.diagnostic(errors.join("\n"));
      if (diagnostics().includes("Internal server error")) t.diagnostic(diagnostics().slice(-4000));
    });
    const url = `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`;
    await page.goto(url);
    await page.getByText("网站项目", { exact: true }).waitFor();
    const openProject = async (name, label = "编辑项目…") => {
      await page.getByText(name, { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await page.getByTestId("sidebar-project-editor").waitFor();
      await page
        .getByTestId("sidebar-project-editor")
        .getByLabel("项目名称", { exact: true })
        .waitFor();
      return page.getByTestId("sidebar-project-editor");
    };
    const setPurpose = async (editor, purpose) => {
      await editor.getByRole("button", { name: "repo · 用途和说明", exact: true }).click();
      await editor.getByLabel("用途和说明", { exact: true }).fill(purpose);
      await editor.getByRole("heading", { name: "编辑项目", exact: true }).click();
    };
    let editor = await openProject("网站项目");
    assert.equal(
      await editor.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      true,
    );
    await editor.getByLabel("项目名称", { exact: true }).fill("取消的名称");
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__sidebarOrganization.calls.filter((call) => call.method === "project").length,
      ),
      0,
    );
    editor = await openProject("网站项目");
    await editor.getByLabel("项目名称", { exact: true }).fill("前后端协作");
    await editor.getByRole("button", { name: "添加目录", exact: true }).click();
    await editor.locator('[data-project-member="/fixture/backend"]').waitFor();
    assert.equal(
      await editor.getByRole("button", { name: "repo · 移除目录", exact: true }).isDisabled(),
      true,
    );
    await editor.getByRole("button", { name: "backend · 上移", exact: true }).click();
    await setPurpose(editor, "前后端共用协议，接口变更需同步。");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await page.getByText("前后端协作", { exact: true }).waitFor();
    const project = await page.evaluate(
      () => globalThis.__sidebarOrganization.settings().projectDefinitions.projects[0],
    );
    assert.equal(project.primaryFolderPath, "/fixture/repo");
    assert.deepEqual(project.sourceFolderPaths, ["/fixture/repo", "/fixture/backend"]);
    assert.equal(
      project.members.find((member) => member.id === project.memberOrder[0]).path,
      "/fixture/backend",
    );
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.drafts), 0);
    assert.equal(
      await page.evaluate(() => globalThis.__sidebarOrganization.facts.selected),
      "unchanged",
    );
    editor = await openProject("前后端协作");
    await setPurpose(editor, "本地待核对草稿");
    await page.evaluate(() => {
      const projects = globalThis.__sidebarOrganization.settings().projectDefinitions.projects;
      const latest = structuredClone(projects[0]);
      latest.revision++;
      latest.description = "其它窗口已修改项目说明";
      latest.members[0].description = "其它窗口的目录用途";
      latest.members[0].role = "frontend";
      projects[0] = latest;
    });
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    const latestPreview = editor.getByTestId("project-conflict-latest");
    await latestPreview.getByText("其它窗口已修改项目说明", { exact: true }).waitFor();
    assert.equal(await latestPreview.getByText("/fixture/repo", { exact: true }).count(), 1);
    assert.match(await latestPreview.innerText(), /其它窗口的目录用途/);
    assert.equal(await editor.getByText("本地待核对草稿", { exact: true }).count(), 1);
    assert.equal(
      await editor.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      true,
    );
    await editor.getByRole("button", { name: "查看最新内容并保留我的草稿", exact: true }).click();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    editor = await openProject("前后端协作");
    await setPurpose(editor, "前后端共用协议；保存回执检查。").catch(async (error) => {
      await page.screenshot({ path: ".artifacts/sidebar-project-held-failure.png" });
      t.diagnostic((await page.locator("body").innerText()).slice(0, 5000));
      throw error;
    });
    const syncBefore = await page.evaluate(
      () => globalThis.__sidebarOrganization.facts.settingsSync,
    );
    await page.evaluate(() => globalThis.__sidebarOrganization.holdProjectSave());
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => globalThis.__sidebarOrganization.isProjectSaveHeld());
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    const another = await openProject("远程服务");
    await another.getByLabel("项目名称", { exact: true }).fill("未保存的远程草稿");
    await page.evaluate(() => globalThis.__sidebarOrganization.releaseProjectSave());
    await page.waitForFunction(
      (before) => globalThis.__sidebarOrganization.facts.settingsSync > before,
      syncBefore,
    );
    assert.equal(
      await another.getByLabel("项目名称", { exact: true }).inputValue(),
      "未保存的远程草稿",
    );
    await another.getByRole("button", { name: "取消", exact: true }).click();
    await another.waitFor({ state: "detached" });
    await page.reload();
    await page.getByText("前后端协作", { exact: true }).waitFor();
    editor = await openProject("本地项目会话", "编辑所属项目…");
    assert.equal(await editor.locator("[data-project-member]").count(), 2);
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "detached" });

    await page.getByTestId("sidebar-organize").hover();
    await page.getByRole("menuitem", { name: "新建分区", exact: true }).click();
    const create = page.getByTestId("sidebar-organization-dialog");
    await create.getByLabel("分区名称", { exact: true }).fill("协作分区");
    await create.getByRole("button", { name: "确定", exact: true }).click();
    await create.waitFor({ state: "detached" });
    await page.getByText("协作分区", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "编辑分区…", exact: true }).click();
    const section = page.getByTestId("sidebar-section-editor");
    await section.getByLabel("分区名称", { exact: true }).fill("联调分区");
    await section.getByRole("button", { name: "添加已有内容…", exact: true }).click();
    await section.getByRole("button", { name: /前后端协作/ }).click();
    await section.getByRole("button", { name: /登录优化/ }).click();
    await page.evaluate(() => globalThis.__sidebarOrganization.externalSection());
    assert.equal(
      await section.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      true,
    );
    await section.getByRole("button", { name: "查看最新内容并保留我的草稿", exact: true }).click();
    await section.getByRole("combobox", { name: "默认新建目标", exact: true }).click();
    await page.getByRole("option", { name: "前后端协作", exact: true }).click();
    await section.getByRole("button", { name: "保存", exact: true }).click();
    await section.waitFor({ state: "detached" });
    assert.equal(await page.getByText("其它窗口", { exact: true }).count(), 1);
    const state = await page.evaluate(() => globalThis.__sidebarOrganization.snapshot());
    const savedSection = state.sections.find((item) => item.title === "联调分区");
    assert.equal(savedSection.entries.length, 2);
    assert.equal(savedSection.defaultTargetRef.kind, "project");
    editor = await openProject("远程服务");
    await editor.getByLabel("项目名称", { exact: true }).fill("并发首次保存的草稿");
    await page.evaluate(() => {
      const state = globalThis.__sidebarOrganization;
      state.settings().projectDefinitions.projects.push({
        id: "remote-created-elsewhere",
        revision: 1,
        name: "远程服务",
        description: "其它窗口已创建的项目",
        primaryFolderPath: state.origin,
        sourceFolderPaths: [state.origin],
        workspaceIdentity: state.identity,
      });
    });
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor
      .getByTestId("project-conflict-latest")
      .getByText("其它窗口已创建的项目", { exact: true })
      .waitFor();
    assert.equal(
      await editor
        .getByText("项目已被移除，请关闭后重新选择。草稿仍保留。", { exact: true })
        .count(),
      0,
    );
    await editor.getByRole("button", { name: "放弃草稿并编辑已有项目", exact: true }).click();
    editor = page.getByTestId("sidebar-project-editor");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="sidebar-project-editor"] input')?.value ===
        "远程服务",
    );
    assert.equal(await editor.getByLabel("项目名称", { exact: true }).inputValue(), "远程服务");
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await page.getByText("远程服务", { exact: true }).waitFor();
    await page.evaluate(() => globalThis.__sidebarOrganization.offline());
    editor = await openProject("远程服务");
    assert.equal(
      await editor.getByRole("button", { name: "添加目录", exact: true }).isDisabled(),
      true,
    );
    await editor.getByLabel("项目名称", { exact: true }).fill("远程协作");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await page.getByText("远程协作", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 0);
    await page.evaluate(() => globalThis.__sidebarOrganization.online());
    editor = await openProject("远程协作");
    await editor.getByRole("button", { name: "添加目录", exact: true }).click();
    await editor.getByPlaceholder("输入路径", { exact: true }).fill("/fixture/remote-api");
    await editor.getByRole("button", { name: "前往", exact: true }).click();
    await editor.getByRole("button", { name: "选择此目录", exact: true }).click();
    await editor.locator('[data-project-member="/fixture/remote-api"]').waitFor();
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    const calls = await page.evaluate(() => globalThis.__sidebarOrganization.calls);
    assert.equal(
      calls.filter(
        (call) => call.method === "localStat" && call.params.path === "/fixture/remote-api",
      ).length,
      0,
    );
    assert.ok(
      calls.some(
        (call) => call.method === "remoteStat" && call.params.path === "/fixture/remote-api",
      ),
    );
    await mkdir(".artifacts/sidebar-collaboration", { recursive: true });
    for (const [index, theme] of [
      "zai-dark",
      "zai-light",
      "sepia-light",
      "midnight-blue",
      "forest-dark",
      "cinnabar",
      "inkpurple",
    ].entries()) {
      await page.setViewportSize({ width: index % 2 ? 390 : 1280, height: index % 2 ? 844 : 1000 });
      await page.goto(`${url}?theme=${theme}`);
      editor = await openProject("前后端协作");
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "20px"),
      );
      const box = await editor.boundingBox();
      assert.ok(
        box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1,
        `${theme}: editor within viewport`,
      );
      for (const name of ["保存", "取消"]) {
        const action = await editor.getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(
          action.y >= 0 && action.y + action.height <= page.viewportSize().height,
          `${theme}: ${name} stays visible at 20px UI text`,
        );
      }
      await page.screenshot({ path: `.artifacts/sidebar-collaboration/project-${theme}.png` });
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      await editor.waitFor({ state: "detached" });
    }
    assert.deepEqual(errors, []);
  },
);
