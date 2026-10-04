import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { gitPublicationRequestSchema, gitCommitRequestSchema } from "@lcode/shared";

test("publication pins selected local branch independently from checkout HEAD and dirty files", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  const original = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("switch", "-c", "L-GO");
  await writeFile(join(f.root, "a.txt"), "target\n");
  await f.git("commit", "-qam", "target");
  const target = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("switch", "main");
  await writeFile(join(f.root, "notes.txt"), "keep\n");
  const request = { ...f.request, sourceBranch: "L-GO" };
  const expectedState = await f.service.getPublishState(request);
  assert.equal(expectedState.headCommitHash, target);
  assert.equal(expectedState.branchName, "L-GO");
  await f.service.push({ ...request, remote: "origin", branch: "L-GO", expectedState });
  await f.service.createTag({ ...request, name: "v1.0.0", expectedState });
  await f.service.push({
    ...request,
    remote: "origin",
    tag: "v1.0.0",
    tagCommitHash: target,
    expectedState,
  });
  assert.equal((await remote.git("rev-parse", "L-GO")).trim(), target);
  assert.equal((await remote.git("rev-parse", "refs/tags/v1.0.0")).trim(), target);
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), original);
  assert.equal((await f.git("branch", "--show-current")).trim(), "main");
  await f.git("update-ref", "refs/heads/L-GO", original);
  await assert.rejects(
    f.service.push({ ...request, remote: "origin", branch: "L-GO", expectedState }),
    /变化|changed/,
  );
});

test("selected branch is a strict ref name and cannot escape into ordinary commit requests", () => {
  assert.equal(
    gitPublicationRequestSchema.safeParse({ workspacePath: "/repo", sourceBranch: "L-GO" }).success,
    true,
  );
  for (const sourceBranch of ["--all", "main~1", "refs/heads/main", "main:other"])
    assert.equal(
      gitPublicationRequestSchema.safeParse({ workspacePath: "/repo", sourceBranch }).success,
      false,
    );
  assert.equal(
    gitCommitRequestSchema.safeParse({
      workspacePath: "/repo",
      sourceBranch: "main",
      message: "commit",
    }).success,
    false,
  );
});
