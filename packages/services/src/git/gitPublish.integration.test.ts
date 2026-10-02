import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishFixture } from "./gitPublishTestHelpers.js";

test("explicit publication reaches two selected remotes without mirror/default/followTags expansion", async (t) => {
  const f = await publishFixture(t);
  const first = await f.remote("first"),
    second = await f.remote("second");
  await f.git("branch", "private-branch");
  await f.git("tag", "-am", "private annotation", "private-tag");
  for (const [key, value] of [
    ["remote.first.mirror", "true"],
    ["remote.first.push", "+refs/*:refs/*"],
    ["push.default", "matching"],
    ["push.followTags", "true"],
    ["push.autoSetupRemote", "true"],
  ])
    await f.git("config", key!, value!);
  const expectedState = await f.state();
  const head = expectedState.headCommitHash!;
  assert.deepEqual(
    (await f.service.listRemotes(f.request)).remotes.map(({ name }) => name),
    ["first", "second"],
  );
  for (const remote of ["first", "second"]) {
    const result = await f.service.push({ ...f.request, remote, branch: "main", expectedState });
    assert.equal(result.remoteName, remote);
    assert.equal(result.setUpstream, remote === "first");
    assert.equal(result.warning, undefined);
  }
  for (const remote of [first, second])
    assert.equal(
      (await remote.git("for-each-ref", "--format=%(objectname) %(refname)")).trim(),
      `${head} refs/heads/main`,
    );
  assert.equal((await f.git("config", "--get-all", "branch.main.remote")).trim(), "first");
  assert.equal((await f.git("config", "--get-all", "branch.main.merge")).trim(), "refs/heads/main");
  await f.service.push({ ...f.request, remote: "second", branch: "main", expectedState });
  assert.equal((await f.git("config", "--get-all", "branch.main.remote")).trim(), "first");
});

test("non-fast-forward and conflicting remote tags are rejected without force or damage", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  const old = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("push", "origin", "main");
  await writeFile(join(f.root, "a.txt"), "new\n");
  await f.git("commit", "-qam", "remote ahead");
  const ahead = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("push", "origin", "main");
  await f.git("tag", "conflict", ahead);
  await f.git("push", "origin", "refs/tags/conflict");
  await f.git("tag", "-d", "conflict");
  await f.git("reset", "--hard", old);
  const expectedState = await f.state();
  await assert.rejects(
    f.service.push({ ...f.request, remote: "origin", branch: "main", expectedState }),
    /rejected|fast.forward/i,
  );
  assert.equal((await remote.git("rev-parse", "main")).trim(), ahead);
  await f.service.createTag({ ...f.request, name: "conflict", expectedState });
  await assert.rejects(
    f.service.push({
      ...f.request,
      remote: "origin",
      tag: "conflict",
      tagCommitHash: old,
      expectedState,
    }),
    /rejected|already exists/i,
  );
  assert.equal((await remote.git("rev-parse", "refs/tags/conflict")).trim(), ahead);
});

test("tag create is atomic/idempotent, HEAD-only and detached tag publication retains annotated objects", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  const expectedState = await f.state();
  const results = await Promise.all(
    [0, 1].map(() =>
      f.service.createTag({
        ...f.request,
        name: "v1.0.0",
        ref: expectedState.headCommitHash!,
        expectedState,
      }),
    ),
  );
  assert.equal(results.filter(({ created }) => created).length, 1);
  assert.ok(results.every(({ commitHash }) => commitHash === expectedState.headCommitHash));
  await f.git("tag", "-am", "keep annotation", "annotated");
  const object = (await f.git("rev-parse", "refs/tags/annotated")).trim();
  assert.equal(
    (await f.service.listTags(f.request)).tags.find(({ name }) => name === "annotated")?.commitHash,
    expectedState.headCommitHash,
  );
  await f.git("checkout", "--detach", "-q");
  const detached = await f.state();
  await f.service.push({
    ...f.request,
    remote: "origin",
    tag: "annotated",
    tagCommitHash: detached.headCommitHash!,
    expectedState: detached,
  });
  assert.equal((await remote.git("rev-parse", "refs/tags/annotated")).trim(), object);
  await assert.rejects(
    f.service.push({ ...f.request, remote: "origin", branch: "main", expectedState: detached }),
    /detached|分支/i,
  );
  await writeFile(join(f.root, "a.txt"), "new\n");
  await f.git("commit", "-qam", "next");
  await assert.rejects(
    f.service.createTag({ ...f.request, name: "wrong", ref: expectedState.headCommitHash! }),
    /HEAD/,
  );
  await assert.rejects(
    f.service.createTag({ ...f.request, name: "v1.0.0" }),
    /conflict|冲突|不同/i,
  );
});

test("tag publication pins the tag object even if a pre-push hook moves the local tag", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  await f.git("tag", "-am", "frozen annotation", "selected");
  const object = (await f.git("rev-parse", "refs/tags/selected")).trim();
  await f.git("commit", "--allow-empty", "-qm", "next");
  const expectedState = await f.state();
  const peeled = (await f.git("rev-parse", "selected^{commit}")).trim();
  await f.hook("pre-push", "git tag -f selected HEAD >/dev/null");
  const result = await f.service.push({
    ...f.request,
    remote: "origin",
    tag: "selected",
    tagCommitHash: peeled,
    expectedState,
  });
  assert.equal((await remote.git("rev-parse", "refs/tags/selected")).trim(), object);
  assert.match(result.warning!, /tag|标签|Tag/);
});

test("effective inherited, partial and multi-valued upstreams are never rewritten", async (t) => {
  for (const mode of ["inherited", "remote-only", "merge-only", "multi"])
    await t.test(mode, async (t) => {
      const f = await publishFixture(t);
      await f.remote("origin");
      if (mode === "inherited")
        await writeFile(
          f.globalConfig,
          '[branch "main"]\n remote = keep\n merge = refs/heads/old\n',
        );
      if (mode === "remote-only" || mode === "multi")
        await f.git("config", "--add", "branch.main.remote", "keep");
      if (mode === "merge-only" || mode === "multi")
        await f.git("config", "--add", "branch.main.merge", "refs/heads/old");
      if (mode === "multi") {
        await f.git("config", "--add", "branch.main.remote", "keep-two");
        await f.git("config", "--add", "branch.main.merge", "refs/heads/other");
      }
      const config = await readFile(join(f.root, ".git", "config"), "utf8");
      const result = await f.service.push({
        ...f.request,
        remote: "origin",
        branch: "main",
        expectedState: await f.state(),
      });
      assert.equal(result.setUpstream, false);
      assert.equal(await readFile(join(f.root, ".git", "config"), "utf8"), config);
    });
});

test("cross-name/tag pushes never configure upstream, and config-lock failure preserves successful publication", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  const expectedState = await f.state();
  assert.equal(
    (await f.service.push({ ...f.request, remote: "origin", branch: "release", expectedState }))
      .setUpstream,
    false,
  );
  await f.service.createTag({ ...f.request, name: "selected", expectedState });
  assert.equal(
    (await f.service.push({ ...f.request, remote: "origin", tag: "selected", expectedState }))
      .setUpstream,
    false,
  );
  await writeFile(join(f.root, ".git", "config.lock"), "external lock");
  const result = await f.service.push({
    ...f.request,
    remote: "origin",
    branch: "main",
    expectedState,
  });
  assert.equal(result.setUpstream, false);
  assert.match(result.warning!, /upstream|上游|config|配置/i);
  assert.equal((await remote.git("rev-parse", "main")).trim(), expectedState.headCommitHash);
  assert.equal(await readFile(join(f.root, ".git", "config.lock"), "utf8"), "external lock");
});

test("service boundary rejects malicious or unknown publication parameters before side effects", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  for (const extras of [
    { remote: remote.path, branch: "main" },
    { remote: "absent", branch: "main" },
    { remote: "origin", branch: "main", force: true },
    { remote: "origin", branch: ":main" },
  ]) {
    await assert.rejects(f.service.push({ ...f.request, ...extras }));
  }
  await assert.rejects(f.service.createTag({ ...f.request, name: "--all" }));
  await assert.rejects(f.service.createTag({ ...f.request, name: "bad", ref: "HEAD~1" }));
  assert.equal((await remote.git("for-each-ref")).trim(), "");
  await f.git("checkout", "--orphan", "empty", "-q");
  assert.equal((await f.state()).headCommitHash, null);
  await assert.rejects(f.service.createTag({ ...f.request, name: "empty-tag" }), /HEAD/);
});
