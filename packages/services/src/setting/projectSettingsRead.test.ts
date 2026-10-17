import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createSettingService } from "./settingService.js";

test("first project migration keeps the original file and project mutations fail closed on corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-project-settings-safety-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const folder = join(directory, "source");
    await mkdir(folder);
    const settingsDirectory = join(directory, ".lcode", "v2");
    await mkdir(settingsDirectory, { recursive: true });
    const path = join(settingsDirectory, "setting.json");
    const raw = JSON.stringify({
      localProjects: [
        { id: "p", name: "Before", primaryFolderPath: folder, sourceFolderPaths: [folder] },
      ],
    });
    await writeFile(path, raw);
    const owner = createSettingService();
    const request = {
      type: "save" as const,
      projectId: "p",
      operationId: "edit",
      expectedRevision: 0,
      project: { id: "p", name: "After", primaryFolderPath: folder, sourceFolderPaths: [folder] },
    };
    assert.equal((await owner.mutateProject(request)).status, "applied");
    assert.equal(await readFile(`${path}.before-project-definitions`, "utf8"), raw);
    for (const corrupt of ["{broken", JSON.stringify({ localProjects: [{ id: "broken" }] })]) {
      await writeFile(path, corrupt);
      await assert.rejects(
        owner.mutateProject({ ...request, operationId: "corrupt", expectedRevision: 1 }),
      );
      assert.equal(await readFile(path, "utf8"), corrupt);
      assert.equal(await readFile(`${path}.before-project-definitions`, "utf8"), raw);
    }
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
