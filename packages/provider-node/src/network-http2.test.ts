import assert from "node:assert/strict";
import test from "node:test";
import {
  constants,
  createSecureServer,
  type ServerHttp2Stream,
  type IncomingHttpHeaders,
  type Http2Session,
} from "node:http2";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, createServer as netServer } from "node:net";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApiNetworkTransport } from "./network-transport.js";

async function fixture(t: import("node:test").TestContext) {
  const forge = createRequire(new URL("../../services/package.json", import.meta.url))(
    "node-forge",
  );
  const keys = forge.pki.rsa.generateKeyPair(2048),
    cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const subject = [{ name: "commonName", value: "HTTP2 Fixture" }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const tls = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  const directory = await mkdtemp(join(tmpdir(), "lcode-h2-")),
    caCertPath = join(directory, "ca.pem");
  await writeFile(caCertPath, tls.cert);
  const sockets = new Set<import("node:net").Socket>();
  const servers: Array<
    | ReturnType<typeof createSecureServer>
    | ReturnType<typeof httpServer>
    | ReturnType<typeof netServer>
  > = [];
  const owners: Array<ReturnType<typeof createHostApiNetworkTransport>> = [];
  t.after(async () => {
    for (const owner of owners) owner.dispose();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    await Promise.all(owners.map((owner) => owner.disposeAndWait()));
    await rm(directory, { recursive: true, force: true });
  });
  const listen = async (server: (typeof servers)[number]) => {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  };
  const owner = (options: object) => {
    const result = createHostApiNetworkTransport(async () => ({
      caCertPath,
      http2: "negotiate" as const,
      ...options,
    }));
    owners.push(result);
    return result;
  };
  return { tls, listen, owner, sockets };
}

test("TLS negotiates H2 and H1 before POST; policy changes do not reuse the other protocol", async (t) => {
  const f = await fixture(t),
    versions: number[] = [];
  const server = createSecureServer({ ...f.tls, allowHTTP1: true });
  server.on("request", (req, res) => {
    req.resume();
    versions.push(req.httpVersionMajor);
    assert.equal(req.headers["proxy-authorization"], undefined);
    res.end("fixture");
  });
  const port = await f.listen(server);
  const negotiated = f.owner({});
  await (
    await negotiated.fetch(`https://127.0.0.1:${port}`, { method: "POST", body: "{}" })
  ).text();
  await (
    await f
      .owner({ http2: "disabled" })
      .fetch(`https://127.0.0.1:${port}`, { method: "POST", body: "{}" })
  ).text();
  assert.deepEqual(versions, [2, 1]);
  const h1 = httpsServer(f.tls, (req, res) => {
    assert.equal(req.httpVersionMajor, 1);
    req.resume();
    res.end("h1");
  });
  const fallback = await f.listen(h1);
  assert.equal(
    await (
      await negotiated.fetch(`https://127.0.0.1:${fallback}`, { method: "POST", body: "{}" })
    ).text(),
    "h1",
  );
});

test("authenticated SOCKS5 negotiates H2 inside target TLS", async (t) => {
  const f = await fixture(t);
  const target = createSecureServer(f.tls);
  target.on("request", (req, res) => {
    assert.equal(req.httpVersionMajor, 2);
    assert.equal(req.headers["proxy-authorization"], undefined);
    req.resume();
    res.end("socks-h2");
  });
  const port = await f.listen(target);
  const proxy = netServer((socket) => {
    let buffered = Buffer.alloc(0),
      phase = 0;
    const receive = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (phase === 0) {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
        buffered = buffered.subarray(2 + buffered[1]!);
        phase = 1;
        socket.write(Buffer.from([5, 2]));
      }
      if (phase === 1) {
        if (buffered.length < 2 || buffered.length < 3 + buffered[1]!) return;
        const length = buffered[1]!,
          passwordLength = buffered[2 + length]!;
        if (buffered.length < 3 + length + passwordLength) return;
        assert.equal(buffered.subarray(2, 2 + length).toString(), "fixture");
        assert.equal(
          buffered.subarray(3 + length, 3 + length + passwordLength).toString(),
          "secret",
        );
        buffered = buffered.subarray(3 + length + passwordLength);
        phase = 2;
        socket.write(Buffer.from([1, 0]));
      }
      if (phase === 2) {
        if (buffered.length < 5) return;
        const addressLength = buffered[3] === 1 ? 4 : buffered[3] === 3 ? buffered[4]! + 1 : 16;
        if (buffered.length < 6 + addressLength) return;
        assert.equal(buffered.readUInt16BE(4 + addressLength), port);
        const rest = buffered.subarray(6 + addressLength);
        socket.removeListener("data", receive);
        const upstream = connect(port, "127.0.0.1", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          socket.pipe(upstream).pipe(socket);
        });
        f.sockets.add(upstream);
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      }
    };
    socket.on("data", receive);
  });
  const proxyPort = await f.listen(proxy);
  const response = await f
    .owner({ httpProxy: `socks5://fixture:secret@127.0.0.1:${proxyPort}` })
    .fetch(`https://127.0.0.1:${port}`, { method: "POST", body: "{}" });
  assert.equal(await response.text(), "socks-h2");
});

for (const protocol of ["http", "https"] as const)
  test(`authenticated ${protocol} CONNECT negotiates target H2`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    let posted = 0;
    const target = createSecureServer(f.tls);
    target.on("request", (req, res) => {
      assert.equal(req.httpVersionMajor, 2);
      assert.equal(req.headers["proxy-authorization"], undefined);
      req.resume();
      posted++;
      res.end("h2");
    });
    const port = await f.listen(target);
    let proxyH2 = 0;
    const secureProxy = createSecureServer({ ...f.tls, allowHTTP1: true });
    secureProxy.on("session", (session) => {
      proxyH2++;
      session.on("error", () => {});
    });
    secureProxy.on("stream", (stream: ServerHttp2Stream) => {
      stream.on("error", () => {});
      stream.respond({ ":status": 502 });
      stream.end();
    });
    const proxy = protocol === "http" ? httpServer() : secureProxy;
    proxy.on("connect", (req, socket, head) => {
      assert.equal(
        req.headers["proxy-authorization"],
        `Basic ${Buffer.from("fixture:secret").toString("base64")}`,
      );
      const upstream = connect(port, "127.0.0.1");
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    const proxyPort = await f.listen(proxy);
    const response = await f
      .owner({ httpProxy: `${protocol}://fixture:secret@127.0.0.1:${proxyPort}` })
      .fetch(`https://127.0.0.1:${port}`, { method: "POST", body: "{}" });
    assert.equal(await response.text(), "h2");
    assert.equal(posted, 1);
    assert.equal(proxyH2, 0, "proxy handshake remains H1 even when the proxy advertises H2");
  });

test(
  "GOAWAY fails in-flight POSTs without replaying them inside the transport",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      seen: string[] = [],
      sessions = new Set<unknown>();
    const target = createSecureServer(f.tls);
    target.on("session", (session) => session.on("error", () => {}));
    target.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      stream.on("error", () => {});
      stream.resume();
      seen.push(String(headers["x-fixture-id"]));
      if (headers[":path"] === "/warm") {
        seen.pop();
        stream.respond({ ":status": 200 });
        stream.end("warm");
        return;
      }
      sessions.add(stream.session);
      stream.respond({ ":status": 200, "content-type": "text/event-stream" });
      stream.write("data: waiting\n\n");
      if (seen.length === 2) {
        for (const session of sessions as Set<import("node:http2").ServerHttp2Session>)
          session.goaway();
      }
    });
    const port = await f.listen(target),
      owner = f.owner({});
    await (await owner.fetch(`https://127.0.0.1:${port}/warm`)).text();
    await setImmediate();
    const outcomes = await Promise.allSettled(
      ["a", "b"].map(async (id) =>
        (
          await owner.fetch(`https://127.0.0.1:${port}`, {
            method: "POST",
            body: "{}",
            headers: { "x-fixture-id": id },
          })
        ).text(),
      ),
    );
    assert.equal(
      outcomes.every((outcome) => outcome.status === "rejected"),
      true,
    );
    await setImmediate();
    await setImmediate();
    assert.deepEqual(seen.sort(), ["a", "b"]);
  },
);

for (const cancelled of ["a", "b"] as const)
  test(
    `H2 multiplexes open POST streams and isolates cancellation of ${cancelled}`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t),
        sessions = new Set<unknown>(),
        streams = new Map<string, import("node:http2").ServerHttp2Stream>();
      const target = createSecureServer(f.tls);
      target.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        stream.on("error", () => {});
        stream.resume();
        sessions.add(stream.session);
        streams.set(String(headers["x-fixture-id"]), stream);
        stream.respond({ ":status": 200, "content-type": "text/event-stream" });
        stream.write("data: ready\n\n");
      });
      const port = await f.listen(target),
        owner = f.owner({});
      const signals = { a: new AbortController(), b: new AbortController() };
      const first = await owner.fetch(`https://127.0.0.1:${port}`, {
        method: "POST",
        body: "{}",
        headers: { "x-fixture-id": "a" },
        signal: signals.a.signal,
      });
      const second = await owner.fetch(`https://127.0.0.1:${port}`, {
        method: "POST",
        body: "{}",
        headers: { "x-fixture-id": "b" },
        signal: signals.b.signal,
      });
      assert.equal(sessions.size, 1);
      const responses = { a: first, b: second };
      const cancelledBody = responses[cancelled].text();
      signals[cancelled].abort();
      await assert.rejects(cancelledBody);
      const kept = cancelled === "a" ? "b" : "a";
      streams.get(kept)!.end("data: done\n\n");
      assert.equal(await responses[kept].text(), "data: ready\n\ndata: done\n\n");
    },
  );

for (const failure of ["goaway", "half-close"] as const)
  test(`shared H2 session ${failure} does not replay any POST`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t),
      seen: string[] = [];
    let session: Http2Session | undefined;
    const target = createSecureServer(f.tls);
    let peerSocket: import("node:tls").TLSSocket | undefined;
    target.on("secureConnection", (socket) => {
      peerSocket = socket;
    });
    target.on("session", (value) => value.on("error", () => {}));
    target.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      stream.on("error", () => {});
      stream.resume();
      seen.push(String(headers["x-fixture-id"]));
      session = stream.session;
      stream.respond({ ":status": 200, "content-type": "text/event-stream" });
      stream.write("data: ready\n\n");
    });
    const port = await f.listen(target),
      owner = f.owner({});
    const first = await owner.fetch(`https://127.0.0.1:${port}`, {
      method: "POST",
      body: "{}",
      headers: { "x-fixture-id": "a" },
    });
    const firstBody = first.text();
    const second = await owner.fetch(`https://127.0.0.1:${port}`, {
      method: "POST",
      body: "{}",
      headers: { "x-fixture-id": "b" },
    });
    const secondBody = second.text();
    if (failure === "goaway") session!.goaway();
    else peerSocket!.end();
    const outcomes = await Promise.allSettled([firstBody, secondBody]);
    assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
    await setImmediate();
    await setImmediate();
    assert.deepEqual(seen, ["a", "b"]);
  });

for (const refusal of ["rst", "goaway"] as const)
  for (const body of [undefined, "{}"])
    test(
      `H2 ${refusal} before headers never replays ${body ? "JSON" : "empty"} POST`,
      { timeout: 5000 },
      async (t) => {
        const f = await fixture(t);
        let posted = 0;
        const target = createSecureServer(f.tls);
        target.on("session", (session) => session.on("error", () => {}));
        target.on("stream", (stream) => {
          stream.on("error", () => {});
          stream.resume();
          posted++;
          if (refusal === "rst") stream.close(constants.NGHTTP2_REFUSED_STREAM);
          else stream.session!.goaway(constants.NGHTTP2_NO_ERROR, 0);
        });
        const port = await f.listen(target);
        const owner = f.owner({});
        await assert.rejects(owner.fetch(`https://127.0.0.1:${port}`, { method: "POST", body }));
        await setImmediate();
        assert.equal(posted, 1);
        assert.equal(owner.activeRequestCount, 0);
      },
    );
