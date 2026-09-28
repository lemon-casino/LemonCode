import type { TuiSelection, TuiSubmitPrompt } from "@lcode/tui";
import { getLCodeCopy } from "@lcode/i18n";
import type { CommandCenterApp, CommandCenterLoginResult } from "./types.js";
import { randomUUID } from "node:crypto";

export function buildLoginSelection(locale?: string): TuiSelection {
  const copy = getLCodeCopy(locale).tui.loginSetup;
  return {
    emptyMessage: copy.emptyMessage,
    filterable: false,
    help: copy.help,
    items: [
      {
        command: "/login zai-coding-plan",
        id: "zai-coding-plan",
        keywords: ["zai", "oauth", "coding", "plan"],
        pending: {
          cancelStatus: copy.pending.cancelStatus,
          help: copy.pending.help,
          primary: copy.options.zaiOauth.pendingPrimary,
          secondary: copy.options.zaiOauth.pendingSecondary,
          status: copy.pending.status,
        },
        primary: copy.options.zaiOauth.primary,
        secondary: copy.options.zaiOauth.secondary,
      },
      {
        command: "/login bigmodel-coding-plan",
        id: "bigmodel-coding-plan",
        keywords: ["bigmodel", "oauth", "coding", "plan"],
        pending: {
          cancelStatus: copy.pending.cancelStatus,
          help: copy.pending.help,
          primary: copy.options.bigmodelOauth.pendingPrimary,
          secondary: copy.options.bigmodelOauth.pendingSecondary,
          status: copy.pending.status,
        },
        primary: copy.options.bigmodelOauth.primary,
        secondary: copy.options.bigmodelOauth.secondary,
      },
      {
        command: "/login zai-coding-plan-api-key",
        id: "zai-coding-plan-api-key",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.input.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.input.placeholder,
          primary: copy.options.zaiApiKey.inputPrimary,
          secondary: copy.options.zaiApiKey.inputSecondary,
          status: copy.input.status,
          submitStatus: copy.input.submitStatus,
        },
        keywords: ["zai", "api", "key", "manual"],
        primary: copy.options.zaiApiKey.primary,
        secondary: copy.options.zaiApiKey.secondary,
      },
      {
        command: "/login bigmodel-coding-plan-api-key",
        id: "bigmodel-coding-plan-api-key",
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.input.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.input.placeholder,
          primary: copy.options.bigmodelApiKey.inputPrimary,
          secondary: copy.options.bigmodelApiKey.inputSecondary,
          status: copy.input.status,
          submitStatus: copy.input.submitStatus,
        },
        keywords: ["bigmodel", "api", "key", "manual"],
        primary: copy.options.bigmodelApiKey.primary,
        secondary: copy.options.bigmodelApiKey.secondary,
      },
    ],
    prompt: copy.prompt,
    title: copy.title,
  };
}

export function loginSetupResponse(locale?: string): string {
  return getLCodeCopy(locale).tui.loginSetup.response;
}

export function formatLoginResult(result: CommandCenterLoginResult): string {
  const label = result.user.name || result.user.email || result.user.user_id;
  const browserNote =
    result.browser && !result.browser.opened
      ? `\nBrowser open failed: ${result.browser.reason ?? "unknown error"}`
      : "";

  return [
    `Configured Z.AI Coding Plan as ${label}.`,
    `Model: ${result.model}`,
    `Credentials: ${result.credentialsPath}`,
    `Model selection: ${result.configPath}${browserNote}`,
  ].join("\n");
}

export function formatProviderSetupResult(result: {
  configPath: string;
  model: string;
  providerId: "bigmodel" | "zai";
}): string {
  const provider = result.providerId === "bigmodel" ? "BigModel" : "Z.AI";
  return [
    `Configured ${provider} Coding Plan.`,
    `Model: ${result.model}`,
    `Model selection: ${result.configPath}`,
  ].join("\n");
}

export async function emitLoginAuthorizeMessage(
  options: Parameters<TuiSubmitPrompt>[1],
  authorizeUrl: string,
  providerName: string,
  session: Pick<CommandCenterApp, "sessionId" | "traceId">,
): Promise<void> {
  const onEvent = options.onEvent;
  if (!onEvent) return;

  await onEvent({
    id: `local-login-authorize-${randomUUID()}` as never,
    payload: {
      content: [
        `Open this URL to sign in with ${providerName}:`,
        "",
        authorizeUrl,
        "",
        "After authorization, return here and I will finish the login automatically.",
      ].join("\n"),
    },
    sequenceNumber: 0,
    sessionId: session.sessionId as never,
    timestamp: new Date(),
    traceId: session.traceId as never,
    type: "assistant_message" as never,
  });
}

export function parseApiKeyLoginArgs(args: string): {
  apiKey: string;
  kind: "bigmodel-coding-plan-api-key" | "zai-coding-plan-api-key";
  providerId: "bigmodel" | "zai";
} | null {
  const [kind, ...rest] = args.split(/\s+/u);
  if (kind !== "zai-coding-plan-api-key" && kind !== "bigmodel-coding-plan-api-key") {
    return null;
  }
  return {
    apiKey: rest.join(" ").trim(),
    kind,
    providerId: kind.startsWith("bigmodel") ? "bigmodel" : "zai",
  };
}
