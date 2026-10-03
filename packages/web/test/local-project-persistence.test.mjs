import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "saved projects survive gated Root startup, repeated restores and explicit removal",
  { timeout: 180_000 },
  async (t) => {
    const { createSettingService } = await tsImport(
      "../../services/src/setting/settingService.ts",
      import.meta.url,
    );
    const home = await mkdtemp(join(tmpdir(), "lcode-project-persistence-"));
    const oldOverride = process.env.LCODE_DESKTOP_HOME_DIR;
    process.env.LCODE_DESKTOP_HOME_DIR = home;
    t.after(async () => {
      if (oldOverride === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
      else process.env.LCODE_DESKTOP_HOME_DIR = oldOverride;
      // 只清理本测试由 mkdtemp 返回的绝对目录，不处理用户数据目录。
      assert.equal(home.startsWith(join(tmpdir(), "lcode-project-persistence-")), true);
      await rm(home, { recursive: true, force: true });
    });
    const projects = [
      {
        id: "fixture-project-a",
        name: "Saved app",
        primaryFolderPath: "C:/fixture/app",
        sourceFolderPaths: ["C:/fixture/app", "C:/fixture/docs"],
      },
      {
        id: "fixture-project-b",
        name: "Saved other",
        primaryFolderPath: "C:/fixture/other",
        sourceFolderPaths: ["C:/fixture/other"],
      },
    ];
    let service = createSettingService();
    await service.update({
      providerFamilyDomainMigrated: true,
      localProjects: projects,
      recentProjects: projects.map((project) => project.primaryFolderPath),
      lastWorkspaceSession: projects.map((project) => ({
        kind: "local",
        workspacePath: project.primaryFolderPath,
        workspacePurpose: "project",
        localProjectId: project.id,
      })),
      lastActiveTabIndex: 0,
    });
    const mutations = [];
    const server = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Content-Type", "application/json");
      try {
        if (request.method === "OPTIONS") {
          response.end();
          return;
        }
        if (request.method === "POST") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const patch = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          mutations.push(patch);
          await service.update(patch);
        }
        response.end(JSON.stringify(await service.get()));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const settingsOrigin = `http://127.0.0.1:${server.address().port}`;
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${port}/test/fixtures/local-project-persistence.html?settingsOrigin=${encodeURIComponent(settingsOrigin)}`;
    const persisted = async () =>
      JSON.parse(await readFile(join(home, ".lcode/v2/setting.json"), "utf8"));
    await page.goto(`${url}&gatedRoot`);
    await page.waitForFunction(
      () =>
        window.__projectFixture.runtimePreferencesSynced > 0 &&
        window.__projectFixture.modelReads > 0,
    );
    // 等启动快照的 React effect 完成当前帧；不靠长延时回避误删时序。
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.deepEqual((await persisted()).localProjects, projects);
    assert.equal(
      mutations.some((patch) => "localProjects" in patch),
      false,
    );

    for (const width of [1280, 390]) {
      service = createSettingService(); // 新实例从同一设置文件读取，而非复用内存快照。
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await page.getByRole("button", { name: "Saved app", exact: true }).waitFor();
      await page.getByRole("button", { name: "Saved other", exact: true }).waitFor();
      assert.equal(await page.getByTestId("full-restore").innerText(), "false");
      assert.equal(await page.getByTestId("tab-count").innerText(), "1");
      assert.deepEqual((await persisted()).localProjects, projects);
      await page.getByRole("button", { name: "Duplicate project", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="error"]').textContent.length > 0,
      );
      assert.deepEqual((await persisted()).localProjects, projects);
      await page.getByRole("button", { name: "Complete restore", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="full-restore"]').textContent === "true",
      );
      assert.equal(await page.getByTestId("tab-count").innerText(), "3");
      assert.deepEqual((await persisted()).localProjects, projects);
    }
    await page.getByRole("button", { name: "Remove project", exact: true }).click();
    await page
      .getByRole("button", { name: "Saved app", exact: true })
      .waitFor({ state: "detached" });
    assert.deepEqual((await persisted()).localProjects, [projects[1]]);
    service = createSettingService();
    await page.goto(url);
    await page.getByRole("button", { name: "Saved other", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Saved app", exact: true }).count(), 0);
    assert.deepEqual((await persisted()).localProjects, [projects[1]]);
    assert.deepEqual(errors, []);
  },
);
