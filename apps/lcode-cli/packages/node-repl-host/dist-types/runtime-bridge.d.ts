import type { BrowserClientTransport } from "@lcode/core/browser-client";
export declare const NODE_REPL_BROWSER_BRIDGE_SYMBOL: unique symbol;
export declare const BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Browser is not available in subagent";
export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
    documentationRoot: string;
    assertAvailable(): void;
}
export declare function readNodeReplBrowserRuntimeBridge(globals: Record<PropertyKey, unknown>): NodeReplBrowserRuntimeBridge;
//# sourceMappingURL=runtime-bridge.d.ts.map