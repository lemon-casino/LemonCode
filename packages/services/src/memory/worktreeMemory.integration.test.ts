import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { appSettingsSchema, type AppSettings } from "@lcode/shared";
import { resolveProjectMemoryRoot } from "@lcode/shared/node";
import { createWorktreeService, type WorktreeGitPort } from "../worktree/node.js";
import { getLCodeDataRootDir, setDataBaseDir } from "../paths.js";
import { createMemoryService } from "./memoryService.js";

test(
  "real worktree owner discovers a nested project's memories in a frozen custom checkout location",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "worktree-memory-owner-"));
    setDataBaseDir(directory);
    t.after(async () => {
      setDataBaseDir(null);
      await rm(directory, { recursive: true, force: true });
    });
    const execute = promisify(execFile);
    const git: WorktreeGitPort = {
      run: async ({ cwd, args, stdin, env: gitEnv }) => {
        try {
          const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
          );
          const pending = execute("git", args, {
            cwd,
            windowsHide: true,
            env: {
              ...env,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: join(directory, "empty-config"),
              ...gitEnv,
            },
          });
          pending.child.stdin?.end(stdin);
          const { stdout, stderr } = await pending;
          return { stdout, stderr, exitCode: 0 };
        } catch (error) {
          const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
          if (typeof failure.code !== "number") throw error;
          return {
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
            exitCode: failure.code,
          };
        }
      },
    };
    async function command(cwd: string, ...args: string[]) {
      const result = await git.run({ cwd, args });
      assert.equal(result.exitCode, 0, result.stderr);
    }
    await command(directory, "init", "--initial-branch=main", "repository");
    const repo = join(directory, "repository");
    const project = join(repo, "nested project");
    await mkdir(project);
    await writeFile(join(project, "file.txt"), "baseline");
    await command(repo, "config", "user.name", "Memory Fixture");
    await command(repo, "config", "user.email", "fixture@example.invalid");
    await command(repo, "add", ".");
    await command(repo, "commit", "-m", "baseline");
    const options = { dataDir: join(directory, "managed"), git };
    const owner = createWorktreeService(options);
    await owner.updateManagementSettings({
      rootLocation: "custom",
      rootDirectory: join(directory, "custom trees"),
    });
    const binding = await owner.prepare({
      workspacePath: project,
      taskId: "memory",
      requestId: "memory",
      setupCommands: [],
    });
    assert.notEqual(binding.workspacePath, binding.checkoutPath);
    await owner.rename({ bindingId: binding.id, displayName: "nested memory" });
    // 修改未来分配位置之后，识别仍须消费既有绑定冻结路径。
    await owner.updateManagementSettings({ rootLocation: "project" });
    let settings: AppSettings = appSettingsSchema.parse({ recentProjects: [project] });
    const service = createMemoryService({
      settingService: {
        get: async () => settings,
        update: async (patch: Partial<AppSettings>) => {
          settings = { ...settings, ...patch };
        },
      },
      worktreeService: createWorktreeService(options),
    });
    const input = {
      cliStorageRoot: join(getLCodeDataRootDir(), "cli"),
      workspacePath: binding.workspacePath,
    };
    const profile = resolveProjectMemoryRoot(input);
    const local = resolveProjectMemoryRoot({ ...input, storageLocation: "workspace" });
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "fact.md"), "nested worktree fact");
    const writer = await owner.acquireCheckout({
      workspacePath: binding.checkoutPath,
      ownerId: "lifecycle-writer",
    });
    try {
      await assert.rejects(
        service.changeStorageLocation({ location: "workspace" }),
        /Checkout is busy/,
      );
      assert.equal(settings.memoryStorageLocation, "profile");
      await assert.rejects(readFile(join(local, "fact.md")), { code: "ENOENT" });
    } finally {
      await owner.releaseCheckout({ token: writer.token, ownerId: writer.ownerId });
    }
    assert.equal((await service.changeStorageLocation({ location: "workspace" })).copiedCount, 1);
    const catalog = await service.listProjectMemories();
    assert.equal(catalog.length, 2);
    assert.ok(catalog.every((scope) => scope.label === "nested project / nested memory"));
    assert.deepEqual(catalog.map((scope) => scope.memoryRoot).sort(), [local, profile].sort());
    const scope = catalog.find((entry) => entry.storageLocation === "workspace")!;
    assert.equal(
      (await service.readProjectMemoryFile({ workspaceId: scope.id, fileName: "fact.md" })).content,
      "nested worktree fact",
    );
    await assert.rejects(readFile(join(binding.checkoutPath, ".lcode", "memory", "fact.md")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(project, ".lcode", "memory", "fact.md")), {
      code: "ENOENT",
    });
    await writeFile(join(local, "later.md"), "new worktree fact");
    assert.equal((await service.changeStorageLocation({ location: "profile" })).copiedCount, 1);
    assert.equal(await readFile(join(profile, "later.md"), "utf8"), "new worktree fact");
    assert.equal(await readFile(join(local, "later.md"), "utf8"), "new worktree fact");
    await owner.archive({ bindingId: binding.id, requestId: "archive-memory" });
    assert.deepEqual(
      (await service.listProjectMemories()).map((entry) => entry.storageLocation),
      ["profile"],
    );
    await assert.rejects(
      service.readProjectMemoryFile({ workspaceId: scope.id, fileName: "fact.md" }),
      /Unknown/,
    );
  },
);
