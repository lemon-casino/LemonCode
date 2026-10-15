import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { SSHBackend } from "../packages/server/src/remote/ssh-backend.ts";
import { materializeRemotePromptAttachments } from "../packages/desktop/src/host/remotePromptAttachments.ts";

const { Server } = createRequire(new URL("../packages/server/package.json", import.meta.url))(
  "ssh2",
);

test(
  "folder attachment uses the real SSH backend and SFTP streams for every file",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-folder-ssh-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "中文 ' nested"));
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "中文 ' nested", "data.txt"), "SSH folder contents");
    await writeFile(join(root, "zero"), "");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const files = new Map();
    const commands = [];
    const clients = new Set();
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      clients.add(client);
      client.on("error", () => {});
      client.on("close", () => clients.delete(client));
      client.on("authentication", (context) => context.accept());
      client.on("ready", () =>
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            commands.push(info.command);
            const stream = acceptExec();
            if (info.command.includes("HOME")) stream.write("/home/fixture");
            stream.exit(0);
            stream.end(() => stream.close());
          });
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            const handles = new Map();
            let nextHandle = 0;
            sftp.on("OPEN", (id, path) => {
              const handle = Buffer.alloc(4);
              handle.writeUInt32BE(++nextHandle);
              handles.set(handle.toString("hex"), path);
              files.set(path, Buffer.alloc(0));
              sftp.handle(id, handle);
            });
            sftp.on("WRITE", (id, handle, offset, data) => {
              const path = handles.get(handle.toString("hex"));
              const previous = files.get(path);
              const next = Buffer.alloc(Math.max(previous.length, offset + data.length));
              previous.copy(next);
              data.copy(next, offset);
              files.set(path, next);
              sftp.status(id, 0);
            });
            sftp.on("CLOSE", (id, handle) => {
              handles.delete(handle.toString("hex"));
              sftp.status(id, 0);
            });
          });
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const backend = new SSHBackend({
      host: "127.0.0.1",
      port: server.address().port,
      username: "fixture",
      password: "fixture-only",
    });
    t.after(async () => {
      backend.dispose();
      for (const client of clients) client._sock.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    const progress = [];
    const result = await materializeRemotePromptAttachments(
      {
        content: "",
        traceId: "fixture-ssh",
        attachments: [{ kind: "file", filename: "folder", localPath: root, sizeBytes: 0 }],
      },
      { backend, uploadOptions: { onProgress: (p) => progress.push(p) } },
    );
    const remote = result.attachments[0].localPath;
    assert.equal(result.attachments[0].mimeType, "inode/directory");
    assert.equal(files.get(`${remote}/中文 ' nested/data.txt`).toString(), "SSH folder contents");
    assert.equal(files.get(`${remote}/zero`).length, 0);
    assert.equal(files.size, 2);
    assert.ok(commands.some((command) => command.includes(`${remote}/empty`)));
    assert.deepEqual(progress.at(-1), { uploadedBytes: 19, totalBytes: 19 });
  },
);
