import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import type { BrowserWindow, MessagePortMain, UtilityProcess } from "electron";
import { buildRemoteWorkspaceIdentity, HostMessageTypes, HostResponseTypes } from "@lcode/shared";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron")
      return {
        url: "data:text/javascript,export const BrowserWindow={getAllWindows(){return []}};export class MessageChannelMain{}",
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { createRemoteWorkspaceSessionManager } = await import("./desktopRemoteSessions.js");

for (const action of ["cancel", "window-close", "shutdown"] as const) {
  test(`WSL identity resolution: ${action} fences a late result before Host dispatch`, async () => {
    let finish!: (value: { kind: "wsl"; distro: string; user: string }) => void;
    let signal: AbortSignal | undefined;
    const identity = new Promise<{ kind: "wsl"; distro: string; user: string }>((resolve) => {
      finish = resolve;
    });
    const messages: { type: string }[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: { type: string }) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: { info() {}, warn() {}, error() {} },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
      resolveWslTarget: (_target, abortSignal?: AbortSignal) => {
        signal = abortSignal;
        return identity;
      },
    });
    const connecting = manager.createRemoteWorkspaceSession(win, { kind: "wsl" }, "request");
    const rejected = assert.rejects(connecting, /取消|关闭|退出/);
    if (action === "cancel")
      manager.cancelPendingRemoteWorkspaceSessionsForWindow(1, "test", "request");
    if (action === "window-close") manager.disposeRemoteWorkspaceSessionsForWindow(1);
    if (action === "shutdown") await manager.disposeAllAndWaitForAppShutdown("test");
    // 先放行旧 resolver，失败实现也能结束，不靠 timeout 判断取消是否生效。
    finish({ kind: "wsl", distro: "TestDistro", user: "tester" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const dispatched = messages.some(
      (message) => message.type === HostMessageTypes.ConnectRemoteWorkspace,
    );
    manager.disposeRemoteWorkspaceSessionsForWindow(1);
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.equal(dispatched, false);
  });
}

for (const connected of [false, true]) {
  test(`cancellation ${connected ? "during provider initialization" : "after dispatch"} disposes late Host sessions`, async () => {
    const messages: { type: string; requestId?: string; remoteSessionId?: string }[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: (typeof messages)[number]) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: { info() {}, warn() {}, error() {} },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
    });
    const result = manager
      .createRemoteWorkspaceSession(win, { kind: "docker", container: "test-container" }, "request")
      .then(
        () => "success",
        (error: Error) => error.message,
      );
    const complete = () =>
      child.emit("message", {
        type: HostResponseTypes.RemoteWorkspaceConnected,
        requestId: "request",
        descriptor: {
          remoteSessionId: "session",
          target: { kind: "docker", container: "test-container" },
          generation: 1,
        },
      });
    if (connected) complete();
    manager.cancelPendingRemoteWorkspaceSessionsForWindow(1, "test", "request");
    if (!connected) complete();
    try {
      assert.ok(
        messages.some(
          (message) =>
            message.type === HostMessageTypes.DisposeRemoteWorkspaceSession &&
            message.remoteSessionId === "session",
        ),
      );
      assert.match(await result, /取消/);
    } finally {
      // 放行 provider owner 的退出；迟到的初始化回调不得再创建 attachment。
      child.emit("exit", 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        messages.filter((message) => message.type === HostMessageTypes.AttachServicePort).length,
        0,
      );
    }
  });
}

for (const cancel of [false, true]) {
  test(`renderer readiness ${cancel ? "cannot revive a cancelled connection" : "publishes the initialized remote session"}`, async () => {
    const messages: {
      type: string;
      requestId?: string;
      environmentKey?: string;
      attachmentId?: string;
      clientMode?: string;
      scope?: unknown;
    }[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      postMessage(message: (typeof messages)[number]) {
        messages.push(message);
      },
    });
    const win = {
      isDestroyed: () => false,
      webContents: { id: 1, isDestroyed: () => false, send() {}, postMessage() {} },
    } as unknown as BrowserWindow;
    const manager = createRemoteWorkspaceSessionManager({
      logger: { info() {}, warn() {}, error() {} },
      windowHostProcessMap: new Map([[1, child as unknown as UtilityProcess]]),
      resolveRemoteAssetDirs: () => ({}),
      createMessageChannel: () => ({ port1: {} as MessagePortMain, port2: {} as MessagePortMain }),
    });
    const target = { kind: "ssh" as const, host: "::1", username: "tester" };
    const workspaceIdentity = buildRemoteWorkspaceIdentity("/project", target);
    const result = manager.createRemoteWorkspaceSession(win, target, "request").then(
      (id) => id,
      (error: Error) => error.message,
    );
    child.emit("message", {
      type: HostResponseTypes.RemoteWorkspaceConnected,
      requestId: "request",
      descriptor: {
        remoteSessionId: "session",
        target,
        workspacePath: "/project",
        workspaceIdentity,
        generation: 1,
      },
    });
    const provision = messages.find(
      (message) => message.type === HostMessageTypes.ProviderProvisioningExecute,
    )!;
    assert.ok(provision);
    child.emit("message", {
      type: HostResponseTypes.ProviderProvisioningExecutionResult,
      requestId: provision.requestId,
      environmentKey: provision.environmentKey,
      status: "applied",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const attachment = messages.find(
      (message) => message.type === HostMessageTypes.AttachServicePort,
    )!;
    assert.ok(attachment);
    assert.equal(attachment.clientMode, "desktop-continuous");
    assert.deepEqual(attachment.scope, {
      kind: "remote",
      remoteSessionId: "session",
      workspacePath: "/project",
      workspaceIdentity,
    });
    if (cancel) manager.cancelPendingRemoteWorkspaceSessionsForWindow(1, "test", "request");
    manager.confirmRendererAttachmentReady(1, {
      sessionId: "session",
      attachmentId: attachment.attachmentId!,
    });
    if (cancel) assert.match(await result, /取消/);
    else assert.equal(await result, "session");
    if (!cancel) manager.disposeRemoteWorkspaceSession("session");
    child.emit("exit", 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      messages.filter((message) => message.type === HostMessageTypes.DisposeRemoteWorkspaceSession)
        .length,
      1,
    );
  });
}
