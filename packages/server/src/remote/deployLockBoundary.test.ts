import assert from "node:assert/strict";
import test from "node:test";
import type { IRemoteBackend } from "./backend.js";
import { deployServer } from "./deploy.js";

test("every deployment acquires the remote install-root lock before reading assets or writing components", async () => {
  for (const legacyMode of [undefined, "caller-serialized"] as const) {
    const stoppedAtLock = new Error("test stops at remote lock boundary");
    const commands: string[] = [];
    const backend: IRemoteBackend = {
      detect: async () => ({ platform: "linux", arch: "x64" }),
      exists: async () => false,
      readFile: async () => {
        throw new Error("unexpected read before lock");
      },
      upload: async () => {
        throw new Error("unexpected upload before lock");
      },
      exec: async (command) => {
        commands.push(command);
        throw stoppedAtLock;
      },
      dispose() {},
    };
    const options = {
      force: true,
      // 老调用方的对象即便残留这个字段，也不能绕过跨窗口安装目录互斥。
      deployLockMode: legacyMode,
      remoteAssetNetwork: {
        fetch: async () => {
          throw new Error("unexpected network before lock");
        },
      },
    };
    await assert.rejects(
      deployServer(backend, await backend.detect(), options),
      (error) => error === stoppedAtLock,
    );
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /\.deploy\.lock/);
  }
});
