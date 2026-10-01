import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AiSdkModelAdapter } from "@lcode/adapters/model";
import { createRootTraceContext, type ModelSelection } from "@lcode/contracts";
import { AgentRuntime } from "@lcode/core";
import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplateMap,
  parseProviderConfig,
  type ProviderConfigSnapshot,
} from "@lcode/provider";
import { lcodeProtocolMethods, type ModelConnectivityResult } from "@lcode/shared";
import { ApiProviderModelRuntime } from "../app/provider-registry-model-runtime.js";
import { createSessionFacade } from "../app/session-facade.js";
import type { LCodeApp } from "../app/types.js";
import { LCodeProtocolNdjsonConnection } from "./transport.js";
import { testProviderModelConnectivity } from "./workspace-model-runtime.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const modelConfig = ModelConfig.fromData({
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 8192,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["low", "high"], map: '{"reasoning_effort": reasoningLevel}' },
    maxOutputTokens: { max: 1024, map: '{"max_tokens": maxOutputTokens}' },
    speed: { values: ["normal", "fast"], map: '{"service_tier": speed}' },
  },
});

test(
  "NDJSON temporary probes reach four real Adapter HTTP streams and finish without changing the active session",
  { timeout: 15_000 },
  async () => {
    const enteredFour = deferred();
    const release = deferred();
    const allResponses = deferred();
    let httpFailure: { status: number; code?: string } | undefined;
    const calls: Array<{
      body: Record<string, unknown>;
      headers: IncomingHttpHeaders;
      response: ServerResponse;
    }> = [];
    const network = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        calls.push({ body, headers: request.headers, response });
        if (calls.length === 4) enteredFour.resolve();
        await release.promise;
        if (httpFailure) {
          response.writeHead(httpFailure.status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "fixture upstream rejection",
                type: "invalid_request_error",
                code: httpFailure.code ?? null,
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
        };
        response.end(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
            "data: [DONE]\n\n",
        );
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    network.listen(0, "127.0.0.1");
    await once(network, "listening");
    const address = network.address();
    assert.ok(address && typeof address !== "string");
    let reads = 0;
    const config: ProviderConfigSnapshot = {
      revision: "config",
      lcodeBuiltinRevision: "builtin",
      personalRevision: "personal",
      lcodeBuiltinProviders: ProviderConfigMap.empty(),
      lcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
      personalProviders: new ProviderConfigMap([
        [
          "custom",
          parseProviderConfig({
            group: "standard-personal",
            access: { type: "api-key", apiKey: "fixture-key" },
            api: {
              type: "openai-chat-completions",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              headers: { "x-fixture": "frozen-header" },
            },
            personalModelIds: ["disabled", "published"],
            builtinModelIds: ["deleted"],
            excludedModelIds: ["deleted"],
          }),
        ],
      ]),
      lcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: modelConfig },
      ]),
      personalModels: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "custom",
          modelId: "disabled",
          config: ModelConfig.fromData({ enabled: false }),
        },
      ]),
      personalSaveGenerations: { custom: "saved-once" },
    };
    const registry = new ProviderRegistryService({
      configSource: {
        read: async () => {
          reads += 1;
          return config;
        },
        onDidChange: () => () => undefined,
      },
      accountSource: {
        read: async () => ({
          revision: "account",
          basedOnLCodeBuiltinRevision: "builtin",
          providers: ProviderConfigMap.empty(),
        }),
        onDidChange: () => () => undefined,
      },
    });
    await registry.start();
    const modelRuntime = new ApiProviderModelRuntime({
      registry,
      modelAdapter: new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }),
    });
    modelRuntime.start();
    const selected: ModelSelection = {
      providerId: "custom",
      modelId: "published",
      options: { reasoningLevel: "high", speed: "fast" },
    };
    const traceContext = createRootTraceContext();
    let accountRefreshes = 0;
    let closeCount = 0;
    const runtimeConfig = { modelSelection: selected };
    const runtime = {
      config: runtimeConfig,
      modelFactory: modelRuntime.modelFactory,
      rootTraceContext: traceContext,
      createModelStatusSink: () => undefined,
      testModelConnectivity: AgentRuntime.prototype.testModelConnectivity,
      getSessionModelSelection: () => selected,
      providerRuntimeHeadersPort: {
        shouldRefreshBeforeModelRequest: () => true,
        refreshBeforeModelRequest: async () => {
          accountRefreshes += 1;
          throw new Error("API key model must not refresh account headers");
        },
      },
    } as unknown as AgentRuntime;
    const facade = createSessionFacade({
      configResult: { config: { ui: { locale: "en-US", theme: "system" } } } as never,
      configuredMcpServers: {},
      executionPort: {} as never,
      logger: {} as never,
      loggerFactory: {} as never,
      ownsExecutionPort: false,
      ownsMcpPort: false,
      ownsSessionStore: false,
      prepareResume: async () => undefined,
      prepareUserExecutionBoundary: async () => undefined,
      projectID: "fixture-project" as never,
      providerRegistry: registry,
      temporaryModelFactory: modelRuntime.temporaryModelFactory,
      resolveUiLocale: () => "en-US",
      runtime,
      sessionId: "fixture-session" as never,
      sessionStore: {} as never,
      traceContext,
      untrustedProjectMcpServers: new Set(),
      workingDirectory: "/workspace",
    });
    const workspace = { workspacePath: "/workspace", workspaceKey: "/workspace" };
    const app = {
      ...facade,
      runtime,
      close: async () => {
        closeCount += 1;
      },
    } as LCodeApp;
    const context = {
      sessions: new Map([["fixture-session", { workspace, app }]]),
      deps: {
        refreshProviderRegistry: async () => {
          await registry.refresh("connectivity");
        },
        createLCodeApp: () => {
          throw new Error("active session should be reused");
        },
      },
    } as unknown as LCodeProtocolAgentServerContext;
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const responses: Array<{ id: string; result?: unknown; error?: unknown }> = [];
    const failureResponses = new Map<string, (result: ModelConnectivityResult) => void>();
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const message = JSON.parse(line) as {
          id: string;
          result?: ModelConnectivityResult;
          error?: unknown;
        };
        responses.push(message);
        if (message.result) failureResponses.get(message.id)?.(message.result);
      }
      if (responses.length === 5) allResponses.resolve();
    });
    const connection = new LCodeProtocolNdjsonConnection({
      input,
      output,
      signal: controller.signal,
      handleMessage: async (message) => {
        if (!("method" in message) || !("id" in message)) return;
        if (message.method !== lcodeProtocolMethods.providerTestModelConnectivity)
          return { id: message.id, result: {} };
        try {
          return {
            id: message.id,
            result: await testProviderModelConnectivity(context, message.params),
          };
        } catch (error) {
          return { id: message.id, error: { code: -32000, message: String(error) } };
        }
      },
    });
    connection.start();
    const snapshot = registry.getSnapshot();
    try {
      input.write(
        ["unregistered", "disabled", "deleted", "another"]
          .map((modelId) =>
            JSON.stringify({
              id: modelId,
              method: lcodeProtocolMethods.providerTestModelConnectivity,
              params: {
                workspace,
                selection: { providerId: "custom", modelId },
                mode: "temporary",
              },
            }),
          )
          .join("\n") + "\n",
      );
      await enteredFour.promise;
      assert.equal(
        responses.length,
        0,
        "all four physical HTTP requests started before any probe finishes",
      );
      input.write(
        JSON.stringify({
          id: "ordinary",
          method: lcodeProtocolMethods.workspaceUpdateModelIoPreferences,
          params: {},
        }) + "\n",
      );
      await tick();
      assert.deepEqual(
        responses.map(({ id }) => id),
        ["ordinary"],
      );
      assert.equal(calls.length, 4);
      assert.deepEqual(calls.map(({ body }) => body.model).sort(), [
        "another",
        "deleted",
        "disabled",
        "unregistered",
      ]);
      for (const { body, headers } of calls) {
        assert.equal(headers.authorization, "Bearer fixture-key");
        assert.equal(headers["x-fixture"], "frozen-header");
        assert.equal(body.max_tokens, 1);
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.service_tier, "normal");
        assert.equal(body.stream, true);
        assert.equal(body.tools, undefined);
        assert.deepEqual(body.messages, [
          { role: "system", content: "You are LCode connectivity probe." },
          { role: "user", content: "hi" },
        ]);
      }
      release.resolve();
      await allResponses.promise;
      assert.equal(responses.filter(({ error }) => error).length, 0);
      for (const response of responses.filter(({ id }) => id !== "ordinary"))
        assert.deepEqual(response.result, { success: true });
      assert.equal(runtime.getSessionModelSelection(), selected);
      assert.equal(runtimeConfig.modelSelection, selected);
      assert.equal(registry.getSnapshot(), snapshot);
      assert.equal(registry.getModel("custom", "disabled"), undefined);
      assert.equal(registry.getModel("custom", "deleted"), undefined);
      assert.equal(accountRefreshes, 0);
      assert.equal(closeCount, 0);
      assert.ok(reads >= 2, "workspace handler refreshes authoritative provider facts");
      const failures = [
        { status: 404, code: "model_not_found", expected: "model-not-found" },
        { status: 400, code: "invalid_model", expected: "model-not-found" },
        { status: 404 },
        { status: 401, code: "model_not_found" },
        { status: 403, code: "model_not_found" },
        { status: 429, code: "model_not_found" },
        { status: 500, code: "model_not_found" },
      ];
      for (const [index, failure] of failures.entries()) {
        httpFailure = failure;
        const id = `http-failure-${index}`;
        const resultPromise = new Promise<ModelConnectivityResult>((resolve) =>
          failureResponses.set(id, resolve),
        );
        input.write(
          JSON.stringify({
            id,
            method: lcodeProtocolMethods.providerTestModelConnectivity,
            params: {
              workspace,
              selection: { providerId: "custom", modelId: id },
              mode: "temporary",
            },
          }) + "\n",
        );
        const result = await resultPromise;
        failureResponses.delete(id);
        assert.equal(result.success, false);
        if (result.success) throw new Error("expected failed HTTP probe");
        assert.equal(
          result.error.code,
          failure.expected,
          `HTTP ${failure.status}/${failure.code ?? "unknown"}`,
        );
        assert.equal(registry.getSnapshot(), snapshot);
        assert.equal(runtime.getSessionModelSelection(), selected);
      }
    } finally {
      release.resolve();
      controller.abort();
      await connection.waitForClose();
      input.destroy();
      output.destroy();
      modelRuntime.dispose();
      registry.dispose();
      network.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        network.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
