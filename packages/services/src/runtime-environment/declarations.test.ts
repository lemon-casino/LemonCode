import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  parseProjectDeclarations,
  serializeDeclarations,
  type DeclarationInputs,
} from "./domain/declarations.js";
import { checkEnginesConstraint } from "./domain/engines.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function parse(inputs: Partial<DeclarationInputs> = {}) {
  const lockfileNames = inputs.lockfileNames ?? [];
  return parseProjectDeclarations({
    lockfileNames,
    lockfileDigests: Object.fromEntries(lockfileNames.map((name) => [name, sha(`${name}\n`)])),
    ...inputs,
  });
}

test("mise.toml exact tools preserve project declarations", () => {
  const parsed = parse({
    miseToml: '[tools]\nnode = "24.14.0"\npnpm = "10.33.2"\n',
    lockfileNames: ["pnpm-lock.yaml"],
  });
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(
    parsed.tools.map((tool) => [tool.key, tool.constraint, tool.exact]),
    [
      ["node", "24.14.0", true],
      ["pnpm", "10.33.2", true],
    ],
  );
});

test("standard static semver syntax is accepted without inventing a version", () => {
  for (const constraint of ["22", "22 || >=24", "20 - 22", "0.x", "^0.2.3", "~24.14.0", "*"]) {
    const parsed = parse({ miseToml: `[tools]\nnode = "${constraint}"\n` });
    assert.deepEqual(parsed.issues, [], constraint);
    assert.deepEqual(parsed.tools[0], {
      key: "node",
      constraint,
      exact: false,
      source: "mise.toml",
    });
  }
  const prerelease = parse({ nodeVersionFile: "v24.0.0-rc.1\n" });
  assert.deepEqual(prerelease.issues, []);
  assert.equal(prerelease.tools[0]?.constraint, "24.0.0-rc.1");
  assert.equal(prerelease.tools[0]?.exact, true);
});

test("dynamic tool syntax and unknown tools are rejected without echoing values", () => {
  const parsed = parse({
    miseToml: "[tools]\nnode = { version = '24', token = 'fixture-secret' }\npython = '3.12'\n",
  });
  assert.equal(parsed.tools.length, 0);
  assert.equal(parsed.issues.length, 2);
  assert.equal(parsed.issues[0]?.code, "unsupported-declaration");
  assert.equal(parsed.issues[0]?.field, "tools.node");
  assert.ok(!JSON.stringify(parsed).includes("fixture-secret"));
});

test("invalid TOML and JSON produce safe unsupported-declaration issues", () => {
  assert.equal(parse({ miseToml: "[tools\nnode=1" }).issues[0]?.source, "mise.toml");
  const invalid = parse({ packageJson: '{"token":"fixture-secret",' });
  assert.equal(invalid.issues[0]?.code, "unsupported-declaration");
  assert.ok(!JSON.stringify(invalid).includes("fixture-secret"));
});

test("different exact versions report both sources instead of discarding one", () => {
  const parsed = parse({
    miseToml: '[tools]\nnode = "24.14.0"\n',
    nodeVersionFile: "20.11.1\n",
  });
  const conflict = parsed.issues.find((entry) => entry.code === "configuration-conflict");
  assert.ok(conflict);
  assert.match(conflict.message, /mise\.toml/);
  assert.match(conflict.message, /\.node-version/);
  assert.equal(parsed.tools.length, 2);
});

test("the same exact version in two sources is not a conflict", () => {
  const parsed = parse({
    miseToml: '[tools]\nnode = "24.14.0"\n',
    nodeVersionFile: "v24.14.0\n",
  });
  assert.deepEqual(parsed.issues, []);
});

test("multiple range sources are retained for intersection", () => {
  const parsed = parse({
    miseToml: '[tools]\nnode = "20 || 22 || 24"\n',
    nodeVersionFile: ">=22 <25\n",
    nvmrcFile: "24.x\n",
  });
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.tools.length, 3);
});

test("empty and multi-line version files are unsupported", () => {
  assert.equal(
    parse({ nodeVersionFile: "20.11.1\n22.0.0\n" }).issues[0]?.message,
    "只支持单行版本声明",
  );
  assert.equal(parse({ nodeVersionFile: "# only comment\n\n" }).issues[0]?.message, "文件为空");
});

test("packageManager exact pnpm and bundled npm versions are preserved", () => {
  for (const manager of ["pnpm", "npm"]) {
    const parsed = parse({
      packageJson: JSON.stringify({ packageManager: `${manager}@10.9.0+sha512.abc` }),
    });
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.packageManager, {
      key: manager,
      version: "10.9.0",
      source: "package.json#packageManager",
    });
  }
});

test("unknown managers and non-exact packageManager declarations are rejected", () => {
  for (const packageManager of [
    "pnpm@latest",
    "npm@^10",
    "yarn@1.22.22",
    "bun@1.2.3",
    "deno@2.0.0",
  ]) {
    const parsed = parse({ packageJson: JSON.stringify({ packageManager }) });
    assert.equal(parsed.packageManager, undefined, packageManager);
    assert.equal(parsed.issues[0]?.code, "unsupported-declaration", packageManager);
  }
});

test("multiple manager locks without packageManager remain ambiguous", () => {
  const parsed = parse({ lockfileNames: ["pnpm-lock.yaml", "package-lock.json"] });
  assert.equal(parsed.ambiguousLocks, true);
  assert.equal(parsed.issues[0]?.code, "configuration-conflict");
});

test("an explicit packageManager selects only its matching lock and digest", () => {
  const input = {
    packageJson: JSON.stringify({ packageManager: "npm@10.9.0" }),
    lockfileNames: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
    lockfileDigests: { "package-lock.json": sha("npm-lock-v1") },
  };
  const parsed = parse(input);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.ambiguousLocks, false);
  assert.deepEqual(parsed.lockfiles, [{ name: "package-lock.json", digest: sha("npm-lock-v1") }]);
  assert.equal(
    serializeDeclarations(parsed),
    serializeDeclarations(
      parse({
        ...input,
        lockfileDigests: { ...input.lockfileDigests, "pnpm-lock.yaml": sha("ignored-lock-v2") },
      }),
    ),
  );
});

test("packageManager mismatching all disk locks is a conflict", () => {
  const parsed = parse({
    packageJson: JSON.stringify({ packageManager: "npm@10.9.0" }),
    lockfileNames: ["pnpm-lock.yaml"],
  });
  const conflict = parsed.issues.find((entry) => entry.code === "configuration-conflict");
  assert.match(conflict?.message ?? "", /pnpm/);
  assert.equal(parsed.lockfiles.length, 0);
});

test("unknown locks and unsupported managers are not silently adopted", () => {
  const unknown = parse({ lockfileNames: ["pnpm-lock.yaml", "Cargo.lock"] });
  assert.equal(unknown.lockfiles.length, 1);
  assert.equal(unknown.issues[0]?.field, "Cargo.lock");
  for (const name of ["yarn.lock", "bun.lock", "bun.lockb"]) {
    assert.ok(
      parse({ lockfileNames: [name] }).issues.some(
        (entry) => entry.code === "unsupported-declaration",
      ),
    );
  }
});

test("lock inputs require real SHA-256 digests, not filenames or content strings", () => {
  for (const digest of [undefined, "lock-v1", "0123456789abcdef"]) {
    const parsed = parseProjectDeclarations({
      lockfileNames: ["pnpm-lock.yaml"],
      ...(digest ? { lockfileDigests: { "pnpm-lock.yaml": digest } } : {}),
    });
    assert.equal(parsed.issues[0]?.code, "unsupported-declaration");
    assert.equal(parsed.lockfiles[0]?.digest, "missing");
  }
});

test("engines-only input is a constraint, not a fabricated tool declaration", () => {
  const parsed = parse({ packageJson: JSON.stringify({ engines: { node: ">=20" } }) });
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.tools, []);
  assert.equal(parsed.engines?.constraint, ">=20");
});

test("engines follows standard OR, hyphen, caret-zero, wildcard and prerelease rules", () => {
  for (const [constraint, version, accepted] of [
    [">=20 <25", "24.14.0", true],
    [">=20 <25", "18.0.0", false],
    ["20 || >=22", "24.14.0", true],
    ["20 || >=22", "21.1.0", false],
    ["20 - 22", "22.9.9", true],
    ["20 - 22", "23.0.0", false],
    ["^0.2.3", "0.2.9", true],
    ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.4", false],
    ["~24.14.0", "24.14.3", true],
    ["~24.14.0", "24.15.0", false],
    ["24.x", "24.14.0", true],
    ["*", "24.0.0-rc.1", false],
    [">=24.0.0-rc.1 <25", "24.0.0-rc.2", true],
    [">=24.0.0-rc.1 <25", "24.1.0-rc.1", false],
  ] as const) {
    const issue = checkEnginesConstraint(version, {
      key: "node",
      constraint,
      source: "package.json#engines",
    });
    assert.equal(issue === null, accepted, `${version} satisfies ${constraint}`);
    if (!accepted) assert.equal(issue?.code, "configuration-conflict");
  }
});

test("engines rejects dynamic or invalid syntax without guessing", () => {
  const issue = checkEnginesConstraint("24.14.0", {
    key: "node",
    constraint: "lts/*",
    source: "package.json#engines",
  });
  assert.equal(issue?.code, "unsupported-declaration");
});

test("canonical serialization is not a digest and is stable across input property order", () => {
  const first = parse({
    miseToml: '[tools]\nnode = "24.14.0"\npnpm = "10.33.2"\n',
    lockfileNames: ["pnpm-lock.yaml"],
    configurationDigests: {
      ".npmrc": sha("npm-config"),
      "pnpm-workspace.yaml": sha("workspace-config"),
    },
  });
  const reordered = {
    ...first,
    tools: first.tools
      .toReversed()
      .map(({ source, exact, constraint, key }) => ({ source, exact, constraint, key })),
    lockfiles: first.lockfiles.map(({ digest, name }) => ({ digest, name })),
    configurationDigests: {
      "pnpm-workspace.yaml": sha("workspace-config"),
      ".npmrc": sha("npm-config"),
    },
  };
  const serialized = serializeDeclarations(first);
  assert.equal(serialized, serializeDeclarations(reordered));
  assert.match(serialized, /^\{/);
  assert.match(sha(serialized), /^[a-f0-9]{64}$/);
});

test("lock and configuration content digests independently change the declaration digest", () => {
  const input = {
    lockfileNames: ["pnpm-lock.yaml"],
    lockfileDigests: { "pnpm-lock.yaml": sha("lock-v1") },
    configurationDigests: { ".npmrc": sha("config-v1") },
  };
  const baseline = sha(serializeDeclarations(parse(input)));
  assert.notEqual(
    baseline,
    sha(
      serializeDeclarations(
        parse({ ...input, lockfileDigests: { "pnpm-lock.yaml": sha("lock-v2") } }),
      ),
    ),
  );
  assert.notEqual(
    baseline,
    sha(
      serializeDeclarations(
        parse({ ...input, configurationDigests: { ".npmrc": sha("config-v2") } }),
      ),
    ),
  );
});

test("invalid configuration digests cannot publish credentials as a digest", () => {
  const parsed = parse({ configurationDigests: { ".npmrc": "fixture-secret-token" } });
  assert.equal(parsed.issues[0]?.code, "unsupported-declaration");
  assert.ok(!JSON.stringify(parsed).includes("fixture-secret-token"));
  assert.ok(!serializeDeclarations(parsed).includes("fixture-secret-token"));
});
