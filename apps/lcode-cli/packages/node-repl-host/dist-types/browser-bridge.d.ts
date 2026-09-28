import type { NodeReplRequestMeta, NodeReplSession } from "@lcode/core/repl";
export interface ActiveNodeReplCall {
    generation: number;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
}
export declare function createBrowserBridgeGlobals(input: {
    documentationRoot: string;
    generation: number;
    getActiveCall: () => ActiveNodeReplCall | undefined;
    session: () => NodeReplSession;
}): Record<PropertyKey, unknown>;
//# sourceMappingURL=browser-bridge.d.ts.map