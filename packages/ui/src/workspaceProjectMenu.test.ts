import assert from "node:assert/strict";
import test from "node:test";
import type { LocalProject } from "@lcode/shared";
import { buildWorkspaceProjectMenuTabs } from "./workspaceProjectMenu.js";

const projects: LocalProject[] = [
  {
    id: "project-1",
    name: "App suite",
    primaryFolderPath: "C:\\work\\app",
    sourceFolderPaths: ["C:\\work\\app", "C:\\work\\docs"],
  },
];

test("project menu combines persisted projects with legacy and remote workspace tabs", () => {
  const result = buildWorkspaceProjectMenuTabs({
    localProjects: projects,
    workspaceTabs: [
      { workspacePath: "C:\\work\\app", label: "app", localProjectId: "project-1" },
      { workspacePath: "C:\\legacy", label: "legacy" },
      {
        workspacePath: "/srv/app",
        workspaceIdentity: "remote:ssh:host:/srv/app",
        label: "remote",
      },
    ],
  });

  assert.deepEqual(
    result.map((tab) => ({
      path: tab.workspacePath,
      label: tab.label,
      projectId: tab.localProjectId,
    })),
    [
      { path: "C:\\work\\app", label: "App suite", projectId: "project-1" },
      { path: "C:\\legacy", label: "legacy", projectId: undefined },
      { path: "/srv/app", label: "remote", projectId: undefined },
    ],
  );
});

test("closed persisted projects remain selectable and their secondary folders are not duplicated", () => {
  const result = buildWorkspaceProjectMenuTabs({
    localProjects: projects,
    workspaceTabs: [{ workspacePath: "C:\\work\\docs", label: "docs" }],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.label, "App suite");
  assert.equal(result[0]?.workspacePath, "C:\\work\\app");
});
