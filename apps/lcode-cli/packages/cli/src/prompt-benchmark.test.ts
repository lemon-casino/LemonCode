import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelNetworkStatusEvent, PhysicalRequestAccountingPort } from "@lcode/contracts";
import type { RunContext } from "@lcode/shared-types";
import type { RunDependencies } from "./cli-types.js";
import { runPrompt } from "./prompt-command.js";

test("headless accounting includes memory drain and close, and strict Goal is frozen before submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-prompt-bench-"));
  try {
    const acceptance = {
      policy: "strict",
      requirements: [
        {
          id: "tests",
          description: "pass fixture",
          source: "Bash",
          command: "node verify.mjs",
          inputPaths: ["answer.mjs"],
        },
      ],
    };
    const path = join(root, "acceptance.json");
    await writeFile(path, JSON.stringify(acceptance));
    const output: string[] = [],
      order: string[] = [];
    let sink: PhysicalRequestAccountingPort | undefined;
    const record = (id: string, source: string) => {
      sink!.beforeRequest({ requestId: id, contextWindow: 100, maxOutputTokens: 10 });
      for (const type of ["model_request_started", "model_request_completed"])
        void sink!.publish({
          type,
          requestId: id,
          querySource: source,
          timestamp: "2026-10-10T00:00:00Z",
          usage: { totalTokens: 7 },
        } as ModelNetworkStatusEvent);
    };
    const app = {
      traceId: "trace",
      sessionId: "session",
      runtime: {
        isProjectMemoryEnabled: () => true,
        drainMemoryExtractions: async () => {
          order.push("drain");
          record("memory", "project_memory_extraction");
        },
      },
      setTarget: async (input: { acceptance: unknown }) => {
        assert.equal((input.acceptance as { policy: string }).policy, "strict");
        order.push("goal");
      },
      readTarget: async () => ({ status: "complete", acceptance }),
      submitPrompt: async () => {
        order.push("submit");
        record("main", "main_turn");
        return {
          response: "done",
          events: [],
          projection: { status: "idle", turnCount: 1, totalTokenCount: 7 },
        };
      },
      close: async () => {
        order.push("close");
        record("close", "session_title");
      },
    };
    const deps = {
      cwd: () => root,
      env: {},
      skipUserConfig: true,
      shutdownProcess: Object.assign(new EventEmitter(), { platform: process.platform }),
      loadDotenv: () => ({ loaded: false, keys: [] }),
      prepareLCodeTelemetryEnv: async () => ({}),
      shutdownLCodeTelemetry: async () => {},
      startProcessProviderRegistryRuntime: async () => ({
        runtime: { registryService: {} },
        dispose() {},
      }),
      createLCodeApp: async (options: {
        physicalRequestAccounting?: PhysicalRequestAccountingPort;
      }) => {
        sink = options.physicalRequestAccounting;
        return app;
      },
      mapSessionEvent: () => ({}),
    } as unknown as RunDependencies;
    const context = {
      argv: [],
      stdin: {},
      stdout: { write: (value: string) => output.push(value) },
      stderr: { write: (value: string) => assert.fail(value) },
    } as unknown as RunContext;
    assert.equal(
      await runPrompt(
        context,
        "synthetic task",
        [],
        {
          force: false,
          json: false,
          noColor: true,
          verbose: false,
          outputFormat: "stream-json",
          memoryBench: true,
          goalAcceptancePath: path,
          benchmarkLimits: JSON.stringify({ maxRequests: 4, maxReservedTokens: 1000 }),
        },
        deps,
        "test",
      ),
      0,
    );
    assert.deepEqual(order, ["goal", "submit", "drain", "close"]);
    const result = JSON.parse(output.join(""));
    assert.equal(result.type, "result");
    assert.equal(result.physicalRequests.totalTokens, 21);
    assert.equal(result.physicalRequests.maintenanceTokens, 7);
    assert.deepEqual(result.benchmarkTreatment.goal, {
      policy: "strict",
      status: "complete",
      requirementCount: 1,
    });
    assert.throws(
      () => sink!.beforeRequest({ requestId: "late", contextWindow: 100, maxOutputTokens: 10 }),
      /closed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
