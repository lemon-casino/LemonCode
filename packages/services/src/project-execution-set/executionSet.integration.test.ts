import assert from "node:assert/strict";
import { mkdir, writeFile, access, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { projectContextForDefinition } from "@lcode/shared";
import { executionSetFixture } from "./adapters/testFixture.js";
import {
  createProjectExecutionSetService,
  createPublicProjectExecutionSetService,
} from "./node.js";

test("two real repositories prepare durable bindings, one scope and all checkout permits", async (t) => {
  const f = await executionSetFixture(t);
  const [front, back] = f.repositories;
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      revision: 1,
      primaryFolderPath: front!,
      sourceFolderPaths: [front!, back!],
    },
    { workspacePath: front! },
  );
  const options = {
    dataDir: join(f.root, "sets"),
    worktrees: f.worktrees,
    stopSessions: async (snapshot: { sessions: Array<{ sessionId: string }> }) => ({
      stopped: true as const,
      sessionIds: snapshot.sessions.map((session) => session.sessionId),
    }),
  };
  const owner = createProjectExecutionSetService(options);
  const input = { operationId: "create", name: "Login", projectContext };
  const set = await owner.prepare(input);
  assert.equal(set.status, "ready", set.error);
  assert.equal(set.repositories.length, 2);
  const restarted = createProjectExecutionSetService(options);
  assert.equal((await restarted.prepare(input)).id, set.id);
  await assert.rejects(restarted.prepare({ ...input, name: "Different" }), /reused/);
  const target = { ...set.origin, executionSetId: set.id, sessionId: "chat" };
  const reference = await restarted.attachSession({ ...target, operationId: "attach" });
  assert.equal(reference.bindings.length, 2);
  const resolved = await restarted.resolveContext(target);
  assert.equal(resolved.context.executionSetId, set.id);
  assert.equal(resolved.context.members.length, 2);
  for (const member of resolved.context.members) {
    assert.notEqual(member.workspacePath, member.sourcePath);
    await access(join(member.workspacePath, "index.txt"));
  }
  const leases = await restarted.acquireExecution({ ...target, ownerId: "run" });
  assert.equal(leases.length, 2);
  for (const lease of leases)
    await f.worktrees.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  assert.equal("prepare" in createPublicProjectExecutionSetService(restarted), false);
  const archived = await restarted.archive({
    ...set.origin,
    executionSetId: set.id,
    operationId: "archive",
  });
  assert.equal(archived.status, "archived", archived.error);
});

test("partial preparation preserves successful resources and retry reconciles lost binding receipts", async (t) => {
  const f = await executionSetFixture(t);
  let call = 0;
  const resourceIds: string[] = [];
  const worktrees = Object.create(f.worktrees) as typeof f.worktrees;
  worktrees.prepareOwnedBinding = async (input) => {
    const binding = await f.worktrees.prepareOwnedBinding(input);
    resourceIds.push(binding.id);
    if (++call === 2) throw new Error("Lost response after checkout creation");
    return binding;
  };
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      primaryFolderPath: f.repositories[0]!,
      sourceFolderPaths: f.repositories,
    },
    { workspacePath: f.repositories[0]! },
  );
  const dataDir = join(f.root, "sets");
  const owner = createProjectExecutionSetService({ dataDir, worktrees });
  const failed = await owner.prepare({ operationId: "prepare", name: "Feature", projectContext });
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /Lost response/);
  await assert.rejects(
    owner.attachSession({
      ...failed.origin,
      executionSetId: failed.id,
      sessionId: "chat",
      operationId: "attach",
    }),
    /ready|response/,
  );
  const restarted = createProjectExecutionSetService({ dataDir, worktrees: f.worktrees });
  const ready = await restarted.retry({
    ...failed.origin,
    executionSetId: failed.id,
    operationId: "prepare",
  });
  assert.equal(ready.status, "ready", ready.error);
  assert.deepEqual(new Set(ready.repositories.map((repo) => repo.bindingId)), new Set(resourceIds));
  for (const repository of ready.repositories) {
    const bindings = await f.worktrees.list({ workspacePath: repository.repositoryRoot });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.taskId, undefined);
  }
});

test("same repository folders share one binding and unavailable members never start half a set", async (t) => {
  const f = await executionSetFixture(t);
  const front = f.repositories[0]!;
  const child = join(front, "shared");
  await mkdir(child);
  await writeFile(join(child, "schema.txt"), "schema");
  await f.command(front, "add", ".");
  await f.command(front, "commit", "-m", "shared");
  const owner = createProjectExecutionSetService({
    dataDir: join(f.root, "sets"),
    worktrees: f.worktrees,
  });
  const projectContext = projectContextForDefinition(
    {
      id: "single",
      name: "One repository",
      primaryFolderPath: front,
      sourceFolderPaths: [front, child],
    },
    { workspacePath: front },
  );
  const set = await owner.prepare({ operationId: "same", name: "Feature", projectContext });
  assert.equal(set.repositories.length, 1);
  assert.equal(set.repositories[0]?.memberIds.length, 2);
  const invalid = projectContextForDefinition(
    {
      id: "missing",
      name: "Missing",
      primaryFolderPath: front,
      sourceFolderPaths: [front, join(f.root, "missing")],
    },
    { workspacePath: front },
  );
  const failed = await owner.prepare({ operationId: "bad", name: "Bad", projectContext: invalid });
  assert.equal(failed.status, "failed");
  assert.equal(failed.repositories.length, 0);
  assert.equal((await f.worktrees.list({ workspacePath: front })).length, 1);
  const empty = join(front, "untracked-directory");
  await mkdir(empty);
  const emptyContext = projectContextForDefinition(
    { id: "empty", name: "Empty", primaryFolderPath: front, sourceFolderPaths: [front, empty] },
    { workspacePath: front },
  );
  const unavailable = await owner.prepare({
    operationId: "empty-base",
    name: "Empty",
    projectContext: emptyContext,
  });
  assert.equal(unavailable.status, "failed");
  assert.match(unavailable.error!, /absent from.*Git base/);
  assert.equal(unavailable.repositories.length, 0);
  assert.equal(unavailable.preflightFailure?.sourcePath, empty);
  assert.equal((await f.worktrees.list({ workspacePath: front })).length, 1);
  const alias = join(f.root, "source-alias");
  await symlink(front, alias, "junction");
  const linked = projectContextForDefinition(
    { id: "linked", name: "Linked", primaryFolderPath: front, sourceFolderPaths: [front, alias] },
    { workspacePath: front },
  );
  const rejected = await owner.prepare({
    operationId: "linked",
    name: "Linked",
    projectContext: linked,
  });
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error!, /canonical source directory/);
  assert.equal(rejected.repositories.length, 0);
  assert.equal((await f.worktrees.list({ workspacePath: front })).length, 1);
});
