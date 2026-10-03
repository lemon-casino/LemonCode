import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitReviewWorkspaceState } from "./gitReviewWorkspaceState.js";
import { ProxyChannel } from "@lcode/rpc";

test("Host 审核编辑状态：字段并发、同字段冲突、幂等和重启恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-workspace-"));
  try {
    const host = new GitReviewWorkspaceState(dir);
    const scope = { workspacePath: "/repo", workspaceIdentity: " host/repo ", scopeId: "session" };
    const initial = await host.read(scope);
    const first = await host.update({
      scope,
      commandId: "one",
      expectedFieldRevisions: { excludedFiles: 0 },
      patch: { excludedFiles: Array.from({ length: 10_000 }, (_, i) => `f${i}.ts`) },
    });
    assert.equal(first.status, "accepted");
    if (first.status === "accepted") assert.equal(first.commandRevision, 1);
    const second = await host.update({
      scope,
      commandId: "two",
      expectedFieldRevisions: { browsePosition: 0 },
      patch: { browsePosition: 2 },
    });
    assert.equal(second.status, "accepted");
    assert.equal(second.snapshot.data.excludedFiles.length, 10_000);
    const conflict = await host.update({
      scope,
      commandId: "three",
      expectedFieldRevisions: { excludedFiles: initial.fieldRevisions.excludedFiles },
      patch: { excludedFiles: [] },
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.snapshot.revision, 2);
    const retry = await host.update({
      scope,
      commandId: "one",
      expectedFieldRevisions: { excludedFiles: 0 },
      patch: first.snapshot.data,
    });
    assert.equal(retry.status, "accepted");
    if (retry.status === "accepted") assert.equal(retry.commandRevision, 1);
    assert.equal(retry.snapshot.revision, 2);
    const restarted = new GitReviewWorkspaceState(dir);
    assert.equal((await restarted.read(scope)).data.browsePosition, 2);
    const restartedReceipt = await restarted.update({
      scope,
      commandId: "one",
      expectedFieldRevisions: { excludedFiles: 0 },
      patch: { excludedFiles: [] },
    });
    if (restartedReceipt.status === "accepted") assert.equal(restartedReceipt.commandRevision, 1);
    else assert.fail("accepted receipt must survive restart");
    assert.equal((await host.read({ ...scope, scopeId: "other" })).revision, 0);
    assert.equal((await host.read({ ...scope, workspaceIdentity: "other-host/repo" })).revision, 0);
    await assert.rejects(
      host.update({
        scope,
        commandId: "invalid",
        expectedFieldRevisions: {},
        patch: { browsePosition: 3 },
      }),
    );
    await assert.rejects(
      host.update({
        scope,
        commandId: "unknown",
        expectedFieldRevisions: {},
        patch: { unknown: true },
      } as never),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "桌面持续订阅与手机重连快照复用同一 Host；另一窗口文件事件可达",
  { timeout: 15_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "review-events-"));
    const scope = { workspacePath: "/repo", scopeId: "session" };
    const host = new GitReviewWorkspaceState(dir);
    const channel = ProxyChannel.fromService({
      getReviewWorkspace: (input: typeof scope) => host.read(input),
      updateReviewWorkspace: (input: Parameters<typeof host.update>[0]) => host.update(input),
      onDynamicReviewWorkspace: (input: typeof scope) => host.subscribe(input),
    });
    const client = () =>
      ProxyChannel.toService<{
        getReviewWorkspace: typeof host.read;
        updateReviewWorkspace: typeof host.update;
        onDynamicReviewWorkspace: typeof host.subscribe;
      }>({
        call: (method, args) => channel.call({}, method, args),
        listen: (event, arg) => channel.listen({}, event, arg),
      });
    const desktop = client(),
      phone = client();
    const revisions: number[] = [];
    const live = desktop.onDynamicReviewWorkspace(scope)((snapshot) =>
      revisions.push(snapshot.revision),
    );
    try {
      await phone.updateReviewWorkspace({
        scope,
        commandId: "phone",
        expectedFieldRevisions: { browsePosition: 0 },
        patch: { browsePosition: 1 },
      });
      assert.ok(revisions.includes(1));
      const otherWindow = new GitReviewWorkspaceState(dir);
      const received = new Promise<void>((resolve) => {
        const listener = desktop.onDynamicReviewWorkspace(scope)((snapshot) => {
          if (snapshot.revision === 2) {
            listener.dispose();
            resolve();
          }
        });
        t.after(() => listener.dispose());
      });
      await otherWindow.update({
        scope,
        commandId: "window",
        expectedFieldRevisions: { includeUnstaged: 0 },
        patch: { includeUnstaged: false },
      });
      await received;
      // 手机连接重建直接获取完整新基线，缺失的通知不能回退版本或丢失字段。
      const resumed = await client().getReviewWorkspace(scope);
      assert.equal(resumed.revision, 2);
      assert.equal(resumed.data.browsePosition, 1);
      assert.equal(resumed.data.includeUnstaged, false);
    } finally {
      live.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
