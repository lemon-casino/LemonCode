import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, connect } from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createHostApiNetworkTransport } from "./provider-network.js";

test("HTTP, HTTPS and SOCKS5 proxies authenticate without sending credentials to targets", async (t) => {
  // 测试证书在本机临时生成，不降低生产 TLS 校验，也不依赖外网或真实代理。
  const forge = createRequire(new URL("../../services/package.json", import.meta.url))(
    "node-forge",
  );
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: "commonName", value: "Proxy Fixture" }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const cert = forge.pki.certificateToPem(certificate),
    key = forge.pki.privateKeyToPem(keys.privateKey);
  const directory = await mkdtemp(join(tmpdir(), "lcode-proxy-auth-"));
  const caCertPath = join(directory, "fixture.pem");
  await writeFile(caCertPath, cert);
  const sockets = new Set<Duplex>();
  const servers: Array<
    | ReturnType<typeof createHttpServer>
    | ReturnType<typeof createHttpsServer>
    | ReturnType<typeof createNetServer>
  > = [];
  const transports: Array<ReturnType<typeof createHostApiNetworkTransport>> = [];
  t.after(async () => {
    for (const transport of transports) transport.dispose();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const listen = async (server: (typeof servers)[number]) => {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  };
  let targets = 0;
  const target = createHttpServer((req, res) => {
    targets++;
    assert.equal(req.headers["proxy-authorization"], undefined);
    assert.equal(req.headers.authorization, "Bearer fixture-model-key");
    res.end("fixture-ok");
  });
  const targetPort = await listen(target);
  const secureTarget = createHttpsServer({ cert, key }, (req, res) => {
    targets++;
    assert.equal(req.headers["proxy-authorization"], undefined);
    res.end("fixture-ok");
  });
  const secureTargetPort = await listen(secureTarget);
  const expectedAuth = `Basic ${Buffer.from("fixture@user:fixture:p@ss%").toString("base64")}`;
  for (const protocol of ["http", "https"] as const) {
    const proxy = protocol === "https" ? createHttpsServer({ cert, key }) : createHttpServer();
    proxy.on("connect", (req, socket, head) => {
      if (req.headers["proxy-authorization"] !== expectedAuth) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const port = Number(req.url!.split(":").at(-1));
      const upstream = connect(port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      sockets.add(socket);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    const port = await listen(proxy);
    const transport = createHostApiNetworkTransport(async () => ({
      httpProxy: `${protocol}://fixture%40user:fixture%3Ap%40ss%25@127.0.0.1:${port}`,
      caCertPath,
    }));
    transports.push(transport);
    assert.equal(
      await (
        await transport.fetch(`http://127.0.0.1:${targetPort}`, {
          headers: { authorization: "Bearer fixture-model-key" },
        })
      ).text(),
      "fixture-ok",
    );
    assert.equal(
      await (await transport.fetch(`https://127.0.0.1:${secureTargetPort}`)).text(),
      "fixture-ok",
    );
    const rejected = createHostApiNetworkTransport(async () => ({
      httpProxy: `${protocol}://fixture:wrong@127.0.0.1:${port}`,
      caCertPath,
    }));
    transports.push(rejected);
    await assert.rejects(rejected.fetch(`http://127.0.0.1:${targetPort}`));
  }
  const socks = createNetServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0),
      state = 0;
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        state = 1;
        socket.write(Buffer.from([5, 2]));
      }
      if (state === 1) {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]!) return;
        const userLength = buffer[1]!,
          passwordLength = buffer[2 + userLength]!;
        if (buffer.length < 3 + userLength + passwordLength) return;
        const username = buffer.subarray(2, 2 + userLength).toString(),
          password = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
        if (username !== "fixture@user" || password !== "fixture:p@ss%") {
          socket.end(Buffer.from([1, 1]));
          return;
        }
        buffer = buffer.subarray(3 + userLength + passwordLength);
        state = 2;
        socket.write(Buffer.from([1, 0]));
      }
      if (state === 2) {
        if (buffer.length < 5) return;
        const addressLength = buffer[3] === 1 ? 4 : buffer[3] === 3 ? buffer[4]! + 1 : 16;
        const total = 4 + addressLength + 2;
        if (buffer.length < total) return;
        const port = buffer.readUInt16BE(total - 2),
          rest = buffer.subarray(total);
        socket.removeListener("data", receive);
        const upstream = connect(port, "127.0.0.1", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          socket.pipe(upstream).pipe(socket);
        });
        sockets.add(upstream);
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      }
    };
    socket.on("data", receive);
  });
  const socksPort = await listen(socks);
  const transport = createHostApiNetworkTransport(async () => ({
    httpProxy: `socks5://fixture%40user:fixture%3Ap%40ss%25@127.0.0.1:${socksPort}`,
    caCertPath,
  }));
  transports.push(transport);
  assert.equal(
    await (
      await transport.fetch(`http://127.0.0.1:${targetPort}`, {
        headers: { authorization: "Bearer fixture-model-key" },
      })
    ).text(),
    "fixture-ok",
  );
  assert.equal(
    await (await transport.fetch(`https://127.0.0.1:${secureTargetPort}`)).text(),
    "fixture-ok",
  );
  const rejected = createHostApiNetworkTransport(async () => ({
    httpProxy: `socks5://fixture:wrong@127.0.0.1:${socksPort}`,
  }));
  transports.push(rejected);
  await assert.rejects(rejected.fetch(`http://127.0.0.1:${targetPort}`));
  assert.equal(targets, 6);
});
