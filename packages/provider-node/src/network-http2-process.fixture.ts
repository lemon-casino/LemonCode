import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSecureServer, type ServerHttp2Stream } from "node:http2";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHostApiNetworkTransport } from "./network-transport.js";
import { getProviderNetworkDiagnostics } from "./network-diagnostics.js";

const [directory, protocol, orderText, tail] = process.argv.slice(2);
assert.ok(directory && orderText);
const order = JSON.parse(orderText) as string[];
const cycles = Number(process.argv[6] ?? 1);
assert.ok(Number.isInteger(cycles) && cycles > 0 && cycles <= 100);
const forge = createRequire(new URL("../../services/package.json", import.meta.url))("node-forge");
const keys = forge.pki.rsa.generateKeyPair(2048);
const certificate = forge.pki.createCertificate();
certificate.publicKey = keys.publicKey;
certificate.serialNumber = "01";
certificate.validity.notBefore = new Date(Date.now() - 60_000);
certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
const subject = [{ name: "commonName", value: "Concurrent stream fixture" }];
certificate.setSubject(subject);
certificate.setIssuer(subject);
certificate.setExtensions([
  { name: "basicConstraints", cA: true },
  { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
]);
certificate.sign(keys.privateKey, forge.md.sha256.create());
const cert = forge.pki.certificateToPem(certificate);
const caCertPath = join(directory, "ca.pem");
await writeFile(caCertPath, cert);
const server = createSecureServer({
  cert,
  key: forge.pki.privateKeyToPem(keys.privateKey),
  allowHTTP1: true,
});
const sockets = new Set<import("node:net").Socket>();
const streams = new Map<string, { end(chunk: string): unknown }>();
const seen: string[] = [];
let sessions = 0;
server.on("session", (session) => {
  sessions++;
  session.on("error", () => {});
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
});
server.on("request", (request, response) => {
  if (request.httpVersionMajor !== 1) return;
  request.resume();
  const id = String(request.headers["x-fixture-id"]);
  seen.push(id);
  streams.set(id, response);
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${id}\n\n`);
});
server.on("stream", (stream: ServerHttp2Stream, headers) => {
  stream.on("error", () => {});
  stream.resume();
  const id = String(headers["x-fixture-id"]);
  seen.push(id);
  streams.set(id, stream);
  stream.respond({ ":status": 200, "content-type": "text/event-stream" });
  stream.write(`data: ${id}\n\n`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const owner = createHostApiNetworkTransport(async () => ({
  caCertPath,
  http2: protocol === "h1" ? "disabled" : "negotiate",
}));
try {
  for (let cycle = 0; cycle < cycles; cycle++) {
    const bodies = new Map<string, Promise<string>>();
    for (const id of [...order].sort()) {
      const response = await owner.fetch(`https://127.0.0.1:${address.port}`, {
        method: "POST",
        body: "{}",
        headers: { "x-fixture-id": id },
      });
      const body = response.text();
      void body.catch(() => {});
      bodies.set(id, body);
    }
    assert.equal(sessions, protocol === "h1" ? 0 : 1);
    console.error(`fixture: ${order.length} response headers received`);
    // 正常完成顺序必须由服务端控制；不能只测试取消/GOAWAY，漏掉兄弟流 end 后的重入。
    for (const id of order) {
      streams.get(id)!.end(tail === "empty" ? "" : "data: done\n\n");
      assert.equal(
        await bodies.get(id),
        `data: ${id}\n\n${tail === "empty" ? "" : "data: done\n\n"}`,
      );
      console.error(`fixture: ${id} body settled`);
    }
  }
  assert.deepEqual(seen, Array.from({ length: cycles }, () => [...order].sort()).flat());
  assert.equal(owner.activeRequestCount, 0);
  await owner.disposeAndWait();
  const diagnostic = getProviderNetworkDiagnostics().at(-1)!;
  assert.equal(diagnostic.phase, "closed");
  assert.equal(diagnostic.activeRequests, 0);
  assert.equal(diagnostic.started, order.length * cycles);
  assert.equal(diagnostic.finished, order.length * cycles);
  if (protocol === "h2")
    assert.ok(
      diagnostic.connections.every(
        (connection) => connection.phase === "retired" && connection.protocol === "h2",
      ),
    );
  console.error("fixture: owner disposed");
  console.log(JSON.stringify({ completed: order, sessions, posted: seen.length }));
} finally {
  owner.dispose();
  for (const socket of sockets) socket.destroy();
  server.close();
}
