const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Claude prints local clock times; Intl supplies the Windows timezone database too. */
export function claudeQuotaReset(value: string, now: number, span: number): string | undefined {
  const match =
    /^(?:(\w{3}) (\d{1,2})(?:, (\d{4}))?(?: at|,)? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?: \(([^)]+)\))?$/iu.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const [, month, day, year, hour, minute, meridiem, zone] = match;
  const h = Number(hour),
    m = Number(minute ?? 0);
  if (h < 1 || h > 12 || m > 59 || (month && !MONTHS.includes(month.toLowerCase())))
    return undefined;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
  } catch {
    return undefined;
  }
  const local = (ms: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(ms).map((p) => [p.type, p.value]));
    return [
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ] as const;
  };
  const ref = local(now),
    dates: number[] = [];
  if (month) {
    for (const y of year ? [Number(year)] : [ref[0] - 1, ref[0], ref[0] + 1])
      dates.push(
        Date.UTC(
          y,
          MONTHS.indexOf(month.toLowerCase()),
          Number(day),
          (h % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0),
          m,
        ),
      );
  } else {
    for (let offset = -2; offset <= 2; offset++)
      dates.push(
        Date.UTC(
          ref[0],
          ref[1],
          ref[2] + offset,
          (h % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0),
          m,
        ),
      );
  }
  const candidates: number[] = [];
  for (const wall of dates) {
    // Date.UTC 会把不存在的日期进位；不能把 CLI 的无效日期解释成另一天的重置。
    if (month && new Date(wall).getUTCDate() !== Number(day)) continue;
    const offsets = new Set<number>();
    // 两侧各取时区偏移：夏令时回拨同一钟点可对应两个真实时刻，跳过不存在的钟点。
    for (const delta of [-86400000, 0, 86400000]) {
      const probe = wall + delta;
      const p = local(probe);
      offsets.add(Date.UTC(...p) - probe);
    }
    for (const offset of offsets) {
      const candidate = wall - offset;
      const p = local(candidate);
      if (Date.UTC(...p) === wall) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => a - b);
  const chosen = year
    ? candidates[0]
    : (candidates.find((t) => t >= now && t <= now + span + 7200000) ??
      candidates.filter((t) => t < now).at(-1));
  return chosen === undefined ? undefined : new Date(chosen).toISOString();
}
