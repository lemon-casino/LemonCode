import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectContextSnapshot, formatProjectContextSnapshot } from "./projectContext.js";
test("project scope is explicit without MCP and does not confuse same-path remote projects", () => {
  const local = {
    id: "local",
    name: "Shop",
    primaryFolderPath: "/web",
    sourceFolderPaths: ["/web", "/api"],
  };
  const remote = { ...local, id: "remote", workspaceIdentity: "remote-scope" };
  const settings = {
    localProjects: [local],
    projectDefinitions: { version: 1 as const, projects: [local, remote] },
  };
  const snapshot = buildProjectContextSnapshot(settings, {
    workspacePath: "/web",
    workspaceIdentity: "remote-scope",
  })!;
  assert.equal(snapshot.projectId, "remote");
  assert.deepEqual(
    snapshot.members.map((member) => member.workspacePath),
    ["/web", "/api"],
  );
  assert.match(formatProjectContextSnapshot(snapshot), /\/api/);
  assert.equal(
    buildProjectContextSnapshot(settings, {
      workspacePath: "/web",
      workspaceIdentity: "other-source",
    }),
    null,
  );
  remote.name = "Changed";
  assert.equal(snapshot.name, "Shop");
});
