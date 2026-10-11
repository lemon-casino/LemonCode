import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { appSettingsSchema, type AppSettings } from "@lcode/shared";
import { prepareProjectMemoryStorage } from "@lcode/shared/node";
import { createMemoryService } from "./memoryService.js";
import { getLCodeDataRootDir, setDataBaseDir } from "../paths.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-location-service-"));
  setDataBaseDir(directory);
  const workspace = join(directory, "project");
  await mkdir(workspace);
  const hash = createHash("sha256")
    .update(process.platform === "win32" ? workspace.toLowerCase() : workspace)
    .digest("hex")
    .slice(0, 16);
  const profile = join(
    getLCodeDataRootDir(),
    "cli",
    "memories",
    "projects",
    `project-${hash}`,
    "memory",
  );
  const local = join(workspace, ".lcode", "memory");
  let settings = {
    ...appSettingsSchema.parse({ recentProjects: [workspace] }),
    memoryStorageLocation: "profile",
  } as AppSettings;
  let rejectUpdate = false;
  const service = createMemoryService({
    settingService: {
      get: async () => settings,
      update: async (patch: Partial<AppSettings>) => {
        if (rejectUpdate) throw new Error("injected settings write failure");
        settings = { ...settings, ...patch };
      },
    },
  });
  return {
    directory,
    workspace,
    profile,
    local,
    service,
    settings: () => settings,
    rejectUpdate: (value = true) => {
      rejectUpdate = value;
    },
    cleanup: async () => {
      setDataBaseDir(null);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("switch copies nested memory and keeps both catalogs readable after reopening service", async () => {
  const h = await fixture();
  try {
    await mkdir(join(h.profile, "topics"), { recursive: true });
    await writeFile(join(h.profile, "topics", "workflow.md"), "confirmed project workflow");
    await writeFile(join(h.profile, "MEMORY.md"), "topics/workflow.md");
    const changed = await h.service.changeStorageLocation({ location: "workspace" });
    assert.equal(changed.copiedCount, 2);
    assert.equal(changed.conflictCount, 0);
    assert.equal(h.settings().memoryStorageLocation, "workspace");
    assert.equal(
      await readFile(join(h.profile, "topics", "workflow.md"), "utf8"),
      "confirmed project workflow",
    );
    assert.equal(
      await readFile(join(h.local, "topics", "workflow.md"), "utf8"),
      "confirmed project workflow",
    );
    const reopened = createMemoryService({
      settingService: { get: async () => h.settings(), update: async () => {} },
    });
    const catalog = await reopened.listProjectMemories();
    assert.deepEqual(catalog.map((entry) => entry.storageLocation).sort(), [
      "profile",
      "workspace",
    ]);
    const target = catalog.find((entry) => entry.storageLocation === "workspace")!;
    assert.equal(
      (
        await reopened.readProjectMemoryFile({
          workspaceId: target.id,
          fileName: "topics/workflow.md",
        })
      ).content,
      "confirmed project workflow",
    );
    await assert.rejects(
      reopened.readProjectMemoryFile({
        workspaceId: target.id,
        fileName: "../storage-location.json",
      }),
    );
    await assert.rejects(
      reopened.readProjectMemoryFile({
        workspaceId: `workspace:${basename(h.workspace)}`,
        fileName: "MEMORY.md",
      }),
    );
    assert.equal((await h.service.changeStorageLocation({ location: "workspace" })).copiedCount, 0);
  } finally {
    await h.cleanup();
  }
});

test("switch preserves target conflicts and copies new project topics back to profile", async () => {
  const h = await fixture();
  try {
    await mkdir(h.profile, { recursive: true });
    await mkdir(h.local, { recursive: true });
    await writeFile(join(h.profile, "fact.md"), "source version");
    await writeFile(join(h.local, "fact.md"), "target version");
    const changed = await h.service.changeStorageLocation({ location: "workspace" });
    assert.equal(changed.conflictCount, 1);
    assert.equal(await readFile(join(h.local, "fact.md"), "utf8"), "target version");
    await writeFile(join(h.local, "new.md"), "new fact");
    const back = await h.service.changeStorageLocation({ location: "profile" });
    assert.equal(back.copiedCount, 1);
    assert.equal(await readFile(join(h.profile, "fact.md"), "utf8"), "source version");
    assert.equal(await readFile(join(h.profile, "new.md"), "utf8"), "new fact");
  } finally {
    await h.cleanup();
  }
});

test("failed setting commit retains old location and never removes source", async () => {
  const h = await fixture();
  try {
    await mkdir(h.profile, { recursive: true });
    await writeFile(join(h.profile, "fact.md"), "original");
    h.rejectUpdate();
    await assert.rejects(
      h.service.changeStorageLocation({ location: "workspace" }),
      /settings write failure/,
    );
    assert.equal(h.settings().memoryStorageLocation, "profile");
    assert.equal(await readFile(join(h.profile, "fact.md"), "utf8"), "original");
    await assert.rejects(h.service.changeStorageLocation({ location: "elsewhere" as "profile" }));
  } finally {
    await h.cleanup();
  }
});

test("catalog and migration reject project directory links without exposing external memory", async () => {
  const h = await fixture();
  try {
    const outside = join(h.directory, "outside");
    await mkdir(join(outside, "memory"), { recursive: true });
    await writeFile(join(outside, "memory", "private.md"), "outside content");
    await symlink(
      outside,
      join(h.workspace, ".lcode"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(h.service.listProjectMemories(), /directory|link|path/i);
    await assert.rejects(h.service.changeStorageLocation({ location: "workspace" }));
    assert.equal(h.settings().memoryStorageLocation, "profile");
  } finally {
    await h.cleanup();
  }
});

test("remote session paths in recent projects are never scanned or copied locally", async () => {
  const h = await fixture();
  try {
    h.settings().lastWorkspaceSession = [
      {
        kind: "remote",
        workspacePath: h.workspace,
        target: { kind: "docker", container: "fixture" },
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
      },
    ];
    await mkdir(h.profile, { recursive: true });
    await writeFile(join(h.profile, "fact.md"), "local profile remains readable");
    const changed = await h.service.changeStorageLocation({ location: "workspace" });
    assert.equal(changed.copiedCount, 0);
    await assert.rejects(readFile(join(h.local, "fact.md")), { code: "ENOENT" });
    assert.deepEqual(
      (await h.service.listProjectMemories()).map((entry) => entry.storageLocation),
      ["profile"],
    );
  } finally {
    await h.cleanup();
  }
});

test("empty project can select project storage without manufacturing remembered facts", async () => {
  const h = await fixture();
  try {
    assert.deepEqual(await h.service.changeStorageLocation({ location: "workspace" }), {
      location: "workspace",
      copiedCount: 0,
      conflictCount: 0,
    });
    assert.equal(h.settings().memoryStorageLocation, "workspace");
    assert.deepEqual(await h.service.listProjectMemories(), []);
  } finally {
    await h.cleanup();
  }
});

test("retry after setting failure copies new source files written while the old setting remained active", async () => {
  const h = await fixture();
  try {
    await mkdir(h.profile, { recursive: true });
    await writeFile(join(h.profile, "first.md"), "first fact");
    h.rejectUpdate();
    await assert.rejects(
      h.service.changeStorageLocation({ location: "workspace" }),
      /settings write failure/,
    );
    assert.equal(h.settings().memoryStorageRevision ?? 0, 0);
    await writeFile(join(h.profile, "later.md"), "new fact while profile remained active");
    h.rejectUpdate(false);
    const retried = await h.service.changeStorageLocation({ location: "workspace" });
    assert.equal(retried.copiedCount, 1);
    assert.equal(h.settings().memoryStorageLocation, "workspace");
    assert.equal(h.settings().memoryStorageRevision, 1);
    assert.equal(
      await readFile(join(h.local, "later.md"), "utf8"),
      "new fact while profile remained active",
    );
    await rm(join(h.local, "first.md"));
    assert.equal((await h.service.changeStorageLocation({ location: "workspace" })).copiedCount, 0);
    await assert.rejects(readFile(join(h.local, "first.md")), { code: "ENOENT" });
  } finally {
    await h.cleanup();
  }
});

test("committed setting revisions fence delayed old runtimes in both switch directions", async () => {
  const h = await fixture();
  try {
    await mkdir(h.profile, { recursive: true });
    await writeFile(join(h.profile, "first.md"), "first fact");
    const input = {
      workspacePath: h.workspace,
      cliStorageRoot: join(getLCodeDataRootDir(), "cli"),
    };
    await h.service.changeStorageLocation({ location: "workspace" });
    assert.equal(h.settings().memoryStorageRevision, 1);
    await rm(join(h.local, "first.md"));
    await prepareProjectMemoryStorage({ ...input, storageLocation: "profile", storageRevision: 0 });
    assert.equal(
      (
        await prepareProjectMemoryStorage({
          ...input,
          storageLocation: "workspace",
          storageRevision: 1,
        })
      ).copiedCount,
      0,
    );
    await assert.rejects(readFile(join(h.local, "first.md")), { code: "ENOENT" });

    await writeFile(join(h.local, "second.md"), "second fact");
    await h.service.changeStorageLocation({ location: "profile" });
    assert.equal(h.settings().memoryStorageRevision, 2);
    await rm(join(h.profile, "second.md"));
    await prepareProjectMemoryStorage({
      ...input,
      storageLocation: "workspace",
      storageRevision: 1,
    });
    assert.equal(
      (
        await prepareProjectMemoryStorage({
          ...input,
          storageLocation: "profile",
          storageRevision: 2,
        })
      ).copiedCount,
      0,
    );
    await assert.rejects(readFile(join(h.profile, "second.md")), { code: "ENOENT" });
    await h.service.changeStorageLocation({ location: "profile" });
    assert.equal(h.settings().memoryStorageRevision, 2);
  } finally {
    await h.cleanup();
  }
});

test("exhausted setting revision rejects a switch before copying files", async () => {
  const h = await fixture();
  try {
    h.settings().memoryStorageRevision = Number.MAX_SAFE_INTEGER;
    await mkdir(h.profile, { recursive: true });
    await writeFile(join(h.profile, "fact.md"), "source remains untouched");
    await assert.rejects(h.service.changeStorageLocation({ location: "workspace" }), /revision/i);
    await assert.rejects(readFile(join(h.local, "fact.md")), { code: "ENOENT" });
    assert.equal(await readFile(join(h.profile, "fact.md"), "utf8"), "source remains untouched");
    assert.equal(h.settings().memoryStorageLocation, "profile");
  } finally {
    await h.cleanup();
  }
});

test("catalog keeps opaque local identity roots separate under the same project", async () => {
  const h = await fixture();
  try {
    for (const [identity, content] of [
      ["1111111111111111", "scope A"],
      ["2222222222222222", "scope B"],
    ]) {
      const memory = join(h.workspace, ".lcode", "memories", identity!, "memory");
      await mkdir(memory, { recursive: true });
      await writeFile(join(memory, "same.md"), content!);
    }
    const catalog = await h.service.listProjectMemories();
    assert.equal(catalog.length, 2);
    assert.notEqual(catalog[0]!.id, catalog[1]!.id);
    const contents = await Promise.all(
      catalog.map(
        async (scope) =>
          (await h.service.readProjectMemoryFile({ workspaceId: scope.id, fileName: "same.md" }))
            .content,
      ),
    );
    assert.deepEqual(contents.sort(), ["scope A", "scope B"]);
  } finally {
    await h.cleanup();
  }
});

test("multi-folder project copies memory only into its primary folder", async () => {
  const h = await fixture();
  try {
    const secondary = join(h.directory, "secondary");
    await mkdir(secondary);
    h.settings().recentProjects = [];
    h.settings().localProjects = [
      {
        id: "multi",
        name: "multi-folder project",
        primaryFolderPath: h.workspace,
        sourceFolderPaths: [h.workspace, secondary],
      },
    ];
    await mkdir(h.profile, { recursive: true });
    await writeFile(join(h.profile, "shared-project.md"), "facts for this whole project");
    const result = await h.service.changeStorageLocation({ location: "workspace" });
    assert.equal(result.copiedCount, 1);
    assert.equal(
      await readFile(join(h.local, "shared-project.md"), "utf8"),
      "facts for this whole project",
    );
    await assert.rejects(readFile(join(secondary, ".lcode", "memory", "shared-project.md")), {
      code: "ENOENT",
    });
    assert.equal(
      (await h.service.listProjectMemories()).filter(
        (entry) => entry.storageLocation === "workspace",
      ).length,
      1,
    );
  } finally {
    await h.cleanup();
  }
});
