import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalProject,
  findLocalProjectForWorkspace,
  hasLocalProjectPrimaryFolderConflict,
  normalizeLocalProjectFolderPaths,
} from "./localProjects.js";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";

test("local projects default to an empty registry and accept a validated settings patch", () => {
  assert.deepEqual(appSettingsSchema.parse({}).localProjects, []);
  const project = createLocalProject({
    id: "project-1",
    name: "App suite",
    sourceFolderPaths: ["C:\\work\\app", "C:\\work\\docs"],
  });
  assert.deepEqual(appSettingsPatchSchema.parse({ localProjects: [project] }), {
    localProjects: [project],
  });
});

test("local project creation trims the name and de-duplicates normalized folder paths", () => {
  const project = createLocalProject({
    id: "project-1",
    name: "  App suite  ",
    sourceFolderPaths: ["C:\\work\\app\\", "c:/work/app", "C:\\work\\docs"],
  });

  assert.equal(project.name, "App suite");
  assert.equal(project.primaryFolderPath, "C:\\work\\app");
  assert.deepEqual(project.sourceFolderPaths, ["C:\\work\\app", "C:\\work\\docs"]);
});

test("local project lookup prefers the stable id and otherwise matches the primary folder", () => {
  const projects = [
    createLocalProject({
      id: "project-1",
      name: "App suite",
      sourceFolderPaths: ["C:\\work\\app", "C:\\work\\docs"],
    }),
  ];

  assert.equal(findLocalProjectForWorkspace(projects, "D:\\other", "project-1")?.id, "project-1");
  assert.equal(findLocalProjectForWorkspace(projects, "c:/work/app")?.id, "project-1");
  assert.equal(findLocalProjectForWorkspace(projects, "C:\\work\\docs"), undefined);
  assert.equal(hasLocalProjectPrimaryFolderConflict(projects, "c:/work/app/"), true);
});

test("local project folder normalization rejects empty input and caps the source count", () => {
  assert.throws(() => normalizeLocalProjectFolderPaths([]), /source folder/i);
  assert.throws(
    () =>
      normalizeLocalProjectFolderPaths(
        Array.from({ length: 21 }, (_, index) => `C:\\workspace\\folder-${index}`),
      ),
    /20/,
  );
});
