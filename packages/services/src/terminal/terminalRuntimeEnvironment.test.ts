import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { AppSettings } from "@lcode/shared";
import type { IPty } from "node-pty";
import { createPublicTerminalService, createTerminalService } from "./terminalService.js";
import { applyTerminalEnvironment } from "./terminalProcess.js";
import { terminalCreateParamsSchema, type RuntimeTerminalEnvironmentPort } from "./terminal.js";

test("public terminal facade cannot expose trusted owner stop methods", async () => {
  const { service } = fixture();
  const facade = createPublicTerminalService(service);
  assert.deepEqual(Object.keys(facade).sort(), [
    "create",
    "dispose",
    "onDynamicData",
    "onDynamicExit",
    "resize",
    "write",
  ]);
  for (const method of ["stopWorkspaceAndWait", "disposeAll", "disposeAllAndWait"]) {
    assert.equal(method in facade, false);
  }
  await service.disposeAllAndWait();
});

test("terminal request schema accepts scope and rejects caller-owned env", () => {
  assert.equal(terminalCreateParamsSchema.safeParse({ cols: 80, rows: 24 }).success, true);
  assert.equal(
    terminalCreateParamsSchema.safeParse({ cols: 80, rows: 24, envOverlay: {} }).success,
    false,
  );
});

const workspacePath = tmpdir();
const environmentRef = { environmentId: "a".repeat(32), revision: 1, manifestDigest: "frozen" };
const scope = { workspacePath, workspaceIdentity: "terminal-test-workspace" };
const request = {
  ...scope,
  cwd: workspacePath,
  cols: 80,
  rows: 24,
  sessionId: "session-a",
  executionBindingId: "binding-a",
  environmentRef,
};

function fakePty() {
  let exit: (event: { exitCode: number }) => void = () => {};
  let kills = 0;
  let failKill = false;
  const pty = {
    onData: () => ({ dispose() {} }),
    onExit: (handler: typeof exit) => {
      exit = handler;
      return { dispose() {} };
    },
    write() {},
    resize() {},
    kill() {
      kills += 1;
      if (failKill) throw new Error("stop unconfirmed");
    },
  } as unknown as IPty;
  return {
    pty,
    exit: (exitCode = 0) => exit({ exitCode }),
    failKill: () => {
      failKill = true;
    },
    get kills() {
      return kills;
    },
  };
}

function fixture(runtimeEnvironment?: RuntimeTerminalEnvironmentPort, spawnError?: Error) {
  const spawns: { shell: string; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const ptys: ReturnType<typeof fakePty>[] = [];
  const settings = {
    terminalInheritSystemProfile: false,
    integratedTerminalShell: {
      mode: "shell",
      dialect: "custom",
      id: "custom",
      label: "custom",
      path: process.execPath,
    },
  } as AppSettings;
  const service = createTerminalService({
    settingService: { get: async () => settings },
    runtimeEnvironment,
    loadPty: async () => ({
      spawn(shell, _args, options) {
        if (spawnError) throw spawnError;
        spawns.push({ shell, env: options?.env ?? {}, cwd: options?.cwd ?? "" });
        const process = fakePty();
        ptys.push(process);
        return process.pty;
      },
    }),
  });
  return { service, spawns, ptys };
}

async function turn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("checkout owner stops native subdirectory PTYs, waits for exit, and preserves other identities", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "lcode-pty-checkout-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const { service, ptys } = fixture();
  const child = join(checkout, "packages");
  await mkdir(child, { recursive: true });
  for (const target of [
    { workspacePath: child },
    { workspacePath: child, workspaceIdentity: "other-host" },
  ])
    await service.create({ ...target, cols: 80, rows: 24 });
  let stopped = false;
  const stopping = service.stopCheckoutAndWait({ workspacePath: checkout }).then(() => {
    stopped = true;
  });
  while (!ptys[0]!.kills) await turn();
  assert.equal(stopped, false);
  assert.equal(ptys[1]!.kills, 0);
  ptys[0]!.exit();
  await stopping;
  const remaining = service.disposeAllAndWait();
  ptys[1]!.exit();
  await remaining;
});

test("Host resolved cwd is used for spawn while checkout scope remains the stop identity", async () => {
  const { service, spawns, ptys } = fixture({
    async acquire() {
      return { executionScope: scope, cwd: workspacePath, envOverlay: {}, async release() {} };
    },
  });
  const result = await service.create({
    ...request,
    cwd: join(workspacePath, "untrusted-spelling"),
  });
  assert.equal(spawns[0]?.cwd, workspacePath);
  const stopping = service.stopWorkspaceAndWait(scope);
  await turn();
  assert.equal(ptys[0]?.kills, 1);
  ptys[0]!.exit();
  await stopping;
  await service.dispose({ id: result.id });
  await service.disposeAllAndWait();
});

test("scoped create acquires a trusted terminal environment and applies it only to PTY spawn", async () => {
  const hostEnv = { ...process.env };
  const acquired: unknown[] = [];
  let releases = 0;
  const { service, spawns, ptys } = fixture({
    async acquire(input) {
      acquired.push(input);
      return {
        executionScope: scope,
        envOverlay: {
          set: { PATH: "frozen-tool-path", TERMINAL_RUNTIME_TEST: "frozen" },
          unset: ["NODE_OPTIONS"],
        },
        async release() {
          releases += 1;
        },
      };
    },
  });
  const result = await service.create(request);
  assert.deepEqual(acquired, [
    {
      ...scope,
      cwd: workspacePath,
      sessionId: request.sessionId,
      executionBindingId: request.executionBindingId,
      environmentRef,
      terminalId: result.id,
    },
  ]);
  assert.equal(spawns[0]?.env.PATH, "frozen-tool-path");
  assert.equal(spawns[0]?.env.TERMINAL_RUNTIME_TEST, "frozen");
  assert.equal(spawns[0]?.env.NODE_OPTIONS, undefined);
  assert.equal(spawns[0]?.shell, process.execPath);
  assert.equal(isDeepStrictEqual({ ...process.env }, hostEnv), true, "Host environment changed");
  let disposed = false;
  const disposal = service.dispose({ id: result.id }).then(() => {
    disposed = true;
  });
  await turn();
  assert.equal(ptys[0]?.kills, 1);
  assert.equal(releases, 0);
  assert.equal(disposed, false);
  ptys[0]!.exit();
  await disposal;
  assert.equal(releases, 1);
  ptys[0]!.exit();
  await service.dispose({ id: result.id });
  assert.equal(releases, 1);
  await service.disposeAllAndWait();
});

test("strict create rejects caller env and explicit managed references without a Host port", async () => {
  const { service, spawns } = fixture();
  await assert.rejects(service.create({ ...request, envOverlay: { PATH: "caller" } } as never));
  await assert.rejects(service.create(request), /capability-unavailable/);
  await assert.rejects(service.create({ cols: 80, rows: 24, environmentRef }), /workspacePath/);
  assert.equal(spawns.length, 0);
  await service.disposeAllAndWait();
});

test("scope without an expected ref still goes through Host admission, with no fallback on failure", async () => {
  const { service, spawns } = fixture({
    async acquire(input) {
      assert.equal(input.workspaceIdentity, scope.workspaceIdentity);
      assert.equal(input.environmentRef, undefined);
      throw new Error("scope-mismatch: binding is unavailable");
    },
  });
  await assert.rejects(
    service.create({ ...scope, cwd: workspacePath, cols: 80, rows: 24 }),
    /scope-mismatch/,
  );
  assert.equal(spawns.length, 0);
  await service.disposeAllAndWait();
});

test("a managed cwd never falls back to HOME and releases an acquired pre-spawn reference", async () => {
  let releases = 0;
  const { service, spawns } = fixture({
    async acquire() {
      return {
        envOverlay: { set: { PATH: "frozen" } },
        async release() {
          releases += 1;
        },
      };
    },
  });
  await assert.rejects(
    service.create({ ...request, cwd: join(workspacePath, `missing-${crypto.randomUUID()}`) }),
    /working directory/,
  );
  assert.equal(spawns.length, 0);
  assert.equal(releases, 1);
  await service.disposeAllAndWait();
});

test("legacy terminal preserves the saved shell and Host environment without acquiring a reference", async () => {
  const { service, spawns, ptys } = fixture({ acquire: async () => null });
  const result = await service.create({ cols: 80, rows: 24, cwd: workspacePath });
  assert.equal(result.shell, process.execPath);
  assert.equal(spawns[0]?.env.TERMINAL_RUNTIME_TEST, undefined);
  ptys[0]!.exit();
  await service.disposeAllAndWait();
});

test("unknown PTY stop retains the consumer until a real exit arrives", async () => {
  let releases = 0;
  const { service, ptys } = fixture({
    async acquire() {
      return {
        envOverlay: {},
        async release() {
          releases += 1;
        },
      };
    },
  });
  const result = await service.create(request);
  ptys[0]!.failKill();
  await assert.rejects(service.dispose({ id: result.id }), /process-unknown/);
  assert.equal(releases, 0);
  ptys[0]!.exit();
  await service.disposeAllAndWait();
  assert.equal(releases, 1);
});

test("disposeAll fences a pending acquire and waits for its release without spawning", async () => {
  const acquired = Promise.withResolvers<void>();
  const allowAcquire = Promise.withResolvers<void>();
  let releases = 0;
  const { service, spawns } = fixture({
    async acquire() {
      acquired.resolve();
      await allowAcquire.promise;
      return {
        envOverlay: {},
        async release() {
          releases += 1;
        },
      };
    },
  });
  const creation = service.create(request);
  const rejected = assert.rejects(creation, /cancelled/);
  await acquired.promise;
  service.disposeAll();
  let stopped = false;
  const disposal = service.disposeAllAndWait().then(() => {
    stopped = true;
  });
  await turn();
  assert.equal(stopped, false);
  allowAcquire.resolve();
  await rejected;
  await disposal;
  assert.equal(releases, 1);
  assert.equal(spawns.length, 0);
  await assert.rejects(service.create(request), /closed|disposed/);
});

test("stopWorkspace waits for real exit and does not stop another identity at the same path", async () => {
  const released: string[] = [];
  const { service, ptys } = fixture({
    async acquire(input) {
      return {
        executionScope: { workspacePath, workspaceIdentity: input.workspaceIdentity },
        envOverlay: {},
        async release() {
          released.push(input.terminalId);
        },
      };
    },
  });
  const first = await service.create(request);
  const second = await service.create({ ...request, workspaceIdentity: "other-host" });
  let stopped = false;
  const stopping = service.stopWorkspaceAndWait(scope).then(() => {
    stopped = true;
  });
  await turn();
  assert.equal(stopped, false);
  assert.equal(ptys[0]?.kills, 1);
  assert.equal(ptys[1]?.kills, 0);
  ptys[0]!.exit();
  await stopping;
  assert.deepEqual(released, [first.id]);
  ptys[0]!.exit();
  await turn();
  assert.deepEqual(released, [first.id]);
  ptys[1]!.exit();
  await service.disposeAllAndWait();
  assert.deepEqual(released, [first.id, second.id]);
});

test("a stale acquire resolved to a checkout cannot survive its stop or release a new generation", async () => {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const released: string[] = [];
  let calls = 0;
  const { service, spawns, ptys } = fixture({
    async acquire(input) {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await resume.promise;
      }
      return {
        executionScope: scope,
        envOverlay: {},
        async release() {
          released.push(input.terminalId);
        },
      };
    },
  });
  const creation = service.create({ ...request, workspaceIdentity: "original-project" });
  const rejected = assert.rejects(creation, /cancelled/);
  await started.promise;
  const stopping = service.stopWorkspaceAndWait(scope);
  const current = await service.create(request);
  resume.resolve();
  await rejected;
  await stopping;
  assert.equal(spawns.length, 1);
  assert.equal(ptys[0]?.kills, 0);
  assert.equal(released.length, 1);
  assert.notEqual(released[0], current.id);
  ptys[0]!.exit();
  await service.disposeAllAndWait();
  assert.equal(released.length, 2);
});

test("spawn failure releases its acquired consumer without pretending a PTY exited", async () => {
  let releases = 0;
  const { service, spawns } = fixture(
    {
      async acquire() {
        return {
          envOverlay: {},
          async release() {
            releases += 1;
          },
        };
      },
    },
    new Error("native spawn failed"),
  );
  await assert.rejects(service.create(request), /native spawn failed/);
  assert.equal(spawns.length, 0);
  assert.equal(releases, 1);
  await service.disposeAllAndWait();
});

test("release rejection keeps the exact consumer available for explicit cleanup retry", async () => {
  let attempts = 0;
  const { service, ptys } = fixture({
    async acquire() {
      return {
        envOverlay: {},
        async release() {
          if (++attempts === 1) throw new Error("store unavailable");
        },
      };
    },
  });
  const result = await service.create(request);
  ptys[0]!.exit();
  await turn();
  assert.equal(attempts, 1);
  await service.dispose({ id: result.id });
  assert.equal(attempts, 2);
  await service.disposeAllAndWait();
});

test("Windows PATH aliases cannot override the frozen overlay and empty bases do not inherit", () => {
  const base = {
    Path: "host-path",
    PATH: "other-host-path",
    TEMP: "host-temp",
    TERM: "xterm-256color",
  };
  assert.deepEqual(
    applyTerminalEnvironment(base, { set: { PATH: "frozen" }, unset: ["temp"] }, "win32"),
    {
      PATH: "frozen",
      TERM: "xterm-256color",
    },
  );
  assert.deepEqual(
    applyTerminalEnvironment(base, { base: "empty", set: { PATH: "frozen" } }, "linux"),
    { PATH: "frozen" },
  );
  assert.equal(base.Path, "host-path");
});
