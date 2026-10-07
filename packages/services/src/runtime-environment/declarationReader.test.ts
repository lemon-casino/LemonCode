import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  createDeclarationReader,
  type DeclarationReaderIO,
} from "./adapters/declarationsReader.js";
import { serializeDeclarations } from "./domain/declarations.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface MemoryFile {
  bytes: Buffer;
  inode: number;
  changedAt: number;
  size?: number;
  regular?: boolean;
}
function memoryIO(
  initial: Record<string, string | Buffer>,
  options: {
    chunkSize?: number;
    afterRead?: (file: MemoryFile, name: string, files: Map<string, MemoryFile>) => void;
    readNothing?: boolean;
  } = {},
) {
  const files = new Map<string, MemoryFile>(
    Object.entries(initial).map(([name, value], index) => [
      name,
      {
        bytes: Buffer.from(value),
        inode: index + 1,
        changedAt: 1,
      },
    ]),
  );
  const closed: string[] = [];
  const opened: string[] = [];
  let reads = 0;
  const missing = () => Object.assign(new Error("missing fixture file"), { code: "ENOENT" });
  const statOf = (file: MemoryFile) => ({
    size: file.size ?? file.bytes.length,
    mtimeMs: file.changedAt,
    ctimeMs: file.changedAt,
    dev: 1,
    ino: file.inode,
    isFile: () => file.regular !== false,
  });
  const io: DeclarationReaderIO = {
    async stat(path) {
      const file = files.get(basename(path));
      if (!file) throw missing();
      return statOf(file);
    },
    async open(path) {
      const name = basename(path);
      const file = files.get(name);
      if (!file) throw missing();
      opened.push(name);
      return {
        async stat() {
          return statOf(file);
        },
        async read(buffer, offset, length, position) {
          reads += 1;
          const bytesRead = options.readNothing
            ? 0
            : Math.min(
                length,
                options.chunkSize ?? length,
                Math.max(0, file.bytes.length - position),
              );
          if (bytesRead) file.bytes.copy(buffer, offset, position, position + bytesRead);
          options.afterRead?.(file, name, files);
          return { bytesRead };
        },
        async close() {
          closed.push(name);
        },
      };
    },
  };
  return { io, files, closed, opened, readCount: () => reads };
}

test("reader hashes actual binary lock and configuration bytes without publishing config secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-declaration-reader-"));
  try {
    const lock = Buffer.from([0x66, 0x6f, 0x80, 0xff, 0x0d, 0x0a]);
    const config = "//registry.example.invalid/:_authToken=fixture-secret\r\n";
    const workspace = "packages:\n  - packages/*\n";
    await Promise.all([
      writeFile(join(root, "pnpm-lock.yaml"), lock),
      writeFile(join(root, ".npmrc"), config),
      writeFile(join(root, "pnpm-workspace.yaml"), workspace),
      writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.33.2" })),
    ]);
    const parsed = await createDeclarationReader().read(root);
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.lockfiles, [{ name: "pnpm-lock.yaml", digest: sha(lock) }]);
    assert.deepEqual(parsed.configurationDigests, {
      ".npmrc": sha(config),
      "pnpm-workspace.yaml": sha(workspace),
    });
    assert.ok(!JSON.stringify(parsed).includes("fixture-secret"));
    assert.ok(!serializeDeclarations(parsed).includes("fixture-secret"));
    await writeFile(join(root, ".npmrc"), `${config}strict-peer-dependencies=true\n`);
    assert.notEqual(
      serializeDeclarations(parsed),
      serializeDeclarations(await createDeclarationReader().read(root)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader continues short reads to EOF rather than hashing a partial prefix", async () => {
  const fixture = memoryIO(
    { "pnpm-lock.yaml": "complete-lock-contents", ".npmrc": "fixture-secret" },
    { chunkSize: 2 },
  );
  const parsed = await createDeclarationReader(fixture.io).read("/fixture");
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.lockfiles[0]?.digest, sha("complete-lock-contents"));
  assert.equal(parsed.configurationDigests?.[".npmrc"], sha("fixture-secret"));
  assert.ok(fixture.readCount() > 2);
  assert.deepEqual(fixture.closed.toSorted(), [".npmrc", "pnpm-lock.yaml"]);
});

test("empty present files are hashed while missing files remain absent", async () => {
  const fixture = memoryIO({ "pnpm-lock.yaml": "", ".npmrc": "" });
  const parsed = await createDeclarationReader(fixture.io).read("/fixture");
  assert.deepEqual(parsed.lockfiles, [{ name: "pnpm-lock.yaml", digest: sha("") }]);
  assert.deepEqual(parsed.configurationDigests, { ".npmrc": sha("") });
  const missing = await createDeclarationReader(memoryIO({}).io).read("/fixture");
  assert.deepEqual(missing.lockfiles, []);
  assert.deepEqual(missing.tools, []);
});

test("premature EOF is rejected and its handle is closed", async () => {
  const fixture = memoryIO({ "pnpm-lock.yaml": "not-fully-read" }, { readNothing: true });
  await assert.rejects(
    createDeclarationReader(fixture.io).read("/fixture"),
    /changed while reading/i,
  );
  assert.deepEqual(fixture.closed, ["pnpm-lock.yaml"]);
});

test("same-size mutation, growth and truncation during a read are rejected", async () => {
  for (const change of ["replace", "grow", "truncate"]) {
    let mutated = false;
    const fixture = memoryIO(
      { "pnpm-lock.yaml": "original-lock" },
      {
        chunkSize: 2,
        afterRead(file) {
          if (mutated) return;
          mutated = true;
          file.bytes = Buffer.from(
            change === "replace"
              ? "different-val"
              : change === "grow"
                ? "original-lock-added"
                : "x",
          );
          file.changedAt += 1;
        },
      },
    );
    await assert.rejects(
      createDeclarationReader(fixture.io).read("/fixture"),
      /changed while reading/i,
      change,
    );
    assert.deepEqual(fixture.closed, ["pnpm-lock.yaml"]);
  }
});

test("path replacement is detected even when the open handle and timestamps stay stable", async () => {
  let replaced = false;
  const fixture = memoryIO(
    { "pnpm-lock.yaml": "original-lock" },
    {
      afterRead(file, name, files) {
        if (replaced) return;
        replaced = true;
        files.set(name, { ...file, inode: file.inode + 100 });
      },
    },
  );
  await assert.rejects(
    createDeclarationReader(fixture.io).read("/fixture"),
    /changed while reading/i,
  );
});

test("a file added during another declaration read invalidates the aggregate snapshot", async () => {
  let added = false;
  const fixture = memoryIO(
    { "pnpm-lock.yaml": "original-lock" },
    {
      afterRead(_file, _name, files) {
        if (added) return;
        added = true;
        files.set(".npmrc", { bytes: Buffer.from("fixture-secret"), inode: 100, changedAt: 1 });
      },
    },
  );
  await assert.rejects(
    createDeclarationReader(fixture.io).read("/fixture"),
    /changed while reading/i,
  );
});

test("file deletion after opening invalidates the declaration snapshot", async () => {
  const fixture = memoryIO(
    { "pnpm-lock.yaml": "original-lock" },
    {
      afterRead(_file, name, files) {
        files.delete(name);
      },
    },
  );
  await assert.rejects(
    createDeclarationReader(fixture.io).read("/fixture"),
    /changed while reading/i,
  );
  assert.deepEqual(fixture.closed, ["pnpm-lock.yaml"]);
});

test("oversized declarations/config and locks are rejected before opening or allocating their contents", async () => {
  for (const [name, size] of [
    ["package.json", 1024 * 1024 + 1],
    [".npmrc", 1024 * 1024 + 1],
    ["pnpm-lock.yaml", 32 * 1024 * 1024 + 1],
  ] as const) {
    const fixture = memoryIO({ [name]: "x" });
    const file: MemoryFile = fixture.files.get(name)!;
    file.size = size;
    await assert.rejects(createDeclarationReader(fixture.io).read("/fixture"), /read limit/i, name);
    assert.deepEqual(fixture.opened, []);
  }
});

test("non-regular files cannot be treated as complete empty declarations", async () => {
  const fixture = memoryIO({ "package.json": "{}" });
  const file: MemoryFile = fixture.files.get("package.json")!;
  file.regular = false;
  await assert.rejects(createDeclarationReader(fixture.io).read("/fixture"), /regular file/i);
  assert.deepEqual(fixture.opened, []);
});

test("permission errors are not mistaken for missing optional configuration", async () => {
  const fixture = memoryIO({});
  fixture.io.stat = async () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  await assert.rejects(createDeclarationReader(fixture.io).read("/fixture"), /denied/);
});
