import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNodeContextSourceAdapter,
  createNodeFileSystemAdapter,
  createSqliteSessionStore,
} from "@lcode/adapters";
import {
  AgentRuntime,
  PermissionService,
  type AgentRuntimeConfig,
  type AgentRuntimeDeps,
} from "@lcode/core";
import {
  createInMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type Model,
  type ModelSelection,
} from "@lcode/contracts";
import { NoopAgentExecutionTelemetry } from "@lcode/telemetry";
import { createAppDynamicWorkflowPort } from "./app-dynamic-workflow.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { v4AnswerToPermissionResponse } from "../lcode-protocol/interaction-permission-response.js";
import { buildProtocolPermissionOptions } from "../lcode-protocol/permission-options.js";

const parentSelection: ModelSelection = {
  providerId: "provider-parent",
  modelId: "parent-model",
  options: { reasoningLevel: "low", speed: "standard" },
};
const overrides = [
  {
    siteId: "actor#1",
    selection: {
      providerId: "provider-executor",
      modelId: "executor-model",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  },
  {
    siteId: "actor#2",
    selection: {
      providerId: "provider-reviewer",
      modelId: "reviewer-model",
      options: { reasoningLevel: "low", speed: "standard" },
    },
  },
];
const script = [
  'const executor = agent("executor");',
  'const reviewer = agent("reviewer");',
  'phase("Execute");',
  'const result = await executor.ask("fixture execute");',
  'phase("Review");',
  "return await reviewer.ask(result);",
].join("\n");

for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(
    `approved workflow models reach actual child requests through ${deliveryKind}`,
    { timeout: 30_000 },
    async (t) => {
      const prefix = "lcode-approved-model-requests-";
      const directory = await mkdtemp(join(tmpdir(), prefix));
      const store = createSqliteSessionStore({ dbPath: ":memory:" });
      const sessionId = createSessionId();
      const traceContext = createRootTraceContext({ sessionId });
      const agentTelemetry = new NoopAgentExecutionTelemetry();
      const eventStore = createInMemorySessionEventStore();
      const fileSystemPort = createNodeFileSystemAdapter();
      const contextSourcePort = createNodeContextSourceAdapter({ env: { LCODE_HOME: directory } });
      const permissionService = new PermissionService();
      const requests: ModelSelection[] = [];
      const selections = [parentSelection, ...overrides.map((override) => override.selection)];
      const modelFactory: NonNullable<AgentRuntimeDeps["modelFactory"]> = ({ selection }) => {
        const model = {
          providerId: selection.providerId,
          modelId: selection.modelId,
          options: selection.options ?? {},
          optionSpecs: {
            maxOutputTokens: { max: 4096 },
            reasoningLevel: { values: ["low", "high"] },
            speed: { values: ["standard", "fast"] },
          },
          properties: {
            contextWindow: 128_000,
            inputFormat: { supportsText: true },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsMidConversationSystem: true,
          },
          bind: () => model,
          generateText: async () => {
            requests.push(structuredClone(selection));
            return {
              text: "fixture actor result",
              finishReason: "stop",
              usage: { inputTokens: 10, outputTokens: 3 },
            };
          },
        } as unknown as Model;
        return model;
      };
      const runtimeConfig: AgentRuntimeConfig = {
        workingDirectory: directory,
        workspacePath: directory,
        modelSelection: parentSelection,
        clientMode: deliveryKind,
        deliveryKind,
        modelStreaming: "off",
        compact: { enabled: false },
        memory: { enabled: false },
        mcp: { enabled: false },
        subagents: { enabled: false },
        titleGeneration: { enabled: false },
        toolAllowlist: ["CreateWorkflow"],
      };
      let parent!: AgentRuntime;
      const port = createAppDynamicWorkflowPort({
        agentTelemetry,
        appOptions: {
          env: { LCODE_HOME: directory },
          contextSourcePort,
          executionPort: {},
          fileSystemPort,
          providerRegistry: {
            getView: () => ({
              providers: selections.map((selection) => ({
                providerId: selection.providerId,
                models: [
                  {
                    modelId: selection.modelId,
                    config: {
                      optionSpecs: {
                        reasoningLevel: { values: ["low", "high"] },
                        speed: { values: ["standard", "fast"] },
                      },
                    },
                  },
                ],
              })),
            }),
            validateSelection: (selection: ModelSelection) => {
              assert.ok(
                selections.some((allowed) => JSON.stringify(allowed) === JSON.stringify(selection)),
              );
              return { ok: true };
            },
          },
        },
        configResult: { config: { network: {} } },
        contextSourcePort,
        executionPort: {},
        fileSystemPort,
        getRuntime: () => parent,
        modelFactory,
        permissionService,
        runtimeConfig,
        sessionId,
        sessionStore: store,
        storageRoot: directory,
        traceContext,
        workingDirectory: directory,
        workflowConcurrencyGovernor: getWorkflowConcurrencyGovernor(),
      } as unknown as Parameters<typeof createAppDynamicWorkflowPort>[0]);
      assert.ok(port);
      parent = new AgentRuntime(sessionId, runtimeConfig, {
        agentTelemetry,
        contextSourcePort,
        dynamicWorkflowRunPort: port,
        eventStore,
        fileSystemPort,
        modelFactory,
        permissionService,
        sessionStore: store,
        permissionBroker: {
          requestPermission: async (request) =>
            v4AnswerToPermissionResponse(
              {
                optionId: "allowOnce",
                content: {
                  modifiedInput: { ...(request.input as object), actor_model_overrides: overrides },
                },
              },
              buildProtocolPermissionOptions(request),
              request.toolName,
            ),
        },
      });
      t.after(async () => {
        await port.close();
        await parent.closeBrowserSession();
        store.close();
        assert.ok(directory.startsWith(join(tmpdir(), prefix)));
        // 引擎结算后 Windows 可能短暂保留脚本子进程的 cwd 句柄；只重试测试目录清理。
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
      });
      await parent.ensureSessionPersistedForExternalActivity("fixture workflow");
      const result = await parent
        .getToolExecutor()
        .execute({ id: "fixture-create", name: "CreateWorkflow", input: { script } } as never);
      assert.equal(result.success, true, JSON.stringify(result.error));
      const runId = (result.output as { backgroundTaskId: string }).backgroundTaskId;
      const snapshot = await port.waitForTask(runId);
      assert.equal(snapshot?.runStatus, "completed", JSON.stringify(snapshot?.failure));
      assert.deepEqual(
        requests,
        overrides.map((override) => override.selection),
      );
      assert.deepEqual(parent.getSessionModelSelection(), parentSelection);
      for (const actor of store.workflowJournalStore().listActors(runId)) {
        assert.equal(actor.modelProvenance, "approvedActorOverride");
        const expected = overrides.find((override) => override.siteId === actor.siteId);
        assert.ok(expected);
        assert.equal(actor.resolvedModel, `selection:${JSON.stringify(expected.selection)}`);
      }
    },
  );
}
