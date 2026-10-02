import { Clock3 } from "lucide-react";
import type { TimelineItem } from "./shared";
import { PanelTitle, EmptyLine, TimelinePayload, MetaLine } from "./panel-parts";
import { formatTime } from "./debug-format";

export function TimelinePanel({ items }: { items: TimelineItem[] }) {
  return (
    <section className="panel timeline-panel">
      <PanelTitle icon={<Clock3 size={17} />} title="时间线" />
      <div className="timeline">
        {items.length === 0 ? <EmptyLine text="选择 Trace 后查看事件" /> : null}
        {items.map((item) => (
          <article className={`timeline-item severity-${item.severity ?? "info"}`} key={item.id}>
            <time>{formatTime(item.at)}</time>
            <div>
              <div className="timeline-heading">
                <strong>{item.label}</strong>
                <span>{item.source}</span>
              </div>
              <p className="timeline-summary">{item.summary}</p>
              {item.payload !== undefined ? <TimelinePayload payload={item.payload} /> : null}
              <MetaLine
                values={[
                  item.sessionId ? `会话 ${item.sessionId}` : "",
                  item.turnId ? `轮次 ${item.turnId}` : "",
                  item.toolCallId ? `工具 ${item.toolCallId}` : "",
                ]}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
