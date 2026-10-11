import { mkdir, watch } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "@lcode/shared/node";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { storeSchema, type StoredAccount } from "./providerAccountStoreSchema.js";

const STORE_KEY = "model-provider-oauth-accounts-v1";
const HOST_KEY = "model-provider-oauth-host-id-v1";
export class ProviderAccountStorage {
  constructor(
    private readonly credentials: ICredentialService,
    private readonly lockPath: string,
  ) {}
  async read(): Promise<StoredAccount[]> {
    const raw = await this.credentials.load(STORE_KEY);
    return raw ? storeSchema.parse(JSON.parse(raw)).accounts : [];
  }
  async hostId(): Promise<string> {
    return withFileLock(this.lockPath, async () => {
      const stored = await this.credentials.load(HOST_KEY);
      if (stored && /^urn:uuid:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(stored))
        return stored;
      // 上游把机器标识作为API授权身份的一部分，不能在每次登录时重新随机生成。
      const id = `urn:uuid:${randomUUID()}`;
      await this.credentials.save(HOST_KEY, id);
      return id;
    });
  }
  async mutate(update: (accounts: StoredAccount[]) => void): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      const accounts = await this.read();
      update(accounts);
      await this.credentials.save(STORE_KEY, JSON.stringify({ version: 1, accounts }));
    });
  }
  async readPublic() {
    return (await this.read()).map(
      ({ grant: _grant, generation: _generation, ...account }) => account,
    );
  }
}

/** 原子凭据文件替换发生在其他window-scoped Host时，也要通知当前Registry重读。 */
export function watchProviderAccountStorage(
  file: string | undefined,
  onChange: () => Promise<void>,
): { ready: Promise<void>; dispose: () => void } {
  if (!file) return { ready: Promise.resolve(), dispose: () => {} };
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  void (async () => {
    try {
      await mkdir(dirname(file), { recursive: true });
      controller.signal.throwIfAborted();
      started();
      for await (const event of watch(dirname(file), {
        signal: controller.signal,
        persistent: false,
      })) {
        if (event.filename === basename(file)) await onChange();
      }
    } catch {
      if (!controller.signal.aborted)
        createServiceLogger("provider-accounts").warn(
          undefined,
          "Account change observation failed; reload settings to refresh",
        );
    } finally {
      started();
      controller.abort();
    }
  })();
  return { ready, dispose: () => controller.abort() };
}

export function authorizationFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/claude/iu.test(message) && /install|required|not found|enoent|dependency/iu.test(message))
    return "OAUTH_CLAUDE_CLI_REQUIRED";
  if (/grok/iu.test(message) && /install|required|not found|enoent|dependency/iu.test(message))
    return "OAUTH_GROK_CLI_REQUIRED";
  return "OAUTH_AUTHORIZATION_FAILED";
}
