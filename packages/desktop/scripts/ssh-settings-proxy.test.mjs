import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createServer as netServer, connect } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectNetworkProxySocket } from "@lcode/provider-node/network";
import { remoteTargetSchema } from "@lcode/shared";
import { createRemoteBackend } from "@lcode/server/remote/create-backend.js";
import { resolveSshSettingsProxy } from "../src/host/sshSettingsProxy.ts";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Server: SshServer } = require("ssh2");
const forge = require("node-forge");
const USER = "fixture@user",
  PASSWORD = "fixture:p@ss%";

test(
  "SSH settings proxy supports HTTP, HTTPS and SOCKS5 auth, TLS and cancellation",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-ssh-proxy-"));
    const sockets = new Set();
    const servers = [];
    const backends = [];
    t.after(async () => {
      for (const backend of backends) backend.dispose();
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    });
    const track = (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    };
    async function listen(server, isSsh = false) {
      servers.push(server);
      if (!isSsh) server.on("connection", track);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    }
    const hostKey = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;
    let sshAuthentications = 0;
    const ssh = new SshServer({ hostKeys: [hostKey] }, (client) => {
      track(client._sock);
      client.on("error", () => {});
      client.on("authentication", (context) => {
        if (context.method !== "password") {
          context.reject(["password"]);
          return;
        }
        assert.equal(context.username, "fixture-ssh-user");
        assert.equal(
          context.password,
          "fixture-ssh-password",
          "proxy credentials never enter SSH authentication",
        );
        sshAuthentications++;
        context.accept();
      });
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            stream.write(info.command.includes("uname -m") ? "x86_64" : "Linux");
            stream.exit(0);
            stream.end(() => stream.close());
          });
        }),
      );
    });
    const destinationPort = await listen(ssh, true);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = "01";
    certificate.validity.notBefore = new Date(Date.now() - 60_000);
    certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
    const subject = [{ name: "commonName", value: "Fixture proxy" }];
    certificate.setSubject(subject);
    certificate.setIssuer(subject);
    certificate.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
    ]);
    certificate.sign(keys.privateKey, forge.md.sha256.create());
    const cert = forge.pki.certificateToPem(certificate),
      key = forge.pki.privateKeyToPem(keys.privateKey);
    const caCertPath = join(directory, "fixture.pem");
    await writeFile(caCertPath, cert);
    const target = remoteTargetSchema.parse({
      kind: "ssh",
      host: "destination.invalid",
      port: destinationPort,
      username: "fixture-ssh-user",
      password: "fixture-ssh-password",
      useProxy: true,
    });
    const expectedAuth = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
    const proxyUrls = [];
    for (const protocol of ["http", "https"]) {
      const proxy = protocol === "https" ? httpsServer({ cert, key }) : httpServer();
      proxy.on("connect", (request, socket, head) => {
        if (request.headers["proxy-authorization"] !== expectedAuth) {
          socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        assert.equal(request.url, `destination.invalid:${destinationPort}`);
        const upstream = connect(destinationPort, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        track(upstream);
        upstream.on("close", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
      });
      const port = await listen(proxy);
      proxyUrls.push(
        `${protocol}://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}`,
      );
    }
    const socks = netServer((socket) => {
      let buffer = Buffer.alloc(0),
        state = 0;
      const receive = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (state === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          buffer = buffer.subarray(2 + buffer[1]);
          state = 1;
          socket.write(Buffer.from([5, 2]));
        }
        if (state === 1) {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
          const userLength = buffer[1],
            passwordLength = buffer[2 + userLength];
          if (buffer.length < 3 + userLength + passwordLength) return;
          const username = buffer.subarray(2, 2 + userLength).toString();
          const password = buffer
            .subarray(3 + userLength, 3 + userLength + passwordLength)
            .toString();
          if (username !== USER || password !== PASSWORD) {
            socket.end(Buffer.from([1, 1]));
            return;
          }
          buffer = buffer.subarray(3 + userLength + passwordLength);
          state = 2;
          socket.write(Buffer.from([1, 0]));
        }
        if (state === 2) {
          if (buffer.length < 5) return;
          assert.equal(buffer[3], 3, "SOCKS5 resolves the SSH hostname on the proxy");
          const end = 5 + buffer[4];
          if (buffer.length < end + 2) return;
          assert.equal(buffer.subarray(5, end).toString(), "destination.invalid");
          assert.equal(buffer.readUInt16BE(end), destinationPort);
          socket.removeListener("data", receive);
          const upstream = connect(destinationPort, "127.0.0.1", () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            const rest = buffer.subarray(end + 2);
            if (rest.length) upstream.write(rest);
            socket.pipe(upstream).pipe(socket);
          });
          track(upstream);
          upstream.on("close", () => socket.destroy());
          socket.on("close", () => upstream.destroy());
        }
      };
      socket.on("data", receive);
    });
    const socksPort = await listen(socks);
    proxyUrls.push(
      `socks5://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@127.0.0.1:${socksPort}`,
    );
    for (const proxyUrl of proxyUrls) {
      await t.test(new URL(proxyUrl).protocol, async () => {
        let tunnels = 0;
        const selectedTarget = { ...target, proxyProfileId: "selected-profile" };
        const sshProxy = await resolveSshSettingsProxy(
          selectedTarget,
          async () => ({
            httpProxy: "http://unused.invalid:8080",
            proxyProfiles: [
              { id: "selected-profile", name: "Fixture", httpProxy: proxyUrl, caCertPath },
            ],
          }),
          async (options) => {
            tunnels++;
            return connectNetworkProxySocket(options);
          },
        );
        const backend = await createRemoteBackend(selectedTarget, { sshProxy });
        backends.push(backend);
        const before = sshAuthentications;
        const environments = await Promise.all([backend.detect(), backend.detect()]);
        assert.deepEqual(environments[0], { platform: "linux", arch: "x64" });
        assert.equal(tunnels, 1, "concurrent requests share one SSH handshake");
        assert.equal(sshAuthentications, before + 1);
        backend.dispose();
        const wrong = new URL(proxyUrl);
        wrong.password = "wrong-fixture-secret";
        await assert.rejects(
          connectNetworkProxySocket({
            proxyUrl: wrong.href,
            host: target.host,
            port: destinationPort,
            caCertPath,
          }),
          (error) => {
            assert.equal(`${error.stack}${error.cause}`.includes("wrong-fixture-secret"), false);
            assert.equal(error.cause, undefined);
            return /代理/.test(error.message);
          },
        );
        assert.equal(sshAuthentications, before + 1, "failed auth never falls back to direct SSH");
      });
    }
    await t.test("HTTPS rejects an untrusted proxy certificate", async () => {
      await assert.rejects(
        connectNetworkProxySocket({
          proxyUrl: proxyUrls[1],
          host: target.host,
          port: destinationPort,
        }),
        /代理/,
      );
    });
    await t.test("CONNECT head retains an early SSH banner", async () => {
      const proxy = httpServer();
      proxy.on("connect", (_req, socket) =>
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\nSSH-2.0-fixture\r\n"),
      );
      const port = await listen(proxy);
      const socket = await connectNetworkProxySocket({
        proxyUrl: `http://127.0.0.1:${port}`,
        host: "fixture.invalid",
        port: 22,
      });
      track(socket);
      const data = once(socket, "data");
      socket.resume();
      assert.equal((await data)[0].toString(), "SSH-2.0-fixture\r\n");
      socket.destroy();
    });
    for (const protocol of ["http", "socks5"]) {
      await t.test(`${protocol}: cancel and timeout terminate a stalled handshake`, async () => {
        let reached;
        const proxy = protocol === "http" ? httpServer() : netServer();
        proxy.on(protocol === "http" ? "connect" : "connection", (...args) =>
          reached?.(protocol === "http" ? args[1] : args[0]),
        );
        const port = await listen(proxy);
        const proxyUrl = `${protocol}://127.0.0.1:${port}`;
        const accepted = new Promise((resolve) => {
          reached = resolve;
        });
        const backend = await createRemoteBackend(target, {
          sshProxy: (destination, signal) =>
            connectNetworkProxySocket({ ...destination, proxyUrl, signal }),
        });
        backends.push(backend);
        const pending = backend.detect();
        const rejected = assert.rejects(pending, /取消/);
        await accepted;
        backend.dispose();
        await rejected;
        await assert.rejects(
          connectNetworkProxySocket({
            proxyUrl,
            host: target.host,
            port: destinationPort,
            timeoutMs: 100,
          }),
          /超时/,
        );
      });
    }
    await t.test(
      "disposing a backend rejects a late tunnel before SSH authentication",
      async () => {
        let finish;
        const sshProxy = () =>
          new Promise((resolve) => {
            finish = resolve;
          });
        const backend = await createRemoteBackend(target, { sshProxy });
        backends.push(backend);
        const pending = backend.detect();
        const rejected = assert.rejects(pending, /已释放/);
        backend.dispose();
        const { Socket } = await import("node:net");
        const socket = new Socket();
        finish(socket);
        await rejected;
        assert.equal(socket.destroyed, true);
      },
    );
    await t.test(
      "proxy mode requires an injected settings owner; direct SSH stays available",
      async () => {
        await assert.rejects(createRemoteBackend(target), /代理/);
        const direct = await createRemoteBackend(
          { ...target, host: "127.0.0.1", useProxy: false },
          {
            sshProxy: () => {
              throw new Error("Direct SSH must not open a proxy");
            },
          },
        );
        backends.push(direct);
        assert.deepEqual(await direct.detect(), { platform: "linux", arch: "x64" });
      },
    );
  },
);
