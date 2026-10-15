import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readAgentEntrySha256 } from "./lcodeAgentBuildIdentity.js";

test("agent identity hashes the observed bundle bytes and leaves unknown commands unidentified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-entry-identity-"));
  try {
    await writeFile(join(directory, "lcode.cjs"), "fixture");
    assert.equal(
      await readAgentEntrySha256({ cwd: directory, args: ["lcode.cjs"] }),
      createHash("sha256").update("fixture").digest("hex"),
    );
    assert.equal(await readAgentEntrySha256({ args: ["unknown.cjs"] }), undefined);
    assert.equal(await readAgentEntrySha256({ args: [] }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
