// usage-analytics fixture 数据模块。
// 重构说明：原模块从未入库（git log --all 无任何记录，且被 .gitignore 的
// /packages/web/test/fixtures/* 规则忽略——该目录只逐文件豁免了个别文件，
// 不含本模块），本文件依据 usage-analytics.test.mjs 的既有断言与
// usage-analytics.tsx 的消费方式反推重建（2026-10-12），数值约定记录在
// specs/frontend-ui-component-migration.md 的验证记录。
// 断言对齐：codex 汇总含 120（请求数）、27（错误数）→1（取消数）、240（推理 tokens）；
// claude 汇总含恰好为 "240" 的单元格（deferred 场景 exact 文本断言）；
// 已移除账号经 catalog snapshot 的 accounts 组投影进账号下拉（accountLabel 的
// removed 分支按 connectionId 前 8 位渲染 "已移除账号 · 33333333"）。

export const first = "11111111-1111-4111-8111-111111111111";
export const second = "22222222-2222-4222-8222-222222222222";
const removed = "33333333-3333-4333-8333-333333333333";
export const now = 1790000000000;

function metrics(overrides = {}) {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    cancelledCount: 0,
    retryCount: 0,
    knownUsageRequests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: null,
    avgTimeToFirstTokenMs: null,
    avgDurationMs: null,
    ...overrides,
  };
}

const codexSummary = metrics({
  requestCount: 120,
  successCount: 92,
  errorCount: 27,
  cancelledCount: 1,
  knownUsageRequests: 100,
  totalTokens: 480000,
  inputTokens: 320000,
  outputTokens: 168000,
  reasoningTokens: 240,
  cacheReadTokens: 12000,
  cacheWriteTokens: 4800,
  // 27.1% 与断言 /27.*1/ 同行匹配（innerText 按单元格换行，`.` 不跨行）
  cacheHitRate: 0.271,
  avgTimeToFirstTokenMs: 640,
  avgDurationMs: 3800,
});
const claudeSummary = metrics({
  requestCount: 60,
  successCount: 58,
  errorCount: 2,
  cancelledCount: 0,
  knownUsageRequests: 55,
  totalTokens: 210000,
  inputTokens: 150000,
  outputTokens: 42000,
  reasoningTokens: 240,
  cacheReadTokens: 6000,
  cacheWriteTokens: 2400,
  cacheHitRate: 0.18,
  avgTimeToFirstTokenMs: 820,
  avgDurationMs: 5200,
});
const combinedSummary = metrics({
  requestCount: 180,
  successCount: 150,
  errorCount: 29,
  cancelledCount: 1,
  knownUsageRequests: 155,
  totalTokens: 690000,
  inputTokens: 470000,
  outputTokens: 210000,
  reasoningTokens: 480,
  cacheReadTokens: 18000,
  cacheWriteTokens: 7200,
  cacheHitRate: 0.22,
  avgTimeToFirstTokenMs: 700,
  avgDurationMs: 4200,
});

export const view = {
  revision: 1,
  channels: [
    { id: "codex", name: "Codex", methods: [] },
    { id: "claude", name: "Claude", methods: [] },
  ],
  accounts: [
    {
      connectionId: first,
      channelId: "codex",
      displayName: "Shared account",
      enabled: true,
      status: "ready",
      models: [
        { id: "shared-model", name: "Shared model", protocol: "openai-chat-completions" },
        { id: "heavy-model", name: "Heavy model", protocol: "openai-chat-completions" },
      ],
    },
    {
      connectionId: second,
      channelId: "claude",
      displayName: "Shared account",
      enabled: true,
      status: "ready",
      models: [{ id: "shared-model", name: "Shared model", protocol: "anthropic-messages" }],
    },
  ],
};

const TOTAL_REQUESTS = 40;
const requestRecords = Array.from({ length: TOTAL_REQUESTS }, (_, index) => {
  const isCodex = index % 3 !== 2;
  const status = index % 17 === 16 ? "error" : "completed";
  return {
    providerId: isCodex ? "oauth:codex" : "oauth:claude",
    authChannelId: isCodex ? "codex" : "claude",
    accountConnectionId: isCodex ? first : second,
    id: `req-${index + 1}`,
    sessionId: `session-${index % 7}`,
    modelId: index % 4 === 3 ? "heavy-model" : "shared-model",
    querySource: "agent",
    status,
    startedAt: now - index * 3600000,
    durationMs: 1200 + index * 37,
    timeToFirstTokenMs: 210 + index * 11,
    totalTokens: 1500 + index * 130,
    inputTokens: 1000 + index * 90,
    outputTokens: 400 + index * 40,
    retryCount: 0,
    errorCode: status === "error" ? "upstream_timeout" : null,
  };
});

function dailyBuckets(request) {
  const days =
    request.range === "24h" ? 1 : request.range === "30d" || request.range === "all" ? 30 : 7;
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now - (days - 1 - index) * 86400000).toISOString().slice(0, 10);
    return {
      date,
      ...metrics({
        requestCount: 12 + index,
        successCount: 11 + index,
        errorCount: index % 3,
        knownUsageRequests: 10 + index,
        totalTokens: 40000 + index * 5200,
        inputTokens: 28000 + index * 3600,
        outputTokens: 9000 + index * 1200,
        reasoningTokens: 3000 + index * 400,
        cacheHitRate: 0.24,
        avgTimeToFirstTokenMs: 600 + index * 20,
        avgDurationMs: 3600 + index * 90,
      }),
    };
  });
}

function group(providerId, authChannelId, accountConnectionId, modelId, base) {
  return { providerId, authChannelId, accountConnectionId, modelId, ...base };
}

export function snapshot(request) {
  const summary = !request.providerId
    ? combinedSummary
    : request.providerId === "oauth:codex"
      ? codexSummary
      : claudeSummary;
  const offset = request.offset ?? 0;
  const limit = request.limit ?? 50;
  return {
    source: "agent-db",
    range: request.range,
    generatedAt: now,
    since: now - 30 * 86400000,
    until: now,
    timeZone: request.timeZone ?? "UTC",
    retentionDays: 30,
    summary,
    activity: {
      peakDayTokens: 96000,
      longestSessionMs: 7200000,
      currentStreakDays: 3,
      longestStreakDays: 9,
      activeDays: 12,
      dailyTruncated: false,
    },
    daily: dailyBuckets(request),
    dailyModels: [
      {
        date: new Date(now).toISOString().slice(0, 10),
        ...group("oauth:codex", "codex", first, "shared-model", {
          requestCount: 40,
          knownUsageRequests: 36,
          totalTokens: 90000,
        }),
      },
      {
        date: new Date(now).toISOString().slice(0, 10),
        ...group("oauth:claude", "claude", second, "shared-model", {
          requestCount: 20,
          knownUsageRequests: 19,
          totalTokens: 45000,
        }),
      },
    ],
    providers: [
      group("oauth:codex", "codex", null, null, codexSummary),
      group("oauth:claude", "claude", null, null, claudeSummary),
    ],
    accounts: [
      group("oauth:codex", "codex", first, null, codexSummary),
      group("oauth:claude", "claude", second, null, claudeSummary),
      group("oauth:codex", "codex", removed, null, metrics({ requestCount: 8, errorCount: 8 })),
    ],
    models: [
      group(
        "oauth:codex",
        "codex",
        first,
        "shared-model",
        metrics({ requestCount: 100, knownUsageRequests: 92, totalTokens: 420000 }),
      ),
      group(
        "oauth:codex",
        "codex",
        first,
        "heavy-model",
        metrics({ requestCount: 20, knownUsageRequests: 8, totalTokens: 60000 }),
      ),
      group(
        "oauth:claude",
        "claude",
        second,
        "shared-model",
        metrics({ requestCount: 60, knownUsageRequests: 55, totalTokens: 210000 }),
      ),
    ],
    requests: requestRecords.slice(offset, offset + limit),
    totalRequests: TOTAL_REQUESTS,
    offset,
    limit,
  };
}
