import assert from "node:assert/strict";
import { test } from "node:test";
import { digestDeclarations, parseProjectDeclarations } from "./domain/declarations.js";
import { checkEnginesConstraint } from "./domain/engines.js";

test("mise.toml exact tools freeze with project-declaration source", () => {
  const parsed = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "24.14.0"\npnpm = "10.33.2"\n',
    lockfileNames: ["pnpm-lock.yaml"],
  });
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(
    parsed.tools.map((tool) => [tool.key, tool.constraint, tool.exact]),
    [
      ["node", "24.14.0", true],
      ["pnpm", "10.33.2", true],
    ],
  );
});

test("range constraints are preserved but flagged not exact", () => {
  const parsed = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "22"\n',
    lockfileNames: [],
  });
  assert.equal(parsed.issues.length, 0);
  const node = parsed.tools.find((tool) => tool.key === "node");
  assert.equal(node?.exact, false);
  assert.equal(node?.constraint, "22");
});

test("dynamic tool syntax is unsupported, not guessed", () => {
  const parsed = parseProjectDeclarations({
    miseToml: "[tools]\nnode = { version = '24', foo = 'bar' }\n",
    lockfileNames: [],
  });
  assert.equal(parsed.tools.length, 0);
  assert.equal(parsed.issues[0]?.code, "unsupported-declaration");
  assert.equal(parsed.issues[0]?.field, "tools.node");
});

test("invalid TOML reports unsupported-declaration", () => {
  const parsed = parseProjectDeclarations({
    miseToml: "[tools\nnode=1",
    lockfileNames: [],
  });
  assert.equal(parsed.issues[0]?.code, "unsupported-declaration");
  assert.equal(parsed.issues[0]?.source, "mise.toml");
});

test("version file conflict with mise.toml reports both and prefers mise.toml", () => {
  const parsed = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "24.14.0"\n',
    nodeVersionFile: "20.11.1\n",
    lockfileNames: [],
  });
  const conflict = parsed.issues.find((issue) => issue.code === "configuration-conflict");
  assert.ok(conflict);
  const node = parsed.tools.find((tool) => tool.key === "node");
  assert.equal(node?.constraint, "24.14.0");
});

test("same version in two sources is not a conflict", () => {
  const parsed = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "24.14.0"\n',
    nodeVersionFile: "v24.14.0\n",
    lockfileNames: [],
  });
  assert.equal(parsed.issues.length, 0);
});

test("multi-line version file is unsupported", () => {
  const parsed = parseProjectDeclarations({
    nodeVersionFile: "20.11.1\n22.0.0\n",
    lockfileNames: [],
  });
  assert.equal(parsed.issues[0]?.message, "只支持单行版本声明");
});

test("empty or comment-only version file is unsupported", () => {
  const parsed = parseProjectDeclarations({
    nodeVersionFile: "# only comment\n\n",
    lockfileNames: [],
  });
  assert.equal(parsed.issues[0]?.message, "文件为空");
});

test("packageManager exact version parses; hash suffix stripped", () => {
  const parsed = parseProjectDeclarations({
    packageJson: JSON.stringify({ packageManager: "pnpm@10.33.2+sha512.abc" }),
    lockfileNames: ["pnpm-lock.yaml"],
  });
  assert.equal(parsed.packageManager?.key, "pnpm");
  assert.equal(parsed.packageManager?.version, "10.33.2");
});

test("packageManager non-exact version is unsupported", () => {
  const parsed = parseProjectDeclarations({
    packageJson: JSON.stringify({ packageManager: "pnpm@latest" }),
    lockfileNames: [],
  });
  assert.equal(parsed.issues[0]?.code, "unsupported-declaration");
});

test("multiple manager locks without packageManager is ambiguous", () => {
  const parsed = parseProjectDeclarations({
    packageJson: "{}",
    lockfileNames: ["pnpm-lock.yaml", "yarn.lock"],
  });
  assert.equal(parsed.ambiguousLocks, true);
  assert.equal(parsed.issues[0]?.code, "configuration-conflict");
});

test("packageManager mismatching disk lock is a conflict", () => {
  const parsed = parseProjectDeclarations({
    packageJson: JSON.stringify({ packageManager: "npm@10.9.0" }),
    lockfileNames: ["pnpm-lock.yaml"],
  });
  const conflict = parsed.issues.find((issue) => issue.code === "configuration-conflict");
  assert.ok(conflict?.message.includes("pnpm"));
});

test("unknown lockfile is reported and excluded", () => {
  const parsed = parseProjectDeclarations({
    lockfileNames: "pnpm-lock.yaml Cargo.lock".split(" "),
  });
  assert.equal(parsed.lockfiles.length, 1);
  assert.equal(parsed.issues[0]?.field, "Cargo.lock");
});

test("engines without node declaration source is a conflict", () => {
  const parsed = parseProjectDeclarations({
    packageJson: JSON.stringify({ engines: { node: ">=20" } }),
    lockfileNames: [],
  });
  const conflict = parsed.issues.find((issue) => issue.field === "engines.node");
  assert.ok(conflict);
});

test("engines satisfied / violated by selected exact version", () => {
  const engines = { key: "node", constraint: ">=20 <25", source: "package.json#engines" as const };
  assert.equal(checkEnginesConstraint("24.14.0", engines), null);
  const violated = checkEnginesConstraint("18.0.0", engines);
  assert.equal(violated?.code, "configuration-conflict");
});

test("engines caret and tilde constraints", () => {
  const caret = { key: "node", constraint: "^24.0.0", source: "package.json#engines" as const };
  assert.equal(checkEnginesConstraint("24.14.0", caret), null);
  assert.notEqual(checkEnginesConstraint("25.0.0", caret), null);
  const tilde = { key: "node", constraint: "~24.14.0", source: "package.json#engines" as const };
  assert.equal(checkEnginesConstraint("24.14.3", tilde), null);
  assert.notEqual(checkEnginesConstraint("24.15.0", tilde), null);
});

test("engines unknown syntax is unsupported, not guessed", () => {
  const or = { key: "node", constraint: "20 || >=22", source: "package.json#engines" as const };
  const issue = checkEnginesConstraint("24.14.0", or);
  assert.equal(issue?.code, "unsupported-declaration");
});

test("declaration digest is stable across call order and sensitive to content", () => {
  const a = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "24.14.0"\n',
    lockfileNames: ["pnpm-lock.yaml"],
    lockfileContents: { "pnpm-lock.yaml": "lock-v1" },
  });
  const b = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "24.14.0"\n',
    lockfileNames: ["pnpm-lock.yaml"],
    lockfileContents: { "pnpm-lock.yaml": "lock-v1" },
  });
  const c = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "24.14.1"\n',
    lockfileNames: ["pnpm-lock.yaml"],
    lockfileContents: { "pnpm-lock.yaml": "lock-v1" },
  });
  assert.equal(digestDeclarations(a), digestDeclarations(b));
  assert.notEqual(digestDeclarations(a), digestDeclarations(c));
});
