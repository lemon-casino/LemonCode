import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { createTabStore } from "@/store/tabStore.js";
import {
  executeDesktopWorkspaceReconnect,
  resolveWindowWorkspaceReconnectTarget,
} from "./windowWorkspaceReconnect.js";

test("重连必须精确命中桌面已有 identity/path，手机不能改变桌面焦点", async () => {
  const tabs = createTabStore(null);
  const ssh = { kind: "ssh" as const, host: "fixture.invalid", username: "fixture" };
  const wsl = { kind: "wsl" as const, distro: "Fixture" };
  const identity = buildRemoteWorkspaceIdentity("/same", ssh);
  tabs.getState().ensureWorkspaceTab("/same");
  tabs.getState().ensureWorkspaceTab("/same", { workspaceIdentity: identity, remoteTarget: ssh });
  tabs.getState().ensureWorkspaceTab("/same", {
    workspaceIdentity: buildRemoteWorkspaceIdentity("/same", wsl),
    remoteTarget: wsl,
  });
  const calls: unknown[] = [];
  const reconnect = async (...args: unknown[]) => {
    calls.push(args);
  };
  const target = resolveWindowWorkspaceReconnectTarget(tabs, identity);
  await executeDesktopWorkspaceReconnect({ ...target, requestId: "request" }, tabs, reconnect);
  assert.deepEqual(calls, [
    [
      identity,
      { activateWorkspaceAfterReconnect: false, showErrorToast: false, throwOnFailure: true },
    ],
  ]);
  await assert.rejects(
    executeDesktopWorkspaceReconnect(
      { ...target, workspacePath: "/other", requestId: "wrong" },
      tabs,
      reconnect,
    ),
  );
  assert.throws(() => resolveWindowWorkspaceReconnectTarget(tabs, "/same"));
  assert.throws(() =>
    resolveWindowWorkspaceReconnectTarget(
      tabs,
      buildRemoteWorkspaceIdentity("/same", { kind: "docker", container: "missing" }),
    ),
  );
  assert.equal(calls.length, 1);
  tabs.setState({ tabs: [] });
  await assert.rejects(
    executeDesktopWorkspaceReconnect({ ...target, requestId: "removed" }, tabs, reconnect),
  );
  assert.equal(calls.length, 1);
});
