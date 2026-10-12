import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appSettingsSchema, buildRemoteWorkspaceIdentity, type AppSettings } from "@lcode/shared";
import { resolveProjectMemoryRoot } from "@lcode/shared/node";
import type { WorktreeBinding } from "../worktree/contract.js";
import { createMemoryService } from "./memoryService.js";
import { getLCodeDataRootDir, setDataBaseDir } from "../paths.js";

async function fixture(t: { after: (action: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "worktree-memory-"));
  setDataBaseDir(root);
  t.after(async () => {
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  const checkout = join(root, "custom trees", "checkout");
  await mkdir(project);
  await mkdir(checkout, { recursive: true });
  const binding: WorktreeBinding = {
    id: "binding",
    taskId: "task",
    requestId: "request",
    status: "ready",
    workspacePath: checkout,
    originalWorkspacePath: project,
    repositoryRoot: project,
    commonDirectory: join(project, ".git"),
    checkoutPath: checkout,
    branch: "lcode/task-memory",
    baseCommit: "head",
    targetBranch: "main",
    sourceFolderPaths: [checkout],
    createdAt: "now",
    updatedAt: "now",
  };
  let settings: AppSettings = appSettingsSchema.parse({ recentProjects: [project] });
  let bindings = [binding];
  const queries: string[] = [];
  const service = createMemoryService({
    settingService: {
      get: async () => settings,
      update: async (patch: Partial<AppSettings>) => {
        settings = { ...settings, ...patch };
      },
    },
    worktreeService: {
      list: async ({ workspacePath }) => {
        queries.push(workspacePath);
        return bindings.filter(
          (value) =>
            value.originalWorkspacePath === workspacePath || value.workspacePath === workspacePath,
        );
      },
      acquireCheckout: async ({ workspacePath, ownerId }) => ({
        token: "lease",
        workspacePath,
        ownerId,
      }),
      releaseCheckout: async () => {},
    },
  });
  function memoryRoot(
    workspacePath: string,
    storageLocation: "workspace" | "profile",
    workspaceIdentity?: string,
  ) {
    return resolveProjectMemoryRoot({
      cliStorageRoot: join(getLCodeDataRootDir(), "cli"),
      workspacePath,
      storageLocation,
      workspaceIdentity,
    });
  }
  async function memory(
    workspacePath: string,
    location: "workspace" | "profile",
    content: string,
    identity?: string,
  ) {
    const path = memoryRoot(workspacePath, location, identity);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "fact.md"), content);
    return path;
  }
  return {
    root,
    project,
    checkout,
    binding,
    service,
    memory,
    memoryRoot,
    queries,
    settings: () => settings,
    setBindings: (value: WorktreeBinding[]) => {
      bindings = value;
    },
  };
}

test("worktree memories in both locations are identified without adding the checkout as a project", async (t) => {
  const f = await fixture(t);
  const roots = await Promise.all([
    f.memory(f.project, "workspace", "project"),
    f.memory(f.checkout, "profile", "worktree profile"),
    f.memory(f.checkout, "workspace", "worktree local"),
  ]);
  const catalog = await f.service.listProjectMemories();
  assert.equal(catalog.length, 3);
  assert.ok(f.queries.includes(f.project));
  for (const [index, root] of roots.entries()) {
    const scope = catalog.find((entry) => entry.memoryRoot === root)!;
    assert.ok(scope);
    if (index > 0) assert.equal(scope.label, "project / lcode/task-memory");
    const read = await f.service.readProjectMemoryFile({
      workspaceId: scope.id,
      fileName: "fact.md",
    });
    assert.equal(read.content, ["project", "worktree profile", "worktree local"][index]);
  }
  f.binding.displayName = "记忆修复";
  const renamed = await f.service.listProjectMemories();
  assert.deepEqual(
    renamed.map((scope) => scope.id).sort(),
    catalog.map((scope) => scope.id).sort(),
  );
  assert.ok(
    renamed
      .filter((scope) => scope.memoryRoot !== roots[0])
      .every((scope) => scope.label === "project / 记忆修复"),
  );
  await assert.rejects(readFile(join(f.project, ".lcode", "memory-state", "owner.json")), {
    code: "ENOENT",
  });
});

test("recent project and repeated binding sources do not duplicate or migrate a worktree twice", async (t) => {
  const f = await fixture(t);
  f.settings().recentProjects.push(f.checkout);
  f.setBindings([f.binding, f.binding]);
  const profile = await f.memory(f.checkout, "profile", "isolated worktree fact");
  const result = await f.service.changeStorageLocation({ location: "workspace" });
  assert.equal(result.copiedCount, 1);
  assert.equal(await readFile(join(profile, "fact.md"), "utf8"), "isolated worktree fact");
  assert.equal(
    await readFile(join(f.memoryRoot(f.checkout, "workspace"), "fact.md"), "utf8"),
    "isolated worktree fact",
  );
  await assert.rejects(readFile(join(f.memoryRoot(f.project, "workspace"), "fact.md")), {
    code: "ENOENT",
  });
  const catalog = await f.service.listProjectMemories();
  assert.equal(catalog.length, 2);
  assert.ok(catalog.every((scope) => scope.label === "project / lcode/task-memory"));
  assert.equal((await f.service.changeStorageLocation({ location: "workspace" })).copiedCount, 0);
});

test("worktree identity roots remain separate and switching location prepares the exact identity", async (t) => {
  const f = await fixture(t);
  f.setBindings([
    { ...f.binding, workspaceIdentity: "scope-A", displayName: "A" },
    { ...f.binding, id: "B", workspaceIdentity: "scope-B", displayName: "B" },
  ]);
  await f.memory(f.checkout, "profile", "A", "scope-A");
  await f.memory(f.checkout, "profile", "B", "scope-B");
  assert.equal((await f.service.changeStorageLocation({ location: "workspace" })).copiedCount, 2);
  const catalog = await f.service.listProjectMemories();
  assert.equal(catalog.length, 4);
  assert.equal(new Set(catalog.map((scope) => scope.memoryRoot)).size, 4);
  for (const scope of catalog) {
    const content = (
      await f.service.readProjectMemoryFile({ workspaceId: scope.id, fileName: "fact.md" })
    ).content;
    assert.equal(scope.label, `project / ${content}`);
  }
  await assert.rejects(readFile(join(f.checkout, ".lcode", "memory", "fact.md")), {
    code: "ENOENT",
  });
});

test("terminal, absent and remote worktree scopes never expose or migrate local lookalike paths", async (t) => {
  const f = await fixture(t);
  await f.memory(f.checkout, "workspace", "must not be scanned");
  for (const status of ["archived", "missing", "cancelled", "deleting", "deleted"] as const) {
    f.setBindings([{ ...f.binding, status }]);
    f.settings().recentProjects = [f.project, f.checkout];
    assert.deepEqual(await f.service.listProjectMemories(), []);
  }
  f.settings().recentProjects = [f.project];
  f.setBindings([{ ...f.binding, workspacePath: join(f.root, "absent") }]);
  assert.deepEqual(await f.service.listProjectMemories(), []);
  const remoteIdentity = buildRemoteWorkspaceIdentity("/project", {
    kind: "docker",
    container: "fixture",
  });
  f.setBindings([{ ...f.binding, workspaceIdentity: remoteIdentity }]);
  assert.deepEqual(await f.service.listProjectMemories(), []);
  f.setBindings([{ ...f.binding, originalWorkspaceIdentity: remoteIdentity }]);
  assert.deepEqual(await f.service.listProjectMemories(), []);
  f.settings().lastWorkspaceSession = [
    {
      kind: "remote",
      workspacePath: f.project,
      target: { kind: "docker", container: "fixture" },
      lastOpenedAt: 1,
      lastConnectionStatus: "connected",
    },
  ];
  f.setBindings([f.binding]);
  f.queries.length = 0;
  assert.deepEqual(await f.service.listProjectMemories(), []);
  assert.ok(!f.queries.includes(f.project));
});

test("worktree directory links and owner query failures propagate through the memory service", async (t) => {
  const f = await fixture(t);
  const link = join(f.root, "linked checkout");
  await symlink(f.checkout, link, process.platform === "win32" ? "junction" : "dir");
  f.setBindings([{ ...f.binding, workspacePath: link }]);
  await assert.rejects(f.service.listProjectMemories(), /link/);
  await assert.rejects(f.service.changeStorageLocation({ location: "workspace" }), /link/);
  const unavailable = createMemoryService({
    settingService: { get: async () => f.settings(), update: async () => {} },
    worktreeService: {
      list: async () => {
        throw new Error("owner unavailable");
      },
      acquireCheckout: async () => {
        throw new Error("unexpected acquire");
      },
      releaseCheckout: async () => {},
    },
  });
  await assert.rejects(unavailable.listProjectMemories(), /owner unavailable/);
  await assert.rejects(
    unavailable.changeStorageLocation({ location: "workspace" }),
    /owner unavailable/,
  );
  assert.equal(f.settings().memoryStorageLocation, "profile");
});

test("migration revalidates the binding under its checkout lease and never recreates a deleted checkout", async (t) => {
  const f = await fixture(t);
  await f.memory(f.checkout, "profile", "preserved profile fact");
  let released = false;
  const service = createMemoryService({
    settingService: {
      get: async () => f.settings(),
      update: async () => {
        throw new Error("unexpected commit");
      },
    },
    worktreeService: {
      list: async ({ workspacePath }) => (workspacePath === f.project ? [f.binding] : []),
      acquireCheckout: async ({ workspacePath, ownerId, mode, waitMs }) => {
        assert.equal(mode, "shared");
        assert.equal(waitMs, 1);
        f.binding.status = "deleted";
        await rm(f.checkout, { recursive: true });
        return { token: "lease", ownerId, workspacePath };
      },
      releaseCheckout: async () => {
        released = true;
      },
    },
  });
  await assert.rejects(
    service.changeStorageLocation({ location: "workspace" }),
    /worktree scope changed/,
  );
  assert.equal(released, true);
  assert.equal(f.settings().memoryStorageLocation, "profile");
  await assert.rejects(readFile(join(f.checkout, ".lcode", "memory", "fact.md")), {
    code: "ENOENT",
  });
});
