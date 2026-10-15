import { ClinePlugin } from "../vendor/cline/index.mjs.source";
import { CommandCodePlugin } from "../vendor/commandcode/index.mjs.source";
import { CursorAuthPlugin } from "../vendor/cursor/index.mjs.source";
import { DevinAuthPlugin } from "../vendor/devin/index.mjs.source";
import { FactoryAuthPlugin } from "../vendor/factory/index.mjs.source";
import { GrokAuthPlugin } from "../vendor/grok/index.mjs.source";
import { KiroAuthPlugin } from "../vendor/kiro/index.mjs.source";
import {
  MiniMaxCodeAuthPlugin,
  MiniMaxCodeGlobalAuthPlugin,
  _internal as miniMaxInternal,
} from "../vendor/minimax/index.mjs.source";
import { MimoAuthPlugin } from "../vendor/mimo/index.mjs.source";
import { QoderAuthPlugin, QoderCNAuthPlugin } from "../vendor/qoder/index.mjs.source";
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin } from "../vendor/trae/index.mjs.source";
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin } from "../vendor/workbuddy/index.mjs.source";
import { ZCodeAuthPlugin, _internal as zcodeInternal } from "../vendor/zcode/index.mjs.source";
import { ZedAuthPlugin } from "../vendor/zed/index.mjs.source";
import { ZenFreePlugin } from "../vendor/zen-free/index.mjs.source";

export const plugins = {
  cline: ClinePlugin,
  "commandcode-plan": CommandCodePlugin,
  cursor: CursorAuthPlugin,
  devin: DevinAuthPlugin,
  factory: FactoryAuthPlugin,
  grok: GrokAuthPlugin,
  kiro: KiroAuthPlugin,
  "minimax-code": MiniMaxCodeAuthPlugin,
  "minimax-code-global": MiniMaxCodeGlobalAuthPlugin,
  "mimo-app": MimoAuthPlugin,
  qoder: QoderAuthPlugin,
  "qoder-cn": QoderCNAuthPlugin,
  "trae-cn": TraeCNAuthPlugin,
  "trae-global": TraeGlobalAuthPlugin,
  workbuddy: WorkBuddyAuthPlugin,
  "workbuddy-ai": WorkBuddyAIAuthPlugin,
  bigmodel: ZCodeAuthPlugin,
  zai: ZCodeAuthPlugin,
  zed: ZedAuthPlugin,
  "opencode-zen-free": ZenFreePlugin,
};

export function miniMaxCheckinSignature(channel, method, now) {
  const { init } = miniMaxInternal.signed(
    miniMaxInternal.SITES[channel],
    "/minimax-cloud/api/v1/signin",
    {
      now,
      ...(method === "POST" ? { body: {} } : {}),
    },
  );
  return { "x-timestamp": init.headers["x-timestamp"], "x-signature": init.headers["x-signature"] };
}

export function assertGrantChannel(channel, grant) {
  if (channel !== "zai" && channel !== "bigmodel") return;
  const state = grant?.type === "oauth" ? JSON.parse(grant.refresh || "{}") : grant?.metadata;
  const current = state?.source === "zcode" ? zcodeInternal.ownSignIn() : state;
  if (current?.site && current.site !== channel) {
    throw new Error(
      `The imported ZCode account belongs to ${current.site}; use its matching channel`,
    );
  }
}
