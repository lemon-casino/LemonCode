import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  type PermissionBrokerRequest,
  type SessionEvent,
  SessionEventType,
} from "@lcode/contracts";
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID, lcodeSessionEventSchema } from "@lcode/shared";
import { v4AnswerToPermissionResponse } from "./interaction-permission-response.js";
import {
  v4AnswerToUserInputResponse,
  userInputResponseToBrokerResult,
} from "./interaction-user-input-response.js";
import {
  buildProtocolPermissionOptions,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
} from "./permission-options.js";
import { mapSessionEventForProtocol } from "./session-mapper.js";

const request = {
  input: {
    questions: [
      { question: "Choose a color", header: "Color", options: [] },
      { question: "Choose a shape", header: "Shape", options: [] },
    ],
  },
} as PermissionBrokerRequest;

test("permission answer mapping stays fail closed and keeps session grants out of persistent rules", () => {
  const options = buildProtocolPermissionOptions({
    toolName: CREATE_WORKFLOW_TOOL_NAME,
    optionsPolicy: "session-always-allow",
  });
  const sessionOption = options.find(
    (option) => option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND,
  )!;
  const response = v4AnswerToPermissionResponse(
    { optionId: sessionOption.optionId },
    options,
    CREATE_WORKFLOW_TOOL_NAME,
  );
  assert.equal(response.decision, "allow");
  assert.equal(response.permissionUpdates, undefined);
  assert.deepEqual(response.sessionPermissionUpdates, [
    { behavior: "allow", rules: [{ toolName: CREATE_WORKFLOW_TOOL_NAME }], type: "addRules" },
  ]);
  assert.equal(
    v4AnswerToPermissionResponse({ optionId: "unknown" }, options, CREATE_WORKFLOW_TOOL_NAME)
      .decision,
    "deny",
  );
  assert.equal(
    v4AnswerToPermissionResponse({ optionId: "allowAlways" }, options, CREATE_WORKFLOW_TOOL_NAME)
      .decision,
    "deny",
  );
  const modifiedInput = { script: "return 1;" };
  assert.deepEqual(
    v4AnswerToPermissionResponse(
      { optionId: "allowOnce", content: { modifiedInput } },
      options,
      CREATE_WORKFLOW_TOOL_NAME,
    ),
    { decision: "modify", reason: "Approved once", modifiedInput },
  );
  const refine = {
    optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
    freeText: " adjust the script ",
  };
  assert.equal(
    v4AnswerToPermissionResponse(refine, options, CREATE_WORKFLOW_TOOL_NAME).reasonSource,
    "workflow_refine_feedback",
  );
  assert.equal(v4AnswerToPermissionResponse(refine, options, "Read").reasonSource, undefined);
});

test("user input mapping preserves multi-question answers and annotations while removing legacy fields", () => {
  const response = v4AnswerToUserInputResponse({
    action: "accept",
    content: {
      answer_0: " blue ",
      answer_1: [" circle ", "square"],
      ignoredLegacyField: true,
      annotations: {
        "Choose a color": { notes: "keep this note", preview: "preview text", extra: true },
      },
    },
  });
  const result = userInputResponseToBrokerResult(request, response);
  assert.equal(result.decision, "modify");
  assert.deepEqual(result.modifiedInput, {
    ...(request.input as object),
    answers: { "Choose a color": "blue", "Choose a shape": "circle, square" },
    annotations: { "Choose a color": { notes: "keep this note", preview: "preview text" } },
  });
  assert.deepEqual(
    userInputResponseToBrokerResult(request, { action: "accept", content: { answers: {} } })
      .modifiedInput,
    { ...(request.input as object), answers: {} },
  );
});

test("legacy permission event strips V4 display policy and keeps strict delivery schemas", () => {
  const event = {
    id: "event-1",
    sessionId: "session-1",
    turnId: "turn-1",
    traceId: "trace-1",
    timestamp: new Date(100),
    sequenceNumber: 7,
    type: SessionEventType.PermissionRequested,
    payload: {
      requestId: "permission-1",
      toolCallId: "call-1",
      toolName: CREATE_WORKFLOW_TOOL_NAME,
      input: { script: "return 1;" },
      reason: "Confirm workflow",
      riskLevel: "medium",
      display: { kind: "workflow" },
      optionsPolicy: "session-always-allow",
    },
  } as unknown as SessionEvent;
  for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
    const mapped = mapSessionEventForProtocol(event, deliveryKind, { seq: 12 });
    assert.ok(mapped);
    lcodeSessionEventSchema.parse(mapped);
    assert.equal(mapped.deliveryKind, deliveryKind);
    assert.equal(mapped.seq, 12);
    const payload = mapped.payload as Record<string, unknown>;
    assert.equal(Object.hasOwn(payload, "display"), false);
    assert.equal(Object.hasOwn(payload, "optionsPolicy"), false);
    assert.deepEqual(
      (payload.options as Array<{ kind: string }>).map((option) => option.kind),
      ["allow_once", "deny"],
    );
  }
});
