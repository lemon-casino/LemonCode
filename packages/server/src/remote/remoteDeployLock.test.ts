import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { IRemoteBackend, StdioStream } from "./backend.js";
import { createCloseEventController } from "./closeEvent.js";
import { acquireRemoteDeployLock } from "./remoteDeployLock.js";

async function fixture(t: TestContext, ignoreDestroy = false) {
  const root = await mkdtemp(join(tmpdir(), "lcode-deploy-lock-"));
  const children: ChildProcessWithoutNullStreams[] = [];
  const streams: StdioStream[] = [];
  const closed: Promise<number>[] = [];
  let onStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    onStarted = resolve;
  });
  let disposeCalls = 0;
  const backend: IRemoteBackend = {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    exists: async (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    readFile: (path) => readFile(path, "utf8"),
    upload: async () => assert.fail("lock must not upload"),
    dispose: () => {
      disposeCalls++;
    },
    exec: async (command) => {
      // Windows 的 Git Bash argv 重组会破坏长八进制命令；落盘后执行相同 POSIX 内容。
      const script = join(root, `exec-${children.length}.sh`);
      await writeFile(script, command);
      const child = spawn("bash", ["--noprofile", "--norc", script], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      const pipes = [child.stdin, child.stdout, child.stderr];
      const destroyMethods = pipes.map((pipe) => pipe.destroy.bind(pipe));
      const close = createCloseEventController();
      const completed = once(child, ignoreDestroy ? "exit" : "close").then(async ([code]) => {
        if (ignoreDestroy) {
          // 代理流 close 丢失不等于远端进程还活着；验证 exit 后恢复测试自己的管道回收。
          for (const [index, pipe] of pipes.entries()) {
            pipe.destroy = destroyMethods[index]!;
            pipe.destroy();
          }
        }
        await rm(script, { force: true });
        close.fire(code ?? 1);
        return code ?? 1;
      });
      closed.push(completed);
      if (ignoreDestroy) {
        // 模拟本机销毁代理流没有送达远端；必须由远端自己的 deadline 结束等待。
        child.stdin.destroy = () => child.stdin;
        child.stdout.destroy = () => child.stdout;
        child.stderr.destroy = () => child.stderr;
        child.stdin.end = (() => child.stdin) as typeof child.stdin.end;
      }
      const stream = {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        onClose: close.event,
      };
      streams.push(stream);
      onStarted();
      return stream;
    },
  };
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || !child.pid) continue;
      if (process.platform === "win32") {
        const stop = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await once(stop, "exit");
      } else child.kill("SIGTERM");
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, backend, streams, closed, started, disposeCalls: () => disposeCalls };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("remote lock process did not exit")), 2500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a cancelled waiter exits its remote script without touching another owner or the shared backend", async (t) => {
  const f = await fixture(t);
  const lockDir = join(f.root, ".deploy.lock").replaceAll("\\", "/");
  await mkdir(lockDir);
  await writeFile(join(lockDir, "owner"), "other-deployment");
  const acquiring = acquireRemoteDeployLock(f.backend, { lockDir, acquireTimeoutMs: 5000 });
  // exec 返回前已记录 stream；让 stdin EOF 在等锁阶段送达，而非等到 acquired。
  await f.started;
  f.streams[0]!.stdin.end();
  await bounded(assert.rejects(acquiring));
  await bounded(f.closed[0]!);
  assert.equal(await readFile(join(lockDir, "owner"), "utf8"), "other-deployment");
  assert.equal(f.disposeCalls(), 0);
  assert.deepEqual(await readdir(f.root), [".deploy.lock"]);
});

test("remote acquisition deadline stops a waiter even when local stream destruction is lost", async (t) => {
  const f = await fixture(t, true);
  const lockDir = join(f.root, ".deploy.lock").replaceAll("\\", "/");
  await mkdir(lockDir);
  await writeFile(join(lockDir, "owner"), "other-deployment");
  await assert.rejects(
    acquireRemoteDeployLock(f.backend, { lockDir, acquireTimeoutMs: 40 }),
    /timed out/,
  );
  await bounded(f.closed[0]!);
  assert.equal(await readFile(join(lockDir, "owner"), "utf8"), "other-deployment");
  assert.equal(f.disposeCalls(), 0);
  assert.deepEqual(await readdir(f.root), [".deploy.lock"]);
});

test("a lock owner releases on stdin EOF and normal release is idempotent without orphan heartbeats", async (t) => {
  const f = await fixture(t);
  const lockDir = join(f.root, ".deploy.lock").replaceAll("\\", "/");
  const ended = await acquireRemoteDeployLock(f.backend, { lockDir });
  f.streams[0]!.stdin.end();
  await bounded(f.closed[0]!);
  await ended.release();
  assert.deepEqual(await readdir(f.root), []);
  const handle = await acquireRemoteDeployLock(f.backend, { lockDir });
  await bounded(Promise.all([handle.release(), handle.release()]));
  assert.deepEqual(await readdir(f.root), []);
});

test("concurrent deployments acquire only after the previous owner releases its install-root lock", async (t) => {
  const f = await fixture(t);
  const lockDir = join(f.root, ".deploy.lock").replaceAll("\\", "/");
  const first = await acquireRemoteDeployLock(f.backend, { lockDir });
  const pending = acquireRemoteDeployLock(f.backend, { lockDir });
  assert.equal(await readFile(join(lockDir, "owner"), "utf8"), first.ownerToken);
  await first.release();
  const second = await bounded(pending);
  assert.notEqual(second.ownerToken, first.ownerToken);
  assert.equal(await readFile(join(lockDir, "owner"), "utf8"), second.ownerToken);
  await second.release();
  assert.deepEqual(await readdir(f.root), []);
});
