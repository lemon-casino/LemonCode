import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishFixture } from "./gitPublishTestHelpers.js";

test("explicit push shows the push URL, rejects multiple destinations and leaves legacy push available", async (t) => {
  const f = await publishFixture(t);
  const fetch = await f.remote("origin"),
    push = await f.remote("publication");
  await f.git("config", "remote.origin.pushurl", push.path);
  assert.equal(
    (await f.service.listRemotes(f.request)).remotes.find(({ name }) => name === "origin")?.url,
    push.path,
  );
  await f.git("config", "--add", "remote.origin.pushurl", fetch.path);
  await assert.rejects(
    f.service.push({
      ...f.request,
      remote: "origin",
      branch: "main",
      expectedState: await f.state(),
    }),
    /push URL|目的地/,
  );
  assert.equal(await fetch.git("for-each-ref"), "");
  assert.equal(await push.git("for-each-ref"), "");
  await f.git("config", "--unset-all", "remote.origin.pushurl");
  const legacy = await f.service.push(f.request);
  assert.equal(legacy.remoteName, "origin");
  assert.equal(
    (await fetch.git("rev-parse", "main")).trim(),
    (await f.git("rev-parse", "HEAD")).trim(),
  );
});

test("worktree-specific and included upstream values prevent local config replacement", async (t) => {
  for (const mode of ["worktree", "include"])
    await t.test(mode, async (t) => {
      const f = await publishFixture(t);
      await f.remote("origin");
      if (mode === "worktree") {
        await f.git("config", "extensions.worktreeConfig", "true");
        await f.git("config", "--worktree", "branch.main.remote", "keep");
      } else {
        const included = join(f.base, "included");
        await writeFile(
          included,
          '[branch "main"]\n merge = refs/heads/keep\n merge = refs/heads/other\n',
        );
        await f.git("config", "include.path", included);
      }
      const before = await readFile(join(f.root, ".git", "config"));
      assert.equal(
        (
          await f.service.push({
            ...f.request,
            remote: "origin",
            branch: "main",
            expectedState: await f.state(),
          })
        ).setUpstream,
        false,
      );
      assert.deepEqual(await readFile(join(f.root, ".git", "config")), before);
    });
});

test("snapshot rejects conflicts, truncation and capture-time changes instead of returning a trusted version", async (t) => {
  let mode = "normal",
    changed = false;
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      if (params.args[0] === "ls-files" && params.args.includes("--stage")) {
        if (mode === "truncated") return { ...result, outputTruncated: true };
        if (mode === "moving" && !changed) {
          changed = true;
          await writeFile(join(params.cwd, "a.txt"), "same\n");
          await command.run({ cwd: params.cwd, args: ["add", "a.txt"] });
        }
      }
      return result;
    },
  }));
  mode = "truncated";
  await assert.rejects(f.state(), /exceeded|limit/);
  mode = "moving";
  await assert.rejects(f.state(), /变化|changed/);
  mode = "normal";
  await f.git("checkout", "-qb", "conflicting");
  await writeFile(join(f.root, "a.txt"), "branch\n");
  await f.git("commit", "-qam", "branch");
  await f.git("checkout", "main", "-q");
  await writeFile(join(f.root, "a.txt"), "main\n");
  await f.git("commit", "-qam", "main");
  await f.git("merge", "conflicting").catch(() => {});
  await assert.rejects(f.state(), /冲突/);
});

test("tag and branch mismatch are rejected with no remote changes; tag creation post-change is never silently accepted", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  const first = await f.state();
  await f.service.createTag({ ...f.request, name: "old", expectedState: first });
  await f.git("commit", "--allow-empty", "-qm", "next");
  const second = await f.state();
  await assert.rejects(
    f.service.push({
      ...f.request,
      remote: "origin",
      tag: "old",
      tagCommitHash: second.headCommitHash!,
      expectedState: second,
    }),
    /Tag.*变化/,
  );
  await f.git("checkout", "-qb", "other");
  await assert.rejects(
    f.service.push({ ...f.request, remote: "origin", branch: "main", expectedState: second }),
    /变化/,
  );
  const current = await f.state();
  await f.hook(
    "reference-transaction",
    'if test "$1" = committed; then printf "external\\n" > b.txt; fi',
  );
  await assert.rejects(
    f.service.createTag({ ...f.request, name: "created-fact", expectedState: current }),
    /变化/,
  );
  assert.equal((await f.git("rev-parse", "refs/tags/created-fact")).trim(), current.headCommitHash);
  assert.equal(await remote.git("for-each-ref"), "");
});

test("concurrent same-target tag creation between missing lookup and quiet fallback is idempotent", async (t) => {
  let injected = false;
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      if (
        !injected &&
        params.args.join(" ") === "show-ref --verify --hash refs/tags/concurrent" &&
        result.exitCode !== 0
      ) {
        injected = true;
        await command.run({ cwd: params.cwd, args: ["tag", "concurrent", "HEAD"] });
        return { ...result, exitCode: 128 };
      }
      return result;
    },
  }));
  const result = await f.service.createTag({
    ...f.request,
    name: "concurrent",
    expectedState: await f.state(),
  });
  assert.equal(result.created, false);
  assert.equal(result.commitHash, (await f.git("rev-parse", "HEAD")).trim());
});

test("native commit preserves successful ref fact if command ends without its summary after post-commit", async (t) => {
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      return params.args.includes("commit") && params.args.includes("core.abbrev=no")
        ? {
            ...result,
            stdout: "",
            exitCode: null,
            timedOut: true,
            stderr: "post-commit notification timed out",
          }
        : result;
    },
  }));
  await writeFile(join(f.root, "a.txt"), "new\n");
  await f.git("add", "a.txt");
  const result = await f.service.commit({
    ...f.request,
    message: "feat: timeout fact",
    expectedState: await f.state(),
  });
  assert.equal(result.commitHash, (await f.git("rev-parse", "HEAD")).trim());
  assert.match(result.warning!, /成功|timed out/);
  assert.equal(result.publishState, undefined);
});

test("binary and symlink bytes affect worktree state, including empty files", async (t) => {
  const f = await publishFixture(t);
  const before = await f.state();
  await writeFile(join(f.root, "binary"), Buffer.from([0, 255, 42]));
  const binary = await f.state();
  assert.notEqual(binary.worktreeFingerprint, before.worktreeFingerprint);
  await writeFile(join(f.root, "binary"), Buffer.from([0, 254, 42]));
  assert.notEqual((await f.state()).worktreeFingerprint, binary.worktreeFingerprint);
  await mkdir(join(f.root, "nested"));
  try {
    await symlink("../a.txt", join(f.root, "nested", "link"));
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.diagnostic(
        "Windows symlink privilege unavailable; binary fingerprint verified, symlink branch not exercised.",
      );
      return;
    }
    throw error;
  }
  assert.notEqual((await f.state()).worktreeFingerprint, binary.worktreeFingerprint);
});
