import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@lcode/shared/lcode-protocol-v4";
import { commandAdmissionOf } from "../executor.js";
import { inputIntentMetadata } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

async function createSelectionSideSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const payload = envelope.payload as CommandPayloadMap["createSelectionSideSession"];
  const record = requireRecord(host, envelope.sessionId);
  if (!host.createSelectionSideSession) {
    throw new Error("v4 createSelectionSideSession requires host capability");
  }
  const result = await host.createSelectionSideSession(record.app.sessionId, {
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    ...(payload.firstInput?.modelSelection
      ? { modelSelection: payload.firstInput.modelSelection }
      : {}),
  });
  const childSessionId = result.sessionId;
  const firstInput = payload.firstInput;
  if (!firstInput) {
    return { type: "createSelectionSideSession", sessionId: childSessionId };
  }

  // child 已在 host 中注册后再启动首条输入；输入只落到 child，父会话的
  // CommandInbox/queue 不参与这次 admission，因此不会改变父 turn 的运行态。
  const childRecord = requireRecord(host, childSessionId);
  const admission = commandAdmissionOf(envelope);
  // gateway 不会把 createSelectionSideSession 当成父会话的输入命令；handler 直接把
  // 同一条 envelope 指向 child，复用 session_input 账本而不污染父 queue。
  const durableAdmission =
    (await host.admitInputCommand?.(envelope, childSessionId, admission)) ?? null;
  try {
    const started = await startPromptTurn(host, childRecord, {
      content: firstInput.text,
      inputId: envelope.commandId,
      intent: inputIntentMetadata(envelope, {
        text: firstInput.text,
        requestedDelivery: "startNow",
      }),
    });
    const input = {
      delivery: started.admission.kind === "queued" ? ("queue" as const) : ("startNow" as const),
      inputId: envelope.commandId,
      ...(started.messageId ? { messageId: started.messageId } : {}),
    };
    return {
      type: "createSelectionSideSession",
      sessionId: childSessionId,
      ...(input ? { input } : {}),
    };
  } catch (error) {
    if (durableAdmission) {
      try {
        await host.cancelInputCommand?.(
          childSessionId,
          admission.queueItemId,
          "fault.command.inputRejected",
        );
      } catch (cancelError) {
        host.logger?.warn?.("v4 selection side first input cancellation failed", {
          cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
          inputError: error instanceof Error ? error.message : String(error),
          queueItemId: admission.queueItemId,
          sessionId: childSessionId,
        });
      }
    }
    throw error;
  }
}

export const selectionSideSessionHandlers = {
  createSelectionSideSession,
};
