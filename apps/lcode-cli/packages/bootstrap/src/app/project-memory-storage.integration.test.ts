import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNodeExecutionAdapter,
  createNodeFileSystemAdapter,
  createSqliteSessionStore,
} from "@lcode/adapters";
import { AgentRuntime } from "@lcode/core";
import { prepareProjectMemoryStorage, resolveProjectMemoryRoot } from "@lcode/shared/node";
import {
  createInMemorySessionEventStore,
  createRootTraceContext,
  type Model,
  type ModelRequest,
  type SessionId,
} from "@lcode/contracts";

test("real Bash cwd, SQLite cold resume and legacy path records retain one project-local memory scope", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "lcode-memory-cwd-"));
  const dbPath = join(root, "session.db");
  const store = createSqliteSessionStore({ dbPath });
  let coldStore: ReturnType<typeof createSqliteSessionStore> | undefined;
  const execution = createNodeExecutionAdapter();
  const sessionId = "memory-scope-cold-fixture" as SessionId;
  let auxiliaryRequests = 0;
  const model = {
    providerId: "fixture",
    modelId: "fixture",
    displayName: "Fixture",
    optionSpecs: { maxOutputTokens: { max: 4096 }, reasoningLevel: { values: ["none"] } },
    options: { maxOutputTokens: 4096, reasoningLevel: "none" },
    properties: {
      contextWindow: 64000,
      inputFormat: { supportsText: true },
      supportsMidConversationSystem: true,
    },
    bind: () => model,
    generateText: async (request: ModelRequest) => {
      if (request.tools?.length)
        return { text: "Completed fixture.", finishReason: "stop", usage: {} };
      auxiliaryRequests++;
      const evidence = JSON.parse(String(request.messages[1]!.content));
      if (evidence.items)
        return {
          text: JSON.stringify({
            decisions: evidence.items.map((item: { itemId: string }) => ({
              itemId: item.itemId,
              accept: true,
              reason: "Explicit durable fixture.",
            })),
          }),
          finishReason: "stop",
          usage: {},
        };
      return {
        text: JSON.stringify({
          summary: "Durable fixture",
          items: [
            {
              fileName: "fact.md",
              content:
                "---\ndescription: Fixture architecture constraint\nmetadata:\n  type: project\n---\nFixture requires a stable project root.",
              reason: "Explicit durable fixture.",
              sourceIds: [evidence.sources[0].id],
            },
          ],
        }),
        finishReason: "stop",
        usage: {},
      };
    },
  } as unknown as Model;
  const createRuntime = (sessionStore: typeof store) =>
    new AgentRuntime(
      sessionId,
      {
        workingDirectory: root,
        workspacePath: root,
        mode: "yolo",
        modelSelection: { providerId: "fixture", modelId: "fixture" },
        modelStreaming: "off",
        memory: {
          enabled: true,
          use: true,
          storageLocation: "workspace",
          cliStorageRoot: join(root, "profile", "cli"),
        },
        compact: { enabled: false },
        subagents: { enabled: false },
        mcp: { enabled: false },
        titleGeneration: { enabled: false },
        toolAllowlist: ["Bash"],
      },
      {
        sessionStore,
        modelFactory: () => model,
        fileSystemPort: createNodeFileSystemAdapter(),
        executionPort: execution,
        eventStore: createInMemorySessionEventStore(),
      },
    );
  const drain = (runtime: AgentRuntime) =>
    (
      runtime as unknown as { drainMemoryExtractions(timeout: null): Promise<void> }
    ).drainMemoryExtractions(null);
  const runtime = createRuntime(store);
  try {
    await mkdir(join(root, "child"));
    await writeFile(join(root, "child", "cwd.mjs"), "process.stdout.write(process.cwd())");
    await runtime.ensureSessionPersistedForExternalActivity("scope fixture");
    const changed = await runtime
      .getToolExecutor()
      .execute({ id: "fixture-cd", name: "Bash", input: { command: "cd child" } } as never);
    assert.equal(changed.success, true);
    const probe = await runtime
      .getToolExecutor()
      .execute({ id: "fixture-cwd", name: "Bash", input: { command: "node cwd.mjs" } } as never);
    assert.equal(probe.success, true);
    assert.ok(
      JSON.stringify(probe).includes("child"),
      "real node subprocess executes in changed cwd",
    );
    await runtime.executeTurn(
      "Remember the durable fixture requires a stable project root.",
      undefined,
      { abortSignal: t.signal },
    );
    await drain(runtime);
    assert.equal(auxiliaryRequests, 2, "actual runtime schedules generator and verifier");
    const memoryPath = join(root, ".lcode", "memory", "fact.md");
    assert.match(await readFile(memoryPath, "utf8"), /stable project root/u);
    await assert.rejects(readFile(join(root, "child", ".lcode", "memory", "fact.md")), {
      code: "ENOENT",
    });
    const persisted = (await store.getSession(sessionId))!;
    assert.equal(persisted.path, root);
    assert.equal(
      persisted.directory,
      root,
      "current Bash cwd is runtime-local, not a persisted workspace rewrite",
    );
    // 使用真实持久会话测试path优先，并覆盖旧空path字段的兼容恢复，不伪造window。
    await store.updateSession({ id: sessionId, directory: join(root, "child") });
    coldStore = createSqliteSessionStore({ dbPath });
    const cold = createRuntime(coldStore);
    await cold.resumeFromStore();
    await cold.executeTurn(
      "Remember the durable fixture requires a stable project root.",
      undefined,
      { abortSignal: t.signal },
    );
    await drain(cold);
    assert.equal(
      auxiliaryRequests,
      3,
      "same content is a no-op after one fresh generation in cold scope",
    );
    await coldStore.updateSession({ id: sessionId, directory: root, path: null });
    const legacy = createRuntime(coldStore);
    await legacy.resumeFromStore();
    await legacy.executeTurn(
      "Remember the durable fixture requires a stable project root.",
      undefined,
      { abortSignal: t.signal },
    );
    await drain(legacy);
    assert.equal(auxiliaryRequests, 4, "old record directory fallback remains usable");
    assert.match(await readFile(memoryPath, "utf8"), /stable project root/u);
  } finally {
    runtime.beginShutdown();
    coldStore?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const original of ["profile", "workspace"] as const) {
  test(`real delayed ${original} Runtime keeps its root without reverting a newer placement`, async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "lcode-memory-late-init-"));
    const input = { workspacePath: join(root, "project"), cliStorageRoot: join(root, "cli") };
    await mkdir(input.workspacePath);
    const store = createSqliteSessionStore({ dbPath: join(root, "session.db") });
    const runtimes: AgentRuntime[] = [];
    const next = original === "profile" ? "workspace" : "profile";
    const makeRuntime = (location: "profile" | "workspace", storageRevision: number) => {
      const fs = createNodeFileSystemAdapter();
      const prepare = fs.projectMemory!.prepareStorage!.bind(fs.projectMemory);
      fs.projectMemory!.prepareStorage = async (request) => {
        assert.equal(
          request.storageRevision,
          storageRevision,
          "frozen policy version reaches the real Node preparation port",
        );
        return prepare(request);
      };
      const runtime = new AgentRuntime(
        `late-${location}-${storageRevision}` as SessionId,
        {
          workingDirectory: input.workspacePath,
          workspacePath: input.workspacePath,
          memory: {
            enabled: true,
            use: true,
            storageLocation: location,
            storageRevision,
            cliStorageRoot: input.cliStorageRoot,
          },
          mcp: { enabled: false },
          subagents: { enabled: false },
          titleGeneration: { enabled: false },
        },
        {
          sessionStore: store,
          fileSystemPort: fs,
          eventStore: createInMemorySessionEventStore(),
          modelFactory: () => {
            throw new Error("No model request may be made during storage preparation");
          },
        },
      );
      runtimes.push(runtime);
      return { runtime, fs };
    };
    try {
      // 真实Runtime已构造但尚未发现Skill/context；模拟Host先冻结旧位置版本。
      const old = makeRuntime(original, 0);
      const oldRoot = resolveProjectMemoryRoot({ ...input, storageLocation: original });
      await prepareProjectMemoryStorage({
        ...input,
        storageLocation: original,
        storageRevision: 0,
      });
      await writeFile(join(oldRoot, "retained.md"), "retained source fact");
      const changed = await prepareProjectMemoryStorage({
        ...input,
        storageLocation: next,
        storageRevision: 1,
        previousStorageLocation: original,
      });
      const markerPath = join(resolveProjectMemoryRoot(input), "..", "storage-location.json");
      const markerBefore = await readFile(markerPath, "utf8");
      await rm(join(changed.rootDir, "retained.md"));
      await writeFile(join(changed.rootDir, "new-position.md"), "new selected position");
      await old.runtime.getSkillCatalog(createRootTraceContext());
      assert.equal(await readFile(markerPath, "utf8"), markerBefore);
      assert.equal(
        (await old.fs.projectMemory!.listChanges(oldRoot)).length,
        0,
        "old Runtime registers its own frozen root",
      );
      await assert.rejects(readFile(join(oldRoot, "new-position.md")), { code: "ENOENT" });
      const fresh = makeRuntime(next, 1);
      await fresh.runtime.getSkillCatalog(createRootTraceContext());
      assert.equal((await fresh.fs.projectMemory!.listChanges(changed.rootDir)).length, 0);
      await assert.rejects(readFile(join(changed.rootDir, "retained.md")), { code: "ENOENT" });
      assert.equal(await readFile(markerPath, "utf8"), markerBefore);
    } finally {
      runtimes.forEach((runtime) => runtime.beginShutdown());
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
