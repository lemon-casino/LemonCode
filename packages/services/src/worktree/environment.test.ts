import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./testFixture.js";
import { detectWorktreeSetup, detectWorktreeValidation } from "./adapters/environment.js";

test("manifest detection skips ambiguous, malformed and unsupported package managers", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "package.json"), "{}");
  await writeFile(join(f.repo, "pnpm-lock.yaml"), "fixture");
  await writeFile(join(f.repo, "package-lock.json"), "{}");
  assert.deepEqual(await detectWorktreeSetup(f.repo), []);
  await writeFile(
    join(f.repo, "package.json"),
    JSON.stringify({ packageManager: "npm@11.0.0; injected" }),
  );
  assert.deepEqual(await detectWorktreeSetup(f.repo), []);
  await writeFile(join(f.repo, "package.json"), "invalid json");
  assert.deepEqual(await detectWorktreeSetup(f.repo), []);
  assert.deepEqual(await detectWorktreeValidation(f.repo), []);
});

test("validation uses candidate manifests and CI checks, and respects Yarn major versions", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.repo, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.33.2",
      scripts: { typecheck: "tsc", lint: "oxlint", test: "watch", "test:ci": "node --test" },
    }),
  );
  await writeFile(join(f.repo, "pnpm-lock.yaml"), "fixture");
  assert.deepEqual(await detectWorktreeValidation(f.repo), [
    "pnpm install --frozen-lockfile",
    "pnpm run typecheck",
    "pnpm run lint",
    "pnpm run test:ci",
  ]);
  await writeFile(join(f.repo, "package.json"), JSON.stringify({ packageManager: "yarn@4.5.0" }));
  await writeFile(join(f.repo, "yarn.lock"), "fixture");
  assert.deepEqual(await detectWorktreeSetup(f.repo), ["yarn install --immutable"]);
  assert.deepEqual(await detectWorktreeValidation(f.repo), []);
  await unlink(join(f.repo, "package.json"));
  await writeFile(join(f.repo, "go.mod"), "module fixture.invalid\n");
  assert.deepEqual(await detectWorktreeValidation(f.repo), ["go mod download", "go test ./..."]);
});
