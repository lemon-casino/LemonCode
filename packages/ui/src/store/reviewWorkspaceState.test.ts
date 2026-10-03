import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitReviewWorkspaceSnapshot, type GitReviewWorkspaceUpdate } from "@lcode/shared";
import { Emitter } from "@lcode/rpc";
import type { IGitService } from "@lcode/services";
import { ReviewWorkspaceProjectionStore } from "./reviewWorkspaceState.js";

test("双端草稿/排除/阶段同步、冲突和断线后同命令恢复", async () => {
  const scope = { workspacePath: "/repo", scopeId: "session" };
  let snapshot = createGitReviewWorkspaceSnapshot(scope);
  const event = new Emitter<typeof snapshot>();
  const commands = new Map<string, number>();
  let dropResponse = false;
  const service = {
    getReviewWorkspace: async () => structuredClone(snapshot),
    onDynamicReviewWorkspace: () => event.event,
    updateReviewWorkspace: async (command: GitReviewWorkspaceUpdate) => {
      if (commands.has(command.commandId))
        return {
          status: "accepted",
          commandRevision: commands.get(command.commandId)!,
          snapshot: structuredClone(snapshot),
        };
      const fields = Object.keys(command.patch) as (keyof typeof command.patch)[];
      if (
        fields.some(
          (field) => command.expectedFieldRevisions[field] !== snapshot.fieldRevisions[field],
        )
      )
        return { status: "conflict", snapshot: structuredClone(snapshot) };
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        lastCommandId: command.commandId,
        data: { ...snapshot.data, ...command.patch },
        fieldRevisions: {
          ...snapshot.fieldRevisions,
          ...Object.fromEntries(fields.map((field) => [field, snapshot.revision + 1])),
        },
      };
      commands.set(command.commandId, snapshot.revision);
      event.fire(structuredClone(snapshot));
      if (dropResponse) {
        dropResponse = false;
        throw new Error("offline after accepted");
      }
      return {
        status: "accepted",
        commandRevision: snapshot.revision,
        snapshot: structuredClone(snapshot),
      };
    },
  } as unknown as IGitService;
  const desktop = new ReviewWorkspaceProjectionStore(service, scope);
  const phone = new ReviewWorkspaceProjectionStore(service, scope);
  const d = desktop.subscribe(() => {}),
    p = phone.subscribe(() => {});
  try {
    await Promise.all([desktop.flush(), phone.flush()]);
    desktop.patch({
      draft: {
        message: "desktop",
        previousMessage: "old",
        edited: true,
        requiresRegeneration: false,
      },
    });
    await desktop.flush();
    assert.equal(phone.getSnapshot().data.draft.message, "desktop");
    assert.equal(desktop.getSnapshot().remoteFieldRevisions.draft, 0);
    assert.equal(phone.getSnapshot().remoteFieldRevisions.draft, snapshot.revision);
    phone.patch({ excludedFiles: ["a.ts"], worktreeView: { key: "operation/2", stage: 1 } });
    await phone.flush();
    assert.deepEqual(desktop.getSnapshot().data.excludedFiles, ["a.ts"]);
    assert.equal(desktop.getSnapshot().data.worktreeView?.stage, 1);
    dropResponse = true;
    phone.patch({ browsePosition: 2 });
    await assert.rejects(phone.flush());
    const revision = snapshot.revision;
    await phone.retry();
    assert.equal(phone.getSnapshot().status, "ready");
    assert.equal(snapshot.revision, revision);
    // 模拟离线端仍持有旧字段版本，Host 已接受其它设备的相同字段编辑。
    const detached = new ReviewWorkspaceProjectionStore(service, scope);
    const stop = detached.subscribe(() => {});
    await detached.flush();
    stop();
    desktop.patch({ excludedFiles: ["b.ts"] });
    await desktop.flush();
    detached.patch({ excludedFiles: ["local.ts"] });
    await assert.rejects(detached.flush());
    assert.equal(detached.getSnapshot().status, "conflict");
    assert.deepEqual(detached.getSnapshot().data.excludedFiles, ["local.ts"]);
    assert.deepEqual(snapshot.data.excludedFiles, ["b.ts"]);
    detached.resolve(true);
    await detached.flush();
    assert.deepEqual(desktop.getSnapshot().data.excludedFiles, ["local.ts"]);
  } finally {
    d();
    p();
    event.dispose();
  }
});

test("遗漏通知和回执丢失：本端回执不能掩盖远端修改或重设后续编辑版本", async () => {
  const scope = { workspacePath: "/repo", scopeId: "lost-events" };
  let snapshot = createGitReviewWorkspaceSnapshot(scope);
  const receipts = new Map<string, number>();
  let release: (() => void) | undefined;
  let accepted: (() => void) | undefined;
  let loseResponse = false;
  const service = {
    getReviewWorkspace: async () => structuredClone(snapshot),
    onDynamicReviewWorkspace: () => () => ({ dispose() {} }),
    updateReviewWorkspace: async (command: GitReviewWorkspaceUpdate) => {
      const receipt = receipts.get(command.commandId);
      if (receipt)
        return {
          status: "accepted",
          commandRevision: receipt,
          snapshot: structuredClone(snapshot),
        };
      const fields = Object.keys(command.patch) as (keyof typeof command.patch)[];
      if (
        fields.some(
          (field) => command.expectedFieldRevisions[field] !== snapshot.fieldRevisions[field],
        )
      )
        return { status: "conflict", snapshot: structuredClone(snapshot) };
      const revision = snapshot.revision + 1;
      snapshot = {
        ...snapshot,
        revision,
        lastCommandId: command.commandId,
        fieldRevisions: {
          ...snapshot.fieldRevisions,
          ...Object.fromEntries(fields.map((field) => [field, revision])),
        },
        data: { ...snapshot.data, ...command.patch },
      };
      receipts.set(command.commandId, revision);
      if (loseResponse) {
        loseResponse = false;
        await new Promise<void>((resolve) => {
          release = resolve;
          accepted?.();
        });
        throw new Error("accepted response lost");
      }
      return { status: "accepted", commandRevision: revision, snapshot: structuredClone(snapshot) };
    },
  } as unknown as IGitService;
  const desktop = new ReviewWorkspaceProjectionStore(service, scope);
  const stop = desktop.subscribe(() => {});
  try {
    await desktop.flush();
    await service.updateReviewWorkspace({
      scope,
      commandId: "missed-phone-draft",
      expectedFieldRevisions: { draft: 0 },
      patch: {
        draft: {
          message: "phone",
          previousMessage: null,
          edited: true,
          requiresRegeneration: false,
        },
      },
    });
    desktop.patch({ excludedFiles: ["local-first.ts"] });
    await desktop.flush();
    assert.equal(desktop.getSnapshot().data.draft.message, "phone");
    assert.equal(desktop.getSnapshot().remoteFieldRevisions.draft, 1);
    assert.equal(desktop.getSnapshot().remoteFieldRevisions.excludedFiles, 0);

    loseResponse = true;
    const firstAccepted = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    desktop.patch({ excludedFiles: ["local-accepted.ts"] });
    await firstAccepted;
    desktop.patch({ excludedFiles: ["local-queued.ts"] });
    await service.updateReviewWorkspace({
      scope,
      commandId: "phone-after-local",
      expectedFieldRevisions: { excludedFiles: 3 },
      patch: { excludedFiles: ["phone-new.ts"] },
    });
    release!();
    await assert.rejects(desktop.flush());
    await desktop.retry();
    assert.equal(desktop.getSnapshot().status, "conflict");
    assert.deepEqual(snapshot.data.excludedFiles, ["phone-new.ts"]);
    assert.deepEqual(desktop.getSnapshot().data.excludedFiles, ["local-queued.ts"]);
    assert.equal(desktop.getSnapshot().remoteFieldRevisions.excludedFiles, 4);
    desktop.resolve(false);
    assert.equal(desktop.getSnapshot().status, "ready");
    assert.deepEqual(desktop.getSnapshot().data.excludedFiles, ["phone-new.ts"]);
  } finally {
    stop();
  }
});
