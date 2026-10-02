import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import test from "node:test";
import { assertRegistryCurrent, buildFileHashParts } from "./bash-command-registry-content.mjs";

function hashFiles(files) {
  const hash = createHash("sha256");
  for (const [relativePath, bytes] of files) {
    for (const part of buildFileHashParts(relativePath, bytes)) {
      hash.update(part);
    }
  }
  return hash.digest("hex");
}

test("Windows and POSIX relative paths produce identical source hashes", () => {
  const entries = [
    [["root.js"], Buffer.from("root\n")],
    [["nested", "command.js"], Buffer.from("command\r\n")],
    [["nested", "deeper", "data.bin"], Buffer.from([0, 0x80, 0xff])],
  ];
  const filesFor = (path) => entries.map(([parts, bytes]) => [path.join(...parts), bytes]);
  assert.equal(hashFiles(filesFor(win32)), hashFiles(filesFor(posix)));
});

test("hash input keeps the original byte buffer and NUL boundaries", () => {
  const bytes = Buffer.from([0x41, 0x0d, 0x0a, 0, 0x80, 0xff]);
  const parts = buildFileHashParts("nested/command.js", bytes);
  assert.deepEqual(parts, ["nested/command.js", "\0", bytes, "\0"]);
  assert.equal(parts[2], bytes);
  const expected = createHash("sha256")
    .update("nested/command.js\0")
    .update(bytes)
    .update("\0")
    .digest("hex");
  assert.equal(hashFiles([["nested/command.js", bytes]]), expected);
});

test("hashing preserves the supplied traversal order", () => {
  const files = [
    ["nested/z.js", Buffer.from("first")],
    ["root.js", Buffer.from("second")],
  ];
  const expected = createHash("sha256")
    .update("nested/z.js\0first\0root.js\0second\0")
    .digest("hex");
  assert.equal(hashFiles(files), expected);
  assert.notEqual(hashFiles(files), hashFiles([...files].reverse()));
});

test("source bytes and path changes still change the hash", () => {
  const original = hashFiles([["command.js", Buffer.from("source\n")]]);
  for (const [path, bytes] of [
    ["command.js", Buffer.from("changed\n")],
    ["command.js", Buffer.from("source\r\n")],
    ["renamed.js", Buffer.from("source\n")],
  ]) {
    assert.notEqual(hashFiles([[path, bytes]]), original);
  }
  assert.notEqual(hashFiles([["ab", Buffer.from("c")]]), hashFiles([["a", Buffer.from("bc")]]));
});

const SOURCE_HASH = "0123456789abcdef".repeat(4);
const GENERATED = [
  "/* eslint-disable */",
  "// Generated registry fixture.",
  `// Source: @withfig/autocomplete@2.692.3 (ISC); hash: ${SOURCE_HASH}.`,
  "// Skipped: imports=0, dynamicSubcommands=0, invalidNodes=0, loadSpecNodes=522.",
  'export const BASH_COMMAND_REGISTRY_VERSION = "fig-2.692.3";',
  `export const BASH_COMMAND_REGISTRY_HASH = "${SOURCE_HASH}";`,
  'export const BASH_COMMAND_REGISTRY = {"echo":[["echo"],[],0,[]]};',
  "",
].join("\n");
const LF = Buffer.from(GENERATED);
const CRLF = Buffer.from(GENERATED.replaceAll("\n", "\r\n"));

function assertStale(actual, expected) {
  assert.throws(() => assertRegistryCurrent(actual, expected), {
    message:
      "Generated Bash command registry is stale. Run `pnpm --dir apps/lcode-cli registry:generate`.",
  });
}

test("identical registry files pass", () => {
  assert.doesNotThrow(() => assertRegistryCurrent(LF, LF));
  assert.doesNotThrow(() => assertRegistryCurrent(CRLF, CRLF));
});

test("LF, CRLF and mixed checkout line endings are equivalent", () => {
  const mixed = Buffer.from(GENERATED.replace("\n", "\r\n"));
  for (const actual of [LF, CRLF, mixed]) {
    for (const expected of [LF, CRLF, mixed]) {
      assert.doesNotThrow(() => assertRegistryCurrent(actual, expected));
    }
  }
});

for (const [label, changed] of [
  ["header", GENERATED.replace("Generated registry fixture.", "Changed registry fixture.")],
  ["source hash header", GENERATED.replace(`hash: ${SOURCE_HASH}`, `hash: ${"f".repeat(64)}`)],
  [
    "exported hash",
    GENERATED.replace(`REGISTRY_HASH = "${SOURCE_HASH}"`, `REGISTRY_HASH = "${"f".repeat(64)}"`),
  ],
  ["source version", GENERATED.replace("autocomplete@2.692.3", "autocomplete@2.692.4")],
  ["exported version", GENERATED.replace("fig-2.692.3", "fig-2.692.4")],
  ["body", GENERATED.replaceAll('"echo"', '"printf"')],
  ["whitespace", GENERATED.replace(" = ", "  = ")],
  ["missing final newline", GENERATED.slice(0, -1)],
  ["extra final newline", `${GENERATED}\n`],
]) {
  test(`registry check rejects ${label} drift with either checkout line ending`, () => {
    for (const actual of [LF, CRLF]) {
      for (const expected of [changed, changed.replaceAll("\n", "\r\n")]) {
        assertStale(actual, Buffer.from(expected));
        assertStale(Buffer.from(expected), actual);
      }
    }
  });
}

test("registry check does not normalize lone CR or double CR", () => {
  assertStale(LF, Buffer.from(GENERATED.replace("\n", "\r")));
  assertStale(LF, Buffer.from(GENERATED.replace("\n", "\r\r\n")));
});

test("registry check preserves byte differences that UTF-8 decoding would erase", () => {
  assertStale(Buffer.from([0xff, 0x0a]), Buffer.from([0xfe, 0x0d, 0x0a]));
  assertStale(Buffer.from([0xef, 0xbf, 0xbd, 0x0a]), Buffer.from([0xff, 0x0a]));
  assert.doesNotThrow(() =>
    assertRegistryCurrent(Buffer.from([0xff, 0x0a]), Buffer.from([0xff, 0x0d, 0x0a])),
  );
});
