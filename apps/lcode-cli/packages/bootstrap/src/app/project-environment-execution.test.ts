import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExecutionEnvOverlay,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@lcode/contracts";
import {
  createProjectScopedExecutionPort,
  mergeProjectEnvOverlay,
  type ProjectEnvironmentOverlayResolver,
} from "./project-environment-execution.js";

const request = (env?: ExecutionRequest["env"]): ExecutionRequest => ({
  command: { mode: "argv", file: "node", args: ["-v"] },
  cwd: "/checkout",
  ...(env ? { env } : {}),
});
const frozen: ExecutionEnvOverlay = {
  base: "inherit",
  set: { PATH: "/tools:/host", TMPDIR: "/tmp/environment" },
};
function fakePort() {
  const seen: ExecutionRequest[] = [];
  const port: ExecutionPort = {
    run: async (value) => {
      seen.push(value);
      return {} as ExecutionResult;
    },
    start: async (value) => {
      seen.push(value);
      return { taskId: "t", status: "running", startedAt: new Date() };
    },
    close: async () => {},
  };
  return { port, seen };
}

test("Hook variables merge without changing frozen identity, PATH or resources", () => {
  const merged = mergeProjectEnvOverlay(
    request({ set: { PLUGIN: "1" }, unset: ["UNRELATED"] }),
    frozen,
    "linux",
  );
  assert.equal(merged.env?.set?.PATH, "/tools:/host");
  assert.equal(merged.env?.set?.PLUGIN, "1");
  assert.deepEqual(merged.env?.unset, ["UNRELATED"]);
  for (const own of [
    { base: "empty" as const },
    { set: { PATH: "/other" } },
    { unset: ["PATH"] },
    { set: { TMPDIR: "/shared" } },
  ] as ExecutionEnvOverlay[])
    assert.throws(() => mergeProjectEnvOverlay(request(own), frozen, "linux"), /cannot/);
});

test("Windows overlay uses case-insensitive ownership and cannot leave duplicate PATH keys", () => {
  const windows = { base: "inherit" as const, set: { Path: "C:\\tools;C:\\host" } };
  assert.throws(
    () => mergeProjectEnvOverlay(request({ set: { PATH: "D:\\other" } }), windows, "win32"),
    /cannot override/,
  );
  assert.throws(
    () => mergeProjectEnvOverlay(request({ unset: ["pAtH"] }), windows, "win32"),
    /cannot remove/,
  );
  const merged = mergeProjectEnvOverlay(
    request({ set: { PATH: windows.set.Path } }),
    windows,
    "win32",
  );
  assert.deepEqual(
    Object.keys(merged.env?.set ?? {}).filter((key) => key.toUpperCase() === "PATH"),
    ["PATH"],
  );
});

test("run and background start resolve every time, errors never reach the spawn owner", async () => {
  const { port, seen } = fakePort();
  let calls = 0;
  const resolve: ProjectEnvironmentOverlayResolver = async () => {
    calls++;
    return frozen;
  };
  const scoped = createProjectScopedExecutionPort(port, resolve);
  await scoped.run(request());
  await scoped.start!(request());
  assert.equal(calls, 2);
  assert.equal(seen.length, 2);
  const denied = createProjectScopedExecutionPort(port, async () => {
    throw new Error("Host unavailable");
  });
  await assert.rejects(denied.run(request()), /Host unavailable/);
  await assert.rejects(denied.start!(request()), /Host unavailable/);
  assert.equal(seen.length, 2);
});

test("non-managed resolution preserves the original request", async () => {
  const { port, seen } = fakePort();
  const value = request();
  await createProjectScopedExecutionPort(port, async () => undefined).run(value);
  assert.equal(seen[0], value);
});

test("close releases only after execution-owner close succeeds and is idempotent", async () => {
  const { port } = fakePort();
  const events: string[] = [];
  port.close = async () => {
    events.push("owner-exited");
  };
  const resolve: ProjectEnvironmentOverlayResolver = async () => frozen;
  resolve.close = async () => {
    events.push("reference-released");
  };
  const scoped = createProjectScopedExecutionPort(port, resolve);
  await scoped.close!();
  await scoped.close!();
  assert.deepEqual(events, ["owner-exited", "reference-released"]);
  await assert.rejects(scoped.run(request()), /closing/);
});

test("failed owner close retains the reference, and close during resolve prevents spawn", async () => {
  const { port, seen } = fakePort();
  let released = false;
  const resolver: ProjectEnvironmentOverlayResolver = async () => frozen;
  resolver.close = async () => {
    released = true;
  };
  port.close = async () => {
    throw new Error("stop unconfirmed");
  };
  await assert.rejects(
    createProjectScopedExecutionPort(port, resolver).close!(),
    /stop unconfirmed/,
  );
  assert.equal(released, false);
  let deliver!: () => void;
  const pending = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const delayed: ProjectEnvironmentOverlayResolver = async () => {
    await pending;
    return frozen;
  };
  const scoped = createProjectScopedExecutionPort({ ...port, close: async () => {} }, delayed);
  const running = scoped.run(request());
  const rejected = assert.rejects(running, /closed before spawn/);
  const closing = scoped.close!();
  deliver();
  await rejected;
  await closing;
  assert.equal(seen.length, 0);
});

test("managed Bash preserves explicit and automatic background lifecycle plus task operations", async () => {
  const calls: string[] = [];
  const task = { taskId: "background", status: "running" as const, startedAt: new Date() };
  const signal = new AbortController().signal;
  const base = {
    ...fakePort().port,
    async runBashWithBackgroundLifecycle(
      value: ExecutionRequest,
      lifecycle: { mode: "explicit" | "auto_on_timeout" },
      options?: ExecutionRunOptions,
    ) {
      assert.equal(this, base);
      assert.equal(value.env?.set?.PATH, frozen.set!.PATH);
      assert.equal(value.env?.set?.PLUGIN, "1");
      assert.equal(options?.signal, signal);
      calls.push(lifecycle.mode);
      return { kind: "backgrounded" as const, task };
    },
    getBackgroundTask: async (id: string) => {
      calls.push(`get:${id}`);
      return task;
    },
    waitForBackgroundTask: async (id: string, options?: { signal?: AbortSignal }) => {
      assert.equal(options?.signal, signal);
      calls.push(`wait:${id}`);
      return task;
    },
    readBackgroundBashOutput: async (id: string, sessionId: string) => {
      calls.push(`output:${id}:${sessionId}`);
      return { output: "tail" } as never;
    },
    cancelBackgroundTask: async (id: string) => {
      calls.push(`cancel:${id}`);
      return task;
    },
    close: async () => {
      calls.push("close-owner");
    },
  };
  const resolve: ProjectEnvironmentOverlayResolver = async () => {
    calls.push("resolve");
    return frozen;
  };
  resolve.close = async () => {
    calls.push("release");
  };
  const scoped = createProjectScopedExecutionPort(base, resolve);
  for (const mode of ["explicit", "auto_on_timeout"] as const) {
    const result = await scoped.runBashWithBackgroundLifecycle!(
      request({ set: { PLUGIN: "1" } }),
      { mode },
      { signal },
    );
    assert.deepEqual(result, { kind: "backgrounded", task });
  }
  await scoped.getBackgroundTask!(task.taskId);
  await scoped.waitForBackgroundTask!(task.taskId, { signal });
  await scoped.readBackgroundBashOutput!(task.taskId, "session");
  await scoped.cancelBackgroundTask!(task.taskId);
  await scoped.close!();
  assert.deepEqual(calls, [
    "resolve",
    "explicit",
    "resolve",
    "auto_on_timeout",
    "get:background",
    "wait:background",
    "output:background:session",
    "cancel:background",
    "close-owner",
    "release",
  ]);
  assert.equal(
    createProjectScopedExecutionPort(fakePort().port, resolve).runBashWithBackgroundLifecycle,
    undefined,
  );
});

test("managed background lifecycle never spawns after resolution failure, abort or concurrent close", async () => {
  let spawned = 0;
  const base = {
    ...fakePort().port,
    runBashWithBackgroundLifecycle: async () => {
      spawned++;
      return { kind: "foreground" as const, result: {} as ExecutionResult };
    },
  };
  const denied = createProjectScopedExecutionPort(base, async () => {
    throw new Error("Host unavailable");
  });
  await assert.rejects(
    denied.runBashWithBackgroundLifecycle!(request(), { mode: "explicit" }),
    /Host unavailable/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    denied.runBashWithBackgroundLifecycle!(
      request(),
      { mode: "auto_on_timeout" },
      { signal: aborted.signal },
    ),
    /abort/i,
  );
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const scoped = createProjectScopedExecutionPort(base, async () => {
    entered.resolve();
    await finish.promise;
    return frozen;
  });
  const execution = scoped.runBashWithBackgroundLifecycle!(request(), { mode: "explicit" });
  const rejected = assert.rejects(execution, /closed before spawn/);
  await entered.promise;
  const closing = scoped.close!();
  finish.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(spawned, 0);
});
