import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./network-http2-process.fixture.ts", import.meta.url));
for (const protocol of ["h1", "h2"])
  for (const order of [
    ["a", "b"],
    ["b", "a"],
  ])
    for (const tail of ["data", "empty"])
      test(`${protocol}: normal ${order.join("→")} completion with ${tail} stays inside one physical attempt`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "lcode-h2-process-"));
        try {
          const { stdout } = await run(
            process.execPath,
            ["--import", "tsx", fixture, directory, protocol, JSON.stringify(order), tail],
            {
              timeout: 8_000,
              windowsHide: true,
            },
          );
          assert.deepEqual(JSON.parse(stdout.trim()), {
            completed: order,
            sessions: protocol === "h1" ? 0 : 1,
            posted: 2,
          });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

for (const order of [
  ["c", "a", "b"],
  ["h", "b", "f", "d", "a", "g", "c", "e"],
])
  test(`h2: ${order.length} streams finish out of order without cross-stream settlement`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-h2-process-"));
    try {
      const { stdout } = await run(
        process.execPath,
        ["--import", "tsx", fixture, directory, "h2", JSON.stringify(order), "data"],
        {
          timeout: 8_000,
          windowsHide: true,
        },
      );
      assert.equal(JSON.parse(stdout.trim()).posted, order.length);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("Electron embedded Node completes eight concurrent H2 POSTs in one owned session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-h2-electron-"));
  const electron = createRequire(new URL("../../desktop/package.json", import.meta.url))(
    "electron",
  );
  const order = ["h", "b", "f", "d", "a", "g", "c", "e"];
  try {
    const { stdout } = await run(
      electron,
      ["--import", "tsx", fixture, directory, "h2", JSON.stringify(order), "data"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 8_000, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(stdout.trim()), { completed: order, sessions: 1, posted: 8 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one H2 owner drains 32 waves of eight out-of-order POSTs without replay or retained leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-h2-soak-"));
  const order = ["h", "b", "f", "d", "a", "g", "c", "e"];
  try {
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", fixture, directory, "h2", JSON.stringify(order), "data", "32"],
      { timeout: 8_000, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(stdout.trim()), { completed: order, sessions: 1, posted: 256 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
