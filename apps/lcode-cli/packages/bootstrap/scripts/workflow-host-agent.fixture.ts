import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { inspect } from "node:util";
import { AgentRuntime } from "@lcode/core";
import { createNodeFileSystemAdapter, createNodeContextSourceAdapter } from "@lcode/adapters";
import { createSqliteSessionStore } from "@lcode/adapters/storage";
import {
  createInMemorySessionEventStore,
  createSessionId,
  createRootTraceContext,
  type Model,
  type Logger,
} from "@lcode/contracts";
import { createProtocolProcessLifecycle } from "../../cli/src/protocol-lifecycle.js";
import { createDynamicWorkflowRunService } from "../src/app/dynamic-workflow-run-service.js";
import { readAppResidencySnapshot } from "../src/app/app-residency.js";
import { LCodeProtocolAgentServer } from "../src/lcode-protocol/server.js";
import { LCodeProtocolNdjsonConnection } from "../src/lcode-protocol/transport.js";
import { cleanupProtocolRuntime } from "../src/lcode-protocol/runtime-cleanup.js";
import type { LCodeApp } from "../src/app/types.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "../src/lcode-protocol/server-types.js";

async function main() {
  const lifecycle = createProtocolProcessLifecycle();
  const directory = process.argv[2]!;
  const lane = process.argv[3]!;
  const store = createSqliteSessionStore({ dbPath: join(directory, "fixture.sqlite") });
  const sessionId = createSessionId();
  const events: Array<{ event?: unknown; origin?: unknown; closeId?: unknown; phase?: unknown }> =
    [];
  const logger: Logger = {
    child: () => logger,
    debug() {},
    error() {},
    info: (_message, context) => {
      if (context)
        events.push({
          event: context.event,
          origin: context.origin,
          closeId: context.closeId,
          phase: context.phase,
        });
    },
    warn: (_message, context) => {
      if (context)
        events.push({
          event: context.event,
          origin: context.origin,
          closeId: context.closeId,
          phase: context.phase,
        });
    },
  };
  const eventStore = createInMemorySessionEventStore();
  const fileSystem = createNodeFileSystemAdapter();
  const selection = { providerId: "fixture", modelId: "fixture" };
  const model = {
    providerId: "fixture",
    modelId: "fixture",
    options: { maxOutputTokens: 4096 },
    optionSpecs: { maxOutputTokens: { max: 4096 } },
    bind: () => model,
    properties: {
      contextWindow: 128000,
      inputFormat: { supportsText: true },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsMidConversationSystem: true,
    },
    generateText: async () => ({
      text: "fixture foreground complete",
      finishReason: "stop",
      usage: {},
    }),
  } as unknown as Model;
  const parent = new AgentRuntime(
    sessionId,
    {
      workingDirectory: directory,
      workspacePath: directory,
      mode: "yolo",
      modelSelection: selection,
      modelStreaming: "off",
      compact: { enabled: false },
      memory: { enabled: false },
      titleGeneration: { enabled: false },
      subagents: { enabled: false },
      mcp: { enabled: false },
      toolAllowlist: [],
    },
    {
      sessionStore: store,
      eventStore,
      fileSystemPort: fileSystem,
      modelFactory: () => model,
      contextSourcePort: createNodeContextSourceAdapter({ env: { LCODE_HOME: directory } }),
      logger,
    },
  );
  const owner = await store.acquireWorkflowExecutionOwner({
    parentSessionId: sessionId,
    workspaceKey: directory,
  });
  let releaseRead: (() => void) | undefined;
  let readWaiting = false;
  const port = createDynamicWorkflowRunService({
    parentSessionId: sessionId,
    journal: owner.journal,
    executionOwner: owner,
    fileSystemPort: {
      ...fileSystem,
      readTextFile: async (input) => {
        readWaiting = true;
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        readWaiting = false;
        return fileSystem.readTextFile(input);
      },
    },
    executionPort: {} as never,
    createActorRuntime: () => {
      throw new Error("No actor should start");
    },
    registerResidencyBlockingWork: (work) =>
      parent.retainSessionStoreDependentCloseWork(work as Promise<void>),
    getSessionModelSelection: () => selection,
    logger,
  });
  await writeFile(join(directory, "gate.txt"), "fixture read completed");
  let runId: string | undefined;
  let finalSnapshot: Awaited<ReturnType<typeof port.getTask>>;
  async function launch() {
    const result = await port.submit({
      scriptText: 'phase("Wait"); return await files.read("gate.txt");',
      cwd: directory,
      parentSessionId: sessionId,
      trace: createRootTraceContext({ sessionId }),
    });
    if (!result.ok) throw new Error("Fixture launch rejected");
    runId = result.runId;
  }
  const app = {
    sessionId,
    traceId: "fixture-trace",
    runtime: parent,
    readResidencySnapshot: () => readAppResidencySnapshot(parent, port),
    close: async (context) => {
      await port.close(context);
      await parent.drainSessionStoreDependentCloseWork();
      finalSnapshot = runId ? await port.getTask(runId) : undefined;
    },
  } as LCodeApp;
  const server = new LCodeProtocolAgentServer({
    createLCodeApp: () => app,
    sessionStore: store,
    readShutdownContext: () => lifecycle.shutdownContext,
    sessionResidentPoolOptions: { idleTimeoutMs: 0, highWaterCount: 0, targetCount: 0 },
    loggerFactory: { createLogger: () => logger } as never,
  });
  const context = (server as unknown as { context: LCodeProtocolAgentServerContext }).context;
  await context.deps.createLCodeApp();
  context.sessions.set(sessionId, {
    app,
    workspace: { workspacePath: directory, workspaceKey: directory },
    persistence: "immediate",
    updatedAt: 0,
    eventStore,
  } as LCodeProtocolSessionRecord);
  if (lane === "primary") {
    await launch();
    await parent.executeTurn("Complete the fixture foreground turn.");
  }
  let cleanup: Promise<void> | undefined;
  const close = () =>
    (cleanup ??= cleanupProtocolRuntime({
      logger,
      server,
      sessionStore: store,
      deadlineAt: lifecycle.deadlineAt,
      shutdownContext: lifecycle.shutdownContext,
    }));
  const connection = new LCodeProtocolNdjsonConnection({
    input: lifecycle.input,
    output: process.stdout,
    signal: lifecycle.signal,
    onTransportClosed: (error) => server.disconnectClient(error),
    drainOnAbort: () => (lifecycle.shutdownContext?.transportAvailable ? close() : undefined),
    handleMessage: async (message) => {
      if ("method" in message && "id" in message && message.method === "process/childProcesses") {
        const action = (message.params as { action?: string } | undefined)?.action;
        if (action === "release") releaseRead?.();
        if (action === "launch") {
          context.assertServing?.();
          await launch();
        }
        if (port.countLiveRuns() > 0) server.rebalanceResidentSessions();
        return {
          id: message.id,
          result: {
            runId,
            readWaiting,
            snapshot: runId ? await port.getTask(runId) : undefined,
            foregroundActive: parent.hasActiveOrQueuedTurnWork(),
            facts: app.readResidencySnapshot?.(),
            resident: context.sessions.has(sessionId),
          },
        };
      }
      return server.handleMessage(message);
    },
  });
  server.setNotificationSink((message) => connection.send(message));
  connection.start();
  try {
    await connection.waitForClose();
  } finally {
    lifecycle.requestShutdown();
    await close();
    await writeFile(
      join(directory, `${lane}-result.json`),
      JSON.stringify({ snapshot: finalSnapshot, events, close: lifecycle.shutdownContext }),
    );
    await lifecycle.complete(0);
  }
}
void main().catch(async (error) => {
  await writeFile(join(process.argv[2]!, "agent-error.txt"), inspect(error, { depth: 6 }));
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
