import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProjectDeclarations } from "./domain/declarations.js";
import {
  buildDependencyInstallPlan,
  isReceiptFresh,
  PNPM_IMPORT_METHOD_ENV,
} from "./domain/dependencies.js";

test("pnpm lock builds frozen pnpm install plan", () => {
  const parsed = parseProjectDeclarations({ lockfileNames: ["pnpm-lock.yaml"] });
  const plan = buildDependencyInstallPlan(parsed);
  assert.equal(plan?.manager, "pnpm");
  assert.equal(plan?.command, "pnpm install --frozen-lockfile");
  assert.equal(plan?.lockDigest.length, 16);
});

test("npm/yarn/bun locks map to their managers", () => {
  assert.equal(
    buildDependencyInstallPlan(parseProjectDeclarations({ lockfileNames: ["package-lock.json"] }))
      ?.manager,
    "npm",
  );
  assert.equal(
    buildDependencyInstallPlan(parseProjectDeclarations({ lockfileNames: ["yarn.lock"] }))?.manager,
    "yarn",
  );
  assert.equal(
    buildDependencyInstallPlan(parseProjectDeclarations({ lockfileNames: ["bun.lock"] }))?.manager,
    "bun",
  );
});

test("no lockfile returns null (no fake frozen install)", () => {
  assert.equal(buildDependencyInstallPlan(parseProjectDeclarations({ lockfileNames: [] })), null);
});

test("ambiguous locks return null (do not guess manager)", () => {
  const parsed = parseProjectDeclarations({
    packageJson: "{}",
    lockfileNames: ["pnpm-lock.yaml", "yarn.lock"],
  });
  assert.equal(parsed.ambiguousLocks, true);
  assert.equal(buildDependencyInstallPlan(parsed), null);
});

test("pnpm import method env forces clone-or-copy (no hardlink auto)", () => {
  assert.equal(PNPM_IMPORT_METHOD_ENV.npm_config_package_import_method, "clone-or-copy");
});

const identity = {
  declarationDigest: "digest-1",
  nodeVersion: "24.14.0",
  platform: "windows" as const,
  arch: "x64" as const,
};

const plan = {
  manager: "pnpm" as const,
  command: "pnpm install --frozen-lockfile",
  lockDigest: "lock-1",
};

test("fresh receipt with matching digest/ABI/platform is reusable", () => {
  const receipt = {
    environmentId: "e1",
    manager: "pnpm" as const,
    command: plan.command,
    strategy: "frozen" as const,
    lockDigest: plan.lockDigest,
    declarationDigest: identity.declarationDigest,
    nodeVersion: identity.nodeVersion,
    platform: identity.platform,
    arch: identity.arch,
    exitCode: 0,
    finishedAt: "2026-10-05T00:00:00.000Z",
  };
  assert.equal(isReceiptFresh(receipt, plan, identity), true);
});

test("stale receipt on lock change / ABI change / failure forces reinstall", () => {
  const base = {
    environmentId: "e1",
    manager: "pnpm" as const,
    command: plan.command,
    strategy: "frozen" as const,
    lockDigest: plan.lockDigest,
    declarationDigest: identity.declarationDigest,
    nodeVersion: identity.nodeVersion,
    platform: identity.platform,
    arch: identity.arch,
    exitCode: 0,
    finishedAt: "2026-10-05T00:00:00.000Z",
  };
  assert.equal(
    isReceiptFresh({ ...base, lockDigest: "lock-2" }, plan, identity),
    false,
    "lock digest change must invalidate",
  );
  assert.equal(
    isReceiptFresh({ ...base, nodeVersion: "20.0.0" }, plan, identity),
    false,
    "Node ABI change must invalidate",
  );
  assert.equal(
    isReceiptFresh({ ...base, exitCode: 1 }, plan, identity),
    false,
    "failed install is never fresh",
  );
  assert.equal(
    isReceiptFresh({ ...base, strategy: "non-frozen" }, plan, identity),
    false,
    "non-frozen receipt cannot satisfy frozen plan",
  );
});
