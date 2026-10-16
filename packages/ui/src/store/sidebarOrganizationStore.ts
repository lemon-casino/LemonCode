import { createStore } from "zustand/vanilla";
import { emptySidebarOrganization, type SidebarOrganization } from "@lcode/shared";
export function createSidebarOrganizationStore() {
  return createStore<{
    snapshot: SidebarOrganization;
    ready: boolean;
    pending: boolean;
    error: string | null;
    accept(snapshot: SidebarOrganization): void;
  }>((set) => ({
    snapshot: emptySidebarOrganization(),
    ready: false,
    pending: false,
    error: null,
    accept: (snapshot) =>
      set((current) =>
        current.ready && snapshot.revision <= current.snapshot.revision
          ? current
          : { snapshot, ready: true, error: null },
      ),
  }));
}
