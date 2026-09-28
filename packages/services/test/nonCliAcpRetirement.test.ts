import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LCODE_PROTOCOL_NAME,
  LCODE_PROTOCOL_VERSION,
  lcodeSessionStateSnapshotSchema,
} from "@lcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createLCodeTaskServiceAdapter } from "../src/lcode-agent/lcodeTaskServiceAdapter.js";
import {
  getLegacyTaskSessionSnapshotPath,
  getLCodeDataRootDir,
  setDataBaseDir,
} from "../src/paths.js";
import { createMemoryService } from "../src/memory/memoryService.js";
import { parseLegacyTaskSessionFile } from "../src/session/legacyTaskSessionFile.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";

const meta = {
  taskId: "wrapper-example",
  traceId: "trace-example",
  title: "Imported example",
  workspacePath: "/example/workspace",
  createdAt: 1,
  updatedAt: 2,
  mode: "build" as const,
  provider: "glm" as const,
};

test("current Project Memory catalog and files remain readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-current-memory-"));
  setDataBaseDir(dir);
  try {
    const workspaceId = "example-0123456789abcdef";
    const memoryRoot = join(
      getLCodeDataRootDir(),
      "cli",
      "memories",
      "projects",
      workspaceId,
      "memory",
    );
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Project memory\n");
    await writeFile(join(memoryRoot, "workflow.md"), "Use the current project workflow.\n");
    const service = createMemoryService();
    const catalog = await service.listProjectMemories();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]?.id, workspaceId);
    assert.deepEqual(
      catalog[0]?.files.map((file) => file.name),
      ["MEMORY.md", "workflow.md"],
    );
    const file = await service.readProjectMemoryFile({ workspaceId, fileName: "workflow.md" });
    assert.equal(file.content, "Use the current project workflow.\n");
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("opening the task index leaves retired ACP IDs and user rows untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-acp-index-"));
  const path = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  try {
    await repo.syncTaskMeta({ meta });
    repo.close();
    const database = new DatabaseSync(path);
    try {
      database.exec("ALTER TABLE tasks ADD COLUMN acp_session_id TEXT");
      database
        .prepare("UPDATE tasks SET acp_session_id = ? WHERE task_id = ?")
        .run("session-example", meta.taskId);
    } finally {
      database.close();
    }
    await repo.ensureReady();
    repo.close();
    const reopened = new DatabaseSync(path);
    try {
      const row = reopened.prepare("SELECT task_id, acp_session_id FROM tasks").get();
      assert.equal(row?.task_id, meta.taskId);
      assert.equal(row?.acp_session_id, "session-example");
    } finally {
      reopened.close();
    }
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing sessions report the owner error even when a valid ACP snapshot exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-acp-snapshot-"));
  setDataBaseDir(dir);
  const path = getLegacyTaskSessionSnapshotPath(meta.workspacePath, meta.taskId);
  const snapshot = parseLegacyTaskSessionFile({ meta, messages: [], toolCalls: [] });
  await mkdir(dirname(path), { recursive: true });
  const content = JSON.stringify(snapshot);
  await writeFile(path, content);
  const ownerError = new Error(`Session not found: ${meta.taskId}`);
  const disposable = () => ({ dispose() {} });
  type Options = Parameters<typeof createLCodeTaskServiceAdapter>[0];
  const service = createLCodeTaskServiceAdapter({
    lcodeAgentService: {
      async resumeSession() {
        throw ownerError;
      },
      disposeAll() {},
    } as unknown as Options["lcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return meta;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      await assert.rejects(
        service.getTaskSnapshot({ ...meta, clientMode }),
        (error) => error === ownerError,
      );
    }
    assert.equal(await readFile(path, "utf8"), content);
  } finally {
    service.disposeAll();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("current session recovery preserves Desktop and replayable projections", async () => {
  const snapshot = lcodeSessionStateSnapshotSchema.parse({
    protocol: { name: LCODE_PROTOCOL_NAME, version: LCODE_PROTOCOL_VERSION },
    session: {
      sessionId: meta.taskId,
      workspace: { workspacePath: meta.workspacePath, workspaceKey: meta.workspacePath },
      sessionKind: "interactive",
      title: meta.title,
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId: meta.taskId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 4, stateRevision: 3, pendingRequestIds: [] },
    messages: [],
    slashCommands: [{ name: "compact", description: "Compact" }],
  });
  type Options = Parameters<typeof createLCodeTaskServiceAdapter>[0];
  const disposable = () => ({ dispose() {} });
  const resumed: unknown[] = [];
  const indexed: unknown[] = [];
  const service = createLCodeTaskServiceAdapter({
    lcodeAgentService: {
      async resumeSession(params: unknown) {
        resumed.push(params);
        return snapshot;
      },
      disposeAll() {},
    } as unknown as Options["lcodeAgentService"],
    taskIndexRepo: {
      async getTaskMeta() {
        return meta;
      },
      async syncTaskMeta(params: { meta: typeof meta }) {
        indexed.push(params.meta);
        return params.meta;
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      getWorkspaceEmitter() {
        return { fire() {} };
      },
      ensureSessionSubscription() {},
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  try {
    const desktop = await service.getTaskSnapshot({ ...meta, clientMode: "desktop-continuous" });
    const mobile = await service.getTaskSnapshot({ ...meta, clientMode: "web-remote-replayable" });
    assert.equal(desktop?.meta.taskId, meta.taskId);
    assert.equal(desktop?.meta.provider, "glm");
    assert.deepEqual(desktop?.slashCommands, snapshot.slashCommands);
    assert.equal(desktop?.runtime?.pendingElicitations, undefined);
    assert.deepEqual(mobile?.runtime?.pendingElicitations, []);
    assert.equal((await service.resumeTask(meta)).taskId, meta.taskId);
    assert.equal(resumed.length, 3);
    assert.equal(indexed.length, 3);
  } finally {
    service.disposeAll();
  }
});

test("current Provider configuration starts without an old config migration callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-provider-current-"));
  const runtime = createProviderConfigRuntime({
    lcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/lcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  try {
    await runtime.start();
    const config = await runtime.configService.read();
    assert.ok(config.lcodeBuiltinRevision);
    assert.deepEqual(config.personalProviderOrder, []);
    assert.deepEqual(config.personalProviders.toJSON(), []);
  } finally {
    runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
