import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Emitter } from "@lcode/rpc";
import type { IRemoteBackend } from "@lcode/server/remote";
import { quotePosixPathArg } from "@lcode/server/remote/posixShell.js";
import {
  materializeRemotePromptAttachments,
  cleanupRemotePromptAttachment,
  cleanupStaleRemotePromptAttachments,
} from "./remotePromptAttachments.js";
import { createRemotePromptAttachmentTransferService } from "./promptAttachmentTransferService.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-directory-attachment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commands: string[] = [];
  const uploads: { local: string; remote: string }[] = [];
  const backend: Pick<IRemoteBackend, "exec" | "upload"> = {
    async exec(command) {
      commands.push(command);
      const close = new Emitter<number>();
      const stdout = new PassThrough();
      setImmediate(() => {
        stdout.end(command === 'printf %s "$HOME"' ? "/home/fixture" : "");
        close.fire(0);
      });
      return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), onClose: close.event };
    },
    async upload(local, remote, options) {
      const { readFile } = await import("node:fs/promises");
      const bytes = (await readFile(local)).length;
      uploads.push({ local, remote });
      options?.onProgress?.({ uploadedBytes: bytes, totalBytes: bytes });
    },
  };
  const materialize = (
    path: string,
    signal?: AbortSignal,
    onProgress?: (p: { uploadedBytes: number; totalBytes: number }) => void,
  ) =>
    materializeRemotePromptAttachments(
      {
        content: path,
        traceId: "fixture",
        attachments: [
          {
            kind: "file",
            filename: "folder",
            localPath: path,
            mimeType: "application/octet-stream",
            sizeBytes: 0,
          },
        ],
      },
      { backend, uploadOptions: { signal, onProgress } },
    );
  return { root, backend, commands, uploads, materialize };
}

test("directory attachments preserve nested and empty directories and aggregate file bytes", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "子目录 ' space"));
  await mkdir(join(f.root, "empty"));
  await writeFile(join(f.root, "a.txt"), "abc");
  await writeFile(join(f.root, "子目录 ' space", "b.txt"), "12345");
  await writeFile(join(f.root, "zero"), "");
  const progress: { uploadedBytes: number; totalBytes: number }[] = [];
  const result = await f.materialize(f.root, undefined, (p) => progress.push(p));
  const remote = result.attachments![0]!.localPath!;
  assert.equal(result.content, remote);
  assert.equal(result.uploadedCount, 1);
  assert.equal(f.uploads.length, 3);
  assert.ok(f.uploads.some((u) => u.remote === `${remote}/子目录 ' space/b.txt`));
  assert.ok(f.commands.some((c) => c.includes(`mkdir -p ${quotePosixPathArg(`${remote}/empty`)}`)));
  assert.deepEqual(progress.at(-1), { uploadedBytes: 8, totalBytes: 8 });
  assert.ok(
    progress.every(
      (p, i) =>
        p.totalBytes === 8 && (i === 0 || p.uploadedBytes >= progress[i - 1]!.uploadedBytes),
    ),
  );
});

test("empty directory succeeds and single-file upload still works", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.materialize(f.root)).uploadedCount, 1);
  assert.equal(f.uploads.length, 0);
  const file = join(f.root, "file.txt");
  await writeFile(file, "content");
  assert.equal((await f.materialize(file)).uploadedCount, 1);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]!.local, file);
});

test("partial failure and cancellation clean the whole isolated directory", async (t) => {
  for (const cancel of [false, true]) {
    const f = await fixture(t);
    await writeFile(join(f.root, "one"), "1");
    await writeFile(join(f.root, "two"), "2");
    const controller = new AbortController();
    f.backend.upload = async () => {
      if (cancel) controller.abort();
      else throw new Error("fixture-transfer-failed");
    };
    await assert.rejects(f.materialize(f.root, controller.signal));
    assert.ok(f.commands.some((c) => c.includes("rm -rf --")));
  }
});

test("cleanup refuses roots, parent references and traversal", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/home/fixture/.lcode/tmp/prompt-attachments",
    "/home/fixture/.lcode/tmp/prompt-attachments/trace",
    "/home/fixture/.lcode/tmp/prompt-attachments/trace/nonce",
    "/home/fixture/.lcode/tmp/prompt-attachments/trace/../outside",
    "/elsewhere/file",
  ]) {
    await cleanupRemotePromptAttachment(f.backend, path);
  }
  assert.ok(f.commands.every((c) => !c.includes("rm ")));
});

test("janitor does not immediately delete valid empty directories", async (t) => {
  const f = await fixture(t);
  await cleanupStaleRemotePromptAttachments(f.backend);
  assert.ok(
    f.commands.filter((c) => c.includes("find ")).every((c) => !c.includes("-empty -delete")),
  );
});

test("directory traversal rejects junctions and symlinks", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "target"));
  try {
    await symlink(
      join(f.root, "target"),
      join(f.root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink permission unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(f.materialize(f.root));
  assert.equal(f.uploads.length, 0);
});

test("stage returns a directory MIME and real bytes; adopted content survives composer cleanup", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "data"), "123");
  const service = createRemotePromptAttachmentTransferService(f.backend);
  const params = {
    operationId: "fixture-operation",
    draftId: "draft",
    workspacePath: "/same",
    workspaceIdentity: "remote-fixture-a",
    remoteSessionId: "remote-a",
    localPath: f.root,
    fileName: "folder.png",
    mime: "image/png",
    sizeBytes: 4096,
  };
  const first = await service.stage(params);
  assert.equal(first.mime, "inode/directory");
  assert.equal(first.bytes, 3);
  await service.adopt(params.operationId);
  await service.cleanup(params.operationId);
  assert.ok(!f.commands.some((c) => c.startsWith("rm -rf")));
  const second = await service.stage({
    ...params,
    workspaceIdentity: "remote-fixture-b",
    remoteSessionId: "remote-b",
  });
  assert.notEqual(first.ref, second.ref);
  await service.cancel(params.operationId);
  assert.ok(f.commands.some((c) => c.startsWith(`rm -rf -- ${quotePosixPathArg(second.ref)}`)));
  assert.ok(!f.commands.some((c) => c.startsWith(`rm -rf -- ${quotePosixPathArg(first.ref)}`)));
});

test("permission failure after upload rolls back the directory", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "data"), "content");
  const exec = f.backend.exec;
  f.backend.exec = async (command) => {
    const stream = await exec(command);
    if (!command.startsWith("command chmod 600 ")) return stream;
    return { ...stream, onClose: (listener) => stream.onClose(() => listener(1)) };
  };
  await assert.rejects(f.materialize(f.root));
  assert.equal(f.uploads.length, 1);
  assert.ok(f.commands.some((command) => command.startsWith("rm -rf -- ")));
});
