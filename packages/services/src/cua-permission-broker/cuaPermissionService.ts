// Computer Use Helper macOS permission service — services-side descriptor registration.
//
// As part of the single-package merge the type definitions + functional helpers
// (CuaPermissionStatus, CuaPermissionStatusResult, isCuaPermissionStatusAvailable,
// shouldRunCuaScreenCaptureProbe, ICuaPermissionService interface, etc.) moved
// to @lcode/lcode-cua/src/broker/ports.ts. The descriptor registration itself stays in
// services (host control plane — depends on services' createServiceDescriptor
// + @lcode/shared ServiceChannels), so services internal callers (node.ts,
// accessor.ts, services/index.ts) and ui consumers (via @lcode/services root
// export) keep importing `ICuaPermissionService` from this exact path.
//
// producer 只拥有 type contract；VALUE descriptor 继续由 services 的
// createServiceDescriptor 创建，避免 producer 反向依赖 RPC/service registry。

import { ServiceChannels } from "@lcode/shared";

import { createServiceDescriptor } from "../descriptors.js";

// Type layer — type-only imports from the consolidated package (erased by TS
// at compile time; Vite never resolves @lcode/lcode-cua for these).
import type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
  ICuaPermissionService as BrokerICuaPermissionService,
} from "@lcode/lcode-cua/broker";

// Re-export types for consumers.
export type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
};

// 只从 producer 的纯 ports subpath 复用值谓词。这里不能从 Node-only broker barrel
// re-export，否则 renderer bundle 会引入 process/node:path/node:crypto；也不能再复制实现，
// 否则“省略 options 是否主动抓屏”这种隐私契约会再次漂移。
export {
  isCuaPermissionStatusAvailable,
  shouldRunCuaScreenCaptureProbe,
} from "@lcode/lcode-cua/broker/ports";

export interface ICuaPermissionService extends BrokerICuaPermissionService {}

export const ICuaPermissionService = createServiceDescriptor<BrokerICuaPermissionService>(
  ServiceChannels.CuaPermission,
);
