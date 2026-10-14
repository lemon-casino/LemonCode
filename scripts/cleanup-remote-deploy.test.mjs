import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./cleanup-remote-deploy.sh", import.meta.url));
const posix = (path) =>
  path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const exists = (path) =>
  readFile(path).then(
    () => true,
    () => false,
  );

async function fixture(t, remains) {
  const root = await mkdtemp(join(tmpdir(), "lcode-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const base = join(home, ".lcode/server");
  const bin = join(root, "mock-bin");
  const log = join(root, "process-calls.txt");
  await mkdir(bin, { recursive: true });
  for (const [name, source] of Object.entries({
    id: "printf '123\\n'",
    pgrep: `printf '%s\\n' "pgrep $*" >> ${quote(posix(log))}; ${remains === "query-error" ? "exit 2" : remains ? "printf '99001\\n'; exit 0" : "exit 1"}`,
    pkill: `printf '%s\\n' "pkill $*" >> ${quote(posix(log))}`,
    sleep: "exit 0",
  })) {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${source}\n`);
    await chmod(path, 0o755);
  }
  const files = [
    ".deploy.lock/owner",
    ".deploy.lock.holder-abcd.sh",
    ".deploy.lock.control-abcd",
    ".deploy.lock.stale-abcd/owner",
    "asset-cache/components/linux-x64/mise/hash.lock/owner",
    "asset-cache/components/linux-x64/mise/other.lock",
    "asset-cache/components/linux-x64/mise/hash.lock.holder-abcd.sh",
    "asset-cache/components/linux-x64/mise/hash.lock.control-abcd",
    "asset-cache/components/linux-x64/mise/hash/.ready",
    "asset-cache/components/linux-x64/mise/hash/bin/mise",
    "agents/glm/lcode.cjs",
    "node",
    "lcode-server.cjs",
  ];
  for (const file of files) {
    const path = join(base, file);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "preserved fixture");
  }
  const outside = join(home, "projects/business.lock/owner");
  await mkdir(resolve(outside, ".."), { recursive: true });
  await writeFile(outside, "project data");
  const launcher = join(root, "run.sh");
  await writeFile(
    launcher,
    `export HOME=${quote(posix(home))}\nexport PATH=${quote(posix(bin))}:"$PATH"\nbash ${quote(posix(script))}\n`,
  );
  const child = spawn("bash", [launcher], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (part) => {
    output += part;
  });
  child.stderr.on("data", (part) => {
    output += part;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { base, code, output, outside, log: await readFile(log, "utf8") };
}

test("operator cleanup limits process signals to its UID and removes only deployment lock artifacts", async (t) => {
  const f = await fixture(t, false);
  assert.equal(f.code, 0, f.output);
  assert.match(f.log, /pkill -TERM -u 123 -f/);
  assert.match(f.log, /pkill -KILL -u 123 -f/);
  for (const path of [
    ".deploy.lock/owner",
    ".deploy.lock.holder-abcd.sh",
    ".deploy.lock.control-abcd",
    ".deploy.lock.stale-abcd/owner",
    "asset-cache/components/linux-x64/mise/hash.lock/owner",
    "asset-cache/components/linux-x64/mise/other.lock",
    "asset-cache/components/linux-x64/mise/hash.lock.holder-abcd.sh",
    "asset-cache/components/linux-x64/mise/hash.lock.control-abcd",
  ])
    assert.equal(await exists(join(f.base, path)), false, path);
  for (const path of [
    "asset-cache/components/linux-x64/mise/hash/.ready",
    "asset-cache/components/linux-x64/mise/hash/bin/mise",
    "agents/glm/lcode.cjs",
    "node",
    "lcode-server.cjs",
  ])
    assert.equal(await exists(join(f.base, path)), true, path);
  assert.equal(await readFile(f.outside, "utf8"), "project data");
});

test("operator cleanup keeps every lock when a deployment process remains alive", async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.code, 1, f.output);
  assert.match(f.output, /保留锁/);
  assert.equal(await exists(join(f.base, ".deploy.lock/owner")), true);
  assert.equal(
    await exists(join(f.base, "asset-cache/components/linux-x64/mise/hash.lock/owner")),
    true,
  );
});

test("operator cleanup preserves locks when process inspection fails", async (t) => {
  const f = await fixture(t, "query-error");
  assert.equal(f.code, 2, f.output);
  assert.match(f.output, /无法确认/);
  assert.equal(await exists(join(f.base, ".deploy.lock/owner")), true);
  assert.equal(
    await exists(join(f.base, "asset-cache/components/linux-x64/mise/hash.lock/owner")),
    true,
  );
});

test("the real POSIX process pattern matches deployments and excludes ordinary server and Agent commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-cleanup-pattern-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(script, "utf8");
  const pattern = /deploy_pattern='([^']+)'/.exec(source)?.[1];
  assert.ok(pattern);
  const input = join(root, "commands.txt");
  await writeFile(
    input,
    [
      "sh /home/fixture/.lcode/server/.deploy.lock.holder-aabb-1122.sh",
      "curl -o /home/fixture/.lcode/server/asset-cache/staging/mise/component.tar.gz",
      "node /home/fixture/.lcode/server/lcode-server.cjs --stdio",
      "node /home/fixture/.lcode/server/agents/glm/lcode.cjs",
      "sh /home/fixture/project/deploy.sh",
    ].join("\n"),
  );
  const launcher = join(root, "match.sh");
  await writeFile(launcher, `grep -E ${quote(pattern)} ${quote(posix(input))}\n`);
  const child = spawn("bash", [launcher], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let result = "";
  child.stdout.on("data", (part) => {
    result += part;
  });
  await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  assert.equal(result.trim().split("\n").length, 2);
  assert.doesNotMatch(result, /lcode-server\.cjs|agents\/glm|project\/deploy/);
});
