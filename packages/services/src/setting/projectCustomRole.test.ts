import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildProjectContextSnapshot,
  projectMemberRoleSchema,
  projectMemberSchema,
} from "@lcode/shared";
import { createSettingService } from "./settingService.js";

test("custom project roles survive real settings persistence and frozen session context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-custom-role-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const path = join(directory, "api");
    await mkdir(path);
    const result = await createSettingService().mutateProject({
      type: "save",
      projectId: "custom-role",
      expectedRevision: null,
      operationId: "create-role",
      project: {
        id: "custom-role",
        name: "Custom project",
        primaryFolderPath: path,
        sourceFolderPaths: [path],
        members: [
          {
            id: "api",
            path,
            label: "API",
            role: "  数据服务  ",
            description: "接口与持久化",
            enabled: true,
          },
        ],
      },
    });
    assert.equal(result.status, "applied");
    const settings = await createSettingService().get();
    assert.equal(settings.projectDefinitions?.projects[0]?.members?.[0]?.role, "数据服务");
    const snapshot = buildProjectContextSnapshot(settings, { workspacePath: path });
    assert.equal(snapshot?.members[0]?.role, "数据服务");
    assert.equal(projectMemberRoleSchema.safeParse("x".repeat(81)).success, false);
    const purpose = "用".repeat(80) + "\n" + "明".repeat(1000);
    const updated = await createSettingService().mutateProject({
      type: "save",
      projectId: "custom-role",
      expectedRevision: result.project!.revision!,
      operationId: "merge-purpose",
      project: {
        ...result.project!,
        members: result.project!.members!.map((member) => ({
          ...member,
          role: "",
          label: "",
          description: purpose,
        })),
      },
    });
    assert.equal(updated.status, "applied");
    const reopened = await createSettingService().get();
    assert.equal(reopened.localProjects[0]?.members?.[0]?.description, purpose);
    assert.equal(
      buildProjectContextSnapshot(reopened, { workspacePath: path })?.members[0]?.description,
      purpose,
    );
    assert.equal(
      projectMemberSchema.safeParse({ id: "large", path, description: "x".repeat(1201) }).success,
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
