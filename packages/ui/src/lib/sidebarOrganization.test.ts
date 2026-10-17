import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptySidebarOrganization,
  sidebarEntryKey,
  type SidebarEntryRef,
  type SidebarMutation,
} from "@lcode/shared";
import { applySidebarMutations } from "../../../services/src/sidebar-organization/domain/transition.js";
import {
  invertSidebarMutations,
  normalizeSidebarSelection,
  sidebarInsertionIndex,
} from "./sidebarOrganization.js";

const project: SidebarEntryRef = { kind: "project", workspacePath: "/repo" };
const tree: SidebarEntryRef = {
  kind: "worktree",
  origin: { workspacePath: "/repo" },
  bindingId: "binding",
};
const chat: SidebarEntryRef = {
  kind: "task",
  workspace: { workspacePath: "/repo" },
  taskId: "chat",
};

test("edit and move undo restore whole sections including source defaults and hidden entries", () => {
  const before = applySidebarMutations(emptySidebarOrganization(), [
    {
      type: "create",
      section: { id: "a", title: "A", entries: [project, chat], defaultTargetRef: project },
    },
    { type: "create", section: { id: "b", title: "B", entries: [tree] } },
  ]);
  for (const mutations of [
    [
      {
        type: "editSection",
        sectionId: "b",
        title: "Edited",
        entries: [tree, project],
        defaultTargetRef: project,
      },
    ],
    [{ type: "move", entries: [project], sectionId: "b" }],
  ] satisfies SidebarMutation[][]) {
    const restored = applySidebarMutations(
      applySidebarMutations(before, mutations),
      invertSidebarMutations(before, mutations),
    );
    assert.deepEqual(restored.sections, before.sections);
  }
});
test("selection does not mistake a real worktree chat for the project's natural child", () => {
  const parents = new Map([[sidebarEntryKey(chat), sidebarEntryKey(tree)]]);
  assert.deepEqual(normalizeSidebarSelection([project, chat], [], parents), [project, chat]);
  assert.deepEqual(normalizeSidebarSelection([tree, chat], [], parents), [tree]);
  assert.deepEqual(normalizeSidebarSelection([project, chat]), [project]);
  assert.deepEqual(normalizeSidebarSelection([project, chat], [chat]), [project, chat]);
});
test("split undo restores the original placement using inverse commands", () => {
  const before = applySidebarMutations(emptySidebarOrganization(), [
    {
      type: "create",
      section: { id: "original", title: "Original", entries: [project, tree, chat] },
    },
  ]);
  const mutations: SidebarMutation[] = [
    { type: "create", section: { id: "split", title: "Split", entries: [] } },
    { type: "move", entries: [tree, chat], sectionId: "split" },
  ];
  const after = applySidebarMutations(before, mutations);
  const restored = applySidebarMutations(after, invertSidebarMutations(before, mutations));
  assert.deepEqual(restored.sections, before.sections);
});
test("dissolve undo preserves mixed references and original section order", () => {
  const before = applySidebarMutations(emptySidebarOrganization(), [
    { type: "create", section: { id: "s", title: "Section", entries: [project, tree, chat] } },
  ]);
  const mutation: SidebarMutation[] = [{ type: "remove", sectionId: "s" }];
  assert.deepEqual(
    applySidebarMutations(
      applySidebarMutations(before, mutation),
      invertSidebarMutations(before, mutation),
    ).sections,
    before.sections,
  );
});
test("dropping an earlier item before a later item uses the order after removing dragged entries", () => {
  const entries = [project, tree, chat];
  assert.equal(sidebarInsertionIndex(entries, [project], chat), 1);
  assert.equal(sidebarInsertionIndex(entries, [chat], project), 0);
  assert.equal(sidebarInsertionIndex(entries, [project], project), null);
});
