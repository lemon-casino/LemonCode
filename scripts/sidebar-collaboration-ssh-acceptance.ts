import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { projectContextForDefinition } from "../packages/shared/src/projectContext.js";
import { buildRemoteWorkspaceIdentity } from "../packages/shared/src/remote-workspace-identity.js";
import { createWorktreeService } from "../packages/services/src/worktree/node.js";
import { createProjectExecutionSetService } from "../packages/services/src/project-execution-set/node.js";

/** SSH 源码验收入口。调用者提供已创建的临时根；不读取凭据、不启动模型、不替换远端运行时。 */
export async function runSSHSidebarAcceptance(input: {
  root: string;
  target: { kind: "ssh"; host: string; port: number; username: string };
}) {
  const root = await realpath(input.root);
  assert.equal(dirname(root), "/tmp");
  assert.match(basename(root), /^lcode-sidebar-qa\.[A-Za-z0-9]+$/);
  const activeChildren = new Set<number>();
  const git = {
    run: async (request: {
      cwd: string;
      args: string[];
      env?: Record<string, string>;
      stdin?: string;
    }) =>
      await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
        (resolve, reject) => {
          const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
          );
          const child = spawn("git", request.args, {
            cwd: request.cwd,
            env: {
              ...env,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: join(root, "empty-git-config"),
              ...request.env,
            },
            stdio: "pipe",
          });
          if (child.pid) activeChildren.add(child.pid);
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (data) => {
            stdout += data.toString();
          });
          child.stderr.on("data", (data) => {
            stderr += data.toString();
          });
          child.on("error", reject);
          child.on("close", (exitCode) => {
            if (child.pid) activeChildren.delete(child.pid);
            resolve({ stdout, stderr, exitCode });
          });
          child.stdin.end(request.stdin);
        },
      ),
  };
  const command = async (cwd: string, ...args: string[]) => {
    const result = await git.run({ cwd, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  const front = join(root, "frontend"),
    back = join(root, "backend"),
    contracts = join(front, "contracts");
  await mkdir(contracts, { recursive: true });
  const identity = buildRemoteWorkspaceIdentity(front, input.target);
  const origin = { workspacePath: front, workspaceIdentity: identity };
  const context = projectContextForDefinition(
    {
      id: "ssh-qa-project",
      name: "SSH collaboration QA",
      revision: 1,
      primaryFolderPath: front,
      sourceFolderPaths: [front, contracts, back],
      workspaceIdentity: identity,
    },
    origin,
  );
  const worktrees = createWorktreeService({ dataDir: join(root, "worktree-state"), git });
  const options = {
    dataDir: join(root, "set-state"),
    worktrees,
    stopSessions: async (snapshot: { sessions: { sessionId: string }[] }) => {
      assert.equal(activeChildren.size, 0);
      return {
        stopped: true as const,
        sessionIds: snapshot.sessions.map((item) => item.sessionId),
      };
    },
  };
  let owner = createProjectExecutionSetService(options);
  const unavailable = await owner.prepare({
    operationId: "empty-preflight",
    name: "Missing base directory",
    projectContext: context,
  });
  assert.equal(unavailable.status, "failed");
  assert.equal(unavailable.preflightFailure?.sourcePath, contracts);
  assert.equal(unavailable.repositories.length, 0);
  assert.equal((await worktrees.list(origin)).length, 0);
  await writeFile(join(contracts, "schema.txt"), "tracked contract\n");
  await command(front, "add", ".");
  await command(front, "commit", "-m", "track contract directory");
  const initialHeads = await Promise.all(
    [front, back].map((path) => command(path, "rev-parse", "HEAD")),
  );
  const prepared = await owner.prepare({
    operationId: "ssh-qa-create",
    name: "SSH multi-repository",
    projectContext: context,
  });
  assert.equal(prepared.status, "ready", prepared.error);
  assert.equal(prepared.repositories.length, 2, "same-repository folders must deduplicate");
  const request = { ...origin, executionSetId: prepared.id };
  await owner.attachSession({
    ...request,
    sessionId: "qa-readonly-session",
    operationId: "qa-attach",
  });
  const resolved = await owner.resolveContext({ ...request, sessionId: "qa-readonly-session" });
  assert.equal(resolved.context.members.length, 3);
  assert.equal(resolved.reference.bindings.length, 2);
  for (const member of resolved.context.members) {
    assert.notEqual(member.workspacePath, member.sourcePath);
    assert.ok(member.workspaceIdentity);
    await realpath(member.workspacePath);
  }
  for (const view of await owner.bindings(request)) {
    assert.ok(view.binding);
    await writeFile(join(view.binding.checkoutPath, "qa-feature.txt"), "isolated change\n");
    assert.equal(await command(view.binding.originalWorkspacePath, "status", "--porcelain"), "");
  }
  const permits = await owner.acquireExecution({
    ...request,
    sessionId: "qa-readonly-session",
    ownerId: "ssh-qa-writer",
  });
  assert.equal(permits.length, 2);
  await Promise.all(
    permits.map((permit) =>
      worktrees.releaseCheckout({ token: permit.token, ownerId: "ssh-qa-writer" }),
    ),
  );
  owner = createProjectExecutionSetService(options);
  assert.equal(
    (
      await owner.prepare({
        operationId: "ssh-qa-create",
        name: "SSH multi-repository",
        projectContext: context,
      })
    ).id,
    prepared.id,
  );
  await assert.rejects(
    owner.get({
      ...request,
      workspaceIdentity: buildRemoteWorkspaceIdentity(front, {
        ...input.target,
        port: input.target.port + 1,
      }),
    }),
    /another project source/i,
  );
  const archived = await owner.archive({ ...request, operationId: "qa-archive" });
  assert.equal(archived.status, "archived", archived.error);
  const restored = await owner.restore({ ...request, operationId: "qa-restore" });
  assert.equal(restored.status, "ready", restored.error);
  assert.deepEqual(
    restored.repositories.map((repository) => repository.bindingId),
    prepared.repositories.map((repository) => repository.bindingId),
  );
  for (const view of await owner.bindings(request))
    assert.equal(
      await readFile(join(view.binding!.checkoutPath, "qa-feature.txt"), "utf8"),
      "isolated change\n",
    );
  assert.deepEqual(
    await Promise.all([front, back].map((path) => command(path, "rev-parse", "HEAD"))),
    initialHeads,
  );
  assert.equal(activeChildren.size, 0);
  return {
    transport: "SSH",
    node: process.versions.node,
    platform: process.platform,
    repositories: 2,
    members: 3,
    checks: [
      "untracked member rejected before allocation",
      "same-repository deduplication",
      "remote identity isolation",
      "actual checkout mapping",
      "original files and HEAD unchanged",
      "all checkout permits",
      "restart idempotency",
      "archive/restore preserves modifications",
    ],
    runtime: "source owners; no model runtime started",
    installedApplication: false,
  };
}
