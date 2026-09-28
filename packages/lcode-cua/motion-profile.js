const DEFAULT_SEGMENT_PIXELS = 80;
const DEFAULT_MAX_SEGMENTS = 24;

function point(value, name) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((coordinate) => Number.isFinite(coordinate))
  ) {
    throw new TypeError(`${name} must be a finite [x, y] point`);
  }
  return [Math.round(value[0]), Math.round(value[1])];
}

/** Deterministic, bounded cursor path. No coordinates are logged or persisted here. */
export function createMotionPath(fromValue, toValue, options = {}) {
  const from = point(fromValue, "from");
  const to = point(toValue, "to");
  const profile = options.profile ?? "instant";
  if (profile !== "instant" && profile !== "smooth") {
    throw new TypeError("motion profile must be instant or smooth");
  }
  if (profile === "instant" || (from[0] === to[0] && from[1] === to[1])) return [to];

  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const segmentPixels = options.segmentPixels ?? DEFAULT_SEGMENT_PIXELS;
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 2 || maxSegments > 120) {
    throw new TypeError("maxSegments must be an integer between 2 and 120");
  }
  if (!Number.isFinite(segmentPixels) || segmentPixels <= 0) {
    throw new TypeError("segmentPixels must be positive");
  }

  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const segments = Math.min(maxSegments, Math.max(2, Math.ceil(distance / segmentPixels)));
  const result = [];
  for (let index = 1; index <= segments; index += 1) {
    const t = index / segments;
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const next = [
      Math.round(from[0] + (to[0] - from[0]) * eased),
      Math.round(from[1] + (to[1] - from[1]) * eased),
    ];
    const previous = result.at(-1);
    if (!previous || previous[0] !== next[0] || previous[1] !== next[1]) result.push(next);
  }
  const last = result.at(-1);
  if (!last || last[0] !== to[0] || last[1] !== to[1]) result.push(to);
  return result;
}

export async function executeMotionPath(driver, from, to, options = {}) {
  if (!driver || typeof driver.moveTo !== "function") {
    throw new TypeError("motion driver must provide moveTo(point)");
  }
  const path = createMotionPath(from, to, options);
  const durationMs = options.durationMs ?? 0;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = durationMs > 0 && path.length > 1 ? durationMs / path.length : 0;
  for (const current of path) {
    await driver.moveTo(current);
    if (delayMs > 0 && current !== path.at(-1)) await sleep(delayMs);
  }
  return { pointCount: path.length };
}
