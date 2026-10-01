import {
  lcodeBrowserExecuteParamsSchema,
  lcodeBrowserListParamsSchema,
  lcodeProtocolMethods,
} from "@lcode/shared";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export function browserFixture() {
  const requests: Array<Record<string, unknown>> = [];
  const sessions = new Map<string, LCodeProtocolSessionRecord>([
    [
      "root",
      {
        workspace: { workspacePath: "C:/workspace" },
        deliveryKind: "desktop-continuous",
      } as LCodeProtocolSessionRecord,
    ],
    [
      "remote",
      {
        workspace: {
          workspacePath: "C:/workspace",
          workspaceIdentity: "remote-identity",
          remoteSessionId: "attachment",
        },
        deliveryKind: "web-remote-replayable",
      } as LCodeProtocolSessionRecord,
    ],
  ]);
  const context = {
    sessions,
    deps: {},
    requestClient: async (method, params, schema) => {
      const request =
        method === lcodeProtocolMethods.interactionBrowserList
          ? lcodeBrowserListParamsSchema.parse(params)
          : lcodeBrowserExecuteParamsSchema.parse(params);
      requests.push(request);
      return schema.parse(
        method === lcodeProtocolMethods.interactionBrowserList
          ? {
              browsers: [
                { id: "iab-1", generation: 2, type: "iab", name: "Browser", capabilities: {} },
              ],
            }
          : { ok: true, elapsedMs: 0 },
      );
    },
  } as LCodeProtocolAgentServerContext;
  return { context, sessions, requests, port: createProtocolBrowserControlBroker(context) };
}
