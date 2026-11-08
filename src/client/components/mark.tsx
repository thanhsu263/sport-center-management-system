import { cn } from "@/lib/cn";

export function ArenaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-fg" />
      <rect x="7" y="7" width="18" height="18" fill="none" className="stroke-bg" strokeWidth="1.7" />
      <line x1="16" y1="7" x2="16" y2="25" className="stroke-bg" strokeWidth="1.7" />
      <rect x="7" y="15.1" width="18" height="1.8" className="fill-accent" />
    </svg>
  );
}

/**
 * The mark for the in-app assistant.
 *
 * A plain speech bubble was doing this job — the same glyph every chat widget
 * on the internet uses, and one that says nothing about what this particular
 * assistant knows. It also sat in the header and in the Quick actions grid at
 * once, so the member met the same anonymous bubble twice.
 *
 * This is the court the Arena3 mark is built from, with a spark over the corner
 * it leaves open: the assistant answers out of the centre's own timetable and
 * prices, and the icon should say which centre. Drawn to lucide's geometry —
 * 24px box, 1.75 stroke, round joins — so it sits in a row of lucide icons
 * without looking pasted in.
 */
export function AssistantMark({
  className,
  strokeWidth = 1.75,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-6", className)}
      aria-hidden
    >
      <path d="M13.5 5H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-7" />
      <path d="M4 12h15" />
      <path d="M18.6 2l.85 1.9 1.9.85-1.9.85-.85 1.9-.85-1.9-1.9-.85 1.9-.85z" />
    </svg>
  );
}

export function CourtBackdrop({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 280" className={cn("text-accent", className)} aria-hidden>
      <rect x="18" y="12" width="164" height="256" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <line x1="100" y1="12" x2="100" y2="268" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <rect x="18" y="132" width="164" height="16" fill="currentColor" opacity="0.28" />
      <rect x="40" y="12" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      <rect x="112" y="12" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      <rect x="40" y="188" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      <rect x="112" y="188" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
    </svg>
  );
}
