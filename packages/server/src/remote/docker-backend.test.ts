import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DockerBackend } from "./docker-backend.js";

const fullId = "123456789abc" + "d".repeat(52);
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    this.emit("close", 1);
    return true;
  }
}
function fixture(t: TestContext) {
  const calls: string[][] = [];
  const streams: Child[] = [];
  const commands: Child[] = [];
  let holdCommands = false;
  const containers = [{ ID: fullId, Names: "test-container", State: "running" }];
  mock.method(
    cp,
    "execFile",
    (
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push(args);
      const child = new Child();
      commands.push(child);
      if (!holdCommands)
        queueMicrotask(() => {
          const stdout =
            args[0] === "ps"
              ? containers
                  .map((container) =>
                    JSON.stringify({
                      ...container,
                      ID: args.includes("--no-trunc") ? container.ID : container.ID.slice(0, 12),
                    }),
                  )
                  .join("\n")
              : args[0] === "version"
                ? "1.0"
                : args.at(-1)?.includes("uname -s")
                  ? "Linux"
                  : args.at(-1)?.includes("uname -m")
                    ? "x86_64"
                    : "/home/tester";
          callback(null, stdout, "");
          child.emit("close", 0);
        });
      else child.once("close", () => callback(new Error("cancelled child"), "", ""));
      return child;
    },
  );
  mock.method(cp, "spawn", () => {
    const child = new Child();
    streams.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    calls,
    streams,
    commands,
    containers,
    hold: () => {
      holdCommands = true;
    },
  };
}

test("Docker resolves names, full IDs and unique prefixes using full daemon IDs", async (t) => {
  const { calls } = fixture(t);
  for (const container of ["test-container", fullId, fullId.slice(0, 12), fullId.slice(0, 20)]) {
    const backend = new DockerBackend({ kind: "docker", container });
    assert.deepEqual(await backend.detect(), { platform: "linux", arch: "x64" });
    backend.dispose();
  }
  assert.ok(calls.filter((args) => args[0] === "ps").every((args) => args.includes("--no-trunc")));
});
test("Docker rejects ambiguous ID prefixes and stopped containers", async (t) => {
  const { containers } = fixture(t);
  containers.push({ ID: "123456789abc" + "e".repeat(52), Names: "second", State: "running" });
  await assert.rejects(
    new DockerBackend({ kind: "docker", container: "123456789abc" }).detect(),
    /多个|歧义/,
  );
  containers[0]!.State = "exited";
  await assert.rejects(
    new DockerBackend({ kind: "docker", container: "test-container" }).detect(),
    /未运行/,
  );
});
test("Docker disposal ends and waits only its own exec child; new commands are fenced", async (t) => {
  const { streams, calls } = fixture(t);
  const first = new DockerBackend({ kind: "docker", container: "test-container" });
  const other = new DockerBackend({ kind: "docker", container: "test-container" });
  await first.exec("long-command");
  await other.exec("other-command");
  assert.ok(first.disposeAndWait, "Docker needs a process cleanup barrier");
  await first.disposeAndWait({ graceTimeoutMs: 0, killWaitTimeoutMs: 20 });
  assert.equal(streams[0]!.stdin.writableEnded, true);
  assert.equal(streams[0]!.killed, true);
  assert.equal(streams[1]!.killed, false);
  const before = calls.length;
  await assert.rejects(first.exec("late-command"), /释放/);
  assert.equal(calls.length, before);
  await other.disposeAndWait!({ graceTimeoutMs: 0, killWaitTimeoutMs: 20 });
});
test("Docker disposal cancels an owned discovery process before another command can spawn", async (t) => {
  const { commands, calls, hold } = fixture(t);
  hold();
  const backend = new DockerBackend({ kind: "docker", container: "test-container" });
  const detecting = backend.detect();
  const rejected = assert.rejects(detecting);
  assert.ok(backend.disposeAndWait, "discovery must participate in cleanup");
  await backend.disposeAndWait({ graceTimeoutMs: 0, killWaitTimeoutMs: 20 });
  await rejected;
  assert.ok(commands[0]!.killed);
  assert.equal(calls.length, 1);
});

test("Docker disposal waits for closed stdio even after a child error", async (t) => {
  const { streams } = fixture(t);
  const backend = new DockerBackend({ kind: "docker", container: "test-container" });
  await backend.exec("long-command");
  streams[0]!.emit("error", new Error("child operation failed"));
  let finished = false;
  const disposing = backend.disposeAndWait({ graceTimeoutMs: 1_000 }).then(() => {
    finished = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, "error is not a stdio close receipt");
  } finally {
    streams[0]!.emit("close", 1);
    await disposing;
  }
});
