import type { ModelRequestAuth } from "@lcode/contracts";
import type { CommandPayloadMap } from "@lcode/shared/lcode-protocol-v4";
import type { SendInputOptions } from "../app/types.js";

/** 两种输入协议共用执行材料投影；不把 Secret/Ticket 放入可持久化的 intent。 */
export function createModelExecutionContext(
  input: NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>,
): NonNullable<SendInputOptions["modelExecution"]> {
  const requestAuth = input.requestAuth ? freezeRequestAuth(input.requestAuth) : undefined;
  return {
    ...(input.memoryExtraction ? { memoryExtraction: input.memoryExtraction } : {}),
    selectionScope: "execution",
    ...(requestAuth
      ? {
          requestDependencies: { requestAuth: { source: { resolve: async () => requestAuth } } },
        }
      : {}),
    ...(input.subagents ? { subagents: input.subagents } : {}),
  };
}

function freezeRequestAuth(input: ModelRequestAuth): ModelRequestAuth {
  return Object.freeze({
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.headers ? { headers: Object.freeze({ ...input.headers }) } : {}),
  });
}
