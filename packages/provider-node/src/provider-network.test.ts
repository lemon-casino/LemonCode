import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostApiNetworkTransport,
  resolveProviderNetworkOptions,
  type HostApiNetworkOptions,
} from "./provider-network.js";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";

test("API and OAuth share provider network precedence without leaking global bypass", () => {
  const defaults = {
    httpProxy: "http://localhost:7890",
    noProxy: ".default.invalid",
    caCertPath: "fixture.pem",
  };
  assert.deepEqual(resolveProviderNetworkOptions(undefined, defaults), {
    caCertPath: "fixture.pem",
    forceDirect: true,
  });
  assert.deepEqual(resolveProviderNetworkOptions(null, defaults), {
    caCertPath: "fixture.pem",
    forceDirect: true,
  });
  assert.deepEqual(resolveProviderNetworkOptions({ mode: "default" }, defaults), defaults);
  assert.deepEqual(resolveProviderNetworkOptions({ mode: "direct" }, defaults), {
    caCertPath: "fixture.pem",
    forceDirect: true,
  });
  assert.deepEqual(
    resolveProviderNetworkOptions({ mode: "custom", httpProxy: "http://localhost:7891" }, defaults),
    {
      httpProxy: "http://localhost:7891",
      noProxy: undefined,
      caCertPath: "fixture.pem",
      forceDirect: true,
    },
  );
});

test("live provider requests use separate CONNECT proxies, accept Node Request and return to direct", async (t) => {
  const connections = new Set<import("node:stream").Duplex>();
  const target = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.end(`${req.headers["x-fixture"]}:${Buffer.concat(chunks).toString()}`);
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const address = target.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/model`;
  const proxies = await Promise.all(
    [1, 2].map(async () => {
      let hits = 0;
      const server = createServer();
      server.on("connect", (_req, socket, head) => {
        hits++;
        const upstream = connect(address.port, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        connections.add(socket);
        connections.add(upstream);
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const proxyAddress = server.address();
      assert.ok(proxyAddress && typeof proxyAddress !== "string");
      return { server, url: `http://127.0.0.1:${proxyAddress.port}`, hits: () => hits };
    }),
  );
  let policy: HostApiNetworkOptions = { httpProxy: proxies[0]!.url, forceDirect: true };
  const transport = createHostApiNetworkTransport(async () => policy);
  t.after(() => {
    transport.dispose();
    for (const socket of connections) socket.destroy();
    target.closeAllConnections();
    target.close();
    for (const proxy of proxies) proxy.server.close();
  });
  const request = () =>
    new Request(url, { method: "POST", headers: { "x-fixture": "test" }, body: "payload" });
  assert.equal(await (await transport.fetch(request())).text(), "test:payload");
  assert.equal(proxies[0]!.hits(), 1);
  policy = { httpProxy: proxies[1]!.url, forceDirect: true };
  assert.equal(await (await transport.fetch(request())).text(), "test:payload");
  assert.equal(proxies[1]!.hits(), 1);
  policy = { forceDirect: true };
  assert.equal(await (await transport.fetch(request())).text(), "test:payload");
  policy = { httpProxy: "invalid://bad", forceDirect: true };
  await assert.rejects(transport.fetch(request()), /invalid/);
  assert.deepEqual(
    proxies.map((proxy) => proxy.hits()),
    [1, 1],
  );
});
