import { addDays, ictDateString, ictDateTime, ictWeekday } from "./time";

const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/** Subset: FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18 */
export function expandWeekly(
  rrule: string,
  durationMin: number,
  from: Date,
  until: Date,
): { start: Date; end: Date }[] {
  const parts = Object.fromEntries(
    rrule.split(";").map((p) => {
      const [k, v] = p.split("=");
      return [k ?? "", v ?? ""];
    }),
  );
  if ((parts.FREQ ?? "WEEKLY") !== "WEEKLY") return [];
  const days = (parts.BYDAY ?? "")
    .split(",")
    .map((d) => DAY_MAP[d.trim()])
    .filter((n): n is number => n !== undefined);
  const hour = Number(parts.BYHOUR ?? 18);
  const out: { start: Date; end: Date }[] = [];
  let cursor = ictDateString(from);
  const endDate = ictDateString(until);
  while (cursor <= endDate) {
    const dt = ictDateTime(cursor, `${String(hour).padStart(2, "0")}:00`);
    const wd = ictWeekday(dt);
    if (days.includes(wd) && dt >= from && dt < until) {
      out.push({ start: dt, end: new Date(dt.getTime() + durationMin * 60_000) });
    }
    cursor = addDays(cursor, 1);
  }
  return out;
}
