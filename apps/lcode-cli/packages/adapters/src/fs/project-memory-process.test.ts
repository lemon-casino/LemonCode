import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { digest, memoryFixture } from "./project-memory.test-support.js";

const adapterUrl = new URL("./index.ts", import.meta.url).href;
const runner = `
  import { NodeFileSystemAdapter } from ${JSON.stringify(adapterUrl)};
  const adapter = new NodeFileSystemAdapter();
  process.send({ ready: true });
  process.once("message", async ({ rootDir, content }) => {
    try {
      await adapter.projectMemory.registerRoot(rootDir);
      await adapter.writeTextFile({ path: rootDir + "/race.md", content, expectedMissing: true });
      process.send({ committed: true });
    } catch (error) { process.send({ code: error.code, message: error.message }); }
    process.disconnect();
  });
`;

test("independent Node processes share the root lock and admit only one missing-file writer", async (t) => {
  const { rootDir, memory } = await memoryFixture(t);
  const children = ["writer-one", "writer-two"].map((content) => {
    const process = spawn(
      globalThis.process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", runner],
      { cwd: new URL("../../../../", import.meta.url), stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    process.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const done = new Promise<{ committed?: boolean; code?: string; message?: string }>(
      (resolve, reject) => {
        let result: { committed?: boolean; code?: string; message?: string } | undefined;
        process.on("message", (message: any) => {
          if (!message.ready) result = message;
        });
        process.on("error", reject);
        process.on("exit", (code) => {
          if (code !== 0 || !result) reject(new Error(stderr || `child exit ${code}`));
          else resolve(result);
        });
      },
    );
    const ready = new Promise<void>((resolve) => process.once("message", () => resolve()));
    t.after(() => {
      if (process.exitCode === null) process.kill();
    });
    return { process, ready, done, content };
  });
  await Promise.all(children.map((child) => child.ready));
  for (const child of children) child.process.send({ rootDir, content: child.content });
  const results = await Promise.all(children.map((child) => child.done));
  assert.equal(results.filter((result) => result.committed).length, 1);
  assert.equal(results.filter((result) => result.code === "stale_write").length, 1);
  const changes = await memory.listChanges(rootDir);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.afterHash, digest(await readFile(join(rootDir, "race.md"), "utf8")));
});
