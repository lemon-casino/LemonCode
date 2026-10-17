import { resolve } from "node:path";
import { NodeReplSession } from "@lcode/core/repl";
import { createBrowserBridgeGlobals, type ActiveNodeReplCall } from "./browser-bridge.js";
import { createComputerUseBridgeGlobals, type ActiveCuaNodeReplCall } from "./cua-bridge.js";
import type { NodeReplExecutor } from "./server.js";
const pluginRoot = process.env.LCODE_PLUGIN_ROOT ?? process.cwd();
const browserDocumentationRoot = resolve(pluginRoot, "docs");
const cuaDocumentationRoot = resolve(process.env.LCODE_CUA_PLUGIN_ROOT ?? pluginRoot, "docs");
export function createInProcessNodeReplExecutor(): NodeReplExecutor {
  return async (input) => {
    let activeCall: ActiveNodeReplCall | undefined;
    let activeCuaCall: ActiveCuaNodeReplCall | undefined;
    let session: NodeReplSession;
    const generation = 1;
    session = new NodeReplSession({
      injectedGlobals: () => ({
        ...createBrowserBridgeGlobals({
          documentationRoot: browserDocumentationRoot,
          generation,
          getActiveCall: () => activeCall,
          session: () => session,
        }),
        ...createComputerUseBridgeGlobals({
          broker: input.cuaBroker,
          generation,
          getActiveCall: () => activeCuaCall,
          session: () => session,
          documentationRoot: cuaDocumentationRoot,
        }),
      }),
      restrictProcess: true,
    });
    activeCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    activeCuaCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    try {
      return await session.run(input.code, {
        requestMeta: input.requestMeta,
        signal: input.signal,
        syncTimeoutMs: input.syncTimeoutMs,
      });
    } finally {
      activeCall = undefined;
      activeCuaCall = undefined;
      session.dispose();
    }
  };
}
