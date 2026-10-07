import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer as createViteServer, loadConfigFromFile } from "vite";
import WebSocket, { WebSocketServer } from "ws";
import {
  assertRuntimeDevelopmentDataRoot,
  resolveDesktopPort,
  resolveServerHost,
  resolveServerPort,
  resolveServerProxyHost,
  resolveWebPort,
  withDefaultDevelopmentDataRoot,
} from "./runtime-development-env.mjs";

const webConfigFile = fileURLToPath(new URL("../packages/web/vite.config.ts", import.meta.url));

function assertPortError(callback, name) {
  assert.throws(callback, new RegExp(`${name} must be a decimal integer from 1 to 65535`));
}

test("development ports use defaults, strict range validation, and server precedence", () => {
  assert.equal(resolveWebPort({}), 5173);
  assert.equal(resolveServerPort({}), 3030);
  assert.equal(resolveDesktopPort({}), 5174);
  assert.equal(resolveWebPort({ LCODE_WEB_PORT: " 5373 " }), 5373);
  assert.equal(resolveServerPort({ PORT: "3031" }), 3031);
  assert.equal(resolveServerPort({ PORT: "3031", LCODE_SERVER_PORT: "3032" }), 3032);

  for (const value of ["0", "65536", "1.5", "1e3", "0x100", "nope", "1 2"]) {
    assertPortError(() => resolveWebPort({ LCODE_WEB_PORT: value }), "LCODE_WEB_PORT");
    assertPortError(() => resolveServerPort({ LCODE_SERVER_PORT: value }), "LCODE_SERVER_PORT");
    assertPortError(() => resolveDesktopPort({ LCODE_DESKTOP_PORT: value }), "LCODE_DESKTOP_PORT");
  }
  assertPortError(() => resolveServerPort({ PORT: "0" }), "PORT");
  assertPortError(
    () => resolveServerPort({ PORT: "3031", LCODE_SERVER_PORT: "bad" }),
    "LCODE_SERVER_PORT",
  );
});

test("development backend defaults to loopback and proxy keeps explicit backend host", () => {
  assert.equal(resolveServerHost({}), "localhost");
  assert.equal(resolveServerHost({ HOST: "127.0.0.1" }), "127.0.0.1");
  assert.equal(resolveServerProxyHost({}), "localhost");
  assert.equal(resolveServerProxyHost({ LCODE_SERVER_HOST: "0.0.0.0" }), "127.0.0.1");
  assert.equal(resolveServerProxyHost({ LCODE_SERVER_HOST: "::1" }), "[::1]");
});

test("runtime identity cannot silently reuse the control Host data root", () => {
  assert.doesNotThrow(() => assertRuntimeDevelopmentDataRoot({}));
  assert.doesNotThrow(() =>
    assertRuntimeDevelopmentDataRoot({
      LCODE_RUNTIME_ENVIRONMENT_ID: "environment-a",
      LCODE_DATA_BASE_DIR: "C:/runtime-a",
    }),
  );
  assert.throws(
    () => assertRuntimeDevelopmentDataRoot({ LCODE_RUNTIME_ENVIRONMENT_ID: "environment-a" }),
    /LCODE_RUNTIME_ENVIRONMENT_ID requires an explicit LCODE_DATA_BASE_DIR/,
  );

  assert.deepEqual(withDefaultDevelopmentDataRoot({}, "C:/user/.lcode-dev-home"), {
    LCODE_DATA_BASE_DIR: "C:/user/.lcode-dev-home",
  });
  assert.deepEqual(
    withDefaultDevelopmentDataRoot(
      { LCODE_DATA_BASE_DIR: "C:/private-a" },
      "C:/user/.lcode-dev-home",
    ),
    { LCODE_DATA_BASE_DIR: "C:/private-a" },
  );
  assert.deepEqual(
    withDefaultDevelopmentDataRoot(
      { LCODE_RUNTIME_ENVIRONMENT_ID: "environment-a", LCODE_DATA_BASE_DIR: "C:/private-a" },
      "C:/user/.lcode-dev-home",
    ),
    { LCODE_RUNTIME_ENVIRONMENT_ID: "environment-a", LCODE_DATA_BASE_DIR: "C:/private-a" },
  );
});

async function findFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function startBackend(port, id) {
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/instance") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.send(id);
      webSocket.close();
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    port,
    async close() {
      webSocketServer.close();
      server.close();
      await once(server, "close");
    },
  };
}

async function loadWebDevelopmentConfig(webPort, serverPort) {
  const previous = {
    LCODE_WEB_PORT: process.env.LCODE_WEB_PORT,
    LCODE_SERVER_PORT: process.env.LCODE_SERVER_PORT,
    LCODE_RUNTIME_ENVIRONMENT_ID: process.env.LCODE_RUNTIME_ENVIRONMENT_ID,
    LCODE_DATA_BASE_DIR: process.env.LCODE_DATA_BASE_DIR,
  };
  process.env.LCODE_WEB_PORT = String(webPort);
  process.env.LCODE_SERVER_PORT = String(serverPort);
  delete process.env.LCODE_RUNTIME_ENVIRONMENT_ID;
  delete process.env.LCODE_DATA_BASE_DIR;
  try {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      webConfigFile,
      "silent",
    );
    assert.ok(loaded?.config, "web Vite config should load through the Vite API");
    return loaded.config;
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function startWeb(config) {
  const server = await createViteServer({
    ...config,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [],
    server: {
      ...config.server,
      host: "127.0.0.1",
    },
  });
  await server.listen();
  return server;
}

async function readWebSocket(url) {
  return await new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url);
    webSocket.once("message", (message) => {
      resolve(message.toString());
      webSocket.close();
    });
    webSocket.once("error", reject);
  });
}

test("two Vite instances use separate backend ports and strictPort rejects collisions", async () => {
  const backendA = await startBackend(await findFreePort(), "backend-a");
  const backendB = await startBackend(await findFreePort(), "backend-b");
  let webA;
  let webB;
  let duplicate;
  try {
    const configA = await loadWebDevelopmentConfig(await findFreePort(), backendA.port);
    const configB = await loadWebDevelopmentConfig(await findFreePort(), backendB.port);
    const webPortA = configA.server.port;
    const webPortB = configB.server.port;
    assert.notEqual(webPortA, webPortB);
    assert.equal(configA.server.strictPort, true);

    webA = await startWeb(configA);
    webB = await startWeb(configB);
    const addressA = webA.httpServer.address();
    const addressB = webB.httpServer.address();
    assert.ok(addressA && typeof addressA === "object");
    assert.ok(addressB && typeof addressB === "object");
    assert.notEqual(addressA.port, addressB.port);

    const responseA = await fetch(`http://127.0.0.1:${addressA.port}/api/instance`);
    const responseB = await fetch(`http://127.0.0.1:${addressB.port}/api/instance`);
    assert.deepEqual(await responseA.json(), { id: "backend-a" });
    assert.deepEqual(await responseB.json(), { id: "backend-b" });
    assert.equal(await readWebSocket(`ws://127.0.0.1:${addressA.port}/ws`), "backend-a");
    assert.equal(await readWebSocket(`ws://127.0.0.1:${addressB.port}/ws`), "backend-b");

    duplicate = await createViteServer({
      ...configA,
      configFile: false,
      plugins: [],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { ...configA.server, host: "127.0.0.1" },
    });
    await assert.rejects(duplicate.listen(), /already in use|EADDRINUSE|strictPort/i);
  } finally {
    await duplicate?.close().catch(() => {});
    await webA?.close().catch(() => {});
    await webB?.close().catch(() => {});
    await backendA.close();
    await backendB.close();
  }
});
