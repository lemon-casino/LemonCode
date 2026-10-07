import assert from "node:assert/strict";
import test from "node:test";
import { handleWorktreeRequest } from "./worktreeRequests.js";
import { createWorktreeService } from "../worktree/node.js";
import type { IWorktreeService } from "../worktree/contract.js";
import { worktreeGetBindingParamsSchema } from "@lcode/shared";

const workspace = { workspacePath: "/project", workspaceIdentity: "host-a" };
test("worktree requests reject malformed and cross-environment input before service IO", async () => {
  let called = false;
  const service = {
    prepare: async () => {
      called = true;
      throw new Error("should not run");
    },
  };
  await assert.rejects(
    handleWorktreeRequest(
      "worktree/prepareExecution",
      { ...workspace, workspaceIdentity: "host-b", taskId: "t", requestId: "r" },
      workspace,
      service as never,
    ),
    /scope/i,
  );
  await assert.rejects(
    handleWorktreeRequest(
      "worktree/prepareExecution",
      { ...workspace, taskId: "t" },
      workspace,
      service as never,
    ),
  );
  assert.equal(called, false);
});

test("an unavailable host fails explicitly instead of silently executing locally", async () => {
  await assert.rejects(
    handleWorktreeRequest("worktree/getBinding", { ...workspace, taskId: "t" }, workspace),
    /not available/i,
  );
});

test("writer permits accept only the original checkout or the registered task binding", async () => {
  let acquired = "";
  const service = {
    getBinding: async () => ({
      workspacePath: "/managed/task",
      workspaceIdentity: "task-identity",
      status: "ready",
    }),
    acquireCheckout: async (params: { workspacePath: string }) => {
      acquired = params.workspacePath;
      return { token: "permit" };
    },
  };
  assert.deepEqual(
    await handleWorktreeRequest(
      "checkout/acquireWriter",
      {
        workspacePath: "/managed/task",
        workspaceIdentity: "task-identity",
        sessionId: "t",
        requestId: "r",
      },
      workspace,
      service as never,
    ),
    { permitId: "permit" },
  );
  assert.equal(acquired, "/managed/task");
  await assert.rejects(
    handleWorktreeRequest(
      "checkout/acquireWriter",
      { workspacePath: "/elsewhere", sessionId: "t", requestId: "r" },
      workspace,
      service as never,
    ),
    /scope/i,
  );
});

for (const status of ["deleting", "restoring", "archived", "failed"]) {
  test(`attached execution scope refuses ${status} binding even when paths match`, async () => {
    let acquired = false;
    const attached = { workspacePath: "/managed/task", workspaceIdentity: "task-identity" };
    const service = {
      getBinding: async (params: unknown) => {
        worktreeGetBindingParamsSchema.parse(params);
        return { ...attached, status };
      },
      acquireCheckout: async () => {
        acquired = true;
        return { token: "permit" };
      },
    };
    await assert.rejects(
      handleWorktreeRequest(
        "checkout/acquireWriter",
        {
          ...attached,
          sessionId: "task",
          requestId: "turn",
        },
        { ...attached, commands: [], clock: true } as typeof attached,
        service as never,
      ),
      /binding/,
    );
    assert.equal(acquired, false);
  });
}

test("ordinary local scope without a binding remains writable", async () => {
  const local = { workspacePath: "/project" };
  const service = {
    getBinding: async () => null,
    acquireCheckout: async () => ({ token: "local-permit" }),
  };
  assert.deepEqual(
    await handleWorktreeRequest(
      "checkout/acquireWriter",
      {
        ...local,
        sessionId: "local",
        requestId: "turn",
      },
      local,
      service as never,
    ),
    { permitId: "local-permit" },
  );
});

test("writer RPC maps protocol fields through the real strict service contract", async (t) => {
  for (const scenario of ["local", "remote", "worktree", "repair"] as const) {
    await t.test(scenario, async () => {
      const origin = {
        workspacePath: "/project",
        ...(scenario === "remote" ? { workspaceIdentity: "host-a" } : {}),
      };
      const scope =
        scenario === "worktree" || scenario === "repair"
          ? { workspacePath: `/managed/${scenario}` }
          : origin;
      const acquired: unknown[] = [];
      const released: unknown[] = [];
      const validated = createWorktreeService({
        dataDir: "/unused-fixture",
        git: {
          run: async () => {
            throw new Error("unexpected Git IO");
          },
        },
        coordinator: {
          acquire: async (params) => {
            acquired.push(params);
            return {
              token: "permit",
              workspacePath: params.workspacePath,
              ownerId: params.ownerId,
            };
          },
          release: async (params) => {
            released.push(params);
          },
        },
      });
      const service = {
        ...validated,
        getBinding: async (params: unknown) => {
          worktreeGetBindingParamsSchema.parse(params);
          return { id: "binding", status: "ready", ...scope };
        },
        getIntegration: async () => ({
          id: "operation",
          bindingId: "binding",
          status: "conflicted",
          checkoutPath: scope.workspacePath,
        }),
      } as unknown as IWorktreeService;
      const connectionScope = {
        ...origin,
        commands: [],
        clock: true,
        __lcodeTrustedV4Connection: { connectionId: "fixture" },
      };
      for (const sessionId of ["new-session", "existing-session"]) {
        assert.deepEqual(
          await handleWorktreeRequest(
            "checkout/acquireWriter",
            {
              ...scope,
              sessionId,
              requestId: `${sessionId}:turn`,
              ...(scenario === "repair"
                ? { repair: { parentSessionId: "parent", operationId: "operation" } }
                : {}),
            },
            connectionScope,
            service,
          ),
          { permitId: "permit" },
        );
        const ownerId = `${origin.workspaceIdentity ?? origin.workspacePath}:${sessionId}`;
        assert.deepEqual(acquired.at(-1), {
          ...scope,
          ownerId,
          waitMs: 250,
          mode: scenario === "repair" ? "exclusive" : "shared",
        });
        assert.deepEqual(
          await handleWorktreeRequest(
            "checkout/releaseWriter",
            { permitId: "permit", sessionId },
            origin,
            service,
          ),
          { released: true },
        );
        assert.deepEqual(released.at(-1), { token: "permit", ownerId });
      }
    });
  }
});
