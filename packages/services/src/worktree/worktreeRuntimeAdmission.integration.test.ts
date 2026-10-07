import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveProjectExecutionPolicy } from "@lcode/shared";
import type { PreparedWorktreeRuntime, WorktreeRuntimePorts } from "./contract.js";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

const environment: PreparedWorktreeRuntime = { environmentId: "a".repeat(32), revision: 1, manifestDigest: "manifest", dependenciesPrepared: true, env: { PREPARED_ENV: "yes" } };

test("managed admission fails closed, while local/inherit and old bindings never implicitly prepare runtime", async (t) => {
  const f = await fixture(t);
  const base = { workspacePath: f.repo, taskId: "owner", requestId: "owner", setupCommands: [] };
  await assert.rejects(f.service.prepare({ ...base, environmentPolicy: "managed" }), /capability/);
  assert.deepEqual(await f.service.list({ workspacePath: f.repo }), []);
  let calls = 0;
  const service = createWorktreeService({ ...f.options,
    prepareRuntimeEnvironment: async () => { calls++; return environment; },
    resolveRuntimeEnvironment: async () => environment,
  });
  for (const [index, environmentPolicy] of [undefined, "inherit", "local"].entries()) {
    const binding = await service.prepare({ ...base, taskId: `local-${index}`, requestId: `local-${index}`, environmentPolicy: environmentPolicy as "inherit" | "local" | undefined });
    assert.equal(binding.environmentRef, undefined);
    assert.equal(binding.environmentPolicy, "local");
  }
  const legacy = await f.service.prepare(base);
  await assert.rejects(service.prepare({ ...base, environmentPolicy: "managed" }), /policy cannot change/);
  assert.equal((await service.prepare(base)).id, legacy.id);
  assert.equal(calls, 0);
  const managed = await service.prepare({ ...base, taskId: "managed", requestId: "managed", environmentPolicy: "managed" });
  assert.equal(managed.environmentRef?.manifestDigest, "manifest");
  await assert.rejects(f.service.prepare({ ...base, taskId: "managed", requestId: "managed" }), /capability/);
  await assert.rejects(f.service.archive({ bindingId: managed.id, requestId: "archive" }), /release port/);
  await access(managed.checkoutPath);
});

test("prepared dependency receipt deduplicates only automatic setup and all setup holds the borrowed writer", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "package.json"), JSON.stringify({ packageManager: "pnpm@10.33.2" }));
  await writeFile(join(f.repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await f.command(f.repo, "add", ".");
  await f.command(f.repo, "commit", "-m", "manifest");
  const commands: string[] = [];
  const service = createWorktreeService({ ...f.options,
    prepareRuntimeEnvironment: async (params, writer) => {
      assert.equal(writer?.workspacePath, params.checkoutPath);
      await assert.rejects(f.service.acquireCheckout({ workspacePath: params.checkoutPath, ownerId: "competing-writer", waitMs: 10 }), { code: "LCODE_CHECKOUT_BUSY" });
      return environment;
    },
    resolveRuntimeEnvironment: async () => environment,
    validate: async (_, command, __, env) => { commands.push(command); assert.equal(env?.PREPARED_ENV, "yes"); return { exitCode: 0, output: "configured" }; },
  });
  await service.prepare({ workspacePath: f.repo, taskId: "automatic", requestId: "automatic", environmentPolicy: "managed" });
  assert.deepEqual(commands, []);
  await service.prepare({ workspacePath: f.repo, taskId: "explicit", requestId: "explicit", environmentPolicy: "managed", setupCommands: ["pnpm install --frozen-lockfile", "custom-setup"] });
  assert.deepEqual(commands, ["pnpm install --frozen-lockfile", "custom-setup"]);
});

test("failed managed preparation persists revision zero for retry and discard, with structured diagnostics", async (t) => {
  const f = await fixture(t);
  let fail = true;
  let prepares = 0;
  const diagnostic = { code: "dependency-install-failed", stage: "preparingDependencies", message: "fixture installation failed", retryable: true };
  const ports: WorktreeRuntimePorts = {
    prepareRuntimeEnvironment: async (params) => {
      prepares++;
      assert.equal(params.requestId, "prepare");
      if (prepares > 1) assert.equal(params.environmentId, environment.environmentId);
      if (fail) throw Object.assign(new Error("fixture installation failed"), { operation: { environmentId: environment.environmentId, status: "failed" }, runtimeEnvironmentError: diagnostic });
      return environment;
    },
    resolveRuntimeEnvironment: async () => environment,
  };
  const service = createWorktreeService({ ...f.options, ...ports });
  const request = { workspacePath: f.repo, taskId: "owner", requestId: "prepare", environmentPolicy: "managed" as const, setupCommands: [] };
  await assert.rejects(service.prepare(request), /installation failed/);
  const failed = await service.getBinding({ workspacePath: f.repo, taskId: "owner" });
  assert.equal(failed?.environmentRef?.revision, 0);
  assert.equal(failed?.environmentRef?.environmentId, environment.environmentId);
  assert.equal(failed?.status, "failed");
  assert.deepEqual(failed?.preparation?.runtimeError, diagnostic);
  fail = false;
  const retried = await createWorktreeService({ ...f.options, ...ports }).prepare(request);
  assert.equal(retried.status, "ready");
  assert.equal(retried.environmentRef?.revision, 1);
  assert.equal(prepares, 2);
});

test("list resolves both origin and execution scopes but never matches a foreign identity or path", async (t) => {
  const f = await fixture(t);
  const first = await f.service.prepare({ workspacePath: f.repo, workspaceIdentity: "host-one", taskId: "owner", requestId: "owner", setupCommands: [] });
  const second = await f.service.prepare({ workspacePath: f.repo, workspaceIdentity: "host-two", taskId: "owner", requestId: "owner", setupCommands: [] });
  assert.deepEqual((await f.service.list({ workspacePath: f.repo, workspaceIdentity: "host-one" })).map((binding) => binding.id), [first.id]);
  assert.deepEqual((await f.service.list({ workspacePath: second.workspacePath, workspaceIdentity: "host-two" })).map((binding) => binding.id), [second.id]);
  for (const scope of [
    { workspacePath: first.workspacePath, workspaceIdentity: "host-two" },
    { workspacePath: f.repo },
    { workspacePath: first.workspacePath },
    { workspacePath: join(f.repo, "wrong"), workspaceIdentity: "host-one" },
  ]) assert.deepEqual(await f.service.list(scope), []);
  const stored = JSON.parse(await readFile(join(f.options.dataDir, "bindings", `${first.id}.json`), "utf8"));
  assert.equal(stored.workspaceIdentity, "host-one");
});

test("project environment preference is additive and inheritance remains local by default", () => {
  const scope = { workspacePath: "/fixture", workspaceIdentity: "host:fixture" };
  assert.equal(resolveProjectExecutionPolicy({}, scope).environmentPolicy, "local");
  for (const preference of ["inherit", "managed", "local"] as const) {
    const result = resolveProjectExecutionPolicy({ projectExecutionPreferences: { "host:fixture": { environmentPolicy: preference } } }, scope);
    assert.equal(result.environmentPreference, preference);
    assert.equal(result.environmentPolicy, preference === "managed" ? "managed" : "local");
  }
});
