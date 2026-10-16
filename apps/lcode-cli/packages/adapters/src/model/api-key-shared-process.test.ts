import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const mode of ["generate", "stream"] as const)
  test(
    `XQP-08 independent SDK processes ${mode}: shared admission and actual settlement precede the next POST`,
    { timeout: 30_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "lcode-quota-process-"));
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let posts = 0;
      const server = createServer((request, response) => {
        const ordinal = ++posts;
        request.resume();
        entered.resolve();
        void (async () => {
          if (ordinal === 1) await release.promise;
          if (mode === "stream") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n',
            );
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: "fixture",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              }),
            );
          }
        })();
      });
      t.after(async () => {
        release.resolve();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const fixture = fileURLToPath(new URL("./api-key-shared-sdk.fixture.ts", import.meta.url));
      const run = promisify(execFile);
      const execute = async () => {
        const result = await run(
          process.execPath,
          ["--import", "tsx", fixture, directory, `http://127.0.0.1:${address.port}`, mode],
          { windowsHide: true, timeout: 20_000 },
        );
        return JSON.parse(result.stdout) as { ok: boolean; requests: number };
      };
      const first = execute();
      await entered.promise;
      const rejected = await execute();
      assert.equal(rejected.ok, false);
      assert.equal(rejected.requests, 0);
      assert.equal(posts, 1);
      release.resolve();
      assert.equal((await first).ok, true);
      assert.equal((await execute()).ok, true);
      assert.equal(posts, 2);
    },
  );
