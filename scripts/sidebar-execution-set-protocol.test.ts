import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { buildRemoteWorkspaceIdentity } from "../packages/shared/src/remote-workspace-identity.js";
import { projectContextForDefinition } from "../packages/shared/src/projectContext.js";
import { executionSetFixture } from "../packages/services/src/project-execution-set/adapters/testFixture.js";
import { createProjectExecutionSetService } from "../packages/services/src/project-execution-set/node.js";
import { handleWorktreeRequest } from "../packages/services/src/lcode-agent/worktreeRequests.js";
import {
  prepareProtocolExecutionSet,
  restoreProtocolExecutionSet,
} from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/protocol-execution-set.js";
import type { LCodeProtocolAgentServerContext } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/server-types.js";
import { executionIntentSchema } from "../packages/shared/src/worktreeExecution.js";

test("CLI preparation and cold restore reuse the target Host's complete remote execution set", async (t) => {
  const f = await executionSetFixture(t);
  const workspaceIdentity = buildRemoteWorkspaceIdentity(f.repositories[0]!, {
    kind: "ssh",
    host: "fixture.invalid",
    username: "fixture",
    port: 22,
  });
  const origin = { workspacePath: f.repositories[0]!, workspaceIdentity };
  const workspace = { ...origin, workspaceKey: workspaceIdentity, remoteSessionId: "attachment" };
  const projectContext = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      primaryFolderPath: origin.workspacePath,
      sourceFolderPaths: f.repositories,
      workspaceIdentity,
    },
    origin,
  );
  const owner = createProjectExecutionSetService({
    dataDir: join(f.root, "sets"),
    worktrees: f.worktrees,
  });
  const bases = ["frontend-base", "backend-base"];
  const commits = await Promise.all(
    f.repositories.map(async (repository, index) => {
      await f.command(repository, "branch", bases[index]!);
      const baseline = await f.command(repository, "rev-parse", "HEAD");
      await writeFile(join(repository, "later.txt"), "later main commit");
      await f.command(repository, "add", ".");
      await f.command(repository, "commit", "-m", "later main");
      return baseline;
    }),
  );
  const calls: string[] = [];
  const context = {
    requestClient: async (
      method: string,
      params: unknown,
      schema: { parse(value: unknown): unknown },
    ) => {
      calls.push(method);
      if (method === "session/requestRuntimePreferences") return { projectContext };
      return schema.parse(await handleWorktreeRequest(method, params, origin, f.worktrees, owner));
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const prepared = await prepareProtocolExecutionSet(context, {
    workspace,
    taskId: "chat",
    requestId: "create",
    execution: executionIntentSchema.parse({
      mode: "worktree",
      collaboration: true,
      taskName: "Feature",
      baseRefs: Object.fromEntries(
        projectContext.members.map((member, index) => [member.memberId, bases[index]]),
      ),
    }),
  });
  assert.equal(prepared.workspace.executionSetRef?.bindings.length, 2);
  assert.equal(
    prepared.workspace.executionBindingId,
    undefined,
    "a set is not a synthetic single binding",
  );
  assert.equal(prepared.workspace.remoteSessionId, "attachment");
  for (const binding of prepared.workspace.executionSetRef!.bindings)
    assert.ok(binding.workspaceIdentity?.includes("fixture.invalid"));
  const saved = (await owner.list(origin))[0]!;
  for (const repository of saved.repositories) {
    const index = f.repositories.indexOf(repository.repositoryRoot);
    assert.equal(repository.baseRef, commits[index]);
    assert.notEqual(
      await f.command(repository.repositoryRoot, "rev-parse", "HEAD"),
      commits[index],
    );
  }
  const restored = await restoreProtocolExecutionSet(
    context,
    prepared.workspace,
    "chat",
    prepared.workspace,
  );
  assert.deepEqual(restored.workspace.executionSetRef, prepared.workspace.executionSetRef);
  const child = await prepareProtocolExecutionSet(context, {
    workspace,
    taskId: "child",
    requestId: "child",
    execution: {
      mode: "worktree",
      executionSetId: prepared.workspace.executionSetRef!.executionSetId,
    },
  });
  assert.deepEqual(child.workspace.executionSetRef, prepared.workspace.executionSetRef);
  assert.equal((await owner.list(origin)).length, 1);
  await assert.rejects(
    restoreProtocolExecutionSet(context, prepared.workspace, "chat", {
      ...prepared.workspace,
      workspacePath: f.repositories[0]!,
    }),
    /paths or bindings differ/,
  );
  await assert.rejects(
    handleWorktreeRequest(
      "executionSet/resolveExecution",
      {
        ...origin,
        workspaceIdentity: "another-target",
        sessionId: "chat",
        executionSetId: prepared.workspace.executionSetRef!.executionSetId,
      },
      origin,
      f.worktrees,
      owner,
    ),
    /scope/,
  );
  assert.ok(calls.includes("executionSet/prepareExecution"));
});
