/**
 * An "Add to Google Calendar" link: Google's own event template, filled in.
 * Nothing is sent from here and no Google account is linked; the member's
 * browser opens Google Calendar with the event ready to save.
 */
export type CalendarEvent = {
  title: string;
  start: string | Date;
  end: string | Date;
  details?: string;
  location?: string;
};

// Google wants UTC in the basic form: 20261029T120000Z.
function utcStamp(at: string | Date): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function googleCalendarUrl(e: CalendarEvent): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${utcStamp(e.start)}/${utcStamp(e.end)}`,
  });
  if (e.details) q.set("details", e.details);
  if (e.location) q.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
