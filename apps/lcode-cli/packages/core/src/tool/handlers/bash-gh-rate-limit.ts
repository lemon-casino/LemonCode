const GH_RATE_LIMIT_HINT_COOLDOWN_MS = 60_000;
const GH_COMMAND_RE =
  /(?:^|[;&|]|\b(?:then|do)\b)\s*gh\s+(?!auth\b|help\b|version\b|alias\b|completion\b|config\b)/;
const GH_RATE_LIMIT_RE =
  /API rate limit (?:already )?exceeded|exceeded a secondary rate limit|\bRATE_LIMITED\b/i;
const GH_RATE_LIMIT_HINT =
  "<system-reminder>GitHub API rate limit exceeded (5,000/hr shared across all tools and agents). Run `gh api rate_limit --jq .resources` and sleep until reset before further gh calls. If polling in a loop, use ScheduleWakeup instead of retrying.</system-reminder>";
let nextGhRateLimitHintAt = 0;

export function getGhRateLimitHint(command: string, output: string): string | undefined {
  if (!GH_COMMAND_RE.test(command) || !GH_RATE_LIMIT_RE.test(output)) return undefined;
  const now = Date.now();
  if (now < nextGhRateLimitHintAt) return undefined;
  nextGhRateLimitHintAt = now + GH_RATE_LIMIT_HINT_COOLDOWN_MS;
  return GH_RATE_LIMIT_HINT;
}
