// 产品入口只连接 Helper broker。原生 UIA/AX 与输入副作用都留在 Helper 进程，
// node_repl 不再因为拿到一个非空 socket 路径就直接驱动本机输入。
import { createBrokerComputerUseRuntime } from "./runtime.js";

export function createComputerUseRuntime(options) {
  return createBrokerComputerUseRuntime(options);
}
