import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Event } from "@lcode/rpc";
import type { AppUsageRange, AppUsageSnapshot } from "@lcode/shared";
import { V4_METHODS, v4UsageStatsParamsSchema } from "@lcode/shared/lcode-protocol-v4";
import { createUsageStatsService } from "./usageStatsService.js";
import { createLCodeAgentService } from "../lcode-agent/lcodeAgentService.js";
import { LCodeAgentProcessManager } from "../lcode-agent/lcodeAgentProcessManager.js";
import type { LCodeProtocolClient } from "../lcode-agent/lcodeProtocolClient.js";
import { setDataBaseDir } from "../paths.js";

function emptySnapshot(range: AppUsageRange): AppUsageSnapshot {
  return {
    range,
    generatedAt: 1000,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalTurns: 0,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 0,
      currentStreakDays: 0,
      longestSessionMs: 0,
      longestStreakDays: 0,
      peakDayTokens: 0,
      favoriteModel: null,
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
    dailyModelUsage: [],
    models: [],
    tools: [],
  };
}

test("API-only scope survives UsageStatsService and the real Host V4 request boundary", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-api-usage-"));
  setDataBaseDir(dir);
  const calls: unknown[] = [];
  const client = {
    isDisposed: false,
    onNotification: Event.None,
    onRequest: Event.None,
    onClose: Event.None,
    request: async (method: string, input: unknown, schema: { parse(value: unknown): unknown }) => {
      assert.equal(method, V4_METHODS.usageStats);
      const params = v4UsageStatsParamsSchema.parse(input);
      calls.push(params);
      return schema.parse(emptySnapshot(params.range));
    },
  } as unknown as LCodeProtocolClient;
  t.mock.method(LCodeAgentProcessManager.prototype, "getExistingClient", () => client);
  t.mock.method(LCodeAgentProcessManager.prototype, "getRuntimeIdentity", async () => null);
  t.mock.method(LCodeAgentProcessManager.prototype, "getClient", async () =>
    assert.fail("statistics must not start an Agent"),
  );
  const agent = createLCodeAgentService();
  t.after(async () => {
    await agent.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  });
  await agent.getWorkspaceRuntimeIdentity({ workspacePath: dir });
  type Dependencies = Parameters<typeof createUsageStatsService>[0];
  const usage = createUsageStatsService({
    apiClient: {} as Dependencies["apiClient"],
    accountRequestAuthService: {
      resolveAccessCurrent: async () => assert.fail("API statistics must not fetch a plan"),
      resolveCurrent: async () => assert.fail("API statistics must not fetch a plan"),
      assertCurrent: async () => assert.fail("API statistics must not fetch a plan"),
    },
    lcodeAgentService: agent,
  });
  for (const range of ["7d", "all"] as const) {
    assert.deepEqual(
      await usage.getAppUsageSnapshot({ range, timeZone: "UTC", connectionType: "api-key" }),
      emptySnapshot(range),
    );
  }
  assert.deepEqual(calls, [
    { range: "7d", timeZone: "UTC", connectionType: "api-key" },
    { range: "all", timeZone: "UTC", connectionType: "api-key" },
  ]);
});
