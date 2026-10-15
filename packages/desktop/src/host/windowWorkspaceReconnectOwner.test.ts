import assert from "node:assert/strict";
import test from "node:test";
import { Event, ProxyChannel } from "@lcode/rpc";
import { RemoteServiceAccess } from "@lcode/client";
import {
  buildRemoteWorkspaceIdentity,
  WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE,
  type WindowWorkspaceReconnectRequest,
} from "@lcode/shared";
import { createWindowWorkspaceReconnectOwner } from "./windowWorkspaceReconnectOwner.js";
import { createWindowWorkspaceAttachmentService } from "./windowWorkspaceAttachmentService.js";

const targets = [
  { kind: "ssh" as const, host: "fixture.invalid", username: "fixture" },
  { kind: "wsl" as const, distro: "Fixture" },
  { kind: "docker" as const, container: "fixture" },
].map((target) => ({
  workspacePath: "/same",
  workspaceIdentity: buildRemoteWorkspaceIdentity("/same", target),
}));

function fixture() {
  let id = 0;
  const owner = createWindowWorkspaceReconnectOwner(() => `request-${++id}`);
  const attachment = (trusted: boolean) => {
    const host = createWindowWorkspaceAttachmentService({
      reconnectOwner: owner,
      canHandleReconnect: trusted,
      getCatalog: () => [],
      onCatalogChanged: Event.None,
      resolveScope: () => ({}),
      createChannels: () => ({
        channels: new Map(),
        dispose() {},
        setTransportFlowState: async () => {},
      }),
    });
    const channel = ProxyChannel.fromService(host.service);
    const client = new RemoteServiceAccess({
      getChannel: () =>
        ({
          call: (command: string, args?: unknown[]) => channel.call("test", command, args),
          listen: (event: string, arg?: unknown) => channel.listen("test", event, arg),
        }) as never,
    }).windowWorkspaceService;
    return { host, client };
  };
  return { owner, attachment };
}

test("真实 RPC 同窗口多设备同 identity 合并，SSH/WSL/Docker 同路径仍独立", async () => {
  const f = fixture();
  const desktop = f.attachment(true);
  const phone = f.attachment(false);
  const otherPhone = f.attachment(false);
  const requests: WindowWorkspaceReconnectRequest[] = [];
  const listener = desktop.client.onDynamicReconnectRequested()((request) =>
    requests.push(request),
  );
  const operations = targets.map((target) => phone.client.requestReconnect(target));
  const duplicate = otherPhone.client.requestReconnect(targets[0]!);
  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map(({ workspaceIdentity }) => workspaceIdentity),
    targets.map((target) => target.workspaceIdentity),
  );
  for (const request of requests)
    assert.equal(
      await desktop.client.completeReconnect({ requestId: request.requestId, ok: true }),
      true,
    );
  await Promise.all([...operations, duplicate]);
  listener.dispose();
  desktop.host.dispose();
  phone.host.dispose();
  otherPhone.host.dispose();
  f.owner.dispose();
});

test("Web 不能冒充桌面处理者或伪造结果，输入拒绝新 target/本地 scope/多余字段", async () => {
  const f = fixture();
  const desktop = f.attachment(true);
  const phone = f.attachment(false);
  const requests: WindowWorkspaceReconnectRequest[] = [];
  desktop.client.onDynamicReconnectRequested()((request) => requests.push(request));
  assert.throws(() => phone.client.onDynamicReconnectRequested()(() => {}), /unavailable/);
  const operation = phone.client.requestReconnect(targets[0]!);
  await assert.rejects(
    phone.client.completeReconnect({ requestId: requests[0]!.requestId, ok: true }),
    /unavailable/,
  );
  for (const target of [
    { ...targets[0], target: { kind: "docker", container: "not-existing" } },
    { ...targets[0], remoteSessionId: "forged" },
    { workspacePath: "/same", workspaceIdentity: "/same" },
    { workspacePath: "", workspaceIdentity: targets[0]!.workspaceIdentity },
  ])
    await assert.rejects(phone.client.requestReconnect(target as never));
  assert.equal(requests.length, 1);
  await desktop.client.completeReconnect({ requestId: requests[0]!.requestId, ok: true });
  await operation;
  desktop.host.dispose();
  phone.host.dispose();
  f.owner.dispose();
});

test("桌面处理者退出/换代立即拒绝旧 RPC，旧结果不能结算新请求", async () => {
  const f = fixture();
  const phone = f.attachment(false);
  await assert.rejects(
    phone.client.requestReconnect(targets[0]!),
    new RegExp(WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE),
  );
  const old = f.attachment(true);
  const requests: WindowWorkspaceReconnectRequest[] = [];
  old.client.onDynamicReconnectRequested()((request) => requests.push(request));
  const operation = phone.client.requestReconnect(targets[0]!);
  const rejected = assert.rejects(operation, new RegExp(WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE));
  const next = f.attachment(true);
  next.client.onDynamicReconnectRequested()((request) => requests.push(request));
  await rejected;
  const fresh = phone.client.requestReconnect(targets[0]!);
  assert.equal(
    await old.client.completeReconnect({ requestId: requests[1]!.requestId, ok: true }),
    false,
  );
  assert.equal(
    await next.client.completeReconnect({ requestId: requests[0]!.requestId, ok: true }),
    false,
  );
  await next.client.completeReconnect({ requestId: requests[1]!.requestId, ok: true });
  await fresh;
  const pending = phone.client.requestReconnect(targets[1]!);
  const closed = assert.rejects(pending, new RegExp(WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE));
  next.host.dispose();
  await closed;
  old.host.dispose();
  phone.host.dispose();
  f.owner.dispose();
});

test("失败后可重新请求，另一窗口的处理者无法提交完成结果", async () => {
  const f = fixture();
  const other = fixture();
  const desktop = f.attachment(true);
  const wrongWindow = other.attachment(true);
  const requests: WindowWorkspaceReconnectRequest[] = [];
  desktop.client.onDynamicReconnectRequested()((request) => requests.push(request));
  wrongWindow.client.onDynamicReconnectRequested()(() => {});
  const failed = f.owner.request(targets[0]!);
  const rejection = assert.rejects(failed, /fixture failure/);
  assert.equal(
    await wrongWindow.client.completeReconnect({ requestId: requests[0]!.requestId, ok: true }),
    false,
  );
  await desktop.client.completeReconnect({
    requestId: requests[0]!.requestId,
    ok: false,
    error: "fixture failure",
  });
  await rejection;
  const retry = f.owner.request(targets[0]!);
  assert.equal(requests.length, 2);
  await desktop.client.completeReconnect({ requestId: requests[1]!.requestId, ok: true });
  await retry;
  desktop.host.dispose();
  wrongWindow.host.dispose();
  f.owner.dispose();
  other.owner.dispose();
});
