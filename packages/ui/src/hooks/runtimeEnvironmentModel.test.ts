import assert from "node:assert/strict";
import test from "node:test";
import { runtimeEnvironmentSnapshotSchema } from "@lcode/shared";
import {
  applyEnvironmentSnapshot,
  environmentActionAvailable,
  environmentPreviewAvailability,
  environmentScopeKey,
} from "./runtimeEnvironmentModel.js";

const scope = { workspacePath: "C:/工作树/很长的中文目录", workspaceIdentity: "remote-a" };
const environmentId = "a".repeat(32);
const frame = (stateRevision: number, status = "ready") =>
  runtimeEnvironmentSnapshotSchema.parse({
    protocolVersion: 1,
    scope,
    stateRevision,
    environment: {
      environmentId,
      purpose: "worktree",
      status,
      currentRevision: 2,
      stateRevision,
      tools: [],
      updatedAt: "2026-10-06T00:00:00Z",
    },
  });

test("环境投影按真实 checkout、identity 和 stateRevision 丢弃迟到帧", () => {
  const current = frame(8);
  assert.equal(
    applyEnvironmentSnapshot(current, frame(7, "failed"), scope, environmentId),
    current,
  );
  assert.equal(
    applyEnvironmentSnapshot(
      current,
      { ...frame(9), scope: { ...scope, workspaceIdentity: "remote-b" } },
      scope,
      environmentId,
    ),
    current,
  );
  assert.equal(
    applyEnvironmentSnapshot(
      current,
      { ...frame(9), scope: { ...scope, workspacePath: "C:/另一目录" } },
      scope,
      environmentId,
    ),
    current,
  );
  assert.equal(
    applyEnvironmentSnapshot(
      current,
      { ...frame(9), environment: { ...frame(9).environment!, environmentId: "b".repeat(32) } },
      scope,
      environmentId,
    ),
    current,
  );
  assert.equal(
    applyEnvironmentSnapshot(current, frame(10, "needsUpdate"), scope, environmentId)?.environment
      ?.status,
    "needsUpdate",
  );
  assert.notEqual(
    environmentScopeKey(scope),
    environmentScopeKey({ ...scope, workspacePath: "C:/候选" }),
  );
});

test("snapshot schema 拒绝执行秘密，缺能力和旧协议绝不冒充托管支持", () => {
  assert.equal(
    runtimeEnvironmentSnapshotSchema.safeParse({ ...frame(1), envOverlay: { SECRET: "no" } })
      .success,
    false,
  );
  assert.equal(environmentActionAvailable(undefined, "prepare"), false);
  assert.equal(environmentActionAvailable({ managedEnvironments: true }, "prepare"), false);
  assert.equal(
    environmentActionAvailable(
      { managedEnvironments: true, protocolVersion: 1, actions: ["prepare"] },
      "startService",
    ),
    false,
  );
  assert.equal(
    environmentActionAvailable(
      { managedEnvironments: true, protocolVersion: 1, actions: ["prepare"] },
      "prepare",
    ),
    true,
  );
});

test("预览只允许当前设备可达地址，Web/远端不直开宿主 loopback", () => {
  assert.equal(
    environmentPreviewAvailability("http://localhost:5173", false, false),
    "host-unreachable",
  );
  assert.equal(
    environmentPreviewAvailability("http://127.0.0.1:5173", true, true),
    "host-unreachable",
  );
  assert.equal(
    environmentPreviewAvailability("http://[::1]:5173", false, false),
    "host-unreachable",
  );
  assert.equal(
    environmentPreviewAvailability("http://0.0.0.0:5173", true, false),
    "host-unreachable",
  );
  assert.equal(environmentPreviewAvailability("javascript:alert(1)", true, false), "invalid-url");
  assert.equal(
    environmentPreviewAvailability("https://token:secret@example.test", true, false),
    "invalid-url",
  );
  assert.equal(environmentPreviewAvailability("http://localhost:5173", true, false), null);
  assert.equal(environmentPreviewAvailability("https://preview.example.test", false, true), null);
});
