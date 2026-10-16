import type { Event } from "@lcode/rpc";
import type {
  SidebarOrganization,
  SidebarOrganizationRequest,
  SidebarOrganizationResult,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Profile 级导航引用 owner；不创建或删除任何项目、工作树和会话。 */
export interface ISidebarOrganizationService {
  getSnapshot(): Promise<SidebarOrganization>;
  apply(request: SidebarOrganizationRequest): Promise<SidebarOrganizationResult>;
  onDidChange: Event<SidebarOrganization>;
}
export const ISidebarOrganizationService = createServiceDescriptor<ISidebarOrganizationService>(
  ServiceChannels.SidebarOrganization,
);
