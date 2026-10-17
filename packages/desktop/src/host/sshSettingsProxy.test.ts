import assert from "node:assert/strict";
import test from "node:test";
import { Socket } from "node:net";
import { resolveSshSettingsProxy } from "./sshSettingsProxy.js";

const target = { kind: "ssh" as const, host: "fixture.invalid", username: "fixture" };

test("SSH reads the existing settings proxy only when the switch is enabled", async () => {
  let reads = 0;
  const read = async () => {
    reads++;
    return {
      httpProxy: "socks5://fixture:secret@proxy.invalid:1080",
      httpProxyCaCertPath: "fixture.pem",
    };
  };
  assert.equal(await resolveSshSettingsProxy(target, read), undefined);
  assert.equal(reads, 0);
  const signal = new AbortController().signal;
  const socket = new Socket();
  const factory = await resolveSshSettingsProxy(
    { ...target, useProxy: true },
    read,
    async (options) => {
      assert.equal(options.proxyUrl, "socks5://fixture:secret@proxy.invalid:1080");
      assert.equal(options.caCertPath, "fixture.pem");
      assert.equal(options.host, target.host);
      assert.equal(options.port, 22);
      assert.equal(options.signal, signal);
      return socket;
    },
  );
  assert.ok(factory);
  assert.equal(await factory({ host: target.host, port: 22 }, signal), socket);
  assert.equal(reads, 1);
  socket.destroy();
});

test("enabled SSH proxy mode fails closed for missing or unsupported settings", async () => {
  for (const httpProxy of [undefined, "", "ftp://fixture:secret@proxy.invalid"]) {
    await assert.rejects(
      resolveSshSettingsProxy({ ...target, useProxy: true }, async () => ({ httpProxy })),
      (error: Error) => {
        assert.equal(error.message.includes("secret"), false);
        return /代理/.test(error.message);
      },
    );
  }
});

test("SSH resolves the selected library profile and rereads updates for new connections", async () => {
  let httpProxy = "https://fixture:secret@selected.invalid:8443";
  const read = async () => ({
    httpProxy: "http://unused.invalid:8080",
    httpProxyCaCertPath: "unused.pem",
    proxyProfiles: [{ id: "selected", name: "Fixture", httpProxy, caCertPath: "selected.pem" }],
  });
  for (const url of [httpProxy, "socks5://updated.invalid:1080"]) {
    httpProxy = url;
    const socket = new Socket();
    const factory = await resolveSshSettingsProxy(
      { ...target, useProxy: true, proxyProfileId: "selected" },
      read,
      async (options) => {
        assert.equal(options.proxyUrl, url);
        assert.equal(options.caCertPath, "selected.pem");
        return socket;
      },
    );
    assert.ok(factory);
    await factory({ host: target.host, port: 22 }, new AbortController().signal);
    socket.destroy();
  }
});

test("deleted or invalid profile cannot silently use the default proxy", async () => {
  for (const proxyProfiles of [
    [],
    [{ id: "selected", name: "Fixture", httpProxy: "ftp://fixture:secret@proxy.invalid" }],
  ]) {
    await assert.rejects(
      resolveSshSettingsProxy(
        { ...target, useProxy: true, proxyProfileId: "selected" },
        async () => ({ httpProxy: "http://default.invalid:8080", proxyProfiles }),
      ),
      (error: Error) => /代理/.test(error.message) && !error.message.includes("secret"),
    );
  }
});
