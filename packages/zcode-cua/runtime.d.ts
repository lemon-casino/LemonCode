// runtime 内部实现与注入点的类型面。内部模块：不进 package.json exports。
import type { ComputerUseRuntime, ComputerUseRuntimeOptions } from "./index.js";
import type { CuaInputDriver } from "./cua-driver.js";

/** 权限门 seam：每次有驱动副作用的 execute 在实际执行时调用一次 authorize（不缓存）。 */
export interface CuaPermissionGate {
  authorize(): Promise<boolean>;
}

/**
 * 缺省权限门：凭据存在（brokerSocketPath trim 非空）且 ensureBrokerAvailable（如提供）
 * resolve 才放行；无凭据或 ensure 失败一律拒绝。
 */
export declare function createBrokerPermissionGate(
  options?: ComputerUseRuntimeOptions,
): CuaPermissionGate;

/** 产品 runtime：把 14 方法转发到 Helper broker，本进程不加载原生驱动。 */
export declare function createBrokerComputerUseRuntime(
  options?: ComputerUseRuntimeOptions,
): ComputerUseRuntime;

/**
 * 注入点：包内单测和显式 e2e:local 用 mock/本地驱动 + 门组装兼容 runtime；
 * 产品公开入口 createComputerUseRuntime 固定连接 Helper broker，不使用此本地 seam。
 */
export declare function createComputerUseRuntimeWithDriver(
  driver: CuaInputDriver,
  gate: CuaPermissionGate,
  options?: ComputerUseRuntimeOptions,
): ComputerUseRuntime;

/** 占位失败形状的唯一定义点（UNAVAILABLE_TEXT 的所有者）。 */
export declare const UNAVAILABLE_TEXT: string;
