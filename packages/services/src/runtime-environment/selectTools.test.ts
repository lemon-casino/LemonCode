import assert from "node:assert/strict";
import { test } from "node:test";
import { satisfies, validRange } from "semver";
import { parseProjectDeclarations, type ProjectDeclarations } from "./domain/declarations.js";
import { buildToolResolutionPlan, selectToolsForFreeze } from "./domain/selectTools.js";

const defaults = [
  { key: "node", version: "24.14.0" },
  { key: "pnpm", version: "10.33.2" },
];
const empty = (): ProjectDeclarations => ({
  tools: [],
  lockfiles: [],
  ambiguousLocks: false,
  issues: [],
});
function nodeDeclarations(...constraints: string[]): ProjectDeclarations {
  const sources = ["mise.toml", ".node-version", ".nvmrc"] as const;
  return {
    ...empty(),
    tools: constraints.map((constraint, index) => ({
      key: "node",
      constraint,
      exact: false,
      source: sources[index]!,
    })),
  };
}

test("memory declarations without new optional fields preserve fixed application defaults", () => {
  const plan = buildToolResolutionPlan(empty(), defaults);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(
    plan.tools,
    defaults.map((tool) => ({ ...tool, source: "app-default" })),
  );
  assert.deepEqual(selectToolsForFreeze(empty(), defaults).tools, plan.tools);
});

test("engines alone validates the application default rather than resolving a different Node", () => {
  const declared = parseProjectDeclarations({
    packageJson: JSON.stringify({ engines: { node: "20 || >=24" } }),
    lockfileNames: [],
  });
  const selected = selectToolsForFreeze(declared, defaults, {
    resolvedVersions: { node: "25.0.0", pnpm: "11.0.0" },
  });
  assert.deepEqual(selected.issues, []);
  assert.deepEqual(
    selected.tools,
    defaults.map((tool) => ({ ...tool, source: "app-default" })),
  );
  declared.engines!.constraint = "<24";
  const plan = buildToolResolutionPlan(declared, defaults);
  assert.deepEqual(plan.requests, []);
  assert.equal(plan.tools[0]?.version, "24.14.0");
  assert.equal(plan.issues[0]?.code, "configuration-conflict");
  assert.equal(plan.issues[0]?.field, "engines.node");
});

test("exact declarations and packageManager avoid backend range resolution", () => {
  const parsed = parseProjectDeclarations({
    miseToml: '[tools]\nnode = "24.14.0"\npnpm = "^10"\n',
    nodeVersionFile: ">=24 <25",
    packageJson: JSON.stringify({ packageManager: "pnpm@10.33.2" }),
    lockfileNames: [],
  });
  const plan = buildToolResolutionPlan(parsed, defaults);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(
    plan.tools,
    defaults.map((tool) => ({ ...tool, source: "project-declaration" })),
  );
});

test("multiple OR constraints are combined as a Cartesian intersection", () => {
  const declared = nodeDeclarations("20 || 22 || 24", "22 || >=25", ">=21 <24 || >=26");
  const plan = buildToolResolutionPlan(declared, defaults);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.requests.length, 1);
  const request = plan.requests[0]!;
  assert.equal(request.key, "node");
  assert.ok(validRange(request.constraint));
  for (const version of [
    "20.9.0",
    "21.9.0",
    "22.0.0",
    "22.15.0",
    "23.0.0",
    "24.0.0",
    "25.0.0",
    "26.0.0",
  ]) {
    assert.equal(
      satisfies(version, request.constraint),
      declared.tools.every((tool) => satisfies(version, tool.constraint)),
      version,
    );
  }
  const frozen = selectToolsForFreeze(declared, defaults, {
    resolvedVersions: { node: "22.15.0" },
  });
  assert.deepEqual(frozen.issues, []);
  assert.equal(frozen.tools[0]?.source, "project-declaration");
  assert.equal(frozen.tools[0]?.version, "22.15.0");
});

test("engines intersects tool ranges before requesting a backend version", () => {
  const declared = nodeDeclarations("20 || 24");
  declared.engines = { key: "node", constraint: ">=22", source: "package.json#engines" };
  const plan = buildToolResolutionPlan(declared, defaults);
  assert.deepEqual(plan.issues, []);
  assert.equal(satisfies("20.19.0", plan.requests[0]!.constraint), false);
  assert.equal(satisfies("24.14.0", plan.requests[0]!.constraint), true);
});

test("empty range intersections are conflicts and never reach the backend", () => {
  for (const constraints of [
    ["20 || 22", "24 || 26"],
    ["^0.2.3", ">=0.3.0"],
    [">1.0.0 <1.0.1"],
    ["^1 || ^2", "^2 || ^3", "^1 || ^3"],
    [">=1.2.3-beta <1.2.3", "*"],
  ]) {
    const plan = buildToolResolutionPlan(nodeDeclarations(...constraints), defaults);
    assert.equal(plan.issues[0]?.code, "configuration-conflict", constraints.join(" AND "));
    assert.deepEqual(plan.requests, []);
  }
});

test("prereleases remain excluded unless every selected source branch permits their tuple", () => {
  const cases = [
    [">=1.2.3-beta <2", "*"],
    [">=1.2.3-beta <2", ">=1.2.3-alpha <2"],
    [">=1.2.3-beta <2 || ^3", ">=1.3.0-alpha <2 || ^3"],
    ["^0.2.3 || >=1.2.3-beta <1.2.3", "0.x || >=1.2.3-alpha <1.2.3"],
  ];
  for (const constraints of cases) {
    const declared = nodeDeclarations(...constraints);
    const plan = buildToolResolutionPlan(declared, defaults);
    assert.deepEqual(plan.issues, []);
    const range = plan.requests[0]!.constraint;
    for (const version of [
      "0.2.3",
      "0.2.4",
      "0.3.0",
      "1.2.3-alpha",
      "1.2.3-beta",
      "1.2.3-beta.1",
      "1.2.3",
      "1.2.4-alpha",
      "1.3.0-alpha",
      "1.3.0",
      "2.0.0-alpha",
      "3.0.0",
      "3.1.0-beta",
    ]) {
      assert.equal(
        satisfies(version, range),
        constraints.every((value) => satisfies(version, value)),
        `${constraints.join(" AND ")}: ${version}`,
      );
    }
  }
});

test("hyphen, zero-major caret and wildcard plans retain semver behavior", () => {
  for (const constraints of [["0.2.0 - 0.4", "^0.2.3"], ["24.x", "*"], ["*"]]) {
    const declared = nodeDeclarations(...constraints);
    const plan = buildToolResolutionPlan(declared, defaults);
    assert.deepEqual(plan.issues, []);
    for (const version of ["0.0.0", "0.2.2", "0.2.3", "0.3.0", "24.0.0", "24.14.0", "25.0.0"]) {
      assert.equal(
        satisfies(version, plan.requests[0]!.constraint),
        constraints.every((range) => satisfies(version, range)),
      );
    }
  }
});

test("selection rejects unresolved ranges and backend versions outside any original constraint", () => {
  const declared = nodeDeclarations("22 || 24", ">=24");
  assert.equal(selectToolsForFreeze(declared, defaults).issues[0]?.code, "unsupported-declaration");
  const invalid = selectToolsForFreeze(declared, defaults, {
    resolvedVersions: { node: "22.15.0" },
  });
  assert.equal(invalid.issues[0]?.code, "configuration-conflict");
  const malformed = selectToolsForFreeze(declared, defaults, {
    resolvedVersions: { node: "latest" },
  });
  assert.equal(malformed.issues[0]?.code, "unsupported-declaration");
});

test("exact packageManager must satisfy a range in mise.toml", () => {
  const declared = parseProjectDeclarations({
    miseToml: '[tools]\npnpm = "^9 || ^11"\n',
    packageJson: JSON.stringify({ packageManager: "pnpm@10.33.2" }),
    lockfileNames: [],
  });
  const plan = buildToolResolutionPlan(declared, defaults);
  assert.equal(plan.issues[0]?.code, "configuration-conflict");
  assert.deepEqual(plan.requests, []);
});

test("npm is bundled with frozen Node and its exact requested version remains a verification requirement without locks", () => {
  const declared = parseProjectDeclarations({
    packageJson: JSON.stringify({ packageManager: "npm@10.9.0" }),
    lockfileNames: [],
  });
  for (const result of [
    buildToolResolutionPlan(declared, defaults),
    selectToolsForFreeze(declared, defaults),
  ]) {
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.tools, [{ key: "node", version: "24.14.0", source: "app-default" }]);
    assert.equal(result.bundledNpmVersion, "10.9.0");
  }
});

test("injected unknown managers and tools cannot bypass static validation", () => {
  const manager = empty();
  manager.packageManager = {
    key: "yarn",
    version: "1.22.22",
    source: "package.json#packageManager",
  };
  assert.equal(
    buildToolResolutionPlan(manager, defaults).issues[0]?.code,
    "unsupported-declaration",
  );
  const tool = empty();
  tool.tools = [{ key: "python", constraint: "3.12.0", exact: true, source: "mise.toml" }];
  assert.equal(buildToolResolutionPlan(tool, defaults).issues[0]?.code, "unsupported-declaration");
});

test("injected malformed ranges return structured issues rather than throwing", () => {
  const plan = buildToolResolutionPlan(nodeDeclarations("lts/*"), defaults);
  assert.equal(plan.issues[0]?.code, "unsupported-declaration");
  assert.deepEqual(plan.requests, []);
});
