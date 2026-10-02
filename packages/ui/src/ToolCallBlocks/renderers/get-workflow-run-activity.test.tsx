import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkflowRunSubagentRoster } from "./get-workflow-run-roster.js";

const row = {
  siteId: "actor#one",
  ordinal: 1,
  name: "Reader",
  state: "executing" as const,
  stepsSettled: 0,
  stepsFailed: 0,
  tokens: 0,
};

function render(
  subagent: Parameters<typeof WorkflowRunSubagentRoster>[0]["subagents"][number],
  locale: "zh-CN" | "en-US" = "zh-CN",
  generatedAt: number | undefined = 3_000,
) {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale={locale}>
      <WorkflowRunSubagentRoster subagents={[subagent]} generatedAt={generatedAt} />
    </LCodeIntlProvider>,
  );
}

test("观察卡在 ask 未返回时呈现已观察活动而不猜隐藏推理", () => {
  const html = render({
    ...row,
    askPhase: "executing",
    activity: {
      kind: "model",
      observedAt: 2_000,
      since: 2_000,
      requestsCompleted: 2,
      toolCalls: 3,
    },
  });
  assert.match(html, /模型请求处理中，尚无可见输出/);
  assert.match(html, /成功请求/);
  assert.doesNotMatch(html, /正在输出思考|死锁|0 token/);
});

test("观察卡第一次重试使用生成时刻计算等待，不是渲染时刻", () => {
  const html = render({
    ...row,
    state: "waiting",
    waitCause: "backoff",
    waitSince: 2_500,
    nextRetryAt: 8_000,
    retryAttempt: 2,
    waitReason: "network_error",
  });
  assert.match(html, /第 1 次重试/);
  assert.match(html, /5/);
  assert.doesNotMatch(html, /最多 0|死锁/);
});

test("停止后的截面不继续声称模型正在执行", () => {
  const html = render({
    ...row,
    state: "unfinished",
    activity: {
      kind: "reasoning",
      observedAt: 2_000,
      since: 2_000,
      requestsCompleted: 0,
      toolCalls: 0,
    },
  });
  assert.doesNotMatch(html, /正在输出思考/);
});

const observedTool = {
  kind: "tool" as const,
  toolName: "Read",
  observedAt: 2_000,
  since: 1_000,
  requestsCompleted: 2,
  toolCalls: 3,
  lastRequestCompletedAt: 500,
};

test("首次重试和槽位等待保留并行工具、请求统计及最近交付", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const waitCause of ["slot", "backoff"] as const) {
      const html = render({
        ...row,
        state: "waiting",
        askPhase: "waiting",
        waitCause,
        waitSince: 1_000,
        retryAttempt: 2,
        nextRetryAt: 8_000,
        waitReason: "network_error",
        activity: observedTool,
        lastDeliveredAt: 0,
      }, locale);
      assert.match(html, locale === "zh-CN" ? /正在执行工具：Read/ : /Running tool: Read/);
      assert.match(html, locale === "zh-CN" ? /成功请求数.*2/ : /Successful requests.*2/);
      assert.match(html, locale === "zh-CN" ? /3 次工具调用/ : /3 tool calls/);
      assert.match(html, locale === "zh-CN" ? /最近活动/ : /Last activity/);
      assert.match(html, locale === "zh-CN" ? /最近成功请求/ : /Last successful request/);
      assert.match(html, locale === "zh-CN" ? /已观察的最近交付/ : /Latest observed delivery/);
      assert.match(html, locale === "zh-CN" ? /等待开始/ : /Waiting since/);
      assert.match(html, /2s/);
      if (waitCause === "backoff") assert.match(html, locale === "zh-CN" ? /第 1 次重试/ : /Retry 1/);
      else assert.doesNotMatch(html, /预计|Expected to continue|第 1 次重试|Retry 1/);
    }
  }
});

test("静态等待解释只读取 askPhase 和 queue，不把派发或暂停猜成 provider 等待", () => {
  for (const [askPhase, queue, expected] of [
    ["queued", undefined, /任务已创建，尚未派发/],
    ["queued", { cause: "actor-fifo" }, /等待同一代理的前序任务/],
    ["queued", { cause: "run-capacity" }, /等待工作流并发名额/],
    ["dispatched", undefined, /正在准备，尚未确认模型请求启动/],
    ["paused", undefined, /已暂停/],
  ] as const) {
    const html = render({ ...row, state: "waiting", askPhase, queue, activity: observedTool });
    assert.match(html, expected);
    assert.doesNotMatch(html, /等待并发槽位|正在执行工具/);
    assert.match(html, /成功请求数.*2/);
  }
  for (const state of ["waiting", "executing"] as const) {
    const legacy = render({ ...row, state, activity: observedTool });
    assert.match(legacy, /活动状态暂不可确认/);
    assert.doesNotMatch(legacy, /等待并发槽位|正在执行工具/);
  }
});

test("终态和暂停保留统计而不点亮历史工具或重试", () => {
  for (const patch of [
    { state: "unfinished" as const },
    { state: "done" as const },
    { state: "failed" as const },
    { state: "waiting" as const, askPhase: "paused" as const },
  ]) {
    const html = render({
      ...row,
      ...patch,
      activity: observedTool,
      waitCause: "backoff",
      retryAttempt: 2,
      nextRetryAt: 8_000,
      waitSince: 1_000,
      lastDeliveredAt: 0,
    });
    assert.doesNotMatch(html, /正在执行工具|预计|后重试|已等/);
    assert.match(html, /成功请求数.*2/);
    assert.match(html, /最近成功请求/);
    assert.match(html, /已观察的最近交付/);
  }
});

test("静态卡的时间只取 generatedAt，重复渲染不会增长等待年龄", (t) => {
  const subagent = {
    ...row,
    state: "waiting" as const,
    askPhase: "waiting" as const,
    waitCause: "backoff" as const,
    waitSince: 1_000,
    nextRetryAt: 8_000,
    activity: observedTool,
  };
  t.mock.method(Date, "now", () => 40_000);
  const first = render(subagent);
  t.mock.method(Date, "now", () => 900_000);
  assert.equal(render(subagent), first);
  assert.match(first, /5 秒后继续/);
  const unknownClock = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <WorkflowRunSubagentRoster subagents={[subagent]} generatedAt={undefined} />
    </LCodeIntlProvider>,
  );
  assert.doesNotMatch(unknownClock, /预计|已等|秒后继续/);
});
