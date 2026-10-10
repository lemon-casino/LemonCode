import assert from "node:assert/strict";
import test from "node:test";
import { createMessageId, SessionEventType } from "../deps.js";
import type { SessionInfo, SessionStorePort } from "../deps.js";
import { createPreparedSessionTitle } from "../prepared-session-title.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import { maybeStartSessionTitleGeneration, setCustomSessionTitle } from "./session-title.js";

const input = "清理帮助菜单中的多个入口，同时移除问题上报。";
const summarized = "清理帮助与问题上报入口";

function fixture(prepared = false) {
  const f = createMockRuntime({
    taskType: "interactive",
    workingDirectory: "/fixture",
    titleGeneration: {
      preparedTitle: prepared ? createPreparedSessionTitle(summarized, input) : undefined,
    },
  });
  let session: SessionInfo | null = null;
  let resolveUpdated: () => void = () => {};
  const updated = new Promise<void>((resolve) => {
    resolveUpdated = resolve;
  });
  const store = {
    createSession: async (data: Parameters<SessionStorePort["createSession"]>[0]) =>
      (session = {
        ...data,
        taskType: data.taskType ?? "interactive",
        time: { created: 1, updated: 1 },
      } as SessionInfo),
    getSession: async () => session,
    getMessages: async () => [],
    saveSessionEntry: async () => {},
    listSessionEntries: async () => [],
    updateSession: async (data: Parameters<SessionStorePort["updateSession"]>[0]) => {
      if (!session) return null;
      if (data.expectedTitleSources && !data.expectedTitleSources.includes(session.titleSource!))
        return session;
      session = { ...session, ...data };
      resolveUpdated();
      return session;
    },
  } as unknown as SessionStorePort;
  Object.assign(f.runtime, { sessionStore: store });
  let modelCalls = 0;
  let result = '{"title":"清理帮助与问题上报入口"}';
  let releaseModel: (() => void) | undefined;
  let modelWait: Promise<void> | undefined;
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending: Promise<unknown>[] = [];
  const track = f.runtime.trackResidencyBlockingWork;
  f.runtime.trackResidencyBlockingWork = function (work) {
    const tracked = track.call(this, work);
    pending.push(tracked);
    return tracked as typeof work;
  };
  Object.assign(f.model, {
    bind: () => f.model,
    generateText: async () => {
      modelCalls++;
      markStarted();
      await modelWait;
      return { text: result, finishReason: "stop", usage: {} };
    },
  });
  return {
    ...f,
    session: () => session,
    updated,
    pending,
    started,
    modelCalls: () => modelCalls,
    result: (value: string) => {
      result = value;
    },
    defer: () => {
      modelWait = new Promise((resolve) => {
        releaseModel = resolve;
      });
    },
    release: () => releaseModel?.(),
    edit: (messageId: string) => {
      if (session)
        session = {
          ...session,
          title: "已编辑的任务",
          titleSource: "first_input",
          revert: { targetMessageID: messageId } as SessionInfo["revert"],
        };
    },
  };
}

test("prepared worktree summary is persisted as the session title and emits the common event without another model call", async () => {
  const f = fixture(true);
  await f.runtime.ensureSessionPersisted(input, f.runtime.rootTraceContext);
  assert.equal(f.session()?.title, summarized);
  assert.equal(f.session()?.titleSource, "generated");
  const event = f.storedEvents.find((e) => e.type === SessionEventType.SessionTitleUpdated)!;
  assert.equal((event.payload as { title: string }).title, summarized);
  assert.equal((event.payload as { source: string }).source, "generated");
  assert.equal(
    maybeStartSessionTitleGeneration.call(
      f.runtime,
      input,
      createMessageId(),
      f.runtime.rootTraceContext,
    ),
    false,
  );
  assert.equal(f.modelCalls(), 0);
});

test("ordinary first input continues through the one title sidecar and publishes its summarized title", async () => {
  const f = fixture();
  await f.runtime.ensureSessionPersisted(input, f.runtime.rootTraceContext);
  assert.equal(
    maybeStartSessionTitleGeneration.call(
      f.runtime,
      input,
      createMessageId(),
      f.runtime.rootTraceContext,
    ),
    true,
  );
  await f.updated;
  await f.pending[0];
  assert.equal(f.session()?.title, summarized);
  assert.equal(f.session()?.titleSource, "generated");
  assert.equal(f.modelCalls(), 1);
});

test("a custom task title stays authoritative and never calls the summary model", async () => {
  const f = fixture();
  await f.runtime.ensureSessionPersisted(input, f.runtime.rootTraceContext);
  await setCustomSessionTitle.call(f.runtime, {
    title: "手动任务名称",
    traceContext: f.runtime.rootTraceContext,
  });
  maybeStartSessionTitleGeneration.call(
    f.runtime,
    input,
    createMessageId(),
    f.runtime.rootTraceContext,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.session()?.title, "手动任务名称");
  assert.equal(f.session()?.titleSource, "custom");
  assert.equal(f.modelCalls(), 0);
});

test("late summary cannot replace a manually named task or edited first query", async () => {
  for (const edit of [false, true]) {
    const f = fixture();
    f.defer();
    await f.runtime.ensureSessionPersisted(input, f.runtime.rootTraceContext);
    const messageId = createMessageId();
    maybeStartSessionTitleGeneration.call(f.runtime, input, messageId, f.runtime.rootTraceContext);
    await f.started;
    if (edit) f.edit(messageId);
    else
      await setCustomSessionTitle.call(f.runtime, {
        title: "手动任务名称",
        traceContext: f.runtime.rootTraceContext,
      });
    f.release();
    await f.pending[0];
    assert.equal(f.session()?.title, edit ? "已编辑的任务" : "手动任务名称");
  }
});

test("invalid title output never becomes a truncated task title", async () => {
  for (const result of [
    "直接回答用户的任务",
    '{"title":"' + "超长".repeat(20) + '"}',
    '{"title":"概括标题..."}',
  ]) {
    const f = fixture();
    f.result(result);
    await f.runtime.ensureSessionPersisted(input, f.runtime.rootTraceContext);
    maybeStartSessionTitleGeneration.call(
      f.runtime,
      input,
      createMessageId(),
      f.runtime.rootTraceContext,
    );
    await f.pending[0];
    assert.equal(f.session()?.titleSource, "first_input");
    assert.equal(f.session()?.title, input);
  }
});
