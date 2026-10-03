import assert from "node:assert/strict";
import test from "node:test";
import type { IGitService } from "./git.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";

test("only mutations acquire writer permits; reads and refresh remain available", async () => {
  let acquired = 0,
    released = 0;
  const service = coordinateGitCheckoutWrites(
    {
      stagePaths: async () => {
        throw new Error("fixture-stage");
      },
      refresh: async () => "read",
      getRepositorySummary: async () => "summary",
    } as unknown as IGitService,
    {
      acquire: async (params) => {
        acquired++;
        return { token: "token", ownerId: params.ownerId, workspacePath: params.workspacePath };
      },
      release: async () => {
        released++;
      },
    },
  );
  const params = { workspacePath: "/fixture" };
  assert.equal(await service.refresh(params), "read");
  assert.equal(await service.getRepositorySummary(params), "summary");
  assert.equal(acquired, 0);
  await assert.rejects(service.stagePaths({ ...params, paths: ["x.ts"] }), /fixture-stage/);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});
