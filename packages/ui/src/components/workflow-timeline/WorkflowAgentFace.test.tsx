import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { WorkflowAgentFace, agentColor, avatarColor, FACE_COLORS } from "./WorkflowAgentFace.js";
import { WorkflowAgentPill } from "./WorkflowAgentPill.js";
import { WorkflowMoreRow } from "./WorkflowMoreRow.js";
import { AvatarCluster } from "@/app-shell/WorkflowRunSpineParts.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { TimelinePill } from "./timeline-model.js";

const STATUSES: readonly StepRunStatus[] = ["pending", "running", "done", "cancelled", "failed"];

function render(status: StepRunStatus | undefined, avatarIndex: number | undefined = 3): string {
  return renderToStaticMarkup(
    <WorkflowAgentFace
      avatarIndex={avatarIndex}
      className="size-3.5"
      name="reviewer"
      status={status}
    />,
  );
}

function propertyOf(markup: string, property: string): string {
  const match = new RegExp(`${property}:([^;"]+)`).exec(markup);
  assert.ok(match, `avatar carries ${property}`);
  return match[1]!;
}

function assertUnobstructedGhost(markup: string) {
  assert.match(markup, /data-avatar-variant="cloud-ghost"/);
  assert.match(markup, /wf-ghost-body/);
  assert.match(markup, /wf-ghost-face/);
  assert.doesNotMatch(markup, /wf-face|data-expression|data-eye-expression|data-motion/);
  assert.doesNotMatch(markup, /wf-agent-avatar-(?:check|cross|stop|outline|orbit|crystal|scan)/);
  assert.doesNotMatch(markup, /<mask|<filter|<image|<rect|--wf-avatar-status|lucide-/);
}

test("each status renders a distinct cloud-ghost expression", () => {
  const expressions = STATUSES.map((status) => {
    const markup = render(status);
    assert.match(markup, new RegExp(`data-avatar-status="${status}"`));
    assert.match(markup, /data-subagent-avatar/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /viewBox="1 1 18 18"/);
    assert.match(markup, /wf-agent-avatar size-3\.5/);
    assertUnobstructedGhost(markup);
    return [...markup.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]).join("|");
  });
  assert.equal(new Set(expressions).size, STATUSES.length);
});

test("undefined status renders exactly like pending", () => {
  assert.equal(render(undefined), render("pending"));
});

test("all five faces are free of overlaid status symbols", () => {
  for (const status of STATUSES) assertUnobstructedGhost(render(status));
});

test("the decorative halo paints behind the face without taking over the right-hand status", () => {
  for (const status of STATUSES.filter((value) => value !== "cancelled")) {
    const markup = render(status);
    assert.match(markup, /data-avatar-halo="decorative"/);
    assert.match(markup, /wf-ghost-halo-flow/);
    assert.ok(
      markup.indexOf('data-avatar-halo="decorative"') <
        markup.indexOf('class="wf-ghost-character"'),
    );
    assert.doesNotMatch(markup, /role="img"|aria-label=|<mask|<filter/);
  }
});

test("a stopped ghost has no halo or unused halo gradient", () => {
  const markup = render("cancelled");
  assert.doesNotMatch(markup, /data-avatar-halo|wf-ghost-halo|id="[^"]+-halo"/);
  assert.equal([...markup.matchAll(/<linearGradient /g)].length, 1);
  assert.match(markup, /wf-ghost-eyes-resting/);
});

test("the ghost leaves its palette to the theme for every state and identity", () => {
  for (const status of STATUSES) {
    for (const index of [undefined, 0, 3, 8]) {
      const markup = render(status, index);
      assert.doesNotMatch(markup, /--wf-avatar-identity|#[0-9a-f]{6}\b/i);
      assert.match(markup, /style="--wf-avatar-phase:-\d+ms"/);
    }
  }
});

test("ghost colours derive from shared theme tokens without fixed lavender or status colours", async () => {
  const styles = await readFile(new URL("../../styles.css", import.meta.url), "utf8");
  const start = styles.indexOf(".wf-agent-avatar {");
  const end = styles.indexOf(".wf-ghost-character,", start);
  assert.ok(start >= 0 && end > start);
  const palette = styles.slice(start, end);
  assert.match(palette, /var\(--color-brand\)/);
  assert.doesNotMatch(palette, /var\(--color-background\)/);
  assert.match(palette, /--wf-ghost-paper:\s*var\(--color-neutral-50\)/);
  assert.match(palette, /--wf-ghost-ink:\s*var\(--color-neutral-900\)/);
  assert.match(palette, /--wf-ghost-rim:\s*color-mix\(/);
  assert.match(palette, /var\(--color-rose-400\)/);
  assert.match(palette, /var\(--color-sky-600\)/);
  assert.match(palette, /\.wf-ghost-body\s*\{[^}]*stroke:\s*var\(--wf-ghost-rim\)/);
  assert.doesNotMatch(
    palette,
    /#[0-9a-f]{3,8}\b|--wf-avatar-identity|--color-(?:success|warning|destructive)|theme-/i,
  );
});

test("existing non-avatar identity colour helpers keep their wrapping and name fallback", () => {
  assert.equal(agentColor(undefined, "reviewer"), avatarColor("reviewer"));
  assert.equal(agentColor(-1, "reviewer"), FACE_COLORS.at(-1));
  assert.equal(agentColor(FACE_COLORS.length, "reviewer"), FACE_COLORS[0]);
});

test("loop phase is deterministic and staggered by identity", () => {
  const phases = [0, 1, 2, 3, 4].map((index) =>
    propertyOf(render("running", index), "--wf-avatar-phase"),
  );
  assert.equal(new Set(phases).size, phases.length);
  for (const phase of phases) assert.match(phase, /^-\d+ms$/);
  assert.equal(render("running", 4), render("running", 4));
  const withoutIndex = () =>
    renderToStaticMarkup(
      <WorkflowAgentFace avatarIndex={undefined} name="reviewer" status="running" />,
    );
  assert.equal(withoutIndex(), withoutIndex());
  assert.equal(
    propertyOf(render("pending", 4), "--wf-avatar-phase"),
    propertyOf(render("failed", 4), "--wf-avatar-phase"),
  );
});

test("only the current expression is mounted", () => {
  assert.match(render("pending"), /wf-ghost-eyes/);
  assert.match(render("pending"), /wf-ghost-mouth-curious/);
  assert.match(render("running"), /wf-ghost-mouth-focused/);
  assert.match(render("done"), /wf-ghost-eyes-happy/);
  assert.match(render("done"), /wf-ghost-smile/);
  assert.doesNotMatch(render("done"), /wf-ghost-tear|wf-ghost-eyes-resting/);
  assert.match(render("cancelled"), /wf-ghost-eyes-resting/);
  assert.doesNotMatch(render("cancelled"), /wf-ghost-gaze|wf-ghost-tear/);
  assert.match(render("failed"), /wf-ghost-tear/);
  assert.match(render("failed"), /wf-ghost-mouth-worried/);
});

test("body and halo gradients remain local to each avatar, even for repeated identities", () => {
  const markup = renderToStaticMarkup(
    <>
      {STATUSES.map((status) => (
        <WorkflowAgentFace key={status} avatarIndex={3} name="reviewer" status={status} />
      ))}
    </>,
  );
  const ids = [...markup.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]);
  const references = [...markup.matchAll(/(?:fill|stroke)="url\(#([^)]+)\)"/g)].map(
    (match) => match[1],
  );
  const expectedCount =
    STATUSES.length + STATUSES.filter((status) => status !== "cancelled").length;
  assert.equal(ids.length, expectedCount);
  assert.equal(new Set(ids).size, expectedCount);
  assert.deepEqual(new Set(references), new Set(ids));
});

const pills: TimelinePill[] = STATUSES.map((status, avatarIndex) => ({
  key: status,
  lane: { id: `agent-${status}`, laneClass: "agent", name: status },
  laneClass: "agent",
  avatarIndex,
  status,
  stepIds: [],
}));

function assertIntegratedAvatars(markup: string, expected: readonly StepRunStatus[]) {
  const rendered = [...markup.matchAll(/data-avatar-status="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rendered, expected);
  for (const match of markup.matchAll(/<svg\b[^>]*data-subagent-avatar[^>]*>[\s\S]*?<\/svg>/g)) {
    assertUnobstructedGhost(match[0]);
  }
}

test("both pill sizes consume the five-state ghost with status marks only after the name", () => {
  for (const size of ["md", "row"] as const) {
    for (const status of STATUSES) {
      const markup = renderToStaticMarkup(
        <LCodeIntlProvider initialLocale="zh-CN">
          <WorkflowAgentPill
            avatarIndex={3}
            name="reviewer"
            laneClass="agent"
            status={status}
            size={size}
          />
        </LCodeIntlProvider>,
      );
      assertIntegratedAvatars(markup, [status]);
      assert.match(markup, new RegExp(`data-pill-size="${size}"`));
      const faceClass = markup.match(/<svg[^>]*class="([^"]*)"[^>]*data-subagent-avatar/)?.[1];
      assert.ok(faceClass);
      assert.match(faceClass, size === "md" ? /\bsize-8\b/ : /\bsize-6\b/);
      assert.doesNotMatch(faceClass, /\bsize-(?:4|3\.5)\b/);
      assert.match(markup, size === "md" ? /\bh-8\b/ : /\bh-6\b/);
      const namePosition = markup.indexOf('class="wf-pill-name');
      assert.ok(markup.indexOf("</svg>") < namePosition);
      const marks = [...markup.matchAll(/data-testid="workflow-pill-status"/g)];
      assert.equal(marks.length, status === "pending" ? 0 : 1);
      if (status !== "pending") {
        const tailPosition = markup.indexOf('data-testid="workflow-pill-tail"');
        assert.ok(namePosition < tailPosition);
        assert.ok(tailPosition < marks[0]!.index!);
      }
    }
  }
});

test("workspace and unresolved glyphs retain their compact sizes", () => {
  for (const laneClass of ["workspace", "unresolved"] as const) {
    for (const size of ["md", "row"] as const) {
      const markup = renderToStaticMarkup(
        <LCodeIntlProvider initialLocale="zh-CN">
          <WorkflowAgentPill name="脚本" laneClass={laneClass} status="done" size={size} />
        </LCodeIntlProvider>,
      );
      assert.doesNotMatch(markup, /data-subagent-avatar|wf-ghost-halo/);
      assert.match(markup, size === "md" ? /size-4/ : /size-3\.5/);
    }
  }
});

test("the open arrow and semantic status still share the right-hand tail", () => {
  const markup = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <WorkflowAgentPill
        avatarIndex={3}
        name="reviewer"
        laneClass="agent"
        status="done"
        open={{ onOpen: () => {}, label: "打开 reviewer" }}
      />
    </LCodeIntlProvider>,
  );
  assertIntegratedAvatars(markup, ["done"]);
  assert.match(markup, /<button/);
  assert.equal([...markup.matchAll(/data-testid="workflow-pill-tail"/g)].length, 1);
  const tail = markup.indexOf('data-testid="workflow-pill-tail"');
  assert.ok(tail > markup.indexOf('class="wf-pill-name'));
  assert.ok(markup.indexOf('data-testid="workflow-pill-status"') > tail);
  assert.ok(markup.indexOf('data-testid="workflow-pill-open"') > tail);
});

test("the more-row deck uses ghost expressions without status overlays", () => {
  const markup = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <WorkflowMoreRow more={{ count: pills.length, deck: pills.slice(1, 4), failed: 0 }} />
    </LCodeIntlProvider>,
  );
  assert.match(markup, /workflow-more-deck/);
  assertIntegratedAvatars(markup, STATUSES.slice(1, 4));
  assert.equal([...markup.matchAll(/wf-more-face size-8/g)].length, 3);
});

test("collapsed phase clusters use the same unobstructed ghost", () => {
  const markup = renderToStaticMarkup(
    <>
      <AvatarCluster pills={pills.slice(0, 3)} nameOf={(pill) => pill.key} />
      <AvatarCluster pills={pills.slice(3)} nameOf={(pill) => pill.key} />
    </>,
  );
  assert.match(markup, /workflow-run-phase-cluster/);
  assertIntegratedAvatars(markup, STATUSES);
});
