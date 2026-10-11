import type { ProviderUsageActivity, ProviderUsageSnapshot } from "@lcode/shared";

export const USAGE_DAY_MS = 86_400_000;
const MAX_DAILY_POINTS = 366;
type Day = ProviderUsageSnapshot["daily"][number];
const index = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / USAGE_DAY_MS);

/** 自然日已由IANA时区映射；这里只对日期标签计连续，不能使用固定时区偏移穿越DST。 */
export function providerUsageActivity(
  days: readonly Day[],
  today: string,
  longestSessionMs: number | null,
  dailyTruncated: boolean,
): ProviderUsageActivity {
  const active = days
    .filter((day) => day.totalTokens > 0)
    .map((day) => index(day.date))
    .sort((a, b) => a - b);
  const activeSet = new Set(active);
  let currentStreakDays = 0;
  for (let day = index(today); activeSet.has(day); day--) currentStreakDays++;
  let longestStreakDays = 0;
  let streak = 0;
  let previous: number | undefined;
  for (const day of active) {
    streak = previous === day - 1 ? streak + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, streak);
    previous = day;
  }
  return {
    peakDayTokens: days.reduce((peak, day) => Math.max(peak, day.totalTokens), 0),
    longestSessionMs,
    currentStreakDays,
    longestStreakDays,
    activeDays: active.length,
    dailyTruncated,
  };
}

/** 累计仍包含所有保留记录，趋势只补齐有界日期窗口，不从Unix epoch制造数十年的零格。 */
export function providerUsageCalendar(
  days: readonly Day[],
  since: string,
  until: string,
  empty: () => Omit<Day, "date">,
) {
  const first = index(since);
  const last = index(until);
  const start = Math.max(first, last - MAX_DAILY_POINTS + 1);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const daily: Day[] = [];
  for (let day = start; day <= last; day++) {
    const date = new Date(day * USAGE_DAY_MS).toISOString().slice(0, 10);
    daily.push(byDate.get(date) ?? { date, ...empty() });
  }
  return { daily, truncated: start > first };
}
