import type { ISidebarOrganizationService } from "@lcode/services";
import type { SidebarOrganizationRequest } from "@lcode/shared";

export async function submitSidebarOrganization(
  service: ISidebarOrganizationService,
  request: SidebarOrganizationRequest,
) {
  try {
    return await service.apply(request);
  } catch {
    // 提交可能已落盘但 ACK 丢失。只重发完全相同的 operationId 和参数，由 owner 去重；不能重新创建分区。
    return service.apply(request);
  }
}
