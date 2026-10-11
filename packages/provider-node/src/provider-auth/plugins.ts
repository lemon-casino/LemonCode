import type {
  AuthChallenge,
  AuthDriver,
  AuthGrant,
  AuthImportEntry,
  AuthMethod,
  AuthModel,
} from "./driver.js";
import { PluginWorkerTransport } from "./plugins/transport.js";

const channels = new Set([
  "bigmodel",
  "zai",
  "cline",
  "commandcode-plan",
  "cursor",
  "devin",
  "factory",
  "grok",
  "kiro",
  "minimax-code",
  "minimax-code-global",
  "mimo-app",
  "qoder",
  "qoder-cn",
  "trae-cn",
  "trae-global",
  "workbuddy",
  "workbuddy-ai",
  "zed",
  "opencode-zen-free",
]);
const aliases: Readonly<Record<string, string>> = {
  zcode: "zai",
  mimo: "mimo-app",
  commandcode: "commandcode-plan",
  "zen-free": "opencode-zen-free",
};

interface WorkerChallenge {
  challengeId: number;
  url?: string;
  instructions?: string;
  method: "auto" | "code";
  batch?: boolean;
}

/** Fixed, bundled providers only. Every returned driver owns a separate worker/account. */
export async function createPluginAuthDriver(channelId: string): Promise<AuthDriver | null> {
  return createDriver(channelId);
}

/** Internal deterministic tests redirect every fetch to a local fixture server. */
export function createPluginAuthFixtureDriver(
  channelId: string,
  fixtureOrigin: string,
  fixtureH2Origin?: string,
  fixtureLocalHome?: string,
): AuthDriver | null {
  const url = new URL(fixtureOrigin);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Fixture transport must use an HTTP loopback server");
  }
  if (fixtureH2Origin) {
    const h2 = new URL(fixtureH2Origin);
    if (h2.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(h2.hostname))
      throw new Error("Fixture HTTP/2 transport must use an HTTP loopback server");
  }
  return createDriver(channelId, url.origin, fixtureH2Origin, fixtureLocalHome);
}

function createDriver(
  channelId: string,
  fixtureOrigin?: string,
  fixtureH2Origin?: string,
  fixtureLocalHome?: string,
): AuthDriver | null {
  const channel = aliases[channelId] ?? channelId;
  if (!channels.has(channel)) return null;
  const worker = new PluginWorkerTransport(
    channel,
    fixtureOrigin,
    fixtureH2Origin,
    fixtureLocalHome,
  );
  return {
    methods: () => worker.call<readonly AuthMethod[]>("methods"),
    async authorize(methodId, inputs, signal): Promise<AuthChallenge> {
      const challenge = await worker.call<WorkerChallenge>(
        "authorize",
        { methodId, inputs },
        undefined,
        signal,
        true,
      );
      const cancel = () => {
        void worker.dispose();
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        cancel();
        throw new DOMException("Authorization cancelled", "AbortError");
      }
      let completed = false;
      const complete = async <T>(operation: string, code?: string): Promise<T> => {
        if (completed) throw new Error("Authorization attempt already completed");
        completed = true;
        try {
          return await worker.call<T>(
            operation,
            { challengeId: challenge.challengeId, code },
            undefined,
            signal,
            true,
          );
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      };
      return {
        url: challenge.url,
        instructions: challenge.instructions,
        method: challenge.method,
        complete: (code) => complete<AuthGrant>("complete", code),
        ...(challenge.batch
          ? { completeMany: () => complete<readonly AuthImportEntry[]>("completeMany") }
          : {}),
        cancel() {
          signal.removeEventListener("abort", cancel);
          cancel();
        },
      };
    },
    models: (context) => worker.call<readonly AuthModel[]>("models", {}, context),
    modelCatalog: (context) =>
      worker.call<{ models: readonly AuthModel[]; fallback?: boolean }>(
        "modelCatalog",
        {},
        context,
      ),
    async fetch(request, context) {
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : new Uint8Array(await request.arrayBuffer());
      return worker.call<Response>(
        "fetch",
        {
          request: {
            url: request.url,
            method: request.method,
            headers: [...request.headers],
            body,
          },
        },
        context,
        request.signal,
      );
    },
    quota: (context) => worker.call<unknown>("quota", {}, context),
    dispose: () => worker.dispose(),
  };
}
