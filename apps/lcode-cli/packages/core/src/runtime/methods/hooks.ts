import { HookEventName } from "../deps.js";
import type { HookRunResult, Model, TraceContext, TurnState } from "../deps.js";
import type { HookEventName as HookEventNameType } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const MAX_STOP_HOOK_CONTINUATIONS = 3;

const EMPTY_HOOK_RESULT: HookRunResult = {
  additionalContexts: [],
};
const HOOK_CONTEXT_MAX_CHARS = 24_000;
const HOOK_PREVIEW_MAX_CHARS = 4_000;

type SessionStartSource = "startup" | "resume" | "clear" | "compact";

export async function runSessionStartHooks(
  this: AgentRuntimeInternal,
  source: SessionStartSource,
  traceContext: TraceContext,
  signal?: AbortSignal,
  model?: Pick<Model, "providerId" | "modelId">,
): Promise<HookRunResult> {
  if (this.sessionStartHookRan) return EMPTY_HOOK_RESULT;
  await this.workspaceHookAdmission?.activate(source, signal);
  this.sessionStartHookRan = true;
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  const selectedModel = model ?? this.getSessionModelSelection();
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.SessionStart,
      mode: this.getMode(),
      model: selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : undefined,
      sessionId: this.sessionId,
      source,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { matchValue: source, signal },
  );
}

export async function runUserPromptSubmitHooks(
  this: AgentRuntimeInternal,
  prompt: string,
  attachments: TurnState["attachments"] | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      attachmentsSummary: summarizeTurnAttachments(attachments),
      cwd: this.workingDirectory,
      hookEventName: HookEventName.UserPromptSubmit,
      mode: this.getMode(),
      prompt,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runStopHooks(
  this: AgentRuntimeInternal,
  response: string,
  toolCallCount: number,
  traceContext: TraceContext,
  signal?: AbortSignal,
  stopHookActive = false,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  const responsePreview = truncateForHook(response, HOOK_PREVIEW_MAX_CHARS);

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.Stop,
      mode: this.getMode(),
      responsePreview,
      responseText: response,
      sessionId: this.sessionId,
      stopHookActive,
      timestamp: new Date().toISOString(),
      toolCallCount,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export function injectHookAdditionalContextIntoMessageHistory(
  this: AgentRuntimeInternal,
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): RuntimeMessageEntry | undefined {
  if (additionalContexts.length === 0) return undefined;
  const entry = systemReminderAttachmentEntry(
    "hook_context",
    formatLifecycleHookAdditionalContextBody(eventName, additionalContexts),
  );
  this.messageHistory.addEntries([entry]);
  return entry;
}

export function shouldContinueAfterStopHooks(
  result: HookRunResult,
  continuationCount: number,
): boolean {
  return (
    result.stopShouldContinue === true &&
    result.additionalContexts.length > 0 &&
    continuationCount < MAX_STOP_HOOK_CONTINUATIONS
  );
}

function formatLifecycleHookAdditionalContextBody(
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): string {
  const body = additionalContexts.map((context, index) => `#${index + 1}\n${context}`).join("\n\n");
  return truncateForHook(
    [`${eventName} hook additional context: `, body].join("\n"),
    HOOK_CONTEXT_MAX_CHARS,
  );
}

function summarizeTurnAttachments(
  attachments: TurnState["attachments"] | undefined,
): string | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  return attachments
    .map((attachment, index) => {
      if (attachment.path) return `${index + 1}:${attachment.type}:${attachment.path}`;
      if (attachment.content)
        return `${index + 1}:${attachment.type}:inline:${attachment.content.length} chars`;
      return `${index + 1}:${attachment.type}`;
    })
    .join("\n");
}

function truncateForHook(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
