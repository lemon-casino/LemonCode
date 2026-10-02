import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ILCodeAgentService, LCodeAgentSavedWorkflowTarget } from "@lcode/services";
import {
  buildRemoteWorkspaceIdentity,
  type LCodeSavedWorkflowEntry,
  type LCodeWorkflowsListResult,
} from "@lcode/shared";
import {
  isSavedWorkflowListEmpty,
  selectSavedWorkflowState,
  useSavedWorkflowStore,
} from "./savedWorkflowStore.js";

const target = { workspacePath: "/fixture/project" };
const entry: LCodeSavedWorkflowEntry = {
  name: "review-template",
  description: "Review the selected files",
  scope: "project",
  path: "/fixture/project/.lcode/workflows/review-template.dwf.ts",
};

function list(workflows: LCodeSavedWorkflowEntry[] = []): LCodeWorkflowsListResult {
  return { workflows, invalid: [], dir: "/fixture/project/.lcode/workflows" };
}

function service(
  listSavedWorkflows: ILCodeAgentService["listSavedWorkflows"],
  listSavedWorkflowRuns: ILCodeAgentService["listSavedWorkflowRuns"] = async () => ({ runs: [] }),
): ILCodeAgentService {
  return { listSavedWorkflows, listSavedWorkflowRuns } as ILCodeAgentService;
}

function current(workspace: LCodeAgentSavedWorkflowTarget = target) {
  return selectSavedWorkflowState(useSavedWorkflowStore.getState(), workspace);
}

function load(
  agentService: ILCodeAgentService,
  bypassCache = false,
  workspace: LCodeAgentSavedWorkflowTarget = target,
) {
  return useSavedWorkflowStore.getState().load(workspace, agentService, { bypassCache });
}

afterEach(() => {
  useSavedWorkflowStore.setState({ byWorkspaceKey: {} });
});

test("empty presentation requires successful completion without pending or invalid results", () => {
  const initial = current();
  const empty = { ...initial, loaded: true };
  assert.equal(isSavedWorkflowListEmpty(initial), false);
  assert.equal(isSavedWorkflowListEmpty(empty), true);
  assert.equal(isSavedWorkflowListEmpty({ ...empty, loading: true }), false);
  assert.equal(isSavedWorkflowListEmpty({ ...empty, error: "listing unavailable" }), false);
  assert.equal(isSavedWorkflowListEmpty({ ...empty, error: "" }), false);
  assert.equal(isSavedWorkflowListEmpty({ ...empty, entries: [entry] }), false);
  assert.equal(
    isSavedWorkflowListEmpty({ ...empty, invalid: [{ path: entry.path, reason: "bad metadata" }] }),
    false,
  );
});

test("initial failure remains a completed error, and retry preserves it until recovery", async () => {
  assert.equal(current().loaded, false);
  const failure = Object.assign(new Error("listing unavailable"), { code: -32602 });
  await load(
    service(async () => {
      throw failure;
    }),
  );
  assert.equal(current().loaded, true);
  assert.equal(current().loading, false);
  assert.equal(current().error, "listing unavailable");
  assert.equal(current().errorCode, -32602);

  const retry = Promise.withResolvers<LCodeWorkflowsListResult>();
  const pending = load(
    service(() => retry.promise),
    true,
  );
  assert.equal(current().loading, true);
  assert.equal(current().error, "listing unavailable");
  retry.resolve(list([entry]));
  await pending;
  assert.equal(current().loading, false);
  assert.equal(current().error, null);
  assert.equal(current().errorCode, null);
  assert.deepEqual(current().entries, [entry]);
});

test("successful empty and invalid-only results remain distinguishable", async () => {
  await load(service(async () => list()));
  assert.equal(current().loaded, true);
  assert.equal(current().loading, false);
  assert.equal(current().error, null);
  assert.deepEqual(current().entries, []);
  assert.deepEqual(current().invalid, []);

  const invalid = [
    { path: "/fixture/project/.lcode/workflows/broken.dwf.ts", reason: "bad metadata" },
  ];
  await load(
    service(async () => ({ ...list(), invalid })),
    true,
  );
  assert.deepEqual(current().invalid, invalid);
  assert.equal(current().error, null);
});

test("refresh and refresh failure preserve cached entries, invalid files and directory", async () => {
  const invalid = [
    { path: "/fixture/project/.lcode/workflows/broken.dwf.ts", reason: "bad metadata" },
  ];
  await load(service(async () => ({ ...list([entry]), invalid })));
  const accepted = current();
  const refresh = Promise.withResolvers<LCodeWorkflowsListResult>();
  const pending = load(
    service(() => refresh.promise),
    true,
  );
  assert.equal(current().loading, true);
  assert.equal(current().entries, accepted.entries);
  assert.equal(current().invalid, accepted.invalid);
  assert.equal(current().dir, accepted.dir);
  refresh.reject(new Error("refresh failed"));
  await pending;
  assert.equal(current().loading, false);
  assert.equal(current().error, "refresh failed");
  assert.equal(current().entries, accepted.entries);
  assert.equal(current().invalid, accepted.invalid);
  assert.equal(current().runs, accepted.runs);
  assert.equal(current().dir, accepted.dir);
});

for (const staleResult of ["empty", "error"] as const) {
  test(`late older ${staleResult} cannot overwrite the newest successful result`, async () => {
    const older = Promise.withResolvers<LCodeWorkflowsListResult>();
    const newer = Promise.withResolvers<LCodeWorkflowsListResult>();
    const oldPending = load(service(() => older.promise));
    const newPending = load(
      service(() => newer.promise),
      true,
    );
    newer.resolve(list([entry]));
    await newPending;
    const accepted = current();
    if (staleResult === "empty") older.resolve(list());
    else older.reject(Object.assign(new Error("stale failure"), { code: -32602 }));
    await oldPending;
    assert.equal(current(), accepted);
    assert.deepEqual(current().entries, [entry]);
    assert.equal(current().error, null);
    assert.equal(current().loading, false);
  });

  test(`older ${staleResult} completing first cannot stop loading or replace the latest in-flight request`, async () => {
    const older = Promise.withResolvers<LCodeWorkflowsListResult>();
    const newer = Promise.withResolvers<LCodeWorkflowsListResult>();
    let scans = 0;
    const agentService = service(() => (++scans === 1 ? older.promise : newer.promise));
    const oldPending = load(agentService);
    const newPending = load(agentService, true);
    const awaitingNewest = current();
    if (staleResult === "empty") older.resolve(list());
    else older.reject(new Error("stale failure"));
    await oldPending;
    const afterOlder = current();
    const deduplicated = load(agentService);
    const scanCount = scans;
    newer.resolve(list([entry]));
    await Promise.all([newPending, deduplicated]);
    assert.equal(afterOlder, awaitingNewest);
    assert.equal(afterOlder.loading, true);
    assert.equal(afterOlder.loaded, false);
    assert.equal(afterOlder.error, null);
    assert.equal(scanCount, 2);
    assert.deepEqual(current().entries, [entry]);
  });
}

test("late older success cannot erase the latest failure or replace its cache", async () => {
  await load(service(async () => list([entry])));
  const older = Promise.withResolvers<LCodeWorkflowsListResult>();
  const oldPending = load(
    service(() => older.promise),
    true,
  );
  await load(
    service(async () => {
      throw new Error("newest failed");
    }),
    true,
  );
  const accepted = current();
  older.resolve(list());
  await oldPending;
  assert.equal(current(), accepted);
  assert.equal(current().error, "newest failed");
  assert.deepEqual(current().entries, [entry]);
});

test("same-path workspaces isolate request fences by trimmed workspaceIdentity", async () => {
  const identityA = buildRemoteWorkspaceIdentity(target.workspacePath, {
    kind: "wsl",
    distro: "fixture-a",
  });
  const identityB = buildRemoteWorkspaceIdentity(target.workspacePath, {
    kind: "wsl",
    distro: "fixture-b",
  });
  const a = { ...target, workspaceIdentity: ` ${identityA} `, remoteSessionId: "session-a" };
  const b = { ...target, workspaceIdentity: identityB, remoteSessionId: "session-b" };
  const oldA = Promise.withResolvers<LCodeWorkflowsListResult>();
  const newestA = Promise.withResolvers<LCodeWorkflowsListResult>();
  const firstB = Promise.withResolvers<LCodeWorkflowsListResult>();
  const oldPending = load(
    service(() => oldA.promise),
    false,
    a,
  );
  const bPending = load(
    service(() => firstB.promise),
    false,
    b,
  );
  const newPending = load(
    service(() => newestA.promise),
    true,
    { ...a, workspaceIdentity: identityA },
  );
  newestA.resolve(list([entry]));
  await newPending;
  const acceptedA = current(a);
  const pendingB = current(b);
  oldA.reject(new Error("old host reply"));
  await oldPending;
  firstB.resolve(list([{ ...entry, name: "isolated-template" }]));
  await bPending;
  assert.equal(current(a), acceptedA);
  assert.equal(current({ ...a, workspaceIdentity: identityA }), acceptedA);
  assert.equal(pendingB.loading, true);
  assert.equal(current(b).entries[0]?.name, "isolated-template");
  assert.equal(current(target).loaded, false);
  assert.equal(current({ scope: "global" }).loaded, false);
});

test("path fallback and global scope retain independent cache and in-flight requests", async () => {
  const projectReply = Promise.withResolvers<LCodeWorkflowsListResult>();
  const globalReply = Promise.withResolvers<LCodeWorkflowsListResult>();
  let projectScans = 0;
  const projectService = service(() => {
    projectScans += 1;
    return projectReply.promise;
  });
  const projectPending = load(projectService, false, { ...target, workspaceIdentity: "  " });
  const sharedPending = load(projectService);
  const globalPending = load(
    service(() => globalReply.promise),
    false,
    { scope: "global" },
  );
  globalReply.resolve(list([{ ...entry, scope: "global" }]));
  await globalPending;
  const projectStillLoading = current().loading;
  projectReply.resolve(list());
  await Promise.all([projectPending, sharedPending]);
  assert.equal(projectScans, 1);
  assert.equal(projectStillLoading, true);
  assert.deepEqual(current().entries, []);
  assert.equal(current({ scope: "global" }).entries[0]?.scope, "global");
});

test("history failure does not turn a successful list into a list error", async () => {
  await load(
    service(
      async () => list([entry]),
      async () => {
        throw new Error("history unavailable");
      },
    ),
  );
  assert.equal(current().loaded, true);
  assert.equal(current().error, null);
  assert.deepEqual(current().entries, [entry]);
  assert.deepEqual(current().runs, []);
});
