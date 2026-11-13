/**
 * Opening hours and the hold length, as the manager set them (open_time, close_time,
 * hold_minutes in the centre's settings), for copy and grids that used to write "06:00-22:00"
 * and "five minutes" in by hand.
 *
 * Pure functions, no imports: the node test runner checks them directly.
 */

export type Venue = { open: number; close: number; holdMinutes: number };

/** What the centre shipped with; used until the settings arrive, or if they are unreadable. */
export const DEFAULT_VENUE: Venue = { open: 6, close: 22, holdMinutes: 5 };

/** The settings' raw shape: `HH:MM[:SS]` times and a minute count. */
export type VenueRaw = { open_time?: string | null; close_time?: string | null; hold_minutes?: number | null };

function hourOf(time: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 24 ? hour : null;
}

function closingHour(time: string): number | null {
  const hour = hourOf(time);
  if (hour == null) return null;
  const hasPartialHour = /:(?!00)\d{2}/.test(time.slice(time.indexOf(":")));
  return hasPartialHour ? hour + 1 : hour;
}

/**
 * The venue from raw settings, falling back field by field. A close that is not after the open
 * (a typo in the settings) falls back as a pair rather than drawing an empty day.
 */
export function venueFrom(raw?: VenueRaw | null): Venue {
  const open = hourOf(raw?.open_time);
  // A closing time like 21:30 still sells the 21:00 hour, so the close rounds up.
  const close = closingHour(raw?.close_time ?? "");
  const hold = Number(raw?.hold_minutes);
  const pairOk = open != null && close != null && close > open;
  return {
    open: pairOk ? open! : DEFAULT_VENUE.open,
    close: pairOk ? close! : DEFAULT_VENUE.close,
    holdMinutes: Number.isInteger(hold) && hold > 0 ? hold : DEFAULT_VENUE.holdMinutes,
  };
}

/** The bookable hours of the day: open, open + 1, …, close - 1. */
export function hoursOf(venue: Venue): number[] {
  return Array.from({ length: Math.max(0, venue.close - venue.open) }, (_, index) => venue.open + index);
}

/** 6 → "06:00". */
export const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;
