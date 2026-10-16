export const sidebarOrganizationModule = {
  id: "sidebar-organization",
  requires: ["shared", "services", "rpc"],
  provides: ["sidebar-organization-service"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
