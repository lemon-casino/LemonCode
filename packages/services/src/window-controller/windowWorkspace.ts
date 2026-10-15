import type { Event } from "@lcode/rpc";
import type {
  WindowWorkspaceCatalogEntry,
  WindowWorkspaceRpcCall,
  WindowWorkspaceRpcListen,
  WindowWorkspaceReconnectTarget,
  WindowWorkspaceReconnectRequest,
  WindowWorkspaceReconnectResult,
} from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 已授权窗口 attachment 内的目录和 scoped facade，不创建连接或 runtime。 */
export interface IWindowWorkspaceService {
  getCatalog(): Promise<WindowWorkspaceCatalogEntry[]>;
  onDidChangeCatalog: Event<WindowWorkspaceCatalogEntry[]>;
  call(params: WindowWorkspaceRpcCall): Promise<unknown>;
  onDynamicScopedEvent(params: WindowWorkspaceRpcListen): Event<unknown>;
  requestReconnect(target: WindowWorkspaceReconnectTarget): Promise<void>;
  /** 只在可信 local/desktop-continuous attachment 上可用。 */
  onDynamicReconnectRequested(): Event<WindowWorkspaceReconnectRequest>;
  completeReconnect(result: WindowWorkspaceReconnectResult): Promise<boolean>;
}
export const IWindowWorkspaceService =
  createServiceDescriptor<IWindowWorkspaceService>("window-workspace");
