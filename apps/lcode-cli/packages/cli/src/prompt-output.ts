import { formatJson } from "@lcode/core";
import type { RunContext, GlobalOptions } from "@lcode/shared-types";
import type { loadBootstrapModule } from "./bootstrap-loader.js";
import type { ModeCapableApp, RunDependencies } from "./cli-types.js";

/**
 * Does this run print a JSON summary at the end?
 *
 * An explicit --output-format wins over the older --json flag, so that
 * `--output-format text` can turn the summary off again. Checking only
 * `options.json` here is a trap: `--output-format json` would parse fine and
 * then silently print plain text.
 */
export const wantsJsonSummary = (options: GlobalOptions): boolean =>
  options.outputFormat === undefined
    ? options.json
    : options.outputFormat === "json" || options.outputFormat === "stream-json";

/** Does this run write each session event as it happens? */
export const wantsEventStream = (options: GlobalOptions): boolean =>
  options.outputFormat === "stream-json";

export function writePromptResult(input: {
  ctx: RunContext;
  options: GlobalOptions;
  app: Pick<ModeCapableApp, "sessionId">;
  streamsEvents: boolean;
  multiTurn: boolean;
  traceId: string;
  result: Awaited<ReturnType<ModeCapableApp["submitPrompt"]>>;
  response: string;
  turnResponses: string[];
  hookTrustDiagnostic: Awaited<ReturnType<typeof resolveHeadlessWorkspaceHookTrustDiagnostic>>;
}): number {
  const {
    ctx,
    options,
    app,
    traceId,
    result,
    response,
    turnResponses,
    hookTrustDiagnostic,
    streamsEvents,
    multiTurn,
  } = input;
  if (streamsEvents) {
    // Closing summary, on its own line and tagged so it can be told apart
    // from the events preceding it. Same fields as --json, so a caller that
    // already parses that keeps working.
    ctx.stdout.write(
      `${JSON.stringify({
        type: "result",
        sessionId: app.sessionId,
        traceId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        response,
        ...(multiTurn ? { turnResponses } : {}),
        ...(result.usage ? { usage: { ...result.usage } } : {}),
        eventCount: result.events.length,
        projection: {
          status: result.projection.status,
          turnCount: result.projection.turnCount,
          totalTokenCount: result.projection.totalTokenCount,
          contextUsed: result.projection.contextUsed ?? null,
          contextWindow: result.projection.contextWindow ?? null,
        },
      })}\n`,
    );
    return 0;
  }

  if (wantsJsonSummary(options)) {
    ctx.stdout.write(
      formatJson({
        sessionId: app.sessionId,
        traceId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        response,
        ...(multiTurn ? { turnResponses } : {}),
        ...(result.usage ? { usage: { ...result.usage } } : {}),
        eventCount: result.events.length,
        ...(hookTrustDiagnostic
          ? {
              workspaceHookTrust: {
                workspacePath: hookTrustDiagnostic.workspacePath,
                workspaceIdentity: hookTrustDiagnostic.workspaceIdentity,
                bundleDigest: hookTrustDiagnostic.bundleDigest,
                reasonCode: hookTrustDiagnostic.reasonCode,
                items: hookTrustDiagnostic.items.map((item) => ({
                  reviewItemId: item.reviewItemId,
                  event: item.event,
                  matcher: item.matcher,
                  displayCommand: item.displayCommand,
                  sourcePath: item.sourcePath,
                  configuredEnabled: item.configuredEnabled,
                  hookDeclarationDigest: item.hookDeclarationDigest,
                  trustState: item.trustState,
                })),
              },
            }
          : {}),
        projection: {
          status: result.projection.status,
          turnCount: result.projection.turnCount,
          totalTokenCount: result.projection.totalTokenCount,
          contextUsed: result.projection.contextUsed ?? null,
          contextWindow: result.projection.contextWindow ?? null,
        },
      }),
    );
    return 0;
  }

  if (hookTrustDiagnostic) writeHeadlessWorkspaceHookTrustDiagnostic(ctx, hookTrustDiagnostic);
  // 每个回合的文本按到达序打印，所以最后一段自然就是结算后的总结。
  // 单回合时这与 `${result.response}\n` 逐字节相同。
  ctx.stdout.write(`${turnResponses.join("\n\n")}\n`);
  return 0;
}

const HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS = [
  "workspace_hooks_pending_trust",
  "workspace_hooks_require_trust_capable_host",
  "workspace_hooks_feature_disabled",
] as const;
type HeadlessWorkspaceHookBlockReason = (typeof HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS)[number];

export async function resolveHeadlessWorkspaceHookTrustDiagnostic(input: {
  bootstrapModule: Awaited<ReturnType<typeof loadBootstrapModule>> | undefined;
  deps: RunDependencies;
  events: readonly unknown[];
  workingDirectory: string;
}) {
  let reasonCode: HeadlessWorkspaceHookBlockReason | undefined;
  for (const event of input.events) {
    if (!event || typeof event !== "object") continue;
    const value = event as {
      type?: string;
      payload?: { errorCode?: string; descriptor?: { sourceKind?: string } };
    };
    if (value.type !== "hook_run_blocked" || value.payload?.descriptor?.sourceKind !== "project") {
      continue;
    }
    const errorCode = value.payload.errorCode;
    if (isHeadlessWorkspaceHookBlockReason(errorCode)) {
      reasonCode = errorCode;
      break;
    }
  }
  if (!reasonCode) return undefined;
  const inspect =
    input.deps.inspectWorkspaceHookTrust ?? input.bootstrapModule?.inspectWorkspaceHookTrust;
  if (!inspect) return undefined;
  const status = await inspect({
    workspacePath: input.workingDirectory,
    ...(input.deps.userConfigPath ? { userConfigPath: input.deps.userConfigPath } : {}),
  });
  return { ...status, reasonCode };
}

function isHeadlessWorkspaceHookBlockReason(
  value: string | undefined,
): value is HeadlessWorkspaceHookBlockReason {
  return HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS.some((candidate) => candidate === value);
}

function writeHeadlessWorkspaceHookTrustDiagnostic(
  ctx: RunContext,
  status: Awaited<ReturnType<NonNullable<RunDependencies["inspectWorkspaceHookTrust"]>>>,
): void {
  ctx.stderr.write(
    [
      `Workspace Hooks skipped: ${status.reasonCode}`,
      `workspace: ${status.workspaceIdentity}`,
      `bundle: ${status.bundleDigest ?? "none"}`,
      ...status.items
        .filter((item) => item.configuredEnabled && item.trustState !== "trusted_persistent")
        .map((item) => `pending digest: ${item.hookDeclarationDigest}`),
      `Review with: lcode hooks trust review --workspace ${JSON.stringify(status.workspaceIdentity)}`,
    ].join("\n") + "\n",
  );
}
