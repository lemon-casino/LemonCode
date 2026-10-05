import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BackgroundExecutionSnapshot,
  ExecutionEnvOverlay,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
} from "@lcode/contracts";
import {
  createProjectScopedExecutionPort,
  mergeProjectEnvOverlay,
} from "./project-environment-execution.js";

const request = (overrides: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  command: { mode: "argv", file: "node", args: ["-v"] },
  cwd: "C:/checkout",
  ...overrides,
});

test("merge: request set wins over frozen, unset union, request base wins", () => {
  const merged = mergeProjectEnvOverlay(
    request({
      env: { base: "empty", set: { PLUGIN: "1", PATH: "/own" }, unset: ["A"] },
    }),
    { base: "inherit", set: { PATH: "/frozen:/host", LCODE_ENV: "x" }, unset: ["B"] },
  );
  assert.equal(merged.env?.base, "empty");
  assert.equal(merged.env?.set?.PATH, "/own");
  assert.equal(merged.env?.set?.LCODE_ENV, "x");
  assert.equal(merged.env?.set?.PLUGIN, "1");
  assert.deepEqual([...(merged.env?.unset ?? [])].sort(), ["A", "B"]);
});

test("merge: frozen base applies when request has none", () => {
  const merged = mergeProjectEnvOverlay(request(), { base: "inherit", set: { A: "1" } });
  assert.equal(merged.env?.base, "inherit");
  assert.deepEqual(merged.env?.set, { A: "1" });
  assert.equal(merged.env?.unset, undefined);
});

function fakePort(): {
  port: ExecutionPort;
  seen: ExecutionRequest[];
  closed: () => boolean;
} {
  const seen: ExecutionRequest[] = [];
  let closed = false;
  const snapshot = { taskId: "t" } as unknown as BackgroundExecutionSnapshot;
  const port: ExecutionPort = {
    run: async (incoming) => {
      seen.push(incoming);
      return {} as ExecutionResult;
    },
    start: async (incoming) => {
      seen.push(incoming);
      return { taskId: "t", status: "running", startedAt: new Date() };
    },
    getBackgroundTask: async () => snapshot,
    cancelBackgroundTask: async () => snapshot,
    close: async () => {
      closed = true;
    },
  };
  return { port, seen, closed: () => closed };
}

test("scoped port merges frozen overlay before every run", async () => {
  const { port, seen, closed } = fakePort();
  const frozen: ExecutionEnvOverlay = { base: "inherit", set: { PATH: "/frozen:/host" } };
  const scoped = createProjectScopedExecutionPort(port, async () => frozen);
  await scoped.run(request());
  assert.deepEqual(seen[0]?.env, frozen);
  // start（后台 Bash/Hook 共用同一端口）同样合并。
  await scoped.start?.(request());
  assert.deepEqual(seen[1]?.env, frozen);
  scoped.cancelBackgroundTask?.("t");
  await scoped.close?.();
  assert.equal(closed(), true);
});

test("scoped port passes requests through when no environment matches", async () => {
  const { port, seen } = fakePort();
  const scoped = createProjectScopedExecutionPort(port, async () => undefined);
  const original = request();
  await scoped.run(original);
  assert.equal(seen[0], original);
});

test("scoped port fails open when the resolver throws", async () => {
  const { port, seen } = fakePort();
  const scoped = createProjectScopedExecutionPort(port, async () => {
    throw new Error("host unreachable");
  });
  const original = request();
  await scoped.run(original);
  assert.equal(seen[0], original);
});
