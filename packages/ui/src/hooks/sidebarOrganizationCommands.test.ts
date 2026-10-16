import assert from "node:assert/strict";
import { test } from "node:test";
import { emptySidebarOrganization, type SidebarOrganizationRequest } from "@lcode/shared";
import type { ISidebarOrganizationService } from "@lcode/services";
import { submitSidebarOrganization } from "./sidebarOrganizationCommands.js";
import { createSidebarOrganizationStore } from "@/store/sidebarOrganizationStore.js";

test("a lost commit acknowledgement resends the original idempotency key and input", async () => {
  const requests: SidebarOrganizationRequest[] = [];
  const request: SidebarOrganizationRequest = {
    operationId: "stable",
    expectedRevision: 0,
    mutations: [{ type: "create", section: { id: "section", title: "Section", entries: [] } }],
  };
  const service = {
    apply: async (input: SidebarOrganizationRequest) => {
      requests.push(structuredClone(input));
      if (requests.length === 1) throw new Error("ack lost after commit");
      return { status: "applied", snapshot: { ...emptySidebarOrganization(), revision: 1 } };
    },
  } as ISidebarOrganizationService;
  assert.equal((await submitSidebarOrganization(service, request)).status, "applied");
  assert.deepEqual(requests, [request, request]);
});
test("a snapshot response arriving behind an event cannot rewind or redundantly notify the mirror", () => {
  const store = createSidebarOrganizationStore();
  let updates = 0;
  store.subscribe(() => updates++);
  const latest = {
    ...emptySidebarOrganization(),
    revision: 4,
    sections: [{ id: "s", title: "Latest", entries: [] }],
  };
  store.getState().accept(latest);
  store.getState().accept({ ...emptySidebarOrganization(), revision: 3 });
  store.getState().accept(structuredClone(latest));
  assert.equal(store.getState().snapshot, latest);
  assert.equal(updates, 1);
});
