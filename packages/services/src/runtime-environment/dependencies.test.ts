import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DependencyReceipt } from "@lcode/shared";
import { parseProjectDeclarations, type ProjectDeclarations } from "./domain/declarations.js";
import {
  buildDependencyInstallPlan,
  isReceiptFresh,
  PNPM_IMPORT_METHOD_ENV,
} from "./domain/dependencies.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function declarations(lockfileNames: string[], packageManager?: string) {
  return parseProjectDeclarations({
    ...(packageManager ? { packageJson: JSON.stringify({ packageManager }) } : {}),
    lockfileNames,
    lockfileDigests: Object.fromEntries(
      lockfileNames.map((name) => [name, sha(`contents:${name}`)]),
    ),
  });
}

test("pnpm lock builds a frozen install using its real content digest", () => {
  const plan = buildDependencyInstallPlan(declarations(["pnpm-lock.yaml"]));
  assert.deepEqual(plan, {
    manager: "pnpm",
    command: "pnpm install --frozen-lockfile",
    lockDigest: sha("contents:pnpm-lock.yaml"),
  });
});

test("npm lock builds npm ci and preserves the bundled npm verification version", () => {
  assert.deepEqual(buildDependencyInstallPlan(declarations(["package-lock.json"], "npm@10.9.0")), {
    manager: "npm",
    managerVersion: "10.9.0",
    command: "npm ci",
    lockDigest: sha("contents:package-lock.json"),
  });
});

test("explicit packageManager chooses the matching lock regardless of lock order", () => {
  for (const manager of ["npm", "pnpm"]) {
    const name = manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
    for (const lockfileNames of [
      ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
      ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"],
    ]) {
      const plan = buildDependencyInstallPlan(declarations(lockfileNames, `${manager}@10.9.0`));
      assert.equal(plan?.manager, manager);
      assert.equal(plan?.managerVersion, "10.9.0");
      assert.equal(plan?.lockDigest, sha(`contents:${name}`));
    }
  }
});

test("dependency planning also respects packageManager in injected memory declarations", () => {
  const parsed: ProjectDeclarations = {
    tools: [],
    packageManager: { key: "npm", version: "10.9.0", source: "package.json#packageManager" },
    lockfiles: [
      { name: "pnpm-lock.yaml", digest: sha("pnpm-lock") },
      { name: "package-lock.json", digest: sha("npm-lock") },
    ],
    ambiguousLocks: false,
    issues: [],
  };
  assert.equal(buildDependencyInstallPlan(parsed)?.manager, "npm");
  assert.equal(buildDependencyInstallPlan(parsed)?.lockDigest, sha("npm-lock"));
});

test("unsupported managers and mismatched locks never produce an install plan", () => {
  for (const name of ["yarn.lock", "bun.lock", "bun.lockb"]) {
    assert.equal(buildDependencyInstallPlan(declarations([name])), null);
  }
  assert.equal(buildDependencyInstallPlan(declarations(["pnpm-lock.yaml"], "npm@10.9.0")), null);
  assert.equal(buildDependencyInstallPlan(declarations(["pnpm-lock.yaml"], "yarn@1.22.22")), null);
});

test("no lock returns null without pretending a frozen install occurred", () => {
  assert.equal(buildDependencyInstallPlan(declarations([])), null);
  assert.equal(buildDependencyInstallPlan(declarations([], "npm@10.9.0")), null);
});

test("ambiguous locks return null rather than preferring the first supported manager", () => {
  const parsed = declarations(["pnpm-lock.yaml", "package-lock.json"]);
  assert.equal(parsed.ambiguousLocks, true);
  assert.equal(buildDependencyInstallPlan(parsed), null);
});

test("missing or invalid digest cannot yield a frozen install plan", () => {
  const parsed = parseProjectDeclarations({ lockfileNames: ["pnpm-lock.yaml"] });
  assert.equal(buildDependencyInstallPlan(parsed), null);
  parsed.issues = [];
  assert.equal(buildDependencyInstallPlan(parsed), null);
});

test("pnpm import method explicitly avoids shared hardlinked dependencies", () => {
  assert.equal(PNPM_IMPORT_METHOD_ENV.npm_config_package_import_method, "clone-or-copy");
});

const identity = {
  declarationDigest: sha("declarations-v1"),
  nodeVersion: "24.14.0",
  platform: "windows" as const,
  arch: "x64" as const,
};
const plan = {
  manager: "pnpm" as const,
  command: "pnpm install --frozen-lockfile",
  lockDigest: sha("lock-v1"),
};
const receipt: DependencyReceipt = {
  environmentId: "e1",
  manager: plan.manager,
  command: plan.command,
  strategy: "frozen",
  lockDigest: plan.lockDigest,
  ...identity,
  exitCode: 0,
  finishedAt: "2026-10-05T00:00:00.000Z",
};

test("matching successful receipt remains reusable for legacy memory inputs", () => {
  assert.equal(isReceiptFresh(receipt, plan, identity), true);
});

test("lock/config/ABI/platform/command changes and failures invalidate the receipt", () => {
  for (const changed of [
    { lockDigest: sha("lock-v2") },
    { declarationDigest: sha("config-v2") },
    { nodeVersion: "20.0.0" },
    { platform: "linux" as const },
    { arch: "arm64" as const },
    { manager: "npm" as const },
    { command: "pnpm install" },
    { exitCode: 1 },
    { strategy: "non-frozen" as const },
  ]) {
    assert.equal(
      isReceiptFresh({ ...receipt, ...changed }, plan, identity),
      false,
      JSON.stringify(changed),
    );
  }
  assert.equal(isReceiptFresh(null, plan, identity), false);
});

test("frozen manager and manifest identity require explicit matching receipt evidence", () => {
  const current = { ...identity, managerVersion: "10.33.2", manifestDigest: sha("manifest-v1") };
  const verified = {
    ...receipt,
    managerVersion: current.managerVersion,
    manifestDigest: current.manifestDigest,
  };
  assert.equal(isReceiptFresh(receipt, plan, current), false);
  assert.equal(isReceiptFresh(verified, plan, current), true);
  assert.equal(isReceiptFresh(verified, plan, { ...current, managerVersion: "10.34.0" }), false);
  assert.equal(
    isReceiptFresh(verified, plan, { ...current, manifestDigest: sha("manifest-v2") }),
    false,
  );
  assert.equal(isReceiptFresh({ ...verified, managerVersion: undefined }, plan, current), false);
  assert.equal(isReceiptFresh({ ...verified, manifestDigest: undefined }, plan, current), false);
});
