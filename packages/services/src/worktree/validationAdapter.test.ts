import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWorktreeValidation } from "./adapters/validation.js";

test("native validation applies frozen environment case-insensitively on Windows and reports actual truncation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-validation-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "probe.cjs");
  await writeFile(script, "process.stdout.write(process.env.PATH || process.env.Path || 'missing');");
  const original = process.env.PATH ?? process.env.Path;
  const key = process.platform === "win32" ? "path" : "PATH";
  const result = await runWorktreeValidation(root, `"${process.execPath}" "${script}"`, undefined, { [key]: "frozen-runtime-only" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "frozen-runtime-only");
  assert.equal(result.outputTruncated, false);
  assert.equal(process.env.PATH ?? process.env.Path, original);
  await writeFile(script, "process.stdout.write('x'.repeat(70000));");
  const bounded = await runWorktreeValidation(root, `"${process.execPath}" "${script}"`);
  assert.equal(bounded.output.length, 65536);
  assert.equal(bounded.outputTruncated, true);
});
