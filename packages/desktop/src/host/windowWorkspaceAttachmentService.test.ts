import assert from "node:assert/strict";
import test from "node:test";
import { Emitter, ProxyChannel, type IServerChannel } from "@lcode/rpc";
import {
  ServiceCollection,
  IFileService,
  IWindowWorkspaceService,
  type IServiceAccessor,
} from "@lcode/services";
import {
  buildRemoteWorkspaceIdentity,
  type WindowWorkspaceCatalogEntry,
  type WindowWorkspaceScope,
} from "@lcode/shared";
import { RemoteServiceAccess } from "@lcode/client";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";
import { createWindowWorkspaceAttachmentService } from "./windowWorkspaceAttachmentService.js";

async function fixture() {
  let count = 0;
  let close: (() => void) | undefined;
  const events = new Emitter<string>();
  const remote = new ServiceCollection().register(IFileService, {
    stat: async () => ({ type: "directory", size: 7 }),
    onDidChange: events.event,
  } as unknown as IServiceAccessor["fileService"]);
  const local = new ServiceCollection().register(IFileService, {
    stat: async () => ({ type: "directory", size: 1 }),
  } as unknown as IServiceAccessor["fileService"]);
  const registry = createWindowRemoteConnectionRegistry({
    createId: () => `session-${++count}`,
    connect: async () => ({
      services: remote,
      dispose() {},
      onDidClose(listener) {
        close = () => listener({ exitCode: 1, signal: null });
        return { dispose() {} };
      },
    }),
  });
  const target = {
    kind: "ssh" as const,
    host: "example.invalid",
    username: "fixture",
    password: "fixture-only",
  };
  const identity = buildRemoteWorkspaceIdentity("/same", target);
  const session = await registry.connect({
    requestId: "request",
    target,
    remoteAssets: {},
    workspacePath: "/same",
    workspaceIdentity: identity,
  });
  const scope = {
    kind: "remote" as const,
    remoteSessionId: session.remoteSessionId,
    workspacePath: "/same",
    workspaceIdentity: identity,
    generation: session.generation,
  };
  let releaseCount = 0;
  function attachment() {
    return createWindowWorkspaceAttachmentService({
      getCatalog: () =>
        registry.listSessions().map((item) => ({
          scope: { ...scope, generation: item.generation },
          target: { kind: "ssh", host: target.host, username: target.username },
          sourceAvailability: item.sourceAvailability,
        })) as WindowWorkspaceCatalogEntry[],
      onCatalogChanged: registry.onDidChangeCatalog,
      resolveScope(value) {
        if (value.kind === "local") return local;
        if (registry.getSession(value.remoteSessionId)?.generation !== value.generation)
          throw new Error("stale generation");
        return registry.resolveScopedServices(value);
      },
      createChannels(_scope, source) {
        const channels = new Map<string, IServerChannel>();
        source.exposeOnChannelServer({
          registerChannel: (name, channel) => channels.set(name, channel),
        });
        return {
          channels,
          dispose() {
            releaseCount++;
          },
          setTransportFlowState: async () => {},
        };
      },
    });
  }
  return {
    registry,
    scope,
    events,
    remote,
    close: () => close?.(),
    attachment,
    releases: () => releaseCount,
  };
}

test("真实客户端 scoped facade 区分同路径本机/SSH，目录不泄露认证字段", async () => {
  const f = await fixture();
  const a = f.attachment();
  const server = ProxyChannel.fromService(a.service);
  const client = new RemoteServiceAccess({
    getChannel: () =>
      ({
        call: (command: string, args?: unknown[]) => server.call("test", command, args),
        listen: (event: string, arg?: unknown) => server.listen("test", event, arg),
      }) as never,
  });
  assert.equal(
    (
      await client
        .createWorkspaceServiceAccessor({ kind: "local" })
        .fileService.stat({ path: "/same" })
    ).size,
    1,
  );
  assert.equal(
    (await client.createWorkspaceServiceAccessor(f.scope).fileService.stat({ path: "/same" })).size,
    7,
  );
  assert.equal(
    JSON.stringify(await client.windowWorkspaceService.getCatalog()).includes("fixture-only"),
    false,
  );
  assert.notEqual(IWindowWorkspaceService.channelName, IFileService.channelName);
  a.dispose();
  await f.registry.dispose();
});

test("错 session/path/identity/generation、内部 channel 与断线均 fail closed", async () => {
  const f = await fixture();
  const a = f.attachment();
  const request = { scope: f.scope, channel: "file", command: "stat", args: [{ path: "/same" }] };
  for (const scope of [
    { ...f.scope, remoteSessionId: "other-window" },
    { ...f.scope, workspaceIdentity: "wrong" },
    { ...f.scope, workspacePath: "/wrong" },
    { ...f.scope, generation: 2 },
  ])
    await assert.rejects(a.service.call({ ...request, scope }));
  await assert.rejects(a.service.call({ ...request, channel: "provider-provisioning-target" }));
  await assert.rejects(a.service.call({ ...request, channel: "window-workspace" }));
  f.close();
  await assert.rejects(a.service.call(request));
  a.dispose();
  await f.registry.dispose();
});

test("绑定换代拒绝迟到回包、退休事件监听；另一设备的释放不拆共用连接", async () => {
  const f = await fixture();
  const a = f.attachment();
  const b = f.attachment();
  let release!: (value: unknown) => void;
  let entered!: () => void;
  let admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.remote.register(IFileService, {
    stat: () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      }),
    onDidChange: f.events.event,
  } as unknown as IServiceAccessor["fileService"]);
  const received: unknown[] = [];
  const sub = a.service.onDynamicScopedEvent({
    scope: f.scope,
    channel: "file",
    event: "onDidChange",
  })((value) => received.push(value));
  f.events.fire("before");
  assert.deepEqual(received, ["before"]);
  const pending = a.service.call({ scope: f.scope, channel: "file", command: "stat", args: [] });
  const rejected = assert.rejects(pending, /generation/);
  await admitted;
  await f.registry.bindWorkspaceContext({ ...f.scope });
  f.events.fire("after");
  release({ type: "directory" });
  await rejected;
  assert.deepEqual(received, ["before"]);
  assert.ok(f.releases() > 0);
  a.dispose();
  assert.equal(f.registry.getStats().logicalSessionCount, 1);
  const fresh: WindowWorkspaceScope = {
    ...f.scope,
    generation: f.registry.getSession(f.scope.remoteSessionId)!.generation,
  };
  admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const request = b.service.call({ scope: fresh, channel: "file", command: "stat", args: [] });
  await admitted;
  release({ type: "directory" });
  await request;
  sub.dispose();
  b.dispose();
  await f.registry.dispose();
});
