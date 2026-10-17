import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { projectContextForDefinition } from "@lcode/shared";
import { createWorktreeService } from "../worktree/node.js";
import { executionSetFixture } from "./adapters/testFixture.js";
import { createProjectExecutionSetService } from "./node.js";

test("archive requires stop proof, journals chat visibility and restores the original repository bindings", async (t) => {
  const f = await executionSetFixture(t);
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      primaryFolderPath: f.repositories[0]!,
      sourceFolderPaths: f.repositories,
    },
    { workspacePath: f.repositories[0]! },
  );
  let stopped = false;
  const visibility: boolean[] = [];
  const owner = createProjectExecutionSetService({
    dataDir: join(f.root, "sets"),
    worktrees: f.worktrees,
    selectArchiveSessions: async () => ["chat"],
    setSessionsArchived: async (_set, archived) => {
      visibility.push(archived);
    },
    stopSessions: async (snapshot) => {
      if (!stopped) throw new Error("Writer still running");
      return { stopped: true, sessionIds: snapshot.sessions.map((session) => session.sessionId) };
    },
  });
  const set = await owner.prepare({ operationId: "create", name: "Feature", projectContext });
  const target = { ...set.origin, executionSetId: set.id },
    session = { ...target, sessionId: "chat", operationId: "attach" };
  await owner.attachSession(session);
  const failed = await owner.archive({ ...target, operationId: "archive" });
  assert.equal(failed.status, "archiving");
  assert.match(failed.error!, /Writer still running/);
  for (const view of await owner.bindings(target)) assert.equal(view.binding?.status, "ready");
  assert.deepEqual(visibility, []);
  stopped = true;
  const archived = await owner.archive({ ...target, operationId: "archive" });
  assert.equal(archived.status, "archived", archived.error);
  assert.deepEqual(archived.archiveSessionIds, ["chat"]);
  assert.deepEqual(visibility, [true]);
  const restored = await owner.restore({ ...target, operationId: "restore" });
  assert.equal(restored.status, "ready", restored.error);
  assert.deepEqual(
    restored.repositories.map((repository) => repository.bindingId),
    set.repositories.map((repository) => repository.bindingId),
  );
  assert.deepEqual(visibility, [true, false]);
  await owner.attachSession({ ...session, operationId: "resume" });
  assert.equal(
    (await owner.resolveContext({ ...target, sessionId: "chat" })).reference.bindings.length,
    2,
  );
});

test("failed multi-checkout acquisition releases earlier permits and never admits a partial run", async (t) => {
  const f = await executionSetFixture(t);
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      primaryFolderPath: f.repositories[0]!,
      sourceFolderPaths: f.repositories,
    },
    { workspacePath: f.repositories[0]! },
  );
  const owner = createProjectExecutionSetService({
    dataDir: join(f.root, "sets"),
    worktrees: f.worktrees,
  });
  const set = await owner.prepare({ operationId: "create", name: "Feature", projectContext });
  const target = { ...set.origin, executionSetId: set.id, sessionId: "chat" };
  await owner.attachSession({ ...target, operationId: "attach" });
  let calls = 0;
  const released: string[] = [];
  await assert.rejects(
    owner.acquireExecution(
      { ...target, ownerId: "run" },
      {
        acquireCheckout: async (input) => {
          if (++calls === 2) throw new Error("Backend is busy");
          return f.worktrees.acquireCheckout(input);
        },
        releaseCheckout: async (input) => {
          released.push(input.token);
          await f.worktrees.releaseCheckout(input);
        },
      },
    ),
    /Backend is busy/,
  );
  assert.equal(released.length, 1);
  const all = await owner.acquireExecution({ ...target, ownerId: "retry" });
  assert.equal(all.length, 2);
  for (const lease of all)
    await f.worktrees.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
});

test("concurrent chats share all repository files across owners while lifecycle operations stay exclusive", async (t) => {
  const f = await executionSetFixture(t);
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      primaryFolderPath: f.repositories[0]!,
      sourceFolderPaths: f.repositories,
    },
    { workspacePath: f.repositories[0]! },
  );
  const secondWorktrees = createWorktreeService(f.options);
  const dataDir = join(f.root, "sets");
  const first = createProjectExecutionSetService({ dataDir, worktrees: f.worktrees });
  const second = createProjectExecutionSetService({ dataDir, worktrees: secondWorktrees });
  const set = await first.prepare({ operationId: "create", name: "Shared", projectContext });
  const target = { ...set.origin, executionSetId: set.id };
  await first.attachSession({ ...target, sessionId: "a", operationId: "attach-a" });
  await second.attachSession({ ...target, sessionId: "b", operationId: "attach-b" });
  const a = await first.acquireExecution({ ...target, sessionId: "a", ownerId: "run-a" });
  const b = await second.acquireExecution({ ...target, sessionId: "b", ownerId: "run-b" });
  assert.equal(a.length, 2);
  assert.deepEqual(
    a.map((lease) => lease.workspacePath),
    b.map((lease) => lease.workspacePath),
  );
  assert.ok(a.every((lease, index) => lease.token !== b[index]!.token));
  const firstContext = (await first.resolveContext({ ...target, sessionId: "a" })).context;
  const secondContext = (await second.resolveContext({ ...target, sessionId: "b" })).context;
  for (const [index, member] of firstContext.members.entries()) {
    await writeFile(join(member.workspacePath, "index.txt"), `shared-${index}`);
    assert.equal(
      await readFile(join(secondContext.members[index]!.workspacePath, "index.txt"), "utf8"),
      `shared-${index}`,
    );
  }
  const acquireManager = (workspacePath: string) =>
    secondWorktrees.acquireCheckout({
      workspacePath,
      ownerId: "manager",
      mode: "exclusive",
      waitMs: 1,
    });
  for (const lease of a)
    await assert.rejects(acquireManager(lease.workspacePath), { code: "LCODE_CHECKOUT_BUSY" });
  for (const lease of a)
    await f.worktrees.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  for (const lease of b)
    await assert.rejects(acquireManager(lease.workspacePath), { code: "LCODE_CHECKOUT_BUSY" });
  for (const lease of b)
    await secondWorktrees.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  for (const lease of b) {
    const manager = await acquireManager(lease.workspacePath);
    await secondWorktrees.releaseCheckout({ token: manager.token, ownerId: manager.ownerId });
  }
});

test("independent set fork copies each repository's uncommitted files and rejects another origin", async (t) => {
  const f = await executionSetFixture(t);
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      primaryFolderPath: f.repositories[0]!,
      sourceFolderPaths: f.repositories,
    },
    { workspacePath: f.repositories[0]! },
  );
  const owner = createProjectExecutionSetService({
    dataDir: join(f.root, "sets"),
    worktrees: f.worktrees,
  });
  const set = await owner.prepare({ operationId: "create", name: "Feature", projectContext });
  const target = { ...set.origin, executionSetId: set.id, sessionId: "parent" };
  const reference = await owner.attachSession({ ...target, operationId: "attach" });
  const source = await owner.resolveContext(target);
  for (const [index, member] of source.context.members.entries())
    await writeFile(join(member.workspacePath, "index.txt"), `uncommitted-${index}`);
  const fork = await owner.prepare({
    operationId: "fork",
    name: "Fork",
    projectContext,
    forkSource: reference,
  });
  assert.equal(fork.status, "ready", fork.error);
  assert.notEqual(fork.id, set.id);
  const child = { ...set.origin, executionSetId: fork.id, sessionId: "child" };
  await owner.attachSession({ ...child, operationId: "child" });
  const resolved = await owner.resolveContext(child);
  for (const [index, member] of resolved.context.members.entries()) {
    assert.notEqual(member.bindingId, source.context.members[index]!.bindingId);
    assert.equal(
      await readFile(join(member.workspacePath, "index.txt"), "utf8"),
      `uncommitted-${index}`,
    );
  }
  await assert.rejects(
    owner.get({
      workspacePath: set.origin.workspacePath,
      workspaceIdentity: "different-environment",
      executionSetId: set.id,
    }),
    /another project source/i,
  );
});
