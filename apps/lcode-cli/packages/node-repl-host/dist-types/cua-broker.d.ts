import type { ComputerUseRuntime } from "@lcode/lcode-cua";
import type { Logger } from "@lcode/contracts";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
export interface NodeReplCuaBroker {
    connection: NodeReplCuaBrokerConnection;
    ready: Promise<void>;
    close(): Promise<void>;
}
export declare function createNodeReplCuaBroker(input: {
    runtime: ComputerUseRuntime;
    logger?: Logger;
    platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker;
//# sourceMappingURL=cua-broker.d.ts.map