import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeUiTarsTextAction,
  type UiTarsActionCodecFailureCode,
  type UiTarsActionCodecResult,
} from "./ui-tars-action-codec.js";

const frame = { width: 2_000, height: 1_000 } as const;

test("normalizes the supported UI-TARS action dialect", () => {
  const cases = [
    {
      action: "click(start_box='(100,200,300,400)')",
      expected: {
        name: "left_click",
        parameters: { x: 400, y: 300, mouse_button: "left", click_count: 1 },
      },
    },
    {
      action: "left_double(start_box='(100,200,300,400)')",
      expected: {
        name: "left_click",
        parameters: { x: 400, y: 300, mouse_button: "left", click_count: 2 },
      },
    },
    {
      action: "right_single(start_box='(100,200,300,400)')",
      expected: {
        name: "left_click",
        parameters: { x: 400, y: 300, mouse_button: "right", click_count: 1 },
      },
    },
    {
      action: "drag(start_box='(100,200,300,400)', end_box='(500,600,700,800)')",
      expected: {
        name: "left_click_drag",
        parameters: { start_x: 400, start_y: 300, end_x: 1_200, end_y: 700 },
      },
    },
    {
      action: String.raw`type(content='a,b=c\nnext')`,
      expected: { name: "type", parameters: { content: String.raw`a,b=c\nnext` } },
    },
    {
      action: "hotkey(key='CTRL+L')",
      expected: { name: "key", parameters: { key: "CTRL+L" } },
    },
    {
      action: "scroll(start_box='(100,200,300,400)', direction='down')",
      expected: {
        name: "scroll",
        parameters: { x: 400, y: 300, direction: "down", scroll_amount: 1 },
      },
    },
    {
      action: "wait()",
      expected: { name: "wait", parameters: { duration_ms: 500 } },
    },
  ] as const;

  for (const { action, expected } of cases) {
    const result = decodeUiTarsTextAction({
      text: `Thought: inspect the current UI\nAction: ${action}`,
      frame,
    });
    assert.equal(result.status, "ok", action);
    if (result.status !== "ok") continue;
    assert.equal(result.decision.kind, "action", action);
    if (result.decision.kind !== "action") continue;
    assert.equal(result.decision.thought, "inspect the current UI", action);
    assert.deepEqual(result.decision.action, expected, action);
  }
});

test("preserves finished content without creating an executable action", () => {
  const result = decodeUiTarsTextAction({
    text: "Thought: task is complete\nAction: finished(content='Done, result=42')",
    frame,
  });

  assert.deepEqual(result, {
    status: "ok",
    decision: { kind: "finished", thought: "task is complete", content: "Done, result=42" },
  });
  assert.deepEqual(decodeUiTarsTextAction({ text: "Action: finished()", frame }), {
    status: "ok",
    decision: { kind: "finished", thought: "", content: "" },
  });
  assert.deepEqual(decodeUiTarsTextAction({ text: "Action: finished(content='')", frame }), {
    status: "ok",
    decision: { kind: "finished", thought: "", content: "" },
  });
});

test("rejects ambiguous envelopes and native tool-call conflicts", () => {
  assertInvalid("Thought: choose one\nAction: wait()\nAction: finished()", "multiple-actions");
  assertInvalid("Action: wait() trailing text", "invalid-envelope");
  assertInvalid("Thought: no action", "invalid-envelope");
  assertInvalid("prefix\nAction: wait()", "invalid-envelope");
  assertInvalid("Thought: conflict\nAction: wait()", "native-tool-call-conflict", {
    hasNativeToolCalls: true,
  });
});

test("rejects unknown actions, malformed parameters, and unsafe coordinates", () => {
  assertInvalid("Action: launch(start_box='(100,200,300,400)')", "unsupported-action");
  assertInvalid("Action: click()", "invalid-arguments");
  assertInvalid(
    "Action: click(start_box='(100,200,300,400)', unexpected='x')",
    "invalid-arguments",
  );
  assertInvalid("Action: click(start_box='(100,200,300)')", "invalid-coordinate");
  assertInvalid("Action: click(start_box='(300,400,100,200)')", "invalid-coordinate");
  assertInvalid("Action: click(start_box='(0,0,1001,1000)')", "invalid-coordinate");
  assertInvalid("Action: hotkey(key='CTRL++L')", "invalid-arguments");
  assertInvalid(
    "Action: scroll(start_box='(100,200,300,400)', direction='diagonal')",
    "invalid-arguments",
  );
});

test("rejects an invalid or edge-overflowing frame coordinate", () => {
  const invalidFrame = decodeUiTarsTextAction({
    text: "Action: wait()",
    frame: { width: 0, height: 1_000 },
  });
  assert.equal(invalidFrame.status, "invalid");
  if (invalidFrame.status === "invalid") assert.equal(invalidFrame.code, "invalid-frame");

  assertInvalid("Action: click(start_box='(1000,1000,1000,1000)')", "invalid-coordinate");
});

function assertInvalid(
  text: string,
  code: UiTarsActionCodecFailureCode,
  extra: Partial<{ hasNativeToolCalls: boolean }> = {},
): Extract<UiTarsActionCodecResult, { status: "invalid" }> {
  const result = decodeUiTarsTextAction({ text, frame, ...extra });
  assert.equal(result.status, "invalid", text);
  if (result.status !== "invalid") assert.fail(`Expected invalid UI-TARS output: ${text}`);
  assert.equal(result.code, code, text);
  return result;
}
