import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishFixture } from "./gitPublishTestHelpers.js";

test("publish fingerprints use all tracked/untracked bytes, index flags, HEAD and branch, not cached line counts", async (t) => {
  const f = await publishFixture(t);
  await mkdir(join(f.root, "sub"));
  await writeFile(join(f.root, ".gitignore"), "ignored\na.txt\n");
  await f.git("add", ".gitignore");
  await f.git("commit", "-qm", "ignore");
  const first = await f.state();
  await f.service.getRepositorySummary(f.request);
  await writeFile(join(f.root, "a.txt"), "two\n");
  const content = await f.service.getPublishState({
    ...f.request,
    workspacePath: join(f.root, "sub"),
  });
  assert.notEqual(first.worktreeFingerprint, content.worktreeFingerprint);
  assert.equal(first.indexFingerprint, content.indexFingerprint);
  await writeFile(join(f.root, "ignored"), "ignored bytes\n");
  assert.deepEqual(await f.state(), content);
  await writeFile(join(f.root, "empty"), "");
  const untracked = await f.state();
  assert.notEqual(untracked.worktreeFingerprint, content.worktreeFingerprint);
  await writeFile(join(f.root, "empty"), "same line count");
  assert.notEqual((await f.state()).worktreeFingerprint, untracked.worktreeFingerprint);
  await f.git("add", "-u");
  const staged = await f.state();
  assert.notEqual(staged.indexFingerprint, first.indexFingerprint);
  await f.git("update-index", "--assume-unchanged", "b.txt");
  assert.notEqual((await f.state()).indexFingerprint, staged.indexFingerprint);
  await f.git("update-index", "--no-assume-unchanged", "b.txt");
  await f.git("commit", "-qm", "next");
  const committed = await f.state();
  assert.notEqual(committed.headCommitHash, first.headCommitHash);
  await f.git("checkout", "-qb", "same-head");
  const switched = await f.state();
  assert.equal(switched.headCommitHash, committed.headCommitHash);
  assert.notEqual(switched.branchName, committed.branchName);
});

test("stale publish state rejects commit, tag and push before any side effect", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  const expectedState = await f.state();
  await writeFile(join(f.root, "a.txt"), "two\n");
  await f.git("add", "a.txt");
  await assert.rejects(
    f.service.commit({ ...f.request, message: "feat: reject stale", expectedState }),
    /变化|changed|重新确认/,
  );
  await assert.rejects(
    f.service.createTag({ ...f.request, name: "v1", expectedState }),
    /变化|changed|重新确认/,
  );
  await assert.rejects(
    f.service.push({ ...f.request, remote: "origin", branch: "main", expectedState }),
    /变化|changed|重新确认/,
  );
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), expectedState.headCommitHash);
  assert.equal((await remote.git("for-each-ref")).trim(), "");
  assert.deepEqual((await f.service.listTags(f.request)).tags, []);
});

test("frozen push sends the accepted OID and reports pre-push external changes without falsifying success", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  const expectedState = await f.state();
  await f.hook("pre-push", 'printf "external\\n" > b.txt\ngit commit --allow-empty -qm external');
  const result = await f.service.push({
    ...f.request,
    remote: "origin",
    branch: "main",
    expectedState,
  });
  assert.equal((await remote.git("rev-parse", "main")).trim(), expectedState.headCommitHash);
  assert.notEqual((await f.git("rev-parse", "HEAD")).trim(), expectedState.headCommitHash);
  assert.match(result.warning!, /变化|changed|重新确认/);
  assert.equal(result.setUpstream, false);
  await assert.rejects(
    f.service.createTag({ ...f.request, name: "after-stale", expectedState }),
    /变化|changed|重新确认/,
  );
});

test("guarded ordinary commit returns its next publish state and preserves post-commit success facts", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "a.txt"), "new\n");
  await f.git("add", "a.txt");
  const before = await f.state();
  const committed = await f.service.commit({
    ...f.request,
    message: "feat: selected",
    expectedState: before,
  });
  assert.equal(committed.commitHash, (await f.git("rev-parse", "HEAD")).trim());
  assert.equal(committed.publishState?.headCommitHash, committed.commitHash);
  assert.equal(committed.publishState?.worktreeFingerprint, before.worktreeFingerprint);
  assert.equal(committed.warning, undefined);
  await writeFile(join(f.root, "a.txt"), "again\n");
  await f.git("add", "a.txt");
  await f.hook("post-commit", 'printf "outside\\n" > b.txt\nprintf "post-warning\\n" >&2\nexit 1');
  const warned = await f.service.commit({
    ...f.request,
    message: "feat: hook",
    expectedState: await f.state(),
  });
  assert.equal(warned.commitHash, (await f.git("rev-parse", "HEAD")).trim());
  assert.match(warned.warning!, /已成功|already|post-warning/);
  assert.equal(warned.publishState, undefined);
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "outside\n");
});

test("reviewed commit retries preserve the accepted fact before checking the original expectedState", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "a.txt"), "next\n");
  const draft = await f.service.generateCommitMessage({ ...f.request, review: true });
  assert.ok(draft.review, draft.reviewError);
  const params = {
    ...f.request,
    message: "feat: retry",
    expectedState: await f.state(),
    review: { id: draft.review.id, groupId: draft.review.groups[0]!.id, acknowledged: true },
  };
  const [first, duplicate] = await Promise.all([
    f.service.commit(params),
    f.service.commit(params),
  ]);
  const retried = await f.service.commit(params);
  assert.equal(first.commitHash, duplicate.commitHash);
  assert.equal(first.commitHash, retried.commitHash);
  assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2");
});

test("post-commit index-only writes warn and block publication for ordinary and reviewed commits", async (t) => {
  for (const reviewed of [false, true])
    await t.test(reviewed ? "reviewed" : "ordinary", async (t) => {
      const f = await publishFixture(t);
      await writeFile(join(f.root, "a.txt"), "new\n");
      await f.git("add", "a.txt");
      const draft = reviewed
        ? await f.service.generateCommitMessage({ ...f.request, review: true })
        : undefined;
      await f.hook("post-commit", "git update-index --assume-unchanged b.txt");
      const result = await f.service.commit({
        ...f.request,
        message: "feat: index",
        expectedState: await f.state(),
        ...(draft?.review
          ? {
              review: {
                id: draft.review.id,
                groupId: draft.review.groups[0]!.id,
                acknowledged: true,
              },
            }
          : {}),
      });
      assert.equal(result.commitHash, (await f.git("rev-parse", "HEAD")).trim());
      assert.match(result.warning!, /index|暂存区/);
      assert.equal(result.publishState, undefined);
    });
});

test("guarded commit keeps its actual commit OID if post-commit advances HEAD again", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "a.txt"), "new\n");
  await f.git("add", "a.txt");
  await f.hook(
    "post-commit",
    'git rev-parse HEAD > .git/accepted-commit\nnext=$(printf "external\\n" | git commit-tree HEAD^{tree} -p HEAD)\ngit update-ref HEAD "$next"',
  );
  const before = await f.state();
  const result = await f.service.commit({
    ...f.request,
    message: "feat: actual",
    expectedState: before,
  });
  assert.equal(
    result.commitHash,
    (await readFile(join(f.root, ".git", "accepted-commit"), "utf8")).trim(),
  );
  assert.notEqual(result.commitHash, (await f.git("rev-parse", "HEAD")).trim());
  assert.match(result.warning!, /HEAD|变化|成功/);
  assert.equal(result.publishState, undefined);
});

test("manual selected commits own staging, preserve other staged files, and keep add/delete/rename worktree fingerprints stable", async (t) => {
  for (const guarded of [false, true])
    await t.test(guarded ? "publish" : "ordinary", async (t) => {
      const f = await publishFixture(t);
      await writeFile(join(f.root, "new.txt"), "new content\n");
      await writeFile(join(f.root, "b.txt"), "unrelated staged\n");
      await f.git("add", "b.txt");
      const before = guarded ? await f.state() : undefined;
      const result = await f.service.commit({
        ...f.request,
        message: "feat: new",
        paths: [join(f.root, "new.txt")],
        expectedState: before,
      });
      assert.equal(await f.git("show", "HEAD:new.txt"), "new content\n");
      assert.equal(await f.git("show", "HEAD:b.txt"), "two\n");
      assert.equal(await f.git("show", ":b.txt"), "unrelated staged\n");
      assert.equal(result.warning, undefined);
      if (before)
        assert.equal(result.publishState?.worktreeFingerprint, before.worktreeFingerprint);
      await rm(join(f.root, "new.txt"));
      const deletedState = guarded ? await f.state() : undefined;
      const deleted = await f.service.commit({
        ...f.request,
        message: "feat: delete",
        paths: [join(f.root, "new.txt")],
        expectedState: deletedState,
      });
      assert.equal(deleted.warning, undefined);
      if (deletedState)
        assert.equal(deleted.publishState?.worktreeFingerprint, deletedState.worktreeFingerprint);
      await f.git("mv", "a.txt", "renamed.txt");
      const renamedState = guarded ? await f.state() : undefined;
      const renamed = await f.service.commit({
        ...f.request,
        message: "feat: rename",
        paths: [join(f.root, "renamed.txt")],
        expectedState: renamedState,
      });
      assert.equal(renamed.warning, undefined);
      assert.equal(await f.git("show", "HEAD:renamed.txt"), "one\n");
      await assert.rejects(f.git("show", "HEAD:a.txt"));
      assert.equal(await f.git("show", ":b.txt"), "unrelated staged\n");
    });
});

test("exclusions happen before actual review capture and ordinary prompt generation; exclude-all never broadens", async (t) => {
  const f = await publishFixture(t);
  await mkdir(join(f.root, "sub"));
  await writeFile(join(f.root, "sub", "x.txt"), "before\n");
  await writeFile(join(f.root, "sub", "y.txt"), "before\n");
  await f.git("add", "sub");
  await f.git("commit", "-qm", "sub files");
  await writeFile(join(f.root, "sub", "x.txt"), "chosen\n");
  await writeFile(join(f.root, "sub", "y.txt"), "excluded\n");
  const request = { ...f.request, workspacePath: join(f.root, "sub") };
  const review = await f.service.generateCommitMessage({
    ...request,
    review: true,
    excludedFilePaths: ["sub\\y.txt"],
  });
  assert.ok(review.review, review.reviewError);
  assert.deepEqual(
    review.review.groups.flatMap(({ files }) => files.map(({ path }) => path)),
    ["sub/x.txt"],
  );
  assert.doesNotMatch(f.captured.at(-1)!, /excluded|sub\/y.txt/);
  await f.service.generateCommitMessage({
    ...request,
    excludedFilePaths: [join(f.root, "sub", "y.txt")],
  });
  assert.doesNotMatch(f.captured.at(-1)!, /excluded|sub\/y.txt/);
  const calls = f.captured.length;
  await assert.rejects(
    f.service.generateCommitMessage({
      ...request,
      review: true,
      excludedFilePaths: ["x.txt", "sub/y.txt"],
    }),
    /no changes|没有/,
  );
  assert.equal(f.captured.length, calls);
  const committed = await f.service.commit({
    ...request,
    message: "feat: selected",
    expectedState: await f.state(),
    review: { id: review.review.id, groupId: review.review.groups[0]!.id, acknowledged: true },
  });
  assert.equal(committed.publishState?.headCommitHash, committed.commitHash);
  assert.equal(await f.git("show", "HEAD:sub/y.txt"), "before\n");
  assert.equal(await readFile(join(f.root, "sub", "y.txt"), "utf8"), "excluded\n");
});
