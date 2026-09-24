import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_REFERENCE_DRAG_MIME,
  buildSessionReferenceMention,
  canAcceptSessionReference,
  clearActivePointerSessionReference,
  createSessionReferenceDragPayload,
  finishSessionReferencePointerDrag,
  parseSessionReferenceDragPayload,
  registerSessionReferencePointerTarget,
  resolveSessionReferenceDragOverPayload,
  serializeSessionReferenceDragPayload,
  setActivePointerSessionReference,
  updateSessionReferencePointerDrag,
} from "./sessionReferenceDragDrop.js";

function transfer(raw: string | null, types = [SESSION_REFERENCE_DRAG_MIME]) {
  return {
    types,
    getData: () => raw ?? "",
  };
}

test("session reference payload round-trips and keeps display data non-authoritative", () => {
  const payload = createSessionReferenceDragPayload({
    sessionId: "sess_abc-123",
    workspacePath: "C:/repo",
    workspaceIdentity: "workspace:repo",
    title: "审查登录流程",
    nonce: "session-reference-test-1",
  });
  assert.ok(payload);
  const parsed = parseSessionReferenceDragPayload(
    transfer(serializeSessionReferenceDragPayload(payload)),
  );
  assert.deepEqual(parsed, payload);
  assert.equal(
    buildSessionReferenceMention(payload).markdown,
    "[\u0023审查登录流程](#sess_abc-123)",
  );
  const foreignRendererPayload = JSON.parse(
    serializeSessionReferenceDragPayload(payload),
  ) as Record<string, unknown>;
  foreignRendererPayload.rendererAuthority = "renderer-from-another-window";
  assert.equal(
    parseSessionReferenceDragPayload(transfer(JSON.stringify(foreignRendererPayload))),
    null,
  );
});

test("parser fails closed for invalid ids, remote routes and stale data", () => {
  assert.equal(
    parseSessionReferenceDragPayload(
      transfer(
        JSON.stringify({
          version: 1,
          kind: "zcode/session-reference",
          sessionId: "not-a-session",
          source: { workspacePath: "C:/repo" },
          nonce: "session-reference-test-2",
        }),
      ),
    ),
    null,
  );
  assert.equal(
    createSessionReferenceDragPayload({
      sessionId: "sess_remote",
      workspacePath: "C:/repo",
      remoteSessionId: "remote-1",
    }),
    null,
  );
  assert.equal(parseSessionReferenceDragPayload(transfer("{}", ["text/plain"])), null);
});

test("authority gate rejects self and mismatched remote sessions", () => {
  const payload = createSessionReferenceDragPayload({
    sessionId: "sess_source",
    workspacePath: "C:/source",
    workspaceIdentity: "source",
    nonce: "session-reference-test-3",
  })!;
  assert.equal(
    canAcceptSessionReference(payload, {
      sessionId: "sess_source",
      workspacePath: "C:/target",
    }),
    false,
  );
  const remote = createSessionReferenceDragPayload({
    sessionId: "sess_remote",
    workspacePath: "/remote/source",
    workspaceIdentity: "remote-workspace",
    remoteSessionId: "remote-1",
    nonce: "session-reference-test-4",
  })!;
  assert.equal(
    canAcceptSessionReference(remote, {
      workspacePath: "/remote/target",
      workspaceIdentity: "remote-target",
      remoteSessionId: "remote-2",
    }),
    false,
  );
  assert.equal(
    canAcceptSessionReference(remote, {
      workspacePath: "/remote/target",
      workspaceIdentity: "remote-target",
      remoteSessionId: "remote-1",
    }),
    true,
  );
  assert.equal(
    canAcceptSessionReference(remote, {
      workspacePath: "/remote/target",
      workspaceIdentity: "remote-workspace",
      remoteSessionId: "remote-1",
    }),
    true,
  );
  assert.equal(
    canAcceptSessionReference(remote, {
      workspacePath: "/remote/target",
      remoteSessionId: "remote-1",
    }),
    false,
  );
});

test("dragover may prewarm from the active payload while drop parsing stays strict", () => {
  const payload = createSessionReferenceDragPayload({
    sessionId: "sess_pointer",
    workspacePath: "C:/repo",
    nonce: "session-reference-test-5",
  })!;
  setActivePointerSessionReference(payload);
  assert.deepEqual(resolveSessionReferenceDragOverPayload(transfer(null)), payload);
  assert.equal(parseSessionReferenceDragPayload(transfer(null)), null);
  clearActivePointerSessionReference("other");
  assert.deepEqual(resolveSessionReferenceDragOverPayload(transfer(null)), payload);
  clearActivePointerSessionReference(payload.nonce);
  assert.equal(resolveSessionReferenceDragOverPayload(transfer(null)), null);
});

test("pointer target can be armed and dropped without a second move", () => {
  const payload = createSessionReferenceDragPayload({
    sessionId: "sess_pointer_drop",
    workspacePath: "C:/repo",
    nonce: "session-reference-test-6",
  })!;
  const previousDocument = globalThis.document;
  let droppedAt: [number, number] | null = null;
  const element = { contains: () => true } as unknown as HTMLElement;
  const unregister = registerSessionReferencePointerTarget({
    id: "test-target",
    element,
    onMove: () => {},
    onLeave: () => {},
    onDrop: (_payload, clientX, clientY) => {
      droppedAt = [clientX, clientY];
      return true;
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { elementFromPoint: () => ({}) },
  });
  try {
    setActivePointerSessionReference(payload);
    updateSessionReferencePointerDrag(24, 48);
    assert.equal(finishSessionReferencePointerDrag(payload.nonce), true);
    assert.deepEqual(droppedAt, [24, 48]);
  } finally {
    unregister();
    clearActivePointerSessionReference(payload.nonce);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

test("pointer finish resolves the final pointerup position instead of a stale pane", () => {
  const payload = createSessionReferenceDragPayload({
    sessionId: "sess_pointer_final_position",
    workspacePath: "C:/repo",
    nonce: "session-reference-test-7",
  })!;
  const previousDocument = globalThis.document;
  const insideNode = {};
  const outsideNode = {};
  let leaveCount = 0;
  let dropCount = 0;
  const element = {
    contains: (candidate: unknown) => candidate === insideNode,
  } as unknown as HTMLElement;
  const unregister = registerSessionReferencePointerTarget({
    id: "final-position-target",
    element,
    onMove: () => {},
    onLeave: () => {
      leaveCount += 1;
    },
    onDrop: () => {
      dropCount += 1;
      return true;
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { elementFromPoint: (clientX: number) => (clientX < 50 ? insideNode : outsideNode) },
  });
  try {
    setActivePointerSessionReference(payload);
    updateSessionReferencePointerDrag(24, 48);
    assert.equal(
      finishSessionReferencePointerDrag(payload.nonce, { clientX: 96, clientY: 48 }),
      false,
    );
    assert.equal(leaveCount, 1);
    assert.equal(dropCount, 0);
  } finally {
    unregister();
    clearActivePointerSessionReference(payload.nonce);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});
