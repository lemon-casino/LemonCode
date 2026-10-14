import assert from "node:assert/strict";
import test from "node:test";
import type { LCodeApp } from "../app/types.js";
import { browserFixture } from "./browser-control-broker.fixture.js";
import { activateSessionForResume } from "./server-operations.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { ProtocolRuntimeResources } from "./runtime-resources.js";

function fixture() {
  const { context } = browserFixture();
  let fail = true;
  let created = 0,
    resumed = 0,
    closed = 0,
    unsubscribed = 0;
  let wait: Promise<void> | undefined;
  let subscriptionFailure = false;
  context.appRuntimePreferences = {} as LCodeProtocolAgentServerContext["appRuntimePreferences"];
  context.v4Interactions = {
    initializeAskUserQuestionAutoResolutionEnabled: async () => {},
  } as unknown as LCodeProtocolAgentServerContext["v4Interactions"];
  const original = context.requestClient;
  context.requestClient = (method, params, schema, options) =>
    (params as { scope: string }).scope === "runtime-materialization"
      ? Promise.resolve(
          schema.parse({ memoryEnabled: false, nativeSearchEnhancementsEnabled: true }),
        )
      : original(method, params, schema, options);
  context.deps = {
    cwd: "fixture",
    sessionStore: {
      getSession: async (id: string) => ({
        id,
        path: "fixture",
        directory: "fixture",
        workspaceID: "fixture",
        taskType: "interactive",
        time: { created: 1, updated: 2 },
      }),
      messages: async () => [],
    },
    createSessionEventStore: () => ({}),
    createLCodeApp: async (options: { sessionId: string }) => {
      created++;
      return {
        sessionId: options.sessionId,
        runtime: {
          subscribeEvents: () => {
            if (subscriptionFailure) throw new Error("fixture subscription failure");
            return () => {
              unsubscribed++;
            };
          },
        },
        resume: async () => {
          resumed++;
          await wait;
          if (fail) throw new Error("fixture resume failure");
          return {};
        },
        close: async () => {
          closed++;
        },
      };
    },
  } as unknown as LCodeProtocolAgentServerContext["deps"];
  return {
    context,
    failSubscription: () => {
      subscriptionFailure = true;
    },
    succeed: () => {
      fail = false;
    },
    waitFor: (promise: Promise<void>) => {
      wait = promise;
    },
    counts: () => ({ created, resumed, closed, unsubscribed }),
  };
}

test("failed root resume rolls back its candidate and the next resume actually retries", async () => {
  const f = fixture();
  await assert.rejects(
    activateSessionForResume(f.context, { sessionId: "recover" }),
    /fixture resume failure/,
  );
  assert.equal(f.context.sessions.has("recover"), false);
  assert.deepEqual(f.counts(), { created: 1, resumed: 1, closed: 1, unsubscribed: 1 });
  f.succeed();
  await activateSessionForResume(f.context, { sessionId: "recover" });
  assert.equal(f.context.sessions.has("recover"), true);
  assert.equal(f.counts().resumed, 2);
});

test("concurrent resume has one candidate and does not publish before initialization", async () => {
  const f = fixture();
  f.succeed();
  let release!: () => void;
  f.waitFor(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const first = activateSessionForResume(f.context, { sessionId: "recover" });
  const second = activateSessionForResume(f.context, { sessionId: "recover" });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.context.sessions.has("recover"), false);
    assert.equal(f.counts().created, 1);
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

test("failed app close remains owned and is retried before a new same-ID app allocation", async () => {
  let attempts = 0,
    created = 0;
  const resources = new ProtocolRuntimeResources(async () => {
    created++;
    return {
      sessionId: "recover",
      runtime: { beginShutdown() {} },
      close: async () => {
        attempts++;
        if (attempts === 1) throw new Error("fixture close failure");
      },
    } as unknown as LCodeApp;
  });
  const app = await resources.create({ sessionId: "recover" } as never);
  await assert.rejects(app.close!(), /fixture close failure/);
  await resources.create({ sessionId: "recover" } as never);
  assert.equal(attempts, 2);
  assert.equal(created, 2);
  await resources.close();
});

test("record subscription failure closes the app created before record publication", async () => {
  const f = fixture();
  f.failSubscription();
  await assert.rejects(
    activateSessionForResume(f.context, { sessionId: "recover" }),
    /fixture subscription failure/,
  );
  assert.equal(f.context.sessions.has("recover"), false);
  assert.equal(f.counts().closed, 1);
});
