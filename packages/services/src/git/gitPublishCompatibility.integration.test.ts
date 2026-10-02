import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { GitCommandExecutionResult } from "./providers/gitCommandProvider.js";
import { publishFixture } from "./gitPublishTestHelpers.js";

async function mixedTags(f: Awaited<ReturnType<typeof publishFixture>>) {
  const head = (await f.git("rev-parse", "HEAD")).trim();
  const unsupportedTags: { name: string; objectType: "tree" | "blob" }[] = [];
  for (const [type, ref] of [
    ["commit", "HEAD"],
    ["tree", "HEAD^{tree}"],
    ["blob", "HEAD:a.txt"],
  ] as const) {
    await f.git("tag", `${type}-light`, ref);
    await f.git("tag", "-am", "annotation", `${type}-annotated`, ref);
    await f.git("tag", "-am", "nested annotation", `${type}-nested`, `${type}-annotated`);
    if (type !== "commit")
      for (const suffix of ["annotated", "light", "nested"])
        unsupportedTags.push({ name: `${type}-${suffix}`, objectType: type });
  }
  return { head, unsupportedTags: unsupportedTags.sort((a, b) => a.name.localeCompare(b.name)) };
}

test("mixed lightweight, annotated and nested tags expose only commit targets as publishable", async (t) => {
  const f = await publishFixture(t);
  const remote = await f.remote("origin");
  assert.deepEqual(await f.service.listTags(f.request), { tags: [] });
  const { head, unsupportedTags } = await mixedTags(f);
  const tags = ["commit-annotated", "commit-light", "commit-nested"].map((name) => ({
    name,
    commitHash: head,
  }));
  assert.deepEqual(await f.service.listTags(f.request), { tags, unsupportedTags });
  const expectedState = await f.state();
  for (const tag of tags) {
    const objectHash = (await f.git("rev-parse", `refs/tags/${tag.name}`)).trim();
    await f.service.push({
      ...f.request,
      remote: "origin",
      tag: tag.name,
      tagCommitHash: head,
      expectedState,
    });
    assert.equal((await remote.git("rev-parse", `refs/tags/${tag.name}`)).trim(), objectHash);
  }
  assert.deepEqual(
    (await remote.git("for-each-ref", "--format=%(refname:strip=2)", "refs/tags/"))
      .trim()
      .split(/\r?\n/),
    tags.map(({ name }) => name),
  );
  for (const { name } of unsupportedTags) await f.git("tag", "-d", name);
  assert.deepEqual(await f.service.listTags(f.request), { tags });
});

test("direct unsupported tag create and push reject explicitly without changing local or remote refs", async (t) => {
  let pushCalls = 0;
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      if (params.args.includes("push")) pushCalls++;
      return command.run(params);
    },
  }));
  const remote = await f.remote("origin");
  const { head, unsupportedTags } = await mixedTags(f);
  const refs = await f.git("for-each-ref", "--format=%(refname) %(objectname)");
  const expectedState = await f.state();
  for (const { name, objectType } of unsupportedTags) {
    await assert.rejects(
      f.service.createTag({ ...f.request, name, expectedState }),
      /conflict|冲突/i,
    );
    for (const tagCommitHash of [undefined, head])
      await assert.rejects(
        f.service.push({ ...f.request, remote: "origin", tag: name, tagCommitHash, expectedState }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /unsupported|不支持/i);
          assert.ok(error.message.includes(name));
          assert.ok(error.message.includes(objectType));
          return true;
        },
      );
  }
  assert.equal(pushCalls, 0);
  assert.equal(await f.git("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.equal(await remote.git("for-each-ref"), "");
});

test("tag catalog fails closed for failed, truncated or malformed object reads", async (t) => {
  for (const stage of ["catalog", "object", "peel", "type"])
    for (const fault of ["failed", "truncated", "malformed"])
      await t.test(`${stage}: ${fault}`, async (t) => {
        let objectHash = "";
        let injected = false;
        const f = await publishFixture(t, (command) => ({
          ...command,
          run: async (params) => {
            const result = await command.run(params);
            const matches =
              stage === "catalog"
                ? params.args[0] === "for-each-ref"
                : stage === "object"
                  ? params.args.join(" ") === "show-ref --verify --hash refs/tags/selected"
                  : stage === "peel"
                    ? params.args[0] === "rev-parse" && params.args.at(-1)?.startsWith(objectHash)
                    : params.args[0] === "cat-file" && params.args[1] === "-t";
            if (!objectHash || !matches || injected) return result;
            injected = true;
            if (fault === "failed")
              return { ...result, exitCode: 2, stderr: "fixture tree/blob object read failed" };
            if (fault === "truncated") return { ...result, exitCode: 128, outputTruncated: true };
            return {
              ...result,
              stdout: stage === "catalog" ? "selected\nvanished\n" : "not-an-object\n",
            };
          },
        }));
        await f.git("tag", "-am", "selected annotation", "selected");
        objectHash = (await f.git("rev-parse", "refs/tags/selected")).trim();
        await assert.rejects(f.service.listTags(f.request));
        assert.equal(injected, true);
        assert.equal((await f.git("rev-parse", "refs/tags/selected")).trim(), objectHash);
      });
});

test("tag lookup does not treat timed-out reads as idempotent create success", async (t) => {
  let injected = false;
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      if (!injected && params.args.join(" ") === "show-ref --verify --hash refs/tags/selected") {
        injected = true;
        return { ...result, exitCode: 128, timedOut: true };
      }
      return result;
    },
  }));
  await f.git("tag", "selected");
  await assert.rejects(f.service.createTag({ ...f.request, name: "selected" }), /timed out/);
  assert.equal(
    (await f.git("rev-parse", "refs/tags/selected")).trim(),
    (await f.state()).headCommitHash,
  );
});

test("corrupt tag objects and refs disappearing after catalog capture remain errors", async (t) => {
  await t.test("corrupt object", async (t) => {
    const f = await publishFixture(t);
    await f.git("tag", "-am", "corrupt annotation", "corrupt");
    const objectHash = (await f.git("rev-parse", "refs/tags/corrupt")).trim();
    const refPath = join(f.root, ".git", "refs", "tags", "corrupt");
    const ref = await readFile(refPath, "utf8");
    const objectPath = join(f.root, ".git", "objects", objectHash.slice(0, 2), objectHash.slice(2));
    await chmod(objectPath, 0o600);
    await writeFile(objectPath, "corrupt");
    await assert.rejects(f.service.listTags(f.request), /corrupt|object|failed|inflate/i);
    assert.equal(await readFile(refPath, "utf8"), ref);
  });
  await t.test("disappearing ref", async (t) => {
    const f = await publishFixture(t, (command) => ({
      ...command,
      run: async (params) => {
        const result = await command.run(params);
        if (params.args[0] === "for-each-ref")
          await command.run({ cwd: params.cwd, args: ["update-ref", "-d", "refs/tags/selected"] });
        return result;
      },
    }));
    await f.git("tag", "selected");
    await assert.rejects(f.service.listTags(f.request), /Tag.*变化/);
  });
});

test("real bare remote non-fast-forward preserves porcelain refusal alongside generic stderr", async (t) => {
  let rejection: GitCommandExecutionResult | undefined;
  const stderr = "error: failed to push some refs to fixture remote";
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      if (params.args.includes("--porcelain") && params.args.includes("push")) {
        rejection = result;
        return { ...result, stderr };
      }
      return result;
    },
  }));
  const remote = await f.remote("origin");
  const old = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("commit", "--allow-empty", "-qm", "remote ahead");
  const ahead = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("push", "origin", "main");
  await f.git("reset", "--hard", old);
  await assert.rejects(
    f.service.push({
      ...f.request,
      remote: "origin",
      branch: "main",
      expectedState: await f.state(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /non-fast-forward/);
      assert.ok(error.message.includes(stderr));
      return true;
    },
  );
  assert.match(rejection!.stdout, /non-fast-forward/);
  assert.notEqual(rejection!.exitCode, 0);
  assert.equal((await remote.git("rev-parse", "main")).trim(), ahead);
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), old);
});

test("explicit push failures preserve both channels, state changes and execution diagnostics without duplicates", async (t) => {
  const stdout = "!\tfixture:refs/heads/main\t[remote rejected] (fixture-policy)";
  const stderr = "remote: fixture server diagnostic";
  const cases: {
    name: string;
    patch?: Partial<GitCommandExecutionResult>;
    changed?: boolean;
    diagnostics?: string[];
  }[] = [
    { name: "dual channels" },
    { name: "dual channels and state warning", changed: true },
    {
      name: "truncated with state warning",
      changed: true,
      patch: { outputTruncated: true },
      diagnostics: ["output exceeded limit"],
    },
    {
      name: "timeout and truncation with state warning",
      changed: true,
      patch: {
        exitCode: null,
        timedOut: true,
        outputTruncated: true,
        timeoutMs: 10,
        durationMs: 25,
        timeoutElapsedMs: 12,
        timeoutCloseDelayMs: 13,
        forceKillAttempted: true,
        orphaned: true,
      },
      diagnostics: [
        "timed out after 10ms",
        "elapsed=25ms",
        "killAt=12ms",
        "cleanup=13ms",
        "forceKill=true",
        "orphaned=true",
        "output exceeded limit",
      ],
    },
    { name: "duplicate channels", patch: { stdout: stderr } },
    { name: "empty failure", patch: { stdout: "", stderr: "" } },
    { name: "empty missing exit", patch: { stdout: "", stderr: "", exitCode: null } },
  ];
  for (const scenario of cases)
    await t.test(scenario.name, async (t) => {
      let pushCalls = 0;
      const f = await publishFixture(t, (command) => ({
        ...command,
        run: async (params) => {
          if (!params.args.includes("--porcelain") || !params.args.includes("push"))
            return command.run(params);
          pushCalls++;
          if (scenario.changed) await writeFile(join(params.cwd, "b.txt"), "external change\n");
          return {
            binaryPath: "git",
            cwd: params.cwd,
            args: params.args,
            signal: null,
            stdout,
            stderr,
            exitCode: 1,
            durationMs: 1,
            timedOut: false,
            outputTruncated: false,
            ...scenario.patch,
          };
        },
      }));
      const remote = await f.remote("origin");
      await assert.rejects(
        f.service.push({
          ...f.request,
          remote: "origin",
          branch: "main",
          expectedState: await f.state(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          for (const channel of [
            scenario.patch?.stdout ?? stdout,
            scenario.patch?.stderr ?? stderr,
          ])
            if (channel) assert.ok(error.message.includes(channel), error.message);
          for (const diagnostic of scenario.diagnostics ?? [])
            assert.ok(error.message.includes(diagnostic), error.message);
          const exitCode =
            scenario.patch && "exitCode" in scenario.patch ? scenario.patch.exitCode : 1;
          assert.ok(error.message.includes(`exitCode=${exitCode ?? "null"}`), error.message);
          if (scenario.changed) assert.match(error.message, /变化.*重新确认发布/);
          if (scenario.name === "duplicate channels")
            assert.equal(error.message.split(stderr).length - 1, 1);
          return true;
        },
      );
      assert.equal(pushCalls, 1);
      assert.equal(await remote.git("for-each-ref"), "");
    });
});
