import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "./providers/gitCommandProvider.js";
import { getGitCommandEnv } from "./config.js";
import { createGitService } from "./gitService.js";
import { GitCommitMessageGenerator } from "./gitCommitMessageGenerator.js";

const exec = promisify(execFile);
export async function publishFixture(
  t: TestContext,
  wrap?: (command: GitCommandProvider) => GitCommandProvider,
) {
  const base = await mkdtemp(join(tmpdir(), "lcode-publish-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "checkout");
  await mkdir(root);
  const globalConfig = join(base, "global-config");
  await writeFile(globalConfig, "");
  const env = { ...getGitCommandEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig };
  const at = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd, env, windowsHide: true })).stdout;
  const git = (...args: string[]) => at(root, ...args);
  await git("init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.invalid"],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", join(base, "hooks")],
  ])
    await git("config", key!, value!);
  await writeFile(join(root, "a.txt"), "one\n");
  await writeFile(join(root, "b.txt"), "two\n");
  await git("add", ".");
  await git("commit", "-qm", "initial");
  const command = createGitCommandProvider({
    environmentProvider: {
      resolveGitBinary: async () => "git",
      createCommandEnv: () => env,
    },
  });
  const captured: string[] = [];
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      readCurrentModel: async () => ({ providerId: "fixture", modelId: "fixture" }),
    },
    textGenerator: {
      generateText: async (params) => {
        captured.push(params.prompt);
        let text = "feat: publish selected files";
        if (params.prompt.includes('"groups":')) {
          const input = JSON.parse(params.prompt.split("\n").at(-1)!) as {
            groups: { id: string }[];
          };
          text = JSON.stringify({
            decision: "keep",
            warnings: [],
            messages: input.groups.map(({ id }) => ({ id, message: "feat: selected" })),
            mergedMessage: "feat: selected",
          });
        }
        return { text, selection: params.selection };
      },
    },
  });
  const service = createGitService({
    commandProvider: wrap ? wrap(command) : command,
    commitMessageGenerator: generator,
  });
  const remote = async (name: string) => {
    const path = join(base, `${name}.git`);
    await at(base, "init", "--bare", "-q", path);
    await git("remote", "add", name, path);
    return { path, git: (...args: string[]) => at(path, ...args) };
  };
  const hook = async (name: string, body: string) => {
    await mkdir(join(base, "hooks"), { recursive: true });
    const path = join(base, "hooks", name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  };
  const request = { workspacePath: root, workspaceIdentity: "fixture:publish" };
  const state = () => service.getPublishState(request);
  return { base, root, git, at, remote, hook, globalConfig, captured, service, request, state };
}
