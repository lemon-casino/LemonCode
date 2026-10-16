import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidebarEntryKey, type SidebarEntryRef } from "@lcode/shared";
import { createSidebarOrganizationService } from "./node.js";

const local: SidebarEntryRef = { kind: "project", workspacePath: "/project" };
const remote: SidebarEntryRef = {
  kind: "project",
  workspacePath: "/project",
  workspaceIdentity: "remote-scope",
};
const tree: SidebarEntryRef = {
  kind: "worktree",
  origin: { workspacePath: "/project", workspaceIdentity: "remote-scope" },
  bindingId: "binding",
};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-sidebar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "organization.json");
  return { path, service: createSidebarOrganizationService(path) };
}
test("mixed placement preserves source identity and moves only explicit references", async (t) => {
  const { service } = await fixture(t);
  await service.apply({
    operationId: "create",
    expectedRevision: 0,
    mutations: [
      { type: "create", section: { id: "s", title: "Section", entries: [local, remote, tree] } },
    ],
  });
  const result = await service.apply({
    operationId: "move",
    expectedRevision: 1,
    mutations: [{ type: "move", entries: [remote], sectionId: null }],
  });
  assert.deepEqual(result.snapshot.sections[0]?.entries, [local, tree]);
  assert.notEqual(sidebarEntryKey(local), sidebarEntryKey(remote));
});
test("two owners serialize CAS and a conflict never overwrites accepted changes", async (t) => {
  const { service, path } = await fixture(t);
  const second = createSidebarOrganizationService(path);
  const results = await Promise.all(
    [service, second].map((owner, index) =>
      owner.apply({
        operationId: `op-${index}`,
        expectedRevision: 0,
        mutations: [
          { type: "create", section: { id: `s-${index}`, title: "Section", entries: [] } },
        ],
      }),
    ),
  );
  assert.equal(results.filter((result) => result.status === "applied").length, 1);
  assert.equal(results.filter((result) => result.status === "conflict").length, 1);
  assert.equal((await second.getSnapshot()).revision, 1);
});
test("dedup survives service restart, operationId cannot be repurposed", async (t) => {
  const { service, path } = await fixture(t);
  const request = {
    operationId: "once",
    expectedRevision: 0,
    mutations: [{ type: "create" as const, section: { id: "s", title: "Section", entries: [] } }],
  };
  await service.apply(request);
  const restarted = createSidebarOrganizationService(path);
  assert.equal((await restarted.apply(request)).snapshot.revision, 1);
  await assert.rejects(
    restarted.apply({ ...request, mutations: [{ type: "remove", sectionId: "s" }] }),
    /reused/,
  );
});
test("invalid second mutation rolls back the whole transaction", async (t) => {
  const { service, path } = await fixture(t);
  await service.apply({
    operationId: "init",
    expectedRevision: 0,
    mutations: [{ type: "create", section: { id: "s", title: "Original", entries: [remote] } }],
  });
  const before = await readFile(path, "utf8");
  await assert.rejects(
    service.apply({
      operationId: "bad",
      expectedRevision: 1,
      mutations: [
        { type: "rename", sectionId: "s", title: "Changed" },
        { type: "move", entries: [remote], sectionId: "missing" },
      ],
    }),
  );
  assert.equal(await readFile(path, "utf8"), before);
});
test("source migration is idempotent and never steals manual placement", async (t) => {
  const { service } = await fixture(t);
  await service.apply({
    operationId: "manual",
    expectedRevision: 0,
    mutations: [{ type: "create", section: { id: "manual", title: "Manual", entries: [remote] } }],
  });
  const migration = {
    type: "import" as const,
    source: "old-remote",
    sections: [{ id: "old", title: "Old", entries: [remote, tree] }],
  };
  const first = await service.apply({
    operationId: "import",
    expectedRevision: 1,
    mutations: [migration],
  });
  assert.deepEqual(
    first.snapshot.sections.map((section) => section.entries),
    [[remote], [tree]],
  );
  const again = await service.apply({
    operationId: "again",
    expectedRevision: 2,
    mutations: [migration],
  });
  assert.equal(again.snapshot.sections.length, 2);
});
test("corrupt state is retained and cannot be replaced by empty defaults", async (t) => {
  const { service, path } = await fixture(t);
  await writeFile(path, "broken", "utf8");
  await assert.rejects(service.getSnapshot());
  await assert.rejects(
    service.apply({
      operationId: "new",
      expectedRevision: 0,
      mutations: [{ type: "create", section: { id: "s", title: "Section", entries: [] } }],
    }),
  );
  assert.equal(await readFile(path, "utf8"), "broken");
});
test(
  "subscribed second owner receives a committed revision and releases its watcher",
  { timeout: 10000 },
  async (t) => {
    const { service, path } = await fixture(t);
    const second = createSidebarOrganizationService(path);
    const event = new Promise<number>((resolve) => {
      const subscription = second.onDidChange((snapshot) => {
        if (snapshot.revision === 1) resolve(snapshot.revision);
      });
      t.after(() => subscription.dispose());
    });
    await second.getSnapshot();
    await service.apply({
      operationId: "external",
      expectedRevision: 0,
      mutations: [{ type: "create", section: { id: "s", title: "Section", entries: [] } }],
    });
    assert.equal(await event, 1);
  },
);
test("root order cannot cross object kinds or contain duplicate references", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    service.apply({
      operationId: "bad-order",
      expectedRevision: 0,
      mutations: [{ type: "reorderRoot", kind: "project", entries: [tree] }],
    }),
  );
  const result = await service.apply({
    operationId: "order",
    expectedRevision: 0,
    mutations: [{ type: "reorderRoot", kind: "project", entries: [remote, local] }],
  });
  assert.deepEqual(result.snapshot.rootOrders, [remote, local]);
});
test("confirmed deletion forgets only the exact reference and its root order", async (t) => {
  const { service } = await fixture(t);
  await service.apply({
    operationId: "init",
    expectedRevision: 0,
    mutations: [
      { type: "create", section: { id: "s", title: "Section", entries: [local, remote, tree] } },
      { type: "reorderRoot", kind: "project", entries: [local, remote] },
    ],
  });
  const result = await service.apply({
    operationId: "forget",
    expectedRevision: 1,
    mutations: [{ type: "forget", entries: [remote] }],
  });
  assert.deepEqual(result.snapshot.sections[0]?.entries, [local, tree]);
  assert.deepEqual(result.snapshot.rootOrders, [local]);
});
test(
  "a replacement subscription receives the latest snapshot even after another subscriber saw its revision",
  { timeout: 10000 },
  async (t) => {
    const { service } = await fixture(t);
    await service.apply({
      operationId: "before-reconnect",
      expectedRevision: 0,
      mutations: [{ type: "create", section: { id: "s", title: "Section", entries: [] } }],
    });
    const snapshot = await new Promise<import("@lcode/shared").SidebarOrganization>((resolve) => {
      const subscription = service.onDidChange(resolve);
      t.after(() => subscription.dispose());
    });
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.sections[0]?.title, "Section");
  },
);
