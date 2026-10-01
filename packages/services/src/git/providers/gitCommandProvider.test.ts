import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";
import { createGitCommandProvider } from "./gitCommandProvider.js";

async function chunks(stdout: Buffer[], stderr: Buffer[], maxOutputBytes = 1024) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const spawnMock = mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => {
      for (const chunk of stdout) child.stdout.write(chunk);
      for (const chunk of stderr) child.stderr.write(chunk);
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcess;
  });
  syncBuiltinESMExports();
  try {
    return await createGitCommandProvider({
      environmentProvider: {
        resolveGitBinary: async () => "git-fixture",
        createCommandEnv: () => ({}),
      },
    }).run({ cwd: process.cwd(), args: [], maxOutputBytes });
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
}

test("stdout/stderr 独立跨块解码中文与 emoji，不改变有效 UTF-8 字节", async () => {
  const out = Buffer.from("中文🙂\n");
  const err = Buffer.from("警告🚀\n");
  const result = await chunks(
    [...out].map((byte) => Buffer.from([byte])),
    [err.subarray(0, 1), err.subarray(1, 8), err.subarray(8)],
  );
  assert.equal(result.stdout, out.toString("utf8"));
  assert.equal(result.stderr, err.toString("utf8"));
  assert.equal(result.outputTruncated, false);
});

test("结束时刷新不完整尾字节，不能静默删除无效 UTF-8", async () => {
  const result = await chunks([Buffer.from([0x61, 0xe4, 0xb8])], [Buffer.from([0xf0, 0x9f])]);
  assert.equal(result.stdout, "a\uFFFD");
  assert.equal(result.stderr, "\uFFFD");
});

test("输出限制仍按原始字节计算，不能被多字节解码绕过", async () => {
  const result = await chunks([Buffer.from("中"), Buffer.from("文")], [], 4);
  assert.equal(result.stdout, "中");
  assert.equal(result.outputTruncated, true);
});
