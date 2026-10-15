import type { AuthGrant } from "../driver.js";
import type { LocalIO } from "./local-io.js";
import { NativeAccountRefresh } from "./account-refresh.js";
import { saveLocalCodex } from "./local.js";
import { jwt, number } from "./common.js";

const REFRESH_EARLY_MS = 300_000;

/** OpenAI 的有效期、协议交换及 Codex 文件写回保持专用规则。 */
export class OpenAIRefresh extends NativeAccountRefresh {
  constructor(
    lifetime: AbortSignal,
    localIO: LocalIO,
    exchange: (grant: AuthGrant, signal: AbortSignal) => Promise<AuthGrant>,
  ) {
    super({
      lifetime,
      localIO,
      exchange,
      isFresh: (grant) =>
        Boolean(
          grant.access &&
          (grant.expires ?? (number(jwt(grant.access ?? "").exp) ?? 0) * 1000) >
            Date.now() + REFRESH_EARLY_MS,
        ),
      missingRefreshMessage: "ChatGPT sign-in has expired; sign in again",
      afterCommit: (previous, next) => saveLocalCodex(previous, next, localIO),
    });
  }
}
