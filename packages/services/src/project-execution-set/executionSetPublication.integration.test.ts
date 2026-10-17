import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { projectContextForDefinition, executionSetRepositoryViewsSchema } from "@lcode/shared";
import { createWorktreeService } from "../worktree/node.js";
import { createProjectExecutionSetService } from "./node.js";
import { executionSetFixture } from "./adapters/testFixture.js";

test("set progress reads authoritative partial publication without replaying the successful repository", async (t) => {
  const f = await executionSetFixture(t);
  const worktrees = createWorktreeService({
    ...f.options,
    validate: async () => ({ exitCode: 1, output: "fixture validation failure" }),
  });
  const owner = createProjectExecutionSetService({ dataDir: join(f.root, "sets"), worktrees });
  const origin = { workspacePath: f.repositories[0]! };
  const projectContext = projectContextForDefinition(
    {
      id: "project",
      name: "Project",
      primaryFolderPath: origin.workspacePath,
      sourceFolderPaths: f.repositories,
    },
    origin,
  );
  const set = await owner.prepare({ operationId: "create", name: "Feature", projectContext });
  const request = { ...origin, executionSetId: set.id };
  const before = await owner.bindings(request);
  for (const [index, view] of before.entries()) {
    const binding = view.binding!;
    await writeFile(join(binding.checkoutPath, "feature.txt"), "feature");
    await f.command(binding.checkoutPath, "add", ".");
    await f.command(binding.checkoutPath, "commit", "-m", "feature");
    const operation = await worktrees.integrate({
      bindingId: binding.id,
      requestId: `review-${index}`,
      expectedSourceHead: await f.command(binding.checkoutPath, "rev-parse", "HEAD"),
      targetBranch: "main",
      validationCommands: ["fixture validation"],
    });
    const result = await worktrees.publishIntegration({
      operationId: operation.id,
      approvedCandidateHead: operation.candidateHead!,
      skipValidation: !index,
    });
    assert.equal(result.status, index ? "validation-failed" : "published", result.error);
  }
  const first = executionSetRepositoryViewsSchema.parse(await owner.bindings(request));
  assert.deepEqual(
    first.map((view) => view.integration?.status),
    ["published", "validation-failed"],
  );
  const heads = await Promise.all(
    set.repositories.map((repository) => f.command(repository.repositoryRoot, "rev-parse", "HEAD")),
  );
  const restarted = createProjectExecutionSetService({ dataDir: join(f.root, "sets"), worktrees });
  const next = executionSetRepositoryViewsSchema.parse(await restarted.bindings(request));
  assert.deepEqual(
    next.map((view) => view.integration),
    first.map((view) => view.integration),
  );
  assert.deepEqual(
    await Promise.all(
      set.repositories.map((repository) =>
        f.command(repository.repositoryRoot, "rev-parse", "HEAD"),
      ),
    ),
    heads,
  );
});
