import type { ISidebarOrganizationService } from "./contract.js";
export async function createSectionExample(service: ISidebarOrganizationService) {
  const snapshot = await service.getSnapshot();
  return service.apply({
    operationId: "example-create",
    expectedRevision: snapshot.revision,
    mutations: [{ type: "create", section: { id: "example", title: "Development", entries: [] } }],
  });
}
