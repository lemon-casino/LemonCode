import { Layers3 } from "lucide-react";
import { useMemo } from "react";
import type {
  ContextSectionSource,
  ContextSnapshotView,
  ContextUsageSnapshotView,
  ContextUsageSource,
} from "./shared";
import { PanelTitle, EmptyLine, Metric } from "./panel-parts";
import { formatTokenMethod, formatConfidence, formatObservationLevel } from "./debug-format";

const sourceLabels: Record<ContextSectionSource, string> = {
  system_prompt: "系统",
  skills: "技能",
  tools: "工具",
  other: "其他",
};

const sourceClasses: Record<ContextSectionSource, string> = {
  system_prompt: "tone-system",
  skills: "tone-skills",
  tools: "tone-tools",
  other: "tone-other",
};

const usageSourceLabels: Record<ContextUsageSource, string> = {
  system_prompt: "系统提示",
  meta_user_context: "Meta User 上下文",
  skills: "技能",
  tool_prompt: "工具提示",
  system_tool_schemas: "系统工具",
  mcp_tool_schemas: "MCP 工具",
  messages: "消息",
  other: "其他",
};

const usageSourceClasses: Record<ContextUsageSource, string> = {
  system_prompt: "tone-system",
  meta_user_context: "tone-meta-user",
  skills: "tone-skills",
  tool_prompt: "tone-tools",
  system_tool_schemas: "tone-tool-schema",
  mcp_tool_schemas: "tone-mcp",
  messages: "tone-messages",
  other: "tone-other",
};

export function ContextPanel({
  snapshots,
  usageSnapshots,
}: {
  snapshots: ContextSnapshotView[];
  usageSnapshots: ContextUsageSnapshotView[];
}) {
  const snapshot = useMemo(
    () => snapshots.findLast((item) => item.observationLevel === "full") ?? snapshots.at(-1),
    [snapshots],
  );
  const usageSnapshot = usageSnapshots.at(-1);
  const grouped = useMemo(() => groupSections(snapshot), [snapshot]);

  return (
    <section className="panel context-panel">
      <PanelTitle icon={<Layers3 size={17} />} title="上下文" />
      {!snapshot && !usageSnapshot ? <EmptyLine text="未观察到上下文快照" /> : null}
      {usageSnapshot ? (
        <div className="usage-snapshot">
          <div className="usage-heading">
            <strong>占用快照</strong>
            <span>
              {formatTokenMethod(usageSnapshot.tokenMethod)} ·{" "}
              {formatConfidence(usageSnapshot.confidence)}
            </span>
          </div>
          <div className="metric-row">
            <Metric label="估算 Token" value={usageSnapshot.totalTokens.toLocaleString()} />
            <Metric label="字符" value={usageSnapshot.totalChars.toLocaleString()} />
            <Metric label="算法" value={usageSnapshot.tokenizer ?? "未知"} />
          </div>
          <div className="stack-bar" aria-label="上下文占用 token 分类">
            {usageSnapshot.categories.map((category) => (
              <span
                className={usageSourceClasses[category.source]}
                key={category.id}
                style={{ width: `${Math.max(category.percentTokens * 100, 2)}%` }}
                title={`${usageSourceLabels[category.source]} ${Math.round(category.percentTokens * 100)}%`}
              />
            ))}
          </div>
          <div className="usage-list">
            {usageSnapshot.categories.map((category) => (
              <div className="usage-row" key={category.id}>
                <span className={`dot ${usageSourceClasses[category.source]}`} />
                <strong>{usageSourceLabels[category.source]}</strong>
                <small>
                  {category.tokens.toLocaleString()} Token ·{" "}
                  {Math.round(category.percentTokens * 100)}% ·{" "}
                  {formatTokenMethod(category.tokenMethod)}
                </small>
              </div>
            ))}
          </div>
          {usageSnapshot.mcpTools.length > 0 ? (
            <details className="usage-details">
              <summary>MCP 工具明细</summary>
              <div className="usage-list">
                {usageSnapshot.mcpTools.map((tool) => (
                  <div className="usage-row" key={tool.name}>
                    <span className="dot tone-mcp" />
                    <strong>{tool.name}</strong>
                    <small>
                      {tool.serverName ?? "unknown"} · {tool.tokens.toLocaleString()} Token ·{" "}
                      {formatTokenMethod(tool.tokenMethod)}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {usageSnapshot.skills.length > 0 ? (
            <details className="usage-details">
              <summary>技能明细</summary>
              <div className="usage-list">
                {usageSnapshot.skills.map((skill) => (
                  <div className="usage-row" key={`${skill.source ?? "skill"}:${skill.name}`}>
                    <span className="dot tone-skills" />
                    <strong>{skill.name}</strong>
                    <small>
                      {skill.source ?? "unknown"} · {skill.tokens.toLocaleString()} Token ·{" "}
                      {formatTokenMethod(skill.tokenMethod)}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {usageSnapshot.warnings.map((warning) => (
            <p className="soft-warning" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      {snapshot ? (
        <>
          <div className="usage-heading">
            <strong>文本快照</strong>
            <span>{formatObservationLevel(snapshot.observationLevel)}</span>
          </div>
          <div className="metric-row">
            <Metric label="Token" value={snapshot.totalTokens.toLocaleString()} />
            <Metric label="字符" value={snapshot.totalChars.toLocaleString()} />
            <Metric label="观测" value={formatObservationLevel(snapshot.observationLevel)} />
          </div>
          <div className="stack-bar" aria-label="上下文 token 占比">
            {grouped.map((group) => (
              <span
                className={sourceClasses[group.source]}
                key={group.source}
                style={{ width: `${Math.max(group.percent * 100, 2)}%` }}
                title={`${sourceLabels[group.source]} ${Math.round(group.percent * 100)}%`}
              />
            ))}
          </div>
          <div className="section-list">
            {snapshot.sections.map((section) => (
              <details key={section.id}>
                <summary>
                  <span className={`dot ${sourceClasses[section.source]}`} />
                  <strong>{section.name}</strong>
                  <small>
                    {sourceLabels[section.source]} · {section.tokens.toLocaleString()} Token ·{" "}
                    {Math.round(section.percentTokens * 100)}%
                  </small>
                </summary>
                <pre>{section.content ?? section.preview ?? "只有元数据"}</pre>
              </details>
            ))}
          </div>
          {snapshot.warnings.map((warning) => (
            <p className="soft-warning" key={warning}>
              {warning}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

function groupSections(snapshot?: ContextSnapshotView) {
  const groups = new Map<ContextSectionSource, number>();
  for (const section of snapshot?.sections ?? []) {
    groups.set(section.source, (groups.get(section.source) ?? 0) + section.tokens);
  }
  const total = [...groups.values()].reduce((sum, value) => sum + value, 0);
  return [...groups.entries()].map(([source, tokens]) => ({
    source,
    tokens,
    percent: total > 0 ? tokens / total : 0,
  }));
}
