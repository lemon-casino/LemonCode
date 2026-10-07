import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedServiceProcesses } from "./adapters/managedServices.js";

const key = { environmentId: "b".repeat(32), serviceId: "dev:web", generation: 1 };
const HTTP_SCRIPT = String.raw`
const http = require('node:http');
for (const name of ['LCODE_SERVER_PORT', 'LCODE_WEB_PORT']) {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({
    name, data: process.env.LCODE_DATA_BASE_DIR, marker: process.env.TEST_FROZEN
  })));
  server.on('error', error => { process.stderr.write(error.code); process.exit(1); });
  server.listen(Number(process.env[name]), '127.0.0.1', () => {
    process.stdout.write('Listening http://127.0.0.1:' + server.address().port + '\n');
  });
}
`;
const config = {
  definitions: { "dev:web": { portEnvironment: ["LCODE_SERVER_PORT", "LCODE_WEB_PORT"] } },
};
const spawnParams = (cwd: string, argv = [process.execPath, "-e", HTTP_SCRIPT]) => ({
  ...key,
  cwd,
  argv,
  env: { ...process.env, LCODE_DATA_BASE_DIR: join(cwd, "private"), TEST_FROZEN: "frozen-value" },
});

async function withTemp(action: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-managed-http-"));
  try {
    await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  "real HTTP service group gets distinct ephemeral loopback ports and private frozen env",
  { timeout: 30_000 },
  async () => {
    await withTemp(async (cwd) => {
      const port = createManagedServiceProcesses(config);
      const closed = Promise.withResolvers<number>();
      port.onExit!(key, async (exitCode) => {
        closed.resolve(exitCode);
      });
      try {
        const handle = await port.start(spawnParams(cwd));
        assert.equal(handle.urls.length, 2);
        assert.equal(new Set(handle.urls.map((url) => new URL(url).port)).size, 2);
        const bodies = await Promise.all(
          handle.urls.map(async (url) => {
            const body: unknown = await (await fetch(url)).json();
            assert.ok(
              typeof body === "object" &&
                body !== null &&
                "name" in body &&
                "data" in body &&
                "marker" in body,
            );
            return body;
          }),
        );
        assert.deepEqual(
          new Set(bodies.map((body) => body.name)),
          new Set(["LCODE_SERVER_PORT", "LCODE_WEB_PORT"]),
        );
        for (const body of bodies) {
          assert.equal(body.data, join(cwd, "private"));
          assert.equal(body.marker, "frozen-value");
        }
        const proof = await port.stop({ ...key, pid: 1 }); // PID 故意错误：授权来自原 child 句柄。
        assert.ok(proof);
        await closed.promise;
        for (const url of handle.urls) {
          await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) }));
        }
      } finally {
        await port.stop(key);
      }
    });
  },
);

test(
  "unknown adapter owner cannot stop another owner's service, even with its real PID",
  { timeout: 30_000 },
  async () => {
    await withTemp(async (cwd) => {
      const owner = createManagedServiceProcesses(config);
      const other = createManagedServiceProcesses(config);
      try {
        const handle = await owner.start(spawnParams(cwd));
        assert.equal(await other.stop({ ...key, pid: handle.pid }), undefined);
        assert.equal((await fetch(handle.urls[0]!)).status, 200);
        assert.equal(await owner.stop({ ...key, generation: 2, pid: handle.pid }), undefined);
      } finally {
        await owner.stop(key);
      }
    });
  },
);

test(
  "fixed occupied port fails EADDRINUSE instead of adopting an unrelated listener",
  { timeout: 30_000 },
  async () => {
    await withTemp(async (cwd) => {
      const occupied = createServer((_req, response) => response.end("unrelated"));
      await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
      const address = occupied.address();
      assert.ok(address && typeof address === "object");
      const port = createManagedServiceProcesses(config);
      try {
        await assert.rejects(
          port.start({ ...spawnParams(cwd), ports: [address.port, 0] }),
          /port-bind-failed|EADDRINUSE/,
        );
        assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), "unrelated");
      } finally {
        await port.stop(key);
        await new Promise<void>((resolve, reject) =>
          occupied.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
);

test(
  "startup must observe every declared endpoint and rejects partial readiness",
  { timeout: 30_000 },
  async () => {
    await withTemp(async (cwd) => {
      const port = createManagedServiceProcesses({ ...config, startupTimeoutMs: 700 });
      const partial = HTTP_SCRIPT.replace(
        "['LCODE_SERVER_PORT', 'LCODE_WEB_PORT']",
        "['LCODE_SERVER_PORT']",
      );
      try {
        await assert.rejects(
          port.start(spawnParams(cwd, [process.execPath, "-e", partial])),
          /listening|startup/,
        );
        assert.ok(await port.stop(key));
      } finally {
        await port.stop(key);
      }
    });
  },
);

test(
  "startup failure output stays bounded and does not leak credentials or env values",
  { timeout: 30_000 },
  async () => {
    await withTemp(async (cwd) => {
      const port = createManagedServiceProcesses({ startupTimeoutMs: 800 });
      const script =
        "process.stderr.write('secret-api-key='.repeat(50000));process.stderr.write('http://user:secret@127.0.0.1:1234/?token=secret');process.exit(1)";
      try {
        await assert.rejects(
          port.start(spawnParams(cwd, [process.execPath, "-e", script])),
          (error: Error) => {
            assert.ok(error.message.length < 2048);
            assert.doesNotMatch(error.message, /secret|frozen-value|user:/);
            return true;
          },
        );
      } finally {
        await port.stop(key);
      }
    });
  },
);

test(
  "Host disposal awaits owned close, rejects new starts and does not affect other owners",
  { timeout: 30_000 },
  async () => {
    await withTemp(async (cwd) => {
      const owner = createManagedServiceProcesses(config);
      const other = createManagedServiceProcesses(config);
      try {
        const [owned, unrelated] = await Promise.all([
          owner.start(spawnParams(cwd)),
          other.start(spawnParams(cwd)),
        ]);
        await owner.disposeAndWait();
        for (const url of owned.urls)
          await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) }));
        assert.equal((await fetch(unrelated.urls[0]!)).status, 200);
        await assert.rejects(owner.start({ ...spawnParams(cwd), generation: 2 }), /cancelled/);
        await owner.disposeAndWait();
      } finally {
        await Promise.all([owner.disposeAndWait(), other.disposeAndWait()]);
      }
    });
  },
);

test(
  "aborted startup never leaves a late listening process behind",
  { timeout: 30_000 },
  async () => {
    await withTemp(async (cwd) => {
      const controller = new AbortController();
      const port = createManagedServiceProcesses(config);
      const start = port.start({ ...spawnParams(cwd), signal: controller.signal });
      controller.abort();
      await assert.rejects(start, /cancelled|abort/);
      assert.ok(await port.stop(key));
    });
  },
);
