import { addDays, ictDateString, ictDateTime, ictWeekday } from "../../shared/arena3/time";

const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

function parseWeeklyRule(rrule: string) {
  return Object.fromEntries(
    rrule.split(";").map((part) => {
      const [key, value] = part.split("=");
      return [key ?? "", value ?? ""];
    }),
  );
}

/** Subset: FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18 */
export function expandWeekly(
  rrule: string,
  durationMin: number,
  from: Date,
  until: Date,
): { start: Date; end: Date }[] {
  const parts = parseWeeklyRule(rrule);
  if ((parts.FREQ ?? "WEEKLY") !== "WEEKLY") return [];
  const days = (parts.BYDAY ?? "")
    .split(",")
    .map((d) => DAY_MAP[d.trim()])
    .filter((n): n is number => n !== undefined);
  const hour = Number(parts.BYHOUR ?? 18);
  const startTime = `${String(hour).padStart(2, "0")}:00`;
  const durationMs = durationMin * 60_000;
  const sessions: { start: Date; end: Date }[] = [];
  let cursor = ictDateString(from);
  const endDate = ictDateString(until);
  while (cursor <= endDate) {
    const start = ictDateTime(cursor, startTime);
    const weekday = ictWeekday(start);
    if (days.includes(weekday) && start >= from && start < until) {
      sessions.push({ start, end: new Date(start.getTime() + durationMs) });
    }
    cursor = addDays(cursor, 1);
  }
  return sessions;
}
