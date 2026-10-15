import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "@lcode/core";
import { createNodeFileSystemAdapter } from "@lcode/adapters";
import { createSqliteSessionStore } from "@lcode/adapters/storage";
import {
  createInMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type ProjectId,
} from "@lcode/contracts";
import { commandAckSchema } from "@lcode/shared/lcode-protocol-v4";
import { createDynamicWorkflowRunService } from "../app/dynamic-workflow-run-service.js";
import { createSessionFacade } from "../app/session-facade.js";
import { createAppWorkflowRunFacade } from "../app/app-workflow-run-facade.js";
import type { LCodeApp } from "../app/types.js";
import { LCodeProtocolAgentServer } from "./server.js";
import { activateSessionForResume } from "./server-operations.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(
    `${clientMode}: real Protocol cold owner routing, duplicate admission and unavailable ACK`,
    { timeout: 30_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "lcode-owner-protocol-"));
      const store = createSqliteSessionStore({ dbPath: join(directory, "fixture.sqlite") });
      const originalId = createSessionId();
      const callerId = createSessionId();
      const unavailableId = createSessionId();
      for (const id of [originalId, callerId, unavailableId])
        await store.createSession({
          id,
          projectID: "fixture-project" as ProjectId,
          slug: id,
          directory,
          title: "Fixture",
          version: "fixture",
        });
      const previous = await store.acquireWorkflowExecutionOwner({
        parentSessionId: originalId,
        workspaceKey: directory,
      });
      previous.journal.createRun({
        runId: "recover-original",
        parentSessionId: originalId,
        cwd: directory,
        status: "stopped",
        stopReason: "interrupted",
        caps: { maxConcurrency: 1 },
        spentTokens: 0,
        scriptText: 'return await files.read("held.txt");',
      });
      previous.release();
      const unavailable = await store.acquireWorkflowExecutionOwner({
        parentSessionId: unavailableId,
        workspaceKey: directory,
      });
      unavailable.journal.createRun({
        runId: "unavailable-run",
        parentSessionId: unavailableId,
        cwd: directory,
        status: "stopped",
        stopReason: "interrupted",
        caps: { maxConcurrency: 1 },
        spentTokens: 0,
        scriptText: 'return "must not run";',
      });
      await writeFile(join(directory, "held.txt"), "original owner completed");
      const logger = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };
      const created = new Map<string, number>();
      const ports = new Map<string, ReturnType<typeof createDynamicWorkflowRunService>>();
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      const server = new LCodeProtocolAgentServer({
        sessionStore: store,
        cwd: directory,
        createLCodeApp: async (options) => {
          const sessionId = options!.sessionId!;
          const lease = await store.acquireWorkflowExecutionOwner({
            parentSessionId: sessionId,
            workspaceKey: directory,
          });
          created.set(sessionId, (created.get(sessionId) ?? 0) + 1);
          let runtime!: AgentRuntime;
          const fileSystem = createNodeFileSystemAdapter();
          const read = fileSystem.readTextFile.bind(fileSystem);
          t.mock.method(
            fileSystem,
            "readTextFile",
            async (input: Parameters<typeof fileSystem.readTextFile>[0]) => {
              reads++;
              entered();
              await gate;
              return read(input);
            },
          );
          const port = createDynamicWorkflowRunService({
            journal: lease.journal,
            executionOwner: lease,
            parentSessionId: sessionId,
            withWorkflowRunOwner: options!.withWorkflowRunOwner,
            fileSystemPort: fileSystem,
            executionPort: {} as never,
            createActorRuntime: () => {
              throw new Error("No model actor should start");
            },
            registerResidencyBlockingWork: (work) =>
              runtime.retainSessionStoreDependentCloseWork(work),
          });
          ports.set(sessionId, port);
          runtime = new AgentRuntime(
            sessionId,
            {
              workingDirectory: directory,
              workspacePath: directory,
              mode: "yolo",
              mcp: { enabled: false },
              memory: { enabled: false },
              titleGeneration: { enabled: false },
            },
            {
              sessionStore: store,
              eventStore: options?.eventStore ?? createInMemorySessionEventStore(),
              dynamicWorkflowRunPort: port,
              modelFactory: () => {
                throw new Error("No model should start");
              },
            },
          );
          const session = createSessionFacade({
            runtime,
            sessionId,
            sessionStore: store,
            logger,
            configResult: { config: { ui: { locale: "en-US", theme: "system" } } } as never,
            configuredMcpServers: {},
            executionPort: {} as never,
            ownsSessionStore: false,
            ownsExecutionPort: false,
            ownsMcpPort: false,
            closeDynamicWorkflowRuns: (
              context: import("@lcode/contracts").ProtocolShutdownContext | undefined,
            ) => port.close(context),
          } as unknown as Parameters<typeof createSessionFacade>[0]);
          return {
            ...session,
            runtime,
            sessionId,
            resume: async () => ({}),
            listModels: () => [],
            getDynamicWorkflowRunPort: () => port,
            ...createAppWorkflowRunFacade({
              dynamicWorkflowRunPort: port,
              getRuntime: () => runtime,
              prepareUserExecutionBoundary: async () => {},
              traceContext: createRootTraceContext({ sessionId }),
            }),
          } as unknown as LCodeApp;
        },
      });
      t.after(async () => {
        release();
        await server.shutdown();
        unavailable.release();
        store.close();
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
      });
      const context = (server as unknown as { context: LCodeProtocolAgentServerContext }).context;
      context.requestClient = async (_method, _params, schema) =>
        schema.parse({ memoryEnabled: false, nativeSearchEnhancementsEnabled: true });
      await activateSessionForResume(context, { sessionId: callerId });
      const gateway = context.v4Gateway!;
      await gateway.subscribe({
        topic: `conversation/${callerId}`,
        connectionId: "fixture-connection",
        clientMode,
      });
      const envelope = {
        commandId: "recover-command",
        clientId: "fixture-client",
        sessionId: callerId,
        type: "resumeWorkflowRun",
        payload: { workId: "recover-original" },
        issuedAt: Date.now(),
      };
      const accepted = commandAckSchema.parse(await gateway.handleCommand(envelope));
      assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
      await waiting;
      assert.equal(created.get(originalId), 1);
      assert.equal(ports.get(originalId)!.countLiveRuns(), 1);
      assert.equal(ports.get(callerId)!.countLiveRuns(), 0);
      const duplicate = await gateway.handleCommand(envelope);
      assert.equal(duplicate.status, "duplicate");
      assert.deepEqual({ ...duplicate, status: "accepted" }, accepted);
      assert.equal(reads, 1);
      const refused = commandAckSchema.parse(
        await gateway.handleCommand({
          ...envelope,
          commandId: "unavailable-command",
          payload: { workId: "unavailable-run" },
        }),
      );
      assert.equal(refused.status, "failed");
      assert.equal(
        refused.reasonCode,
        "fault.command.workflowRunResumeRejected.owner_unavailable",
        JSON.stringify(refused),
      );
      assert.equal(created.has(unavailableId), false);
      unavailable.assertOwned();
      release();
      assert.equal(
        (await ports.get(callerId)!.waitForTask("recover-original"))?.runStatus,
        "completed",
      );
      assert.equal(
        store.workflowJournalStore().getRun("recover-original")?.parentSessionId,
        originalId,
      );
      assert.equal(created.get(originalId), 1);
    },
  );
}
