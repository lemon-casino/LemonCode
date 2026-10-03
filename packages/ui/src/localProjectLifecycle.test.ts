import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings, LocalProject } from "@lcode/shared";
import {
  buildLocalProjectRemovalPatch,
  isWorkspaceReferenceForLocalProject,
} from "./localProjectLifecycle.js";

const project: LocalProject = {
  id: "project-1",
  name: "Suite",
  primaryFolderPath: "C:\\work\\app",
  sourceFolderPaths: ["C:\\work\\app", "C:\\work\\docs"],
};

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    localProjects: [project],
    recentProjects: ["C:\\work\\app", "C:\\work\\docs", "C:\\other"],
    locale: "zh-CN",
    ...overrides,
  } as AppSettings;
}

test("legacy workspace paths still identify their local project", () => {
  assert.equal(
    isWorkspaceReferenceForLocalProject(project, { workspacePath: "c:/work/docs/" }),
    true,
  );
});

test("removal by legacy path cleans project, recents, and persisted local sessions", () => {
  const patch = buildLocalProjectRemovalPatch(
    settings({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: "C:\\work\\app", localProjectId: "project-1" },
        { kind: "local", workspacePath: "C:\\other" },
        {
          kind: "remote",
          workspacePath: "/srv/app",
          target: { kind: "ssh", host: "example.test", username: "dev" },
          lastOpenedAt: 1,
          lastConnectionStatus: "connected",
        },
      ],
      lastActiveTabIndex: 2,
    }),
    { workspacePath: "c:/work/app" },
  );

  assert.deepEqual(patch?.localProjects, []);
  assert.deepEqual(patch?.recentProjects, ["C:\\other"]);
  assert.deepEqual(
    patch?.lastWorkspaceSession?.map((entry) => entry.workspacePath),
    ["C:\\other", "/srv/app"],
  );
  assert.equal(patch?.lastActiveTabIndex, 1);
});

test("only an explicit matching removal request changes the registry", () => {
  const snapshot = settings();
  const patch = buildLocalProjectRemovalPatch(snapshot, {
    projectId: "not-this-project",
    workspacePath: "D:\\other",
  });
  assert.equal(patch, null);
  assert.deepEqual(snapshot.localProjects, [project]);
  assert.equal(snapshot.recentProjects.length, 3);
});
