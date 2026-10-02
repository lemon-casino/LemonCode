function requireCheck(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  requireCheck(element, `Missing ${selector}`);
  return element;
}

function luminance(colour: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = colour;
  context.fillRect(0, 0, 1, 1);
  const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

function minimumHaloGap(svg: SVGSVGElement) {
  const halo = query<SVGRectElement>(svg, ".wf-sprout-halo-track");
  const cx = halo.x.baseVal.value + halo.width.baseVal.value / 2;
  const cy = halo.y.baseVal.value + halo.height.baseVal.value / 2;
  const radius = halo.rx.baseVal.value;
  const halfWidth = halo.width.baseVal.value / 2 - radius;
  const halfHeight = halo.height.baseVal.value / 2 - radius;
  const inverse = svg.getScreenCTM()!.inverse();
  const geometry = [
    ...svg.querySelectorAll<SVGGeometryElement>(
      ".wf-sprout-artwork path, .wf-sprout-artwork rect, .wf-sprout-artwork ellipse",
    ),
  ];
  const animations = svg.getAnimations({ subtree: true });
  const saved = animations.map((animation) => ({
    animation,
    time: animation.currentTime,
    state: animation.playState,
  }));
  let minimum = Infinity;
  try {
    animations.forEach((animation) => animation.pause());
    for (let time = 0; time <= 7600; time += 95) {
      animations.forEach((animation) => {
        animation.currentTime = time;
      });
      for (const element of geometry) {
        const style = getComputedStyle(element);
        if (Number(style.opacity) < 0.05) continue;
        const matrix = inverse.multiply(element.getScreenCTM()!);
        const length = element.getTotalLength();
        const stroke =
          style.stroke === "none"
            ? 0
            : (parseFloat(style.strokeWidth) *
                Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))) /
              2;
        for (let point = 0; point <= 24; point++) {
          const position = element.getPointAtLength((length * point) / 24).matrixTransform(matrix);
          const qx = Math.abs(position.x - cx) - halfWidth;
          const qy = Math.abs(position.y - cy) - halfHeight;
          const distance =
            radius - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0);
          minimum = Math.min(minimum, distance - stroke - 1.4);
        }
      }
    }
  } finally {
    saved.forEach(({ animation, time, state }) => {
      animation.currentTime = time;
      if (state === "running") animation.play();
    });
  }
  return minimum;
}

export function checkWorkflowAvatars() {
  const results = [];
  for (const card of document.querySelectorAll<HTMLElement>("[data-fixture-state]")) {
    const state = card.dataset.fixtureState!;
    const svg = query<SVGSVGElement>(card, "svg[data-subagent-avatar]");
    const panel = getComputedStyle(query(svg, ".wf-sprout-faceplate")).fill;
    const faceContrast = contrast(panel, getComputedStyle(query(svg, ".wf-sprout-face")).fill);
    const rimContrast = contrast(panel, getComputedStyle(query(svg, ".wf-sprout-body")).stroke);
    requireCheck(faceContrast >= 4.5, `${state}: face contrast ${faceContrast}`);
    requireCheck(rimContrast >= 3, `${state}: outline contrast ${rimContrast}`);
    requireCheck(svg.querySelector("[data-avatar-halo]"), `${state}: missing halo`);
    requireCheck(
      !!svg.querySelector('[data-avatar-prop="keyboard"]') === (state === "running"),
      `${state}: keyboard visibility`,
    );
    requireCheck(
      !!svg.querySelector('[data-avatar-prop="rain"]') === (state === "failed"),
      `${state}: rain visibility`,
    );
    const animations = svg.getAnimations({ subtree: true });
    if (state === "cancelled") requireCheck(animations.length === 0, "Stopped avatar still moves");
    if (state === "done" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const names = ["wf-sprout-celebrate", "wf-sprout-celebrate-hair", "wf-sprout-shadow"];
      const celebrations = animations.filter((animation) =>
        names.includes((animation as CSSAnimation).animationName),
      );
      requireCheck(celebrations.length === 3, "Missing celebration layers");
      const delays = new Set(celebrations.map((animation) => animation.effect!.getTiming().delay));
      requireCheck(delays.size === 1, "Celebration layers lost synchronization");
      for (const animation of celebrations) {
        const timing = animation.effect!.getTiming();
        requireCheck(
          timing.duration === 3600 && timing.iterations === Infinity,
          "Completed avatar must keep hopping",
        );
      }
    }
    const gap = minimumHaloGap(svg);
    requireCheck(gap >= 4, `${state}: halo gap ${gap} units`);
    for (const pill of card.querySelectorAll<HTMLElement>('[data-testid="workflow-agent-pill"]')) {
      const avatar = query<SVGSVGElement>(
        pill,
        "svg[data-subagent-avatar]",
      ).getBoundingClientRect();
      const expected = pill.dataset.pillSize === "row" ? 24 : 32;
      requireCheck(
        avatar.height === expected &&
          avatar.width === expected &&
          pill.getBoundingClientRect().height === expected,
        `${state}: pill size drift`,
      );
      const tail = pill.querySelector('[data-testid="workflow-pill-tail"]');
      if (tail)
        requireCheck(
          tail.getBoundingClientRect().left > avatar.right,
          `${state}: status covers avatar`,
        );
    }
    results.push({
      state,
      faceContrast: +faceContrast.toFixed(2),
      rimContrast: +rimContrast.toFixed(2),
      haloGapAt32px: +(gap / 4).toFixed(2),
    });
  }
  const deck = query<HTMLElement>(document, '[data-testid="workflow-more-deck"]');
  const halos = [...deck.querySelectorAll(".wf-sprout-halo-track")].map((halo) =>
    halo.getBoundingClientRect(),
  );
  for (let i = 1; i < halos.length; i++)
    requireCheck(halos[i]!.left > halos[i - 1]!.right, "Neighbour halos overlap");
  const narrow = query<HTMLElement>(document, '[data-testid="avatar-switch-target"]');
  requireCheck(
    query(narrow, "button").getBoundingClientRect().width <= narrow.getBoundingClientRect().width,
    "Narrow pill overflows",
  );
  const main = query<HTMLElement>(document, "main");
  requireCheck(main.scrollWidth <= main.clientWidth, "Horizontal overflow");
  const ids = [
    ...document.querySelectorAll<SVGLinearGradientElement>(
      "svg[data-subagent-avatar] linearGradient",
    ),
  ].map((gradient) => gradient.id);
  requireCheck(new Set(ids).size === ids.length, "Duplicate halo gradient IDs");
  return { theme: document.documentElement.className, width: innerWidth, results };
}

export function checkReducedAvatarMotion() {
  const saved: { media: MediaList; text: string }[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion")) {
        saved.push({ media: rule.media, text: rule.media.mediaText });
        rule.media.mediaText = rule.conditionText.includes("no-preference") ? "not all" : "all";
      }
      if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  try {
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    requireCheck(saved.length > 0, "No real reduced-motion media rules found");
    const avatars = [...document.querySelectorAll<SVGSVGElement>("svg[data-subagent-avatar]")];
    for (const avatar of avatars) {
      requireCheck(getComputedStyle(avatar).display !== "none", "Reduced motion hid avatar");
      requireCheck(
        avatar.getAnimations({ subtree: true }).length === 0,
        "Reduced-motion avatar still moves",
      );
      requireCheck(avatar.querySelector("[data-avatar-halo]"), "Reduced motion removed halo");
    }
    return { avatars: avatars.length, animations: 0, staticHalos: avatars.length };
  } finally {
    for (const { media, text } of saved) media.mediaText = text;
  }
}
