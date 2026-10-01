import { useId, type CSSProperties } from "react";
import { cn } from "@/components/lib/utils.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

export const FACE_COLORS = [
  "#54B9A6",
  "#F19D38",
  "#6464EF",
  "#885CF5",
  "#3C82F6",
  "#ED712E",
  "#EB4699",
  "#5BC67A",
  "#EA4045",
] as const;

function nameHash(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

export function avatarColor(name: string): string {
  return FACE_COLORS[nameHash(name) % FACE_COLORS.length]!;
}

export function agentColor(avatarIndex: number | undefined, name: string): string {
  if (avatarIndex === undefined) return avatarColor(name);
  return FACE_COLORS[
    ((avatarIndex % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length
  ]!;
}

function GhostEyes() {
  return (
    <g className="wf-ghost-gaze">
      <g className="wf-ghost-eyes">
        <ellipse cx={7} cy={10} rx={1.05} ry={1.5} />
        <ellipse cx={13} cy={10} rx={1.05} ry={1.5} />
        <path className="wf-ghost-glint" d="M6.65 9.05v.4 M12.65 9.05v.4" />
      </g>
    </g>
  );
}

function GhostExpression({ status }: { status: StepRunStatus }) {
  switch (status) {
    case "pending":
      return (
        <>
          <GhostEyes />
          <path className="wf-ghost-feature" d="M6.3 7.3q.7-.45 1.5-.05" />
          <ellipse className="wf-ghost-mouth-curious" cx={10} cy={13} rx={0.55} ry={0.6} />
        </>
      );
    case "running":
      return (
        <>
          <GhostEyes />
          <path className="wf-ghost-feature" d="M5.8 7.6q1.2 0 2.4.5 M11.8 8.1q1.2-.5 2.4-.5" />
          <path className="wf-ghost-feature wf-ghost-mouth-focused" d="M9.1 13.1q.9-.4 1.8-.2" />
        </>
      );
    case "done":
      return (
        <>
          <path
            className="wf-ghost-feature wf-ghost-eyes-happy"
            d="M5.9 10.2q1.1-1.6 2.2 0 M11.9 10.2q1.1-1.6 2.2 0"
          />
          <path className="wf-ghost-smile" d="M8.2 12.2q1.8 1 3.6 0c0 3-3.6 3-3.6 0Z" />
          <path className="wf-ghost-tongue" d="M9 14.2q1-1 2 0-1 .6-2 0Z" />
        </>
      );
    case "cancelled":
      return (
        <>
          <path
            className="wf-ghost-feature wf-ghost-eyes-resting"
            d="M5.9 10q1.1.8 2.2 0 M11.9 10q1.1.8 2.2 0"
          />
          <path className="wf-ghost-feature" d="M9.2 13q.8.2 1.6 0" />
        </>
      );
    case "failed":
      return (
        <>
          <GhostEyes />
          <path className="wf-ghost-feature" d="M5.6 7.8q1.4 0 2.6-1 M11.8 6.8q1.2 1 2.6 1" />
          <path className="wf-ghost-feature wf-ghost-mouth-worried" d="M8.8 13.6q1.2-1.4 2.4 0" />
          <g className="wf-ghost-tear">
            <path d="M14.8 11.8c.6.8 1 1.6.2 2-1 .2-1.2-.8-.2-2Z" />
            <path className="wf-ghost-glint" d="M14.65 12.8q-.2.4 0 .6" />
          </g>
        </>
      );
  }
}

/** 状态符号只属于药丸右侧尾槽；头像仅派生表情，避免对勾与状态圈遮住五官。 */
export function WorkflowAgentFace({
  avatarIndex,
  className,
  name,
  status,
}: {
  avatarIndex: number | undefined;
  className?: string;
  name: string;
  status: StepRunStatus | undefined;
}) {
  const gradientId = `wf-ghost-${useId()}`;
  const identity = avatarIndex ?? nameHash(name);
  const phase = (((identity * 137) % 1600) + 1600) % 1600;
  const style = { "--wf-avatar-phase": `-${phase}ms` } as CSSProperties;
  const resolvedStatus = status ?? "pending";
  return (
    <svg
      aria-hidden
      className={cn("wf-agent-avatar", className)}
      data-avatar-status={resolvedStatus}
      data-avatar-variant="cloud-ghost"
      data-subagent-avatar
      focusable="false"
      style={style}
      viewBox="0 0 20 20"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop className="wf-ghost-tint-top" offset="0" />
          <stop className="wf-ghost-tint-bottom" offset="1" />
        </linearGradient>
      </defs>
      <g className="wf-ghost-character" key={resolvedStatus}>
        <path
          className="wf-ghost-body"
          d="M3.2 14C3 9.4 3.6 3.4 8.8 2.8c4-.8 7.6 1.6 7.8 6 .2 2.4-.2 4.8 1 6.8 .6 1.6-1.2 2.2-2.8.4-1 2.2-2.6 2.2-4 .4-1.2 1.8-3 2-4.2 0-2.8 2-4.4.4-3.4-2.4Z"
          fill={`url(#${gradientId})`}
        />
        <path className="wf-ghost-shine" d="M6 5.4Q7.8 4 9.4 4" />
        <path className="wf-ghost-arms" d="M4.2 13q.8.6 1 1.4 M15.6 13q-.8.6-1 1.4" />
        <g className="wf-ghost-blush">
          <ellipse cx={5.6} cy={12.2} rx={1.4} ry={0.8} />
          <ellipse cx={14.4} cy={12.2} rx={1.4} ry={0.8} />
        </g>
        <g className="wf-ghost-face">
          <GhostExpression status={resolvedStatus} />
        </g>
      </g>
    </svg>
  );
}
