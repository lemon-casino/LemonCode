import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSettingService } from "./settingService.js";

test("project commands persist member identity, CAS, replay and unrelated settings under two owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-project-editor-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const front = join(directory, "frontend");
    const back = join(directory, "backend");
    await Promise.all([mkdir(front), mkdir(back)]);
    const first = createSettingService();
    const second = createSettingService();
    const create = {
      type: "save" as const,
      operationId: "create",
      projectId: "shop",
      expectedRevision: null,
      project: {
        id: "shop",
        name: "商城",
        primaryFolderPath: front,
        sourceFolderPaths: [front, back],
      },
    };
    const saved = await first.mutateProject(create);
    assert.equal(saved.status, "applied");
    assert.equal(saved.project?.revision, 1);
    assert.equal(saved.project?.members?.length, 2);
    assert.deepEqual(await createSettingService().mutateProject(create), saved);
    await assert.rejects(
      first.mutateProject({ ...create, project: { ...create.project, name: "reuse" } }),
      /reused/,
    );
    const updates = await Promise.all(
      [first, second].map((owner, i) =>
        owner.mutateProject({
          ...create,
          operationId: `edit-${i}`,
          expectedRevision: 1,
          project: { ...saved.project!, name: `Name ${i}` },
        }),
      ),
    );
    assert.deepEqual(updates.map((result) => result.status).sort(), ["applied", "conflict"]);
    const latest = (await first.get()).projectDefinitions!.projects[0]!;
    assert.deepEqual(latest.members, saved.project?.members);
    const badPrimary = await second.mutateProject({
      ...create,
      operationId: "primary",
      expectedRevision: 2,
      project: { ...latest, primaryFolderPath: back, sourceFolderPaths: [back, front] },
    });
    assert.equal(badPrimary.status, "validation_failed");
    const missing = await second.mutateProject({
      ...create,
      operationId: "missing",
      expectedRevision: 2,
      project: {
        ...latest,
        sourceFolderPaths: [front, back, join(directory, "missing")],
        members: undefined,
        memberOrder: undefined,
      },
    });
    assert.equal(missing.status, "validation_failed");
    await first.update({ recentProjects: [front] });
    await assert.rejects(first.update({ localProjects: [] }), /project command/i);
    await second.mutateProject({
      type: "remove",
      projectId: "shop",
      expectedRevision: 2,
      operationId: "remove",
    });
    const settings = await first.get();
    assert.equal(settings.localProjects.length, 0);
    assert.equal(settings.projectDefinitions?.projects.length, 0);
    assert.equal(settings.recentProjects.includes(front), false);
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote definitions with identical paths retain separate identities and local projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-remote-project-editor-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const owner = createSettingService();
    for (const id of ["remote-a", "remote-b"])
      assert.equal(
        (
          await owner.mutateProject({
            type: "save",
            operationId: id,
            expectedRevision: null,
            projectId: id,
            project: {
              id,
              name: id,
              primaryFolderPath: "/data",
              sourceFolderPaths: ["/data", "/api"],
              workspaceIdentity: id,
            },
          })
        ).status,
        "applied",
      );
    const settings = await createSettingService().get();
    assert.equal(settings.localProjects.length, 0);
    assert.equal(settings.projectDefinitions?.projects.length, 2);
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
