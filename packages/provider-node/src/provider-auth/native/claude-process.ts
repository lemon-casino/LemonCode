import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { digest, record, text, type Json } from "./common.js";
import { resolveClaudeCommand } from "./claude-command.js";
import { followLocal } from "./local.js";
import { defaultLocalIO, type LocalIO } from "./local-io.js";

export type ClaudeSpawner = (
  args: string[],
  dir: string,
  additions?: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>;

export function claudeGrant(raw: unknown, previous?: AuthGrant): AuthGrant {
  const credentials = record(raw);
  const oauth = record(credentials.claudeAiOauth);
  if (!text(oauth.refreshToken))
    throw new Error("Import Claude Code's credential JSON with claudeAiOauth");
  return {
    ...previous,
    type: "oauth",
    bridgeId: previous?.bridgeId ?? randomUUID(),
    claudeCredentials: credentials,
    access: text(oauth.accessToken),
    refresh: text(oauth.refreshToken),
    expires: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    accountId: previous?.accountId,
    plan: text(oauth.subscriptionType),
  };
}

export function claudeEnvironment(dir: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_AUTO_COMPACT: "1",
  };
  // 独立profile必须使用本账号OAuth，不能继承主进程的API Key、代理baseURL或另一会话token。
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_EXTRA_BODY",
    "ANTHROPIC_BETAS",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION",
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

export async function spawnClaude(
  args: string[],
  dir: string,
  additions: NodeJS.ProcessEnv = {},
): Promise<ChildProcessWithoutNullStreams> {
  const command = await resolveClaudeCommand();
  const child = spawn(command.command, [...command.prefix, ...args], {
    cwd: dir,
    env: {
      ...claudeEnvironment(dir),
      ...additions,
      ...(command.node ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    stdio: "pipe",
    windowsHide: true,
    shell: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("Claude Code CLI could not be started")));
  });
  return child;
}

export async function temporaryClaudeProfile(credentials?: Json): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lcode-claude-"));
  try {
    if (credentials)
      await writeFile(join(dir, ".credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ skipDangerousModePermissionPrompt: true }),
      { mode: 0o600 },
    );
    return dir;
  } catch (error) {
    await removeClaudeProfile(dir);
    throw error;
  }
}

const runFile = promisify(execFile);
function keychainAccount(): string {
  const user = process.env.USER || userInfo().username;
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
}
function keychainService(dir: string): string {
  return "Claude Code-credentials-" + digest(dir.normalize("NFC")).slice(0, 8);
}
export async function readClaudeCredentials(dir: string): Promise<Json> {
  if (process.platform === "darwin") {
    let stored: string | undefined;
    try {
      stored = (
        await runFile(
          "security",
          ["find-generic-password", "-s", keychainService(dir), "-a", keychainAccount(), "-w"],
          { windowsHide: true, timeout: 15_000 },
        )
      ).stdout.trim();
    } catch {
      /* A new isolated profile initially uses its credential file. */
    }
    if (stored !== undefined) {
      try {
        return record(
          JSON.parse(stored.startsWith("{") ? stored : Buffer.from(stored, "hex").toString("utf8")),
        );
      } catch {
        throw new Error("Claude Code's isolated Keychain credential is invalid");
      }
    }
  }
  try {
    return record(JSON.parse(await readFile(join(dir, ".credentials.json"), "utf8")));
  } catch {
    throw new Error("Claude Code did not save credentials in its isolated profile");
  }
}

export async function removeClaudeProfile(dir: string): Promise<void> {
  const target = resolve(dir);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("lcode-claude-"))
    throw new Error("Refusing to remove an unowned Claude profile");
  if (process.platform === "darwin")
    await runFile(
      "security",
      ["delete-generic-password", "-s", keychainService(target), "-a", keychainAccount()],
      { windowsHide: true, timeout: 15_000 },
    ).catch(() => {});
  await rm(target, { recursive: true, force: true });
}

/** The driver shares exactly one isolated credential profile across this account's CLI sessions. */
export class ClaudeProfile {
  private directory?: Promise<string>;
  private version = "";
  private local = false;
  constructor(private readonly localIO: LocalIO = defaultLocalIO) {}
  async get(grant: AuthGrant): Promise<string> {
    const source = record(grant.localSource);
    if (source.channel === "claude") {
      this.local = true;
      this.directory = Promise.resolve(text(source.dir));
      return this.directory;
    }
    if (!this.directory) {
      const credentials = record(grant.claudeCredentials);
      claudeGrant(credentials, grant);
      this.version = digest(JSON.stringify(credentials));
      this.directory = temporaryClaudeProfile(credentials);
    }
    return this.directory;
  }
  async sync(context: AuthDriverContext): Promise<void> {
    if (!this.directory) return;
    if (this.local) {
      const current = await context.read();
      if (current) await context.write(await followLocal(current, this.localIO, context.signal));
      return;
    }
    const credentials = await readClaudeCredentials(await this.directory);
    const version = digest(JSON.stringify(credentials));
    if (this.version === version) return;
    context.signal?.throwIfAborted();
    const current = await context.read();
    if (!current) return;
    await context.write(claudeGrant(credentials, current));
    this.version = version;
  }
  async dispose(): Promise<void> {
    if (this.directory && !this.local) await removeClaudeProfile(await this.directory);
    this.directory = undefined;
  }
}
