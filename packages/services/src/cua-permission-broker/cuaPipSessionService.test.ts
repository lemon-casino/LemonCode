import assert from "node:assert/strict";
import { test } from "node:test";

import type { PipSessionEvent, PipSessionSnapshot } from "@zcode/zcode-cua/pip-session";
import type { PipSessionClient, PipSessionClientOptions } from "@zcode/zcode-cua/pip-session/node";

import type { ServiceLogger } from "../logger/serviceLogger.js";
import {
  createCuaPipSessionService,
  type CuaPipPresentationCredentials,
} from "./cuaPipSessionService.js";

const credentials: CuaPipPresentationCredentials = {
  pipSocketPath: "/tmp/zcode-cua-pip-test.sock",
  capability: "never-log-this-capability",
  generation: 7,
};

function loggerRecording(records: unknown[][]): ServiceLogger {
  const record = (...args: unknown[]) => records.push(args);
  return { debug: record, info: record, warn: record, error: record };
}

function fakeClientFactory(optionsSeen: PipSessionClientOptions[]): {
  createClient: (options: PipSessionClientOptions) => PipSessionClient;
  snapshots: PipSessionSnapshot[];
  events: PipSessionEvent[];
  closed: number[];
} {
  const snapshots: PipSessionSnapshot[] = [];
  const events: PipSessionEvent[] = [];
  const closed: number[] = [];
  return {
    snapshots,
    events,
    closed,
    createClient(options) {
      const index = optionsSeen.push(options) - 1;
      let connected = false;
      return {
        enabled: true,
        async connect() {
          if (connected) return;
          connected = true;
          assert.ok(options.getSnapshot);
          snapshots.push(await options.getSnapshot());
          options.onDiagnostic?.({ code: "test-diagnostic", message: options.capability });
        },
        async send(event) {
          events.push(event);
          return { applied: true };
        },
        close() {
          closed.push(index);
        },
      };
    },
  };
}

test("passes the authenticated PiP tuple and reconnect snapshot without logging capability", async () => {
  let resolved: CuaPipPresentationCredentials | undefined;
  const optionsSeen: PipSessionClientOptions[] = [];
  const fake = fakeClientFactory(optionsSeen);
  const logs: unknown[][] = [];
  const service = createCuaPipSessionService({
    enabled: true,
    resolveCredentials: async () => resolved,
    createClient: fake.createClient,
    logger: loggerRecording(logs),
  });

  await service.publishLifecycle({
    kind: "turn-started",
    sessionId: "session-a",
    turnId: "turn-a",
    sequenceNumber: 1,
    eventId: "event-start-a",
  });
  resolved = credentials;
  await service.publishFocus({
    kind: "focus-changed",
    sessionId: "session-a",
    revision: 3,
    sourceWindowId: "window-a",
    eventId: "event-focus-a",
  });

  assert.equal(optionsSeen.length, 1);
  assert.equal(optionsSeen[0]?.socketPath, credentials.pipSocketPath);
  assert.equal(optionsSeen[0]?.capability, credentials.capability);
  assert.equal(optionsSeen[0]?.generation, credentials.generation);
  assert.deepEqual(fake.snapshots, [
    {
      turns: [
        {
          kind: "turn-started",
          sessionId: "session-a",
          turnId: "turn-a",
          sequenceNumber: 1,
          eventId: "event-start-a",
        },
      ],
      focus: {
        kind: "focus-changed",
        sessionId: "session-a",
        revision: 3,
        sourceWindowId: "window-a",
        eventId: "event-focus-a",
      },
    },
  ]);
  assert.equal(JSON.stringify(logs).includes(credentials.capability), false);
  service.dispose();
});

test("terminal facts remove only the matching active turn from reconnect snapshots", async () => {
  let resolved: CuaPipPresentationCredentials | undefined;
  const optionsSeen: PipSessionClientOptions[] = [];
  const fake = fakeClientFactory(optionsSeen);
  const service = createCuaPipSessionService({
    enabled: true,
    resolveCredentials: async () => resolved,
    createClient: fake.createClient,
    logger: loggerRecording([]),
  });

  await service.publishLifecycle({
    kind: "turn-started",
    sessionId: "session-a",
    turnId: "turn-new",
    sequenceNumber: 4,
    eventId: "event-start-new",
  });
  await service.publishLifecycle({
    kind: "turn-ended",
    sessionId: "session-a",
    turnId: "turn-old",
    sequenceNumber: 5,
    eventId: "event-end-old",
    outcome: "completed",
  });
  resolved = credentials;
  await service.publishFocus({
    kind: "focus-changed",
    sessionId: "session-a",
    revision: 1,
    sourceWindowId: "window-a",
  });
  await service.publishLifecycle({
    kind: "turn-ended",
    sessionId: "session-a",
    turnId: "turn-new",
    sequenceNumber: 6,
    eventId: "event-end-new",
    outcome: "completed",
  });
  await service.publishLifecycle({
    kind: "turn-started",
    sessionId: "session-b",
    turnId: "turn-b",
    sequenceNumber: 1,
    eventId: "event-start-b",
  });
  await service.publishLifecycle({
    kind: "session-closed",
    sessionId: "session-b",
    sequenceNumber: 2,
    eventId: "event-close-b",
  });
  resolved = { ...credentials, generation: 8 };
  await service.publishFocus({
    kind: "focus-changed",
    sessionId: null,
    revision: 2,
    sourceWindowId: "window-a",
  });

  assert.deepEqual(fake.snapshots, [
    {
      turns: [
        {
          kind: "turn-started",
          sessionId: "session-a",
          turnId: "turn-new",
          sequenceNumber: 4,
          eventId: "event-start-new",
        },
      ],
      focus: {
        kind: "focus-changed",
        sessionId: "session-a",
        revision: 1,
        sourceWindowId: "window-a",
      },
    },
    {
      turns: [],
      focus: {
        kind: "focus-changed",
        sessionId: null,
        revision: 2,
        sourceWindowId: "window-a",
      },
    },
  ]);
  service.dispose();
});

test("terminal facts update the snapshot before an earlier network send settles", async () => {
  const optionsSeen: PipSessionClientOptions[] = [];
  let releaseSend: (() => void) | undefined;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const service = createCuaPipSessionService({
    enabled: true,
    resolveCredentials: async () => credentials,
    createClient(options) {
      optionsSeen.push(options);
      return {
        enabled: true,
        async connect() {},
        async send() {
          await sendGate;
          return { applied: true };
        },
        close() {},
      };
    },
    logger: loggerRecording([]),
  });

  const startDelivery = service.publishLifecycle({
    kind: "turn-started",
    sessionId: "session-a",
    turnId: "turn-a",
    sequenceNumber: 1,
  });
  while (optionsSeen.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const endDelivery = service.publishLifecycle({
    kind: "turn-ended",
    sessionId: "session-a",
    turnId: "turn-a",
    sequenceNumber: 2,
    outcome: "completed",
  });

  assert.deepEqual(await optionsSeen[0]?.getSnapshot?.(), { turns: [] });
  releaseSend?.();
  await Promise.all([startDelivery, endDelivery]);
  service.dispose();
});

test("connects with the retained snapshot when credentials appear without another event", async () => {
  let resolved: CuaPipPresentationCredentials | undefined;
  const optionsSeen: PipSessionClientOptions[] = [];
  const fake = fakeClientFactory(optionsSeen);
  const service = createCuaPipSessionService({
    enabled: true,
    resolveCredentials: async () => resolved,
    createClient: fake.createClient,
    logger: loggerRecording([]),
  });

  await service.publishLifecycle({
    kind: "turn-started",
    sessionId: "session-a",
    turnId: "turn-a",
    sequenceNumber: 1,
  });
  resolved = credentials;
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const poll = () => {
      if (fake.snapshots.length > 0) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("PiP reconnect snapshot was not delivered"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });

  assert.equal(optionsSeen.length, 1);
  assert.equal(fake.snapshots[0]?.turns[0]?.turnId, "turn-a");
  service.dispose();
});

test("reconnect snapshot is bounded and keeps the newest 256 active sessions", async () => {
  let resolved: CuaPipPresentationCredentials | undefined;
  const optionsSeen: PipSessionClientOptions[] = [];
  const fake = fakeClientFactory(optionsSeen);
  const service = createCuaPipSessionService({
    enabled: true,
    resolveCredentials: async () => resolved,
    createClient: fake.createClient,
    logger: loggerRecording([]),
  });

  for (let index = 0; index < 257; index += 1) {
    await service.publishLifecycle({
      kind: "turn-started",
      sessionId: `session-${index}`,
      turnId: `turn-${index}`,
      sequenceNumber: index,
      eventId: `event-${index}`,
    });
  }
  resolved = credentials;
  await service.publishFocus({
    kind: "focus-changed",
    sessionId: "session-256",
    revision: 1,
    sourceWindowId: "window-a",
  });

  assert.equal(fake.snapshots[0]?.turns.length, 256);
  assert.equal(
    fake.snapshots[0]?.turns.some((event) => event.sessionId === "session-0"),
    false,
  );
  assert.equal(fake.snapshots[0]?.turns.at(-1)?.sessionId, "session-256");
  service.dispose();
});

test("credential rotation closes the old client and creates a newly authenticated client", async () => {
  let resolved = credentials;
  const optionsSeen: PipSessionClientOptions[] = [];
  const fake = fakeClientFactory(optionsSeen);
  const service = createCuaPipSessionService({
    enabled: true,
    resolveCredentials: async () => resolved,
    createClient: fake.createClient,
    logger: loggerRecording([]),
  });

  await service.publishFocus({
    kind: "focus-changed",
    sessionId: null,
    revision: 1,
    sourceWindowId: "window-a",
  });
  resolved = { ...credentials, capability: "rotated-capability", generation: 8 };
  await service.publishFocus({
    kind: "focus-changed",
    sessionId: null,
    revision: 2,
    sourceWindowId: "window-a",
  });

  assert.equal(optionsSeen.length, 2);
  assert.deepEqual(fake.closed, [0]);
  assert.equal(optionsSeen[1]?.capability, "rotated-capability");
  assert.equal(optionsSeen[1]?.generation, 8);
  service.dispose();
});
