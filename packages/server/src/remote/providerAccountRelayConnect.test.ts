import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  Event,
  ProxyChannel,
  SocketProtocol,
} from "@lcode/rpc";
import { PROVIDER_ACCOUNT_RELAY_CHANNEL, PROVIDER_ACCOUNT_RELAY_ENV } from "@lcode/shared";
import type { ProviderAccountRelayService } from "@lcode/services";
import type { IRemoteBackend } from "./backend.js";
import { connectRemote } from "./connect.js";
import { wrapStdioStream } from "./stdio-socket.js";

function fixture(t: test.TestContext, supportsRelay = true) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const close = new Emitter<number>();
  let peerClient: ChannelClient | undefined;
  let peerServer: ChannelServer | undefined;
  let protocol: SocketProtocol | undefined;
  let disposed = 0;
  let relayDisposed = 0;
  const commands: string[] = [];
  const relay = {
    service: {
      onDidChange: Event.None,
      getView: async () => ({
        revision: 4,
        channels: [],
        accounts: [{ connectionId: "fixture-account", channelId: "codex", models: [] }],
      }),
    } as unknown as ProviderAccountRelayService,
    dispose() {
      relayDisposed++;
    },
  };
  const backend: IRemoteBackend = {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    exec: async (command) => {
      commands.push(command);
      stdin.once("data", () => {
        setImmediate(() => {
          if (disposed) return;
          protocol = new SocketProtocol(
            wrapStdioStream({ stdin: stdout, stdout: stdin, stderr, onClose: close.event }),
          );
          // 与生产 stdio 同序：反向 client 先监听，再发正向 Initialize。
          peerClient = new ChannelClient(protocol);
          const source = ProxyChannel.toService<ProviderAccountRelayService>(
            peerClient.getChannel(PROVIDER_ACCOUNT_RELAY_CHANNEL),
          );
          peerServer = new ChannelServer(protocol, "stdio");
          peerServer.registerChannel(
            "fixture",
            ProxyChannel.fromService({ readCatalog: () => source.getView() }),
          );
        });
      });
      setImmediate(() =>
        stdout.write(
          JSON.stringify({
            type: "lcode-hello",
            version: "fixture",
            platform: "linux",
            arch: "x64",
            pid: 1,
            ...(supportsRelay ? { capabilities: { providerAccountRelay: true } } : {}),
          }) + "\n",
        ),
      );
      return { stdin, stdout, stderr, onClose: close.event };
    },
    upload: async () => {
      throw new Error("unexpected deploy");
    },
    exists: async () => false,
    readFile: async () => "",
    dispose() {
      disposed++;
      peerClient?.dispose();
      peerServer?.dispose();
      protocol?.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
  t.after(() => {
    if (!disposed) backend.dispose();
    close.dispose();
  });
  t.mock.method(console, "log", () => {});
  return {
    backend,
    relay,
    commands,
    close,
    disposed: () => disposed,
    relayDisposed: () => relayDisposed,
  };
}

test(
  "production remote connect launches the relay flag and initializes both RPC directions",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    const connection = await connectRemote(f.backend, {
      skipDeploy: true,
      providerAccountRelay: f.relay,
    });
    assert.ok(f.commands[0]!.includes(`${PROVIDER_ACCOUNT_RELAY_ENV}='1'`));
    const catalog = await connection.client
      .getChannel("fixture")
      .call<{ revision: number; accounts: { channelId: string }[] }>("readCatalog", []);
    assert.equal(catalog.revision, 4);
    assert.equal(catalog.accounts[0]!.channelId, "codex");
    f.close.fire(1);
    assert.ok(f.relayDisposed() > 0);
    await assert.rejects(
      connection.client.getChannel("fixture").call("readCatalog", []),
      /disposed/,
    );
    connection.dispose();
    assert.equal(f.disposed(), 1);
  },
);

test("an older server cannot silently publish an API-only attachment when OAuth relay was requested", async (t) => {
  const f = fixture(t, false);
  await assert.rejects(
    connectRemote(f.backend, { skipDeploy: true, providerAccountRelay: f.relay }),
    /远端 Server 不支持 OAuth/,
  );
  assert.equal(f.disposed(), 1);
  assert.ok(f.relayDisposed() > 0);
});

test("ordinary remote clients remain compatible without the OAuth relay startup flag", async (t) => {
  const f = fixture(t, false);
  const connection = await connectRemote(f.backend, { skipDeploy: true });
  assert.equal(f.commands[0]!.includes(PROVIDER_ACCOUNT_RELAY_ENV), false);
  connection.dispose();
});

test("connect cancelled before detect releases its private relay source", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    connectRemote(f.backend, {
      skipDeploy: true,
      providerAccountRelay: f.relay,
      signal: controller.signal,
    }),
  );
  assert.equal(f.disposed(), 1);
  assert.equal(f.relayDisposed(), 1);
});
