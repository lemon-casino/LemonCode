import { countContextPrefixMessages } from "../deps.js";
import type { Model } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";

export interface PreparedContextPrefixRefresh {
  commit(): void;
  entries: readonly RuntimeMessageEntry[];
}

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  const prepared = prepareContextPrefixRefresh(runtime, options);
  prepared.commit();
  return prepared.entries;
}

export function prepareContextPrefixRefresh(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): PreparedContextPrefixRefresh {
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    const contextBuilder = runtime.contextBuilder
      ? runtime.createContextBuilderFromSnapshot(
          runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
          runtime.memoryRoot,
          {
            memoryIndexContent: runtime.memoryIndexContent,
            model: options.model,
            persistEnvInfo: false,
          },
        )
      : undefined;
    return {
      entries: options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
      commit: () => {
        if (contextBuilder) runtime.contextBuilder = contextBuilder;
      },
    };
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  const contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    {
      memoryIndexContent: runtime.memoryIndexContent,
      model: options.model,
      // prepare 阶段不得提前改 runtime.config；成功提交时再写入与旧 helper 相同的 envInfo。
      persistEnvInfo: false,
    },
  );
  const effectiveContextResult = contextBuilder.build();
  const contextEntries = buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );
  const historyReplacement = runtime.messageHistory.prepareMessagesReplacement([
    ...contextEntries,
    ...canonicalConversationEntries,
  ]);
  const turnEntries = options.turnRequestEntries;
  const entries = turnEntries
    ? [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))]
    : historyReplacement.entries;
  return {
    entries,
    commit: () => {
      runtime.config.envInfo = contextSnapshot.envInfo;
      runtime.contextBuilder = contextBuilder;
      runtime.latestContextBuildResult = effectiveContextResult;
      historyReplacement.commit();
    },
  };
}
