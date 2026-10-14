import type { Event } from "@lcode/rpc";
import type {
  WindowWorkspaceCatalogEntry,
  WindowWorkspaceRpcCall,
  WindowWorkspaceRpcListen,
} from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 已授权窗口 attachment 内的目录和 scoped facade，不创建连接或 runtime。 */
export interface IWindowWorkspaceService {
  getCatalog(): Promise<WindowWorkspaceCatalogEntry[]>;
  onDidChangeCatalog: Event<WindowWorkspaceCatalogEntry[]>;
  call(params: WindowWorkspaceRpcCall): Promise<unknown>;
  onDynamicScopedEvent(params: WindowWorkspaceRpcListen): Event<unknown>;
}
export const IWindowWorkspaceService =
  createServiceDescriptor<IWindowWorkspaceService>("window-workspace");
