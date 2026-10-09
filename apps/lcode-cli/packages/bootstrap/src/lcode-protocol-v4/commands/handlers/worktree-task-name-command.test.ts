import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope, CommandPayloadMap } from "@lcode/shared/lcode-protocol-v4";
import type { V4CommandCoreHost } from "../types.js";
import { V4CommandExecutor } from "../executor.js";

test("worktree create forwards the complete frozen first input and first-turn model for naming", async () => {
  const text = `${"背景说明。".repeat(70)}\n清理帮助与问题上报入口`;
  const firstModel = { providerId: "first", modelId: "model" };
  const configModel = { providerId: "config", modelId: "model" };
  for (const mode of ["worktree", "local"] as const) {
    for (const modelSelection of [firstModel, undefined]) {
      let received:
        | Parameters<NonNullable<V4CommandCoreHost["createSessionRecord"]>>[0]
        | undefined;
      const stop = new Error("fixture stops before first turn");
      const host = {
        getRecord: () => undefined,
        createSessionRecord: async (params: typeof received) => {
          received = params;
          throw stop;
        },
      } as V4CommandCoreHost;
      const payload: CommandPayloadMap["createSession"] = {
        workspaceId: "/fixture",
        execution: { mode },
        firstInput: { text, modelSelection },
        config: { modelSelection: configModel },
      };
      const envelope = {
        commandId: "create-command",
        clientId: "client",
        sessionId: null,
        type: "createSession",
        payload,
      } as CommandEnvelope;
      await assert.rejects(
        new V4CommandExecutor(host).execute(envelope),
        (error) => error === stop,
      );
      assert.equal(received?.executionRequestId, envelope.commandId);
      assert.deepEqual(received?.execution, { mode });
      assert.deepEqual(
        received?.worktreeTaskNameInput,
        mode === "worktree" ? { text, modelSelection: modelSelection ?? configModel } : undefined,
      );
    }
  }
});

test("empty creates keep their existing naming hints and never request summarization", async () => {
  let received: Parameters<NonNullable<V4CommandCoreHost["createSessionRecord"]>>[0] | undefined;
  const host = {
    getRecord: () => undefined,
    createSessionRecord: async (params: typeof received) => {
      received = params;
      return { sessionId: "session" };
    },
  } as V4CommandCoreHost;
  await new V4CommandExecutor(host).execute({
    commandId: "empty-command",
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: "/fixture", execution: { mode: "worktree", taskName: "已有短名称" } },
  } as CommandEnvelope);
  assert.equal(received?.worktreeTaskNameInput, undefined);
  assert.equal(received?.execution?.taskName, "已有短名称");
});
