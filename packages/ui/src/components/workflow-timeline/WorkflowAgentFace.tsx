import { useId, type CSSProperties } from "react";
import { cn } from "@/components/lib/utils.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { SproutKeyboard, SproutRain } from "./WorkflowSproutProps.js";

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

function SproutEyes() {
  return (
    <g className="wf-sprout-gaze">
      <g className="wf-sprout-eyes">
        <ellipse cx={37} cy={52} rx={3.2} ry={4.2} />
        <ellipse cx={59} cy={52} rx={3.2} ry={4.2} />
      </g>
    </g>
  );
}

function SproutExpression({ status }: { status: StepRunStatus }) {
  switch (status) {
    case "done":
      return (
        <>
          <path
            className="wf-sprout-feature wf-sprout-eyes-happy"
            d="M32 53q5-7 10 0 M54 53q5-7 10 0"
          />
          <path d="M41.5 59.5q6.5 4 13 0c0 11.5-13 11.5-13 0Z" />
          <path className="wf-sprout-tongue" d="M44 66q4-3 8 0-4 3-8 0Z" />
        </>
      );
    case "cancelled":
      return (
        <>
          <path
            className="wf-sprout-feature wf-sprout-eyes-resting"
            d="M32 53q5 4 10 0 M54 53q5 4 10 0"
          />
          <path className="wf-sprout-feature" d="M44 62q4 1.5 8 0" />
        </>
      );
    case "failed":
      return (
        <>
          <SproutEyes />
          <path className="wf-sprout-brows" d="M31.5 45q4-4 8-.5 M55 45.5q4-1.4 8 0" />
          <path className="wf-sprout-feature" d="M42.5 62q2.8-2.8 5.5 0 2.7 2.8 5.5 0" />
        </>
      );
    case "running":
      return (
        <>
          <SproutEyes />
          <path className="wf-sprout-brows" d="M32 44q4-1.7 8 0 M55 44q4-1.7 8 0" />
          <path className="wf-sprout-feature" d="M44 60.8q4 4.3 8 0" />
        </>
      );
    case "pending":
      return (
        <>
          <SproutEyes />
          <path className="wf-sprout-feature" d="M43 61q5 5.5 10 0" />
        </>
      );
  }
}

/** 状态符号只属于药丸右侧尾槽；外侧光环是装饰，停止时保留轮廓但不流动。 */
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
  const haloGradientId = `wf-sprout-${useId()}-halo`;
  const identity = avatarIndex ?? nameHash(name);
  const phase = (((identity * 137) % 1600) + 1600) % 1600;
  const style = { "--wf-avatar-phase": `-${phase}ms` } as CSSProperties;
  const resolvedStatus = status ?? "pending";
  return (
    <svg
      aria-hidden
      className={cn("wf-agent-avatar", className)}
      data-avatar-status={resolvedStatus}
      data-avatar-variant="d2-sprout"
      data-subagent-avatar
      focusable="false"
      style={style}
      viewBox="-8 -25 112 128"
    >
      <defs>
        <linearGradient id={haloGradientId} x1="0" y1="0" x2="1" y2="1">
          <stop className="wf-sprout-halo-tint" offset="0" />
          <stop className="wf-sprout-halo-tint-secondary" offset="1" />
        </linearGradient>
      </defs>
      <g className="wf-sprout-halo" data-avatar-halo="decorative">
        <rect className="wf-sprout-halo-track" x={-5} y={-22} width={106} height={123} rx={22} />
        <rect
          className="wf-sprout-halo-flow"
          x={-5}
          y={-22}
          width={106}
          height={123}
          rx={22}
          pathLength={100}
          stroke={`url(#${haloGradientId})`}
        />
      </g>
      <g className="wf-sprout-artwork" key={resolvedStatus}>
        {resolvedStatus === "failed" ? <SproutRain /> : null}
        {resolvedStatus === "done" ? (
          <ellipse className="wf-sprout-jump-shadow" cx={48} cy={91} rx={21} ry={3} />
        ) : null}
        <g className="wf-sprout-character">
          <g className="wf-sprout-hair">
            <path
              className="wf-sprout-leaf wf-sprout-leaf-blue"
              d="M48 33C32 29 28 17 35 10c13 1 20 12 13 23Z"
            />
            <path
              className="wf-sprout-leaf wf-sprout-leaf-yellow"
              d="M48 32C45 16 57 8 68 14c0 14-10 22-20 18Z"
            />
            <path
              className="wf-sprout-leaf wf-sprout-leaf-green"
              d="M46 33C34 41 22 34 23 25c12-7 23-4 23 8Z"
            />
          </g>
          <g className="wf-sprout-ears">
            <rect x={7} y={48} width={10} height={18} rx={5} />
            <rect x={79} y={48} width={10} height={18} rx={5} />
          </g>
          <rect className="wf-sprout-body" x={14} y={31} width={68} height={52} rx={21} />
          <path
            className="wf-sprout-body-shade"
            d="M20 67c4 11 14 15 28 15s24-4 28-15c-12 8-43 8-56 0Z"
          />
          <rect className="wf-sprout-faceplate" x={22} y={41} width={52} height={31} rx={14} />
          <path className="wf-sprout-shine" d="M25 38q5-3 11-3 M43 78h10" />
          <g className="wf-sprout-blush">
            <ellipse cx={30} cy={59} rx={3.8} ry={2.5} />
            <ellipse cx={66} cy={59} rx={3.8} ry={2.5} />
          </g>
          <g className="wf-sprout-face">
            <SproutExpression status={resolvedStatus} />
          </g>
        </g>
        {resolvedStatus === "running" ? <SproutKeyboard /> : null}
      </g>
    </svg>
  );
}
