import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildProjectContextSnapshot, type LCodeWorkspaceRef } from "@lcode/shared";
import { fixture } from "../worktree/testFixture.js";
import {
  authorizeProjectContextRequest,
  materializeProjectContext,
} from "./projectContextScope.js";

test("project context maps every member to real worktree directories and rejects stale or foreign scopes", async (t) => {
  const { root, repo, service, command } = await fixture(t);
  const frontend = join(repo, "frontend");
  const backend = join(repo, "backend");
  await Promise.all([mkdir(frontend), mkdir(backend)]);
  // Git 不保留空目录，使用真实 tracked 文件验证隔离路径。
  const { writeFile } = await import("node:fs/promises");
  await Promise.all([
    writeFile(join(frontend, "index.txt"), "front"),
    writeFile(join(backend, "index.txt"), "back"),
  ]);
  await command(repo, "add", ".");
  await command(repo, "commit", "-m", "members");
  const binding = await service.prepare({
    workspacePath: repo,
    taskId: "chat",
    requestId: "prepare",
    sourceFolderPaths: [frontend, backend],
    setupCommands: [],
  });
  const workspace: LCodeWorkspaceRef = {
    workspacePath: binding.workspacePath,
    workspaceKey: binding.workspacePath,
    executionBindingId: binding.id,
    originWorkspacePath: repo,
  };
  const settings = {
    localProjects: [
      {
        id: "project",
        name: "Shop",
        primaryFolderPath: repo,
        sourceFolderPaths: [repo, frontend, backend],
      },
    ],
  };
  const snapshot = buildProjectContextSnapshot(settings, workspace)!;
  await authorizeProjectContextRequest(workspace, "chat", { workspacePath: repo }, service);
  const actual = await materializeProjectContext(snapshot, workspace, "chat", service);
  assert.deepEqual(
    actual?.members.map((member) => member.workspacePath),
    [
      binding.checkoutPath,
      join(binding.checkoutPath, "frontend"),
      join(binding.checkoutPath, "backend"),
    ],
  );
  await assert.rejects(
    authorizeProjectContextRequest(
      { ...workspace, originWorkspacePath: root },
      "chat",
      { workspacePath: repo },
      service,
    ),
    /scope-mismatch/,
  );
  await assert.rejects(
    materializeProjectContext(
      snapshot,
      { ...workspace, executionBindingId: "other" },
      "chat",
      service,
    ),
    /no longer ready/,
  );
  await assert.rejects(
    materializeProjectContext(
      { ...snapshot, origin: { workspacePath: repo, workspaceIdentity: "another-host" } },
      workspace,
      "chat",
      service,
    ),
    /another source/,
  );
});
