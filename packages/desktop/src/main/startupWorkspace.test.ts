import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOpenWorkspaceStartupBootstrap,
  resolveStartupWindowBootstrap,
} from "./startupWorkspace.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, settings: object = {}) {
  const root = await mkdtemp(join(tmpdir(), "lcode-startup-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsFile = join(root, "setting.json");
  const conversationWorkspaceDir = join(root, ".lcode", "workspace", "default");
  await writeFile(settingsFile, JSON.stringify(settings));
  return { root, settingsFile, conversationWorkspaceDir };
}

const remoteSession = {
  kind: "remote",
  workspacePath: "/example/project",
  target: { kind: "ssh", host: "example.test", username: "tester" },
  lastOpenedAt: 1,
  lastConnectionStatus: "connected",
};

test("有效本地项目恢复也创建已删除的默认对话目录", async (t) => {
  const paths = await fixture(t);
  const project = join(paths.root, "project");
  await mkdir(project);
  await writeFile(
    paths.settingsFile,
    JSON.stringify({ lastWorkspaceSession: [{ kind: "local", workspacePath: project }] }),
  );
  const result = await resolveStartupWindowBootstrap(paths);
  assert.deepEqual(result, { agentWarmupTargets: [{ workspacePath: project }] });
  assert.equal((await stat(paths.conversationWorkspaceDir)).isDirectory(), true);
});

test("远程 active 后的本地对话目录先恢复再用于存储预热", async (t) => {
  const paths = await fixture(t);
  const project = join(paths.root, "project");
  await mkdir(project);
  await writeFile(
    paths.settingsFile,
    JSON.stringify({
      lastActiveTabIndex: 1,
      recentProjects: [project],
      lastWorkspaceSession: [
        { kind: "local", workspacePath: project },
        remoteSession,
        {
          kind: "local",
          workspacePath: paths.conversationWorkspaceDir,
          workspacePurpose: "conversation",
        },
      ],
    }),
  );
  const before = await readFile(paths.settingsFile, "utf8");
  const result = await resolveStartupWindowBootstrap(paths);
  assert.deepEqual(result, {
    agentWarmupTargets: [
      { workspacePath: paths.conversationWorkspaceDir },
      { workspacePath: project },
    ],
  });
  assert.equal((await stat(paths.conversationWorkspaceDir)).isDirectory(), true);
  assert.equal(await readFile(paths.settingsFile, "utf8"), before);
});

test("只有远程标签仍准备本地备用目录", async (t) => {
  const paths = await fixture(t, { lastWorkspaceSession: [remoteSession] });
  const result = await resolveStartupWindowBootstrap(paths);
  assert.deepEqual(result, {});
  assert.equal((await stat(paths.conversationWorkspaceDir)).isDirectory(), true);
});

test("已删除的用户项目保持不可用且不重新创建", async (t) => {
  const paths = await fixture(t);
  const project = join(paths.root, "deleted-project");
  await writeFile(
    paths.settingsFile,
    JSON.stringify({ lastWorkspaceSession: [{ kind: "local", workspacePath: project }] }),
  );
  const result = await resolveStartupWindowBootstrap(paths);
  assert.deepEqual(result, {
    unavailableWorkspacePath: project,
    agentWarmupTargets: [{ workspacePath: project }],
  });
  assert.equal((await stat(paths.conversationWorkspaceDir)).isDirectory(), true);
  await assert.rejects(stat(project), { code: "ENOENT" });
});

test("显式项目打开通过同一目录准备入口且优先于持久标签", async (t) => {
  const paths = await fixture(t, { lastWorkspaceSession: [remoteSession] });
  const project = join(paths.root, "explicit-project");
  await mkdir(project);
  const explicitBootstrap = createOpenWorkspaceStartupBootstrap(project);
  const result = await resolveStartupWindowBootstrap({ ...paths, explicitBootstrap });
  assert.deepEqual(result, explicitBootstrap);
  assert.equal((await stat(paths.conversationWorkspaceDir)).isDirectory(), true);
});

test("首次启动创建默认目录并选择对话 workspace", async (t) => {
  const paths = await fixture(t);
  const result = await resolveStartupWindowBootstrap(paths);
  assert.deepEqual(result, {
    initialWorkspacePath: paths.conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: paths.conversationWorkspaceDir }],
  });
  assert.equal((await stat(paths.conversationWorkspaceDir)).isDirectory(), true);
});

test("目录准备幂等保留内容，删除后下次启动重新创建", async (t) => {
  const paths = await fixture(t, { lastWorkspaceSession: [remoteSession] });
  await resolveStartupWindowBootstrap(paths);
  const marker = join(paths.conversationWorkspaceDir, "existing.txt");
  await writeFile(marker, "keep");
  await resolveStartupWindowBootstrap(paths);
  assert.equal(await readFile(marker, "utf8"), "keep");
  await rm(paths.conversationWorkspaceDir, { recursive: true });
  await resolveStartupWindowBootstrap(paths);
  assert.equal((await stat(paths.conversationWorkspaceDir)).isDirectory(), true);
});

test("默认目录被文件占用时保留原文件并传播 IO 失败", async (t) => {
  const paths = await fixture(t, { lastWorkspaceSession: [remoteSession] });
  await mkdir(join(paths.root, ".lcode", "workspace"), { recursive: true });
  await writeFile(paths.conversationWorkspaceDir, "keep");
  await assert.rejects(resolveStartupWindowBootstrap(paths), (error: NodeJS.ErrnoException) =>
    ["EEXIST", "ENOTDIR"].includes(error.code ?? ""),
  );
  assert.equal(await readFile(paths.conversationWorkspaceDir, "utf8"), "keep");
});
