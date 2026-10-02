import assert from "node:assert/strict";
import test from "node:test";
import { browserCommandResultSchema, browserCommandSchema } from "@lcode/shared";
import { BROWSER_VIEWPORT_LIMITS } from "./browser-control.port.js";
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserControlPort,
} from "./browser-control.port.js";

const commands: BrowserCommand[] = [
  { method: "navigate", url: "https://example.com", tabId: "tab" },
  { method: "click", x: 1, y: 2, button: "right", modifiers: ["ControlOrMeta"] },
  {
    method: "cuaDrag",
    path: [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ],
  },
  { method: "playwright", action: { name: "locator", selector: "button", operation: "click" } },
  {
    method: "recordingStart",
    options: { viewport: { width: 800, height: 600 }, actions: [{ type: "wait", durationMs: 1 }] },
  },
  { method: "browserViewportSet", width: 800, height: 600 },
  { method: "finalizeTabs", keep: [{ tabId: "tab", status: "handoff" }] },
  { method: "cancelRequest", requestId: "request" },
];

test("browser structural contracts round-trip through only the public shared schema boundary", () => {
  for (const command of commands) assert.deepEqual(browserCommandSchema.parse(command), command);
  const result: BrowserCommandResult = {
    ok: true,
    elapsedMs: 2,
    dialog: null,
    tabs: [
      {
        tabId: "tab",
        url: "https://example.com",
        title: "Example",
        viewport: { width: 800, height: 600 },
      },
    ],
    recording: {
      id: "recording",
      status: "completed",
      phase: "completed",
      progress: 1,
      startedAt: 1,
      updatedAt: 2,
      artifact: {
        path: "recording.webm",
        mimeType: "video/webm",
        width: 800,
        height: 600,
        fps: 30,
        durationMs: 1,
        frameCount: 1,
      },
    },
  };
  assert.deepEqual(browserCommandResultSchema.parse(result), result);
  assert.deepEqual(BROWSER_VIEWPORT_LIMITS, {
    minWidth: 320,
    maxWidth: 3840,
    minHeight: 320,
    maxHeight: 2160,
  });
});

test("minimal browser hosts keep optional child, turn and close capabilities", async () => {
  const port: BrowserControlPort = {
    list: async () => [],
    execute: async () => ({ ok: true, elapsedMs: 0 }),
  };
  assert.deepEqual(await port.list({ sessionId: "session" }), []);
  assert.equal(
    (
      await port.execute({
        browserId: "browser",
        browserGeneration: 1,
        sessionId: "session",
        command: { method: "list" },
      })
    ).ok,
    true,
  );
  assert.equal(port.closeSession, undefined);
  assert.equal(port.turnEnded, undefined);
  assert.equal(port.createChildScope, undefined);
});
