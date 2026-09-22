// ============================================================
// 模型引用的解析（`subagent_model` 的字符串 → 一次选型）
// ============================================================
//
// 纯函数、零 I/O：宿主事实由 `ModelCatalogPort` 递进来（contracts 的
// `interfaces/model-catalog.port.ts`），解析本身留在 core。分开的理由是**可测**——
// 三档匹配、大小写、档位校验与「解不出来时说什么」是这套里唯一会被反复改动的地方，
// 而它们一旦和端口实现搅在一起就只能靠集成测试去钉。
//
// 调用点只有一个：`CreateWorkflow` / `AmendWorkflow` 的 `resolveInput`。解析必须发生在
// 确认窗**之前**——窗上显示的是将要生效的那个模型，而解不出来的调用根本不该开窗。

import type { ModelCatalogEntry, ModelCatalogPort, ModelSelection } from "@zcode/contracts";
import {
  ZCODE_MODEL_REASONING_SEPARATOR,
  formatModelPickerValue,
  parseModelPickerValue,
} from "@zcode/shared/model-selection";

/**
 * 解析结果。失败一律带 `candidates`：模型猜错一个名字之后最有用的下一步信息就是「那这里
 * 有哪些」，否则它只会换个拼法再猜一次。
 */
type ModelReferenceResolution =
  | { ok: true; selection: ModelSelection; entry: ModelCatalogEntry; canonical: string }
  | {
      ok: false;
      reason: "not_found" | "ambiguous" | "disabled" | "reasoning_level_unknown";
      message: string;
      candidates: ModelCatalogEntry[];
    };

/**
 * `not_found` 清单的行数上界。一份配了几十个 provider 的目录能列出几百行，而这段文案是
 * 直接进模型上下文的——超出的部分换一句「其余去调 ListModels」，那是**能拿到全量**的路，
 * 截断则不是。
 */
const MODEL_REFERENCE_CANDIDATE_LINES = 40;

/**
 * 把用户说的模型名解析成一次选型。三档，按特异性从高到低（顺序是规格的一部分）：
 *
 *   1. `providerId/modelId` 全称精确命中；
 *   2. 裸 `modelId` 恰好只挂在一个 provider 下；
 *   3. 裸 `modelId` 挂在多个 provider 下 → 其中有**当前会话那一个**就取它，否则 `ambiguous`。
 *
 * 全部比较大小写不敏感：注册表不给与 `modelId` 不同的展示名，所以没有「按 label 再找一轮」
 * 这一档——用户说的名字与 id 之间只差大小写和 provider 前缀。
 *
 * 被禁用的条目**绝不静默命中**：只匹配到禁用条目时回 `disabled` 并带上各自的理由。悄悄跳过
 * 它去选另一个模型，会让用户拿到一个他没要的模型；悄悄选中它则要等到子代理第一次开口才炸。
 *
 * `$level` 在场必须是该模型的合法档位（否则 `reasoning_level_unknown`）；缺席时取注册表默认档
 * （模型没有档位就不带 options）。`canonical` 是 picker 形，用注册表自己的拼写——此后一路到
 * journal 的 `run-launched` 事件、两条读面与确认窗的都是它。
 */
export function resolveModelReference(
  text: string,
  entries: ModelCatalogEntry[],
): ModelReferenceResolution {
  const { reference, level } = splitReasoningLevel(text.trim());
  const matches = matchEntries(reference, entries);
  if (matches.length === 0) return notFoundResolution(text, entries);

  const enabled = matches.filter((entry) => entry.disabledReason === undefined);
  if (enabled.length === 0) return disabledResolution(text, matches);

  // 第 3 档。全称也走这里：同一个 provider/model 在目录里出现两次是宿主的问题，静默取第一个
  // 会让「我选的到底是哪一个」没有答案。
  const entry = enabled.length === 1 ? enabled[0]! : enabled.find((candidate) => candidate.current);
  if (entry === undefined) return ambiguousResolution(text, enabled);

  const options = resolveReasoningOptions(entry, level);
  if (options === undefined) {
    // `resolveReasoningOptions` 只在给了档位又对不上时回 undefined，所以这里的 level 必在场。
    return reasoningLevelUnknownResolution(text, entry, level ?? "");
  }

  const selection: ModelSelection = {
    // 注册表的拼写，不是用户的：`canonical` 要能逐字回填进下一次调用。
    providerId: entry.providerId,
    modelId: entry.modelId,
    ...options,
  };
  return { ok: true, selection, entry, canonical: formatModelPickerValue(selection) };
}

/**
 * 归一化后的 `subagent_model` → 结构化选型。**只用在 handler 里**：走到那里的字符串已经过
 * `resolveInput` 的解析，所以解不开只可能是有人绕过了归一化——那是接线故障，按接线故障喊出来，
 * 而不是静默把用户要的模型丢掉（子代理会安静地跑在会话模型上，没人看得出来）。
 */
export function parseWorkflowSubagentModel(
  canonical: string | undefined,
  catalog?: ModelCatalogPort,
): ModelSelection | undefined {
  if (canonical === undefined) return undefined;
  try {
    const selection = parseModelPickerValue(canonical);
    // 规范字符串只编码推理档位，工作流主动指定模型时需从当前目录补齐标准速度。
    const speed = catalog
      ?.listModels()
      .find(
        (entry) =>
          entry.providerId === selection.providerId && entry.modelId === selection.modelId,
      )?.defaultSpeed;
    return speed === undefined
      ? selection
      : { ...selection, options: { ...selection.options, speed } };
  } catch (cause) {
    throw new Error(
      `workflow subagent_model reached the handler un-canonicalised: ${canonical}`,
      { cause },
    );
  }
}

/**
 * 生效的子代理模型在结果文案里的一句话（`CreateWorkflow` 与 `AmendWorkflow` 共用，形状照
 * `describeWorkflowConcurrencyLimit`）。**只在设了模型时出现**：跑在会话模型上的 run 没有
 * 可说的，多一句只会让模型以为自己选过什么。
 *
 * 括号里那半句是给模型自己听的：它最容易把「子代理换了模型」读成「我也换了」，然后在下一轮
 * 对用户复述一个假的当前模型。
 */
export function describeWorkflowSubagentModel(canonical: string | undefined): string {
  if (canonical === undefined) return "";
  return ` Subagents run on ${canonical} (the main agent stays on the session model).`;
}

/** 目录条目的规范 id（不含档位）：`ListModels` 的 `id` 与失败清单里的那一行同一个形。 */
export function formatModelCatalogId(entry: ModelCatalogEntry): string {
  return `${entry.providerId}/${entry.modelId}`;
}

/**
 * 切出 `$level`。搜索起点跟着 provider 分隔符走（`parseModelPickerValue` 同款）：provider id
 * 里不会有 `$`，但把整串当模型名扫会让 `a$b/c` 这种畸形串被切在错的位置。
 */
function splitReasoningLevel(text: string): { reference: string; level?: string } {
  const providerSeparatorIndex = text.indexOf("/");
  const searchFrom = providerSeparatorIndex + 1;
  const index = text.indexOf(ZCODE_MODEL_REASONING_SEPARATOR, searchFrom);
  // 空的一侧（`$high`、`glm$`）不算档位：那是拼错，让它落到 not_found 去列清单。
  if (index <= searchFrom || index >= text.length - 1) return { reference: text };
  return { reference: text.slice(0, index), level: text.slice(index + 1) };
}

/** 第 1、2 档的候选集：带 `/` 按全称比，不带按裸 `modelId` 比。 */
function matchEntries(reference: string, entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const providerSeparatorIndex = reference.indexOf("/");
  if (providerSeparatorIndex > 0) {
    const providerId = reference.slice(0, providerSeparatorIndex);
    const modelId = reference.slice(providerSeparatorIndex + 1);
    return entries.filter(
      (entry) => sameToken(entry.providerId, providerId) && sameToken(entry.modelId, modelId),
    );
  }
  return entries.filter((entry) => sameToken(entry.modelId, reference));
}

/**
 * 档位选择。返回 `undefined` 表示给的档位不合法（调用点据此回 `reasoning_level_unknown`）；
 * 返回 `{}` 表示这个模型不带档位——注意这与「档位为空字符串」不是一回事，所以不能用空值合并。
 */
function resolveReasoningOptions(
  entry: ModelCatalogEntry,
  level: string | undefined,
): { options?: { reasoningLevel: string } } | undefined {
  if (level !== undefined) {
    // 注册表自己的拼写胜出：用户打的 `HIGH` 要变成目录里的 `high`，否则 canonical 回填一次就变形。
    const matched = entry.reasoningLevels.find((candidate) => sameToken(candidate, level));
    return matched === undefined ? undefined : { options: { reasoningLevel: matched } };
  }
  if (entry.reasoningLevels.length === 0 || entry.defaultReasoningLevel === undefined) return {};
  return { options: { reasoningLevel: entry.defaultReasoningLevel } };
}

/**
 * 找不到：列出**可选用**的 id。禁用的不进清单——让模型从一份它挑了也用不了的名单里挑，
 * 只会换来第二次失败。当前会话那一条打上 `[current]`：它是「什么都不设」的等价物，标出来
 * 模型才知道选它等于没选。
 */
function notFoundResolution(text: string, entries: ModelCatalogEntry[]): ModelReferenceResolution {
  const candidates = entries.filter((entry) => entry.disabledReason === undefined);
  const shown = candidates.slice(0, MODEL_REFERENCE_CANDIDATE_LINES);
  const overflow = candidates.length - shown.length;
  const lines = shown.map(
    (entry) => `${formatModelCatalogId(entry)}${entry.current ? " [current]" : ""}`,
  );
  if (overflow > 0) lines.push(`… and ${overflow} more.`);
  const body =
    candidates.length === 0
      ? "No models are configured on this host."
      : ["Available models:", ...lines].join("\n");
  return {
    ok: false,
    reason: "not_found",
    message: `No configured model matches \`${text}\`. ${body}\n\nPass one of these ids, or call ListModels.`,
    candidates,
  };
}

/** 同名挂在多个 provider 下，且没有一条是当前会话的：只能让调用方写全称。 */
function ambiguousResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map((entry) => formatModelCatalogId(entry));
  return {
    ok: false,
    reason: "ambiguous",
    message: `\`${text}\` is configured under more than one provider:\n${lines.join("\n")}\n\nPass the full \`providerId/modelId\` of the one you want.`,
    candidates,
  };
}

/** 只匹配到禁用条目：连理由一起说出来，否则用户看到的是「这个模型不存在」而它明明在列表里。 */
function disabledResolution(
  text: string,
  candidates: ModelCatalogEntry[],
): ModelReferenceResolution {
  const lines = candidates.map(
    (entry) => `${formatModelCatalogId(entry)} — ${entry.disabledReason}`,
  );
  return {
    ok: false,
    reason: "disabled",
    message: `\`${text}\` matches a model that cannot be used on this host:\n${lines.join("\n")}\n\nResolve that with the user, or call ListModels and pick another id.`,
    candidates,
  };
}

/** 档位不合法：模型认对了，只是档位打错——所以清单给的是**这个模型的**档位，不是整张目录。 */
function reasoningLevelUnknownResolution(
  text: string,
  entry: ModelCatalogEntry,
  level: string,
): ModelReferenceResolution {
  const id = formatModelCatalogId(entry);
  const levels =
    entry.reasoningLevels.length === 0
      ? `${id} has no reasoning levels — drop the \`$\` suffix.`
      : `Its levels are: ${entry.reasoningLevels.join(", ")}.${
          entry.defaultReasoningLevel === undefined
            ? ""
            : ` Omit the suffix to use ${entry.defaultReasoningLevel}.`
        }`;
  return {
    ok: false,
    reason: "reasoning_level_unknown",
    message: `\`${level}\` is not a reasoning level of ${id}. ${levels}`,
    candidates: [entry],
  };
}

/** id 的比较口径：两端去空白后大小写不敏感。注册表里 id 是标识符，不是自由文本。 */
function sameToken(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
