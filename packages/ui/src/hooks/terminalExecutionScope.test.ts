import assert from "node:assert/strict";
import { test } from "node:test";
import type { ITerminalService } from "@lcode/services";
import { createScopedTerminal } from "./terminalExecutionScope.js";

const scope = {
  workspacePath: "/project",
  workspaceIdentity: "workspace-identity",
  remoteSessionId: "remote-session",
  sessionId: "actual-conversation",
  executionBindingId: "binding",
  environmentRef: { environmentId: "a".repeat(32), revision: 2, manifestDigest: "manifest" },
};

test("real terminal creation sends scope and expected ref to the service, never caller env", async () => {
  const requests: unknown[] = [];
  const service = {
    create: async (params: unknown) => {
      requests.push(params);
      return { id: "pty" };
    },
  } as ITerminalService;
  await createScopedTerminal(service, { cols: 80, rows: 24, cwd: "/checkout/subdir" }, {
    ...scope,
    envOverlay: { PATH: "untrusted" },
  } as typeof scope);
  assert.deepEqual(requests, [{ cols: 80, rows: 24, cwd: "/checkout/subdir", ...scope }]);
});

test("an unscoped legacy create preserves the old cwd and dimensions contract", async () => {
  const requests: unknown[] = [];
  const service = {
    create: async (params: unknown) => {
      requests.push(params);
      return { id: "pty" };
    },
  } as ITerminalService;
  await createScopedTerminal(service, { cols: 80, rows: 24, cwd: "/project" });
  assert.deepEqual(requests, [{ cols: 80, rows: 24, cwd: "/project" }]);
});
