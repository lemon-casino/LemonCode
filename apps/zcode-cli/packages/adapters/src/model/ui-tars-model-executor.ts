/* eslint-disable max-lines -- Request projection, action code generation and stream adaptation share one protocol boundary. */
import { randomUUID } from "node:crypto";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  type ModelEvent,
  type ModelInputMessage,
  type ModelResult,
  type ModelToolCall,
  type ModelUsage,
} from "@zcode/contracts";
import { findOfficialCuaFrameContentPair } from "@zcode/zcode-cua/frame-contract";
import {
  decodeUiTarsTextAction,
  type UiTarsDecision,
  type UiTarsFrameSize,
  type UiTarsNormalizedAction,
} from "./ui-tars-action-codec.js";
import type { ModelExecutionRequest, ModelExecutor } from "./model.js";

export const UI_TARS_ACTION_MARKER = "zcode-ui-tars-action-v1";
export const UI_TARS_OBSERVATION_MARKER = "zcode-ui-tars-observation-v1";
export const UI_TARS_MAX_ACTIONS = 50;

const NODE_REPL_TOOL_NAME = "mcp__node_repl__js";
const UI_TARS_SYNTHETIC_THOUGHT_KEY = "zcode.ui-tars/synthetic-thought-v1";
const UI_TARS_LIMIT_MESSAGE = "Computer Use stopped after 50 UI-TARS actions.";
const UI_TARS_SYSTEM_INSTRUCTION = [
  "You control the currently active desktop application from the latest screenshot.",
  "Return exactly one Thought line followed by exactly one Action line.",
  "Allowed actions are click, left_double, right_single, drag, type, hotkey, scroll, wait, and finished.",
  "Use normalized 0-1000 box coordinates and do not emit native tool calls or additional prose.",
].join(" ");

export interface UiTarsAppRef {
  readonly pid?: number;
  readonly bundle_id?: string;
  readonly name?: string;
  readonly window_id?: number;
}

export interface UiTarsOfficialFrame extends UiTarsFrameSize {
  readonly frameId: string;
  readonly messageIndex: number;
  readonly appRef: UiTarsAppRef;
}

interface PreparedUiTarsStep {
  readonly actionCount: number;
  readonly frame?: UiTarsOfficialFrame;
  readonly needsObservation: boolean;
  readonly toolName: string;
}

export function createUiTarsModelExecutor(executor: ModelExecutor): ModelExecutor {
  return {
    async generateText(request) {
      const prepared = prepareStep(request);
      request.abortSignal?.throwIfAborted();
      if (prepared.actionCount >= UI_TARS_MAX_ACTIONS) return actionLimitResult();
      if (prepared.needsObservation) {
        return toolCallResult(createObservationToolCall(prepared.toolName));
      }
      const result = await executor.generateText(projectProviderRequest(request));
      return transformResult(result, prepared.frame!, prepared.toolName);
    },
    async *streamText(request) {
      const prepared = prepareStep(request);
      request.abortSignal?.throwIfAborted();
      if (prepared.actionCount >= UI_TARS_MAX_ACTIONS) {
        yield* streamFinalText(UI_TARS_LIMIT_MESSAGE, {});
        return;
      }
      if (prepared.needsObservation) {
        yield* streamToolCall(createObservationToolCall(prepared.toolName), {});
        return;
      }
      yield { type: "start" };
      let text = "";
      let usage: ModelUsage = {};
      let finishReason: string | undefined;
      let providerMetadata: Record<string, unknown> | undefined;
      const nativeToolCalls: ModelToolCall[] = [];
      for await (const event of executor.streamText(projectProviderRequest(request))) {
        if (finishReason !== undefined) {
          yield {
            type: "error",
            error: invalidResponse("UI-TARS provider emitted stream data after its finish event"),
          };
          return;
        }
        if (event.type === "text_delta") text += event.text;
        else if (
          event.type === "reasoning_start" ||
          event.type === "reasoning_delta" ||
          event.type === "reasoning_end"
        ) {
          // UI-TARS 的 Action 文本只在 finish 后解析；provider 已签名/标注的 reasoning
          // 仍是用户可见事实，必须原样透传，不能因文本 codec 而丢失。
          yield event;
        } else if (event.type === "tool_call") nativeToolCalls.push(event.toolCall);
        else if (event.type === "finish") {
          usage = event.usage;
          finishReason = event.finishReason;
          providerMetadata = event.providerMetadata;
        } else if (event.type === "error") {
          yield event;
          return;
        } else if (event.type === "compact_stream_boundary") {
          yield event;
        }
      }
      let decision: UiTarsDecision;
      try {
        requireSuccessfulFinish(finishReason);
        decision = decodeDecision(text, prepared.frame!, nativeToolCalls.length > 0);
      } catch (error) {
        yield { type: "error", error };
        return;
      }
      if (decision.kind === "finished") {
        yield* streamDecisionText(decision, usage, providerMetadata);
        return;
      }
      yield* streamDecisionToolCall(
        decision,
        prepared.frame!,
        prepared.toolName,
        usage,
        providerMetadata,
      );
    },
  };
}

function prepareStep(request: ModelExecutionRequest): PreparedUiTarsStep {
  const toolName = resolveNodeReplToolName(request);
  const frame = findLatestOfficialCuaFrame(request.messages, toolName);
  const latestActionIndex = findLatestMarkedActionMessage(request.messages);
  const latestUserIndex = findLatestUserMessage(request.messages);
  return {
    actionCount: countMarkedActions(request.messages),
    frame,
    // 新 user turn 之后必须重拍；上一轮 frame_id 仍可用不代表桌面内容仍与旧栅格一致。
    needsObservation:
      !frame || latestActionIndex > frame.messageIndex || latestUserIndex > frame.messageIndex,
    toolName,
  };
}

function findLatestUserMessage(messages: readonly ModelInputMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function resolveNodeReplToolName(request: ModelExecutionRequest): string {
  const tool = request.tools?.find(
    (candidate) =>
      candidate.name === NODE_REPL_TOOL_NAME || candidate.name.endsWith("__node_repl__js"),
  );
  if (!tool) {
    throw invalidRequest("UI-TARS requires the trusted node_repl Computer Use tool");
  }
  return tool.name;
}

export function findLatestOfficialCuaFrame(
  messages: readonly ModelInputMessage[],
  trustedToolName: string,
): UiTarsOfficialFrame | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    // Bug 根因：只检查 tool 角色会让其它工具伪造帧；authority 必须落到本轮实际解析出的 node_repl。
    if (message?.role !== "tool" || message.toolName !== trustedToolName) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = content.length - 2; blockIndex >= 0; blockIndex -= 1) {
      const pair = findOfficialCuaFrameContentPair([content[blockIndex], content[blockIndex + 1]]);
      if (!pair) continue;
      try {
        const ref = JSON.parse(pair.imageRef.text) as Record<string, unknown>;
        const width = ref.width;
        const height = ref.height;
        const frameId = ref.frameId;
        if (
          !Number.isSafeInteger(width) ||
          (width as number) <= 0 ||
          !Number.isSafeInteger(height) ||
          (height as number) <= 0 ||
          typeof frameId !== "string" ||
          frameId.length === 0
        ) {
          // Bug 根因：最新 pair 不可用于坐标时继续向前找，会把仍可解析的旧栅格重新变成动作依据。
          return undefined;
        }
        const appRef = parseFrameAppRef(ref.appRef);
        return appRef
          ? { width: width as number, height: height as number, frameId, messageIndex, appRef }
          : undefined;
      } catch {
        // findOfficialCuaFrameContentPair 已校验引用；这里只保护 JSON 类型收窄。
      }
    }
  }
  return undefined;
}

function parseFrameAppRef(value: unknown): UiTarsAppRef | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["pid", "bundle_id", "name", "window_id"].includes(key))) {
    return undefined;
  }
  const pid =
    Number.isSafeInteger(value.pid) && (value.pid as number) > 0
      ? (value.pid as number)
      : undefined;
  const bundleId =
    typeof value.bundle_id === "string" && value.bundle_id.length > 0 ? value.bundle_id : undefined;
  const name = typeof value.name === "string" && value.name.length > 0 ? value.name : undefined;
  if (value.pid !== undefined && pid === undefined) return undefined;
  if (value.bundle_id !== undefined && bundleId === undefined) return undefined;
  if (value.name !== undefined && name === undefined) return undefined;
  if (pid === undefined && bundleId === undefined && name === undefined) return undefined;
  const windowId =
    Number.isSafeInteger(value.window_id) && (value.window_id as number) >= 0
      ? (value.window_id as number)
      : undefined;
  if (value.window_id !== undefined && windowId === undefined) return undefined;
  return {
    ...(pid === undefined ? {} : { pid }),
    ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
    ...(name === undefined ? {} : { name }),
    ...(windowId === undefined ? {} : { window_id: windowId }),
  };
}

function projectProviderRequest(request: ModelExecutionRequest): ModelExecutionRequest {
  const messages: ModelInputMessage[] = [{ role: "system", content: UI_TARS_SYSTEM_INSTRUCTION }];
  for (const message of request.messages) {
    const projected = projectProviderMessage(message);
    if (projected) messages.push(projected);
  }
  return {
    ...request,
    messages,
    tools: undefined,
    responseJsonSchema: undefined,
  };
}

function projectProviderMessage(message: ModelInputMessage): ModelInputMessage | undefined {
  const content = projectProviderMessageContent(message);
  const hasContent = typeof content === "string" ? content.length > 0 : content.length > 0;
  if (
    message.role === "assistant" &&
    !hasContent &&
    (content !== message.content || message.toolCalls?.length)
  ) {
    return undefined;
  }
  const role = message.role === "tool" ? "user" : message.role;
  return {
    role,
    content,
    ...(message.cacheControl ? { cacheControl: message.cacheControl } : {}),
    ...(message.providerId ? { providerId: message.providerId } : {}),
    ...(message.modelId ? { modelId: message.modelId } : {}),
  };
}

function projectProviderMessageContent(message: ModelInputMessage): ModelInputMessage["content"] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message.content;
  const content = message.content.filter(
    (block) =>
      block.type !== "reasoning" || block.providerOptions?.[UI_TARS_SYNTHETIC_THOUGHT_KEY] !== true,
  );
  // Bug 根因：文本协议的 Thought 没有 provider 签名；按通用 reasoning 回放会生成
  // Anthropic 空签名 thinking 或 Chat Completions reasoning_content。
  return content.length === message.content.length ? message.content : content;
}

function transformResult(
  result: ModelResult,
  frame: UiTarsOfficialFrame,
  toolName: string,
): ModelResult {
  requireSuccessfulFinish(result.finishReason);
  const decision = decodeDecision(result.text, frame, (result.toolCalls?.length ?? 0) > 0);
  const reasoning = decision.thought
    ? [...(result.reasoning ?? []), createSyntheticThought(decision.thought)]
    : result.reasoning;
  if (decision.kind === "finished") {
    return {
      ...result,
      text: decision.content,
      finishReason: "stop",
      toolCalls: undefined,
      ...(reasoning ? { reasoning } : {}),
    };
  }
  return {
    ...result,
    text: "",
    finishReason: "tool-calls",
    toolCalls: [createActionToolCall(toolName, decision.action, frame)],
    ...(reasoning ? { reasoning } : {}),
  };
}

function decodeDecision(
  text: string,
  frame: UiTarsFrameSize,
  hasNativeToolCalls: boolean,
): UiTarsDecision {
  const decoded = decodeUiTarsTextAction({ text, frame, hasNativeToolCalls });
  if (decoded.status === "ok") return decoded.decision;
  throw invalidResponse(`Invalid UI-TARS response (${decoded.code}): ${decoded.message}`);
}

function createSyntheticThought(text: string) {
  return {
    type: "reasoning" as const,
    text,
    providerOptions: { [UI_TARS_SYNTHETIC_THOUGHT_KEY]: true },
  };
}

function requireSuccessfulFinish(finishReason: string | undefined): void {
  if (finishReason === "stop") return;
  // Bug 根因：可解析的 Action 前缀不代表响应完整；length/content-filter/提前 EOF 后执行会产生真实副作用。
  throw invalidResponse(
    `UI-TARS response did not finish successfully (finishReason=${finishReason ?? "missing"})`,
  );
}

function actionLimitResult(): ModelResult {
  return { text: UI_TARS_LIMIT_MESSAGE, finishReason: "stop", usage: {} };
}

function toolCallResult(toolCall: ModelToolCall): ModelResult {
  return { text: "", finishReason: "tool-calls", usage: {}, toolCalls: [toolCall] };
}

function createObservationToolCall(toolName: string): ModelToolCall {
  return {
    id: `ui-tars-observe-${randomUUID()}`,
    name: toolName,
    input: {
      code: buildObservationCode(),
      title: "Observe the active app",
      timeout_ms: 60_000,
    },
  };
}

function createActionToolCall(
  toolName: string,
  action: UiTarsNormalizedAction,
  frame: UiTarsOfficialFrame,
): ModelToolCall {
  return {
    id: `ui-tars-action-${randomUUID()}`,
    name: toolName,
    input: {
      code: buildActionCode(action, frame.frameId, frame.appRef),
      title: actionTitle(action),
      timeout_ms: 60_000,
    },
  };
}

function bootstrapLines(marker: string): string[] {
  return [
    `const __zcodeUiTarsMarker = ${JSON.stringify(marker)};`,
    "const __zcodePluginRoot = process.env.ZCODE_CUA_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;",
    'if (!__zcodePluginRoot) throw new Error("Computer Use plugin root is unavailable");',
    'const { join: __zcodeJoin } = await import("node:path");',
    'const { pathToFileURL: __zcodePathToFileURL } = await import("node:url");',
    'const { setupComputerUseRuntime: __zcodeSetupComputerUseRuntime } = await import(__zcodePathToFileURL(__zcodeJoin(__zcodePluginRoot, "scripts", "computer-use-client.mjs")).href);',
    "await __zcodeSetupComputerUseRuntime({ globals: globalThis });",
  ];
}

function activeAppLines(): string[] {
  return [
    "const __zcodeApps = await agent.computerUse.listApps({ emit: false });",
    "const __zcodeApp = __zcodeApps.find((app) => app.active === true) ?? __zcodeApps[0];",
    'if (!__zcodeApp) throw new Error("No controllable desktop application is available");',
    "const __zcodeAppRef = Number.isSafeInteger(__zcodeApp.pid) && __zcodeApp.pid > 0 ? { pid: __zcodeApp.pid } : (__zcodeApp.bundle_id ? { bundle_id: __zcodeApp.bundle_id } : { name: __zcodeApp.name });",
    "const __zcodeAppTarget = await agent.computerUse.getApp(__zcodeApp.pid ?? __zcodeApp.bundle_id ?? __zcodeApp.name);",
  ];
}

function boundAppLines(appRef: UiTarsAppRef): string[] {
  return [`const __zcodeAppRef = ${JSON.stringify(appRef)};`];
}

export function buildObservationCode(): string {
  return [
    ...bootstrapLines(UI_TARS_OBSERVATION_MARKER),
    ...activeAppLines(),
    "await __zcodeAppTarget.getAXStateAndScreenshot({ disableDiffing: true });",
  ].join("\n");
}

export function buildActionCode(
  action: UiTarsNormalizedAction,
  frameId: string,
  appRef: UiTarsAppRef,
): string {
  const lines = [...bootstrapLines(UI_TARS_ACTION_MARKER), ...boundAppLines(appRef)];
  lines.push(...actionLines(action, frameId));
  // Bug 根因：getApp(pid/name) 会丢掉 window_id，动作后的官方帧可能来自同进程的另一个窗口。
  lines.push(
    "await agent.computerUse.computer.get_app_state({ app_ref: __zcodeAppRef, include_screenshot: true, disable_diffing: true });",
  );
  return lines.join("\n");
}

function actionLines(action: UiTarsNormalizedAction, frameId: string): string[] {
  const target = (x: number, y: number) => ({ type: "coordinate", x, y, frame_id: frameId });
  switch (action.name) {
    case "left_click":
      return [
        `await agent.computerUse.computer.left_click(${JSON.stringify({
          app_ref: "__APP_REF__",
          target: target(action.parameters.x, action.parameters.y),
          mouse_button: action.parameters.mouse_button,
          click_count: action.parameters.click_count,
        }).replace('"__APP_REF__"', "__zcodeAppRef")});`,
      ];
    case "left_click_drag":
      return [
        `await agent.computerUse.computer.left_click_drag(${JSON.stringify({
          app_ref: "__APP_REF__",
          from_target: target(action.parameters.start_x, action.parameters.start_y),
          to: target(action.parameters.end_x, action.parameters.end_y),
        }).replace('"__APP_REF__"', "__zcodeAppRef")});`,
      ];
    case "type":
      return [
        `await agent.computerUse.computer.type({ app_ref: __zcodeAppRef, text: ${JSON.stringify(action.parameters.content)} });`,
      ];
    case "key":
      return [
        `await agent.computerUse.computer.key({ app_ref: __zcodeAppRef, text: ${JSON.stringify(action.parameters.key)} });`,
      ];
    case "scroll":
      return [
        `await agent.computerUse.computer.scroll(${JSON.stringify({
          app_ref: "__APP_REF__",
          target: target(action.parameters.x, action.parameters.y),
          scroll_direction: action.parameters.direction,
          scroll_amount: action.parameters.scroll_amount,
        }).replace('"__APP_REF__"', "__zcodeAppRef")});`,
      ];
    case "wait":
      return [
        `await new Promise((resolve) => setTimeout(resolve, ${action.parameters.duration_ms}));`,
      ];
  }
}

function actionTitle(action: UiTarsNormalizedAction): string {
  switch (action.name) {
    case "left_click":
      return action.parameters.click_count === 2
        ? "Double-click in the active app"
        : "Click in the active app";
    case "left_click_drag":
      return "Drag in the active app";
    case "type":
      return "Type in the active app";
    case "key":
      return "Press keys in the active app";
    case "scroll":
      return "Scroll the active app";
    case "wait":
      return "Wait for the active app";
  }
}

function toolCallCode(toolCall: ModelToolCall): string | undefined {
  if (!isPlainObject(toolCall.input)) return undefined;
  return typeof toolCall.input.code === "string" ? toolCall.input.code : undefined;
}

function countMarkedActions(messages: readonly ModelInputMessage[]): number {
  let turnStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      turnStart = index;
      break;
    }
  }
  let count = 0;
  for (const message of messages.slice(turnStart)) {
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCallCode(toolCall)?.includes(UI_TARS_ACTION_MARKER)) count += 1;
    }
  }
  return count;
}

function findLatestMarkedActionMessage(messages: readonly ModelInputMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      messages[index]?.toolCalls?.some((toolCall) =>
        toolCallCode(toolCall)?.includes(UI_TARS_ACTION_MARKER),
      )
    ) {
      return index;
    }
  }
  return -1;
}

async function* streamToolCall(
  toolCall: ModelToolCall,
  usage: ModelUsage,
  providerMetadata?: Record<string, unknown>,
): AsyncIterable<ModelEvent> {
  yield { type: "start" };
  yield* streamToolCallAfterStart(toolCall);
  yield { type: "finish", finishReason: "tool-calls", usage, providerMetadata };
}

async function* streamToolCallAfterStart(toolCall: ModelToolCall): AsyncIterable<ModelEvent> {
  yield { type: "tool_input_start", id: toolCall.id, toolName: toolCall.name };
  yield { type: "tool_input_delta", id: toolCall.id, delta: JSON.stringify(toolCall.input) };
  yield { type: "tool_input_end", id: toolCall.id };
  yield { type: "tool_call", toolCall };
}

async function* streamFinalText(text: string, usage: ModelUsage): AsyncIterable<ModelEvent> {
  yield { type: "start" };
  const id = `ui-tars-text-${randomUUID()}`;
  yield { type: "text_start", id };
  if (text) yield { type: "text_delta", id, text };
  yield { type: "text_end", id };
  yield { type: "finish", finishReason: "stop", usage };
}

async function* streamDecisionText(
  decision: Extract<UiTarsDecision, { kind: "finished" }>,
  usage: ModelUsage,
  providerMetadata?: Record<string, unknown>,
): AsyncIterable<ModelEvent> {
  if (decision.thought) yield* streamReasoning(decision.thought, syntheticThoughtMetadata());
  const id = `ui-tars-text-${randomUUID()}`;
  yield { type: "text_start", id };
  if (decision.content) yield { type: "text_delta", id, text: decision.content };
  yield { type: "text_end", id };
  yield { type: "finish", finishReason: "stop", usage, providerMetadata };
}

async function* streamDecisionToolCall(
  decision: Extract<UiTarsDecision, { kind: "action" }>,
  frame: UiTarsOfficialFrame,
  toolName: string,
  usage: ModelUsage,
  providerMetadata?: Record<string, unknown>,
): AsyncIterable<ModelEvent> {
  if (decision.thought) yield* streamReasoning(decision.thought, syntheticThoughtMetadata());
  const toolCall = createActionToolCall(toolName, decision.action, frame);
  yield* streamToolCallAfterStart(toolCall);
  yield { type: "finish", finishReason: "tool-calls", usage, providerMetadata };
}

async function* streamReasoning(
  text: string,
  providerMetadata?: Record<string, unknown>,
): AsyncIterable<ModelEvent> {
  const id = `ui-tars-reasoning-${randomUUID()}`;
  yield { type: "reasoning_start", id, providerMetadata };
  yield { type: "reasoning_delta", id, text, providerMetadata };
  yield { type: "reasoning_end", id, providerMetadata };
}

function syntheticThoughtMetadata(): Record<string, unknown> {
  return { [UI_TARS_SYNTHETIC_THOUGHT_KEY]: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(message: string): ModelProtocolError {
  return new ModelProtocolError(ModelErrorCode.InvalidModelRequest, message, {
    reason: ModelFailureReason.InvalidRequest,
    retryable: false,
    source: "runtime",
  });
}

function invalidResponse(message: string): ModelProtocolError {
  return new ModelProtocolError(ModelErrorCode.InvalidModelResponse, message, {
    reason: ModelFailureReason.Unknown,
    retryable: false,
    source: "runtime",
  });
}
