import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Sport-centre line icons: same 24px grid and 1.75 stroke as lucide, drawn for things lucide lacks. */
export type ArenaIconName =
  | "basketball"
  | "bottle"
  | "calendar-court"
  | "clipboard-check"
  | "court"
  | "medal"
  | "qr-pass"
  | "racket"
  | "shuttlecock"
  | "turnstile"
  | "volleyball"
  | "whistle";

const PATHS: Record<ArenaIconName, ReactNode> = {
  basketball: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 3.75v16.5" />
      <path d="M3.75 12h16.5" />
      <path d="M6.7 5.4c-2.1 2.4-2.1 10.8 0 13.2" />
      <path d="M17.3 5.4c2.1 2.4 2.1 10.8 0 13.2" />
    </>
  ),
  bottle: (
    <>
      <path d="M9.5 2.6h5" />
      <path d="M10 2.6v2.3c0 .55-.55 1.05-1.35 1.7C7.3 7.7 6.5 9 6.5 10.8V18a2.15 2.15 0 0 0 2.15 2.15h6.7A2.15 2.15 0 0 0 17.5 18v-7.2c0-1.8-.8-3.1-2.15-4.2-.8-.65-1.35-1.15-1.35-1.7V2.6" />
      <path d="M6.7 12.6h10.6" />
    </>
  ),
  "calendar-court": (
    <>
      <rect x="3.25" y="4.5" width="17.5" height="16.25" rx="2" />
      <path d="M3.25 9h17.5" />
      <path d="M8 2.75V6" />
      <path d="M16 2.75V6" />
      <rect x="7.2" y="11.5" width="9.6" height="6.4" rx=".45" />
      <path d="M7.2 14.7h9.6" />
      <path d="M12 11.5v6.4" />
    </>
  ),
  "clipboard-check": (
    <>
      <rect x="6.25" y="4.25" width="11.5" height="16.5" rx="1.6" />
      <path d="M9.25 4.25v-.15A1.6 1.6 0 0 1 10.85 2.5h2.3a1.6 1.6 0 0 1 1.6 1.6v.15" />
      <path d="M8.8 12.7 11.1 15l4.3-4.6" />
    </>
  ),
  court: (
    <>
      <rect x="4" y="2.75" width="16" height="18.5" rx="1" />
      <path d="M4 12h16" />
      <path d="M8.25 2.75v18.5" />
      <path d="M15.75 2.75v18.5" />
      <path d="M8.25 7.2h7.5" />
      <path d="M8.25 16.8h7.5" />
      <path d="M12 7.2v9.6" />
    </>
  ),
  medal: (
    <>
      <path d="M8 3.2 12 9.6 16 3.2" />
      <path d="M9.2 3.2h5.6" />
      <circle cx="12" cy="15.5" r="5.15" />
      <path d="m12 12.9.7 1.45 1.6.2-1.18 1.1.3 1.6L12 16.5l-1.42.75.3-1.6-1.18-1.1 1.6-.2z" />
    </>
  ),
  "qr-pass": (
    <>
      <rect x="2.75" y="5" width="18.5" height="14" rx="2" />
      <rect x="5" y="7.4" width="3.6" height="3.6" rx=".3" />
      <rect x="6.15" y="8.55" width="1.3" height="1.3" />
      <rect x="10.2" y="7.4" width="3.6" height="3.6" rx=".3" />
      <rect x="11.35" y="8.55" width="1.3" height="1.3" />
      <rect x="5" y="12.6" width="3.6" height="3.6" rx=".3" />
      <rect x="6.15" y="13.75" width="1.3" height="1.3" />
      <path d="M10.4 13h1.3M12.6 13h1.2M10.4 15.2h2.2M13.2 15.2H14" />
      <path d="M16.2 8.2h2.6M16.2 11h2.6M16.2 14.4h2.2" />
    </>
  ),
  racket: (
    <>
      <ellipse cx="12" cy="8.4" rx="5.5" ry="6.15" />
      <path d="M12 2.5v11.6" />
      <path d="M7.3 6.4h9.4" />
      <path d="M7 8.8h10" />
      <path d="M7.3 11.2h9.4" />
      <path d="M10.5 14.3 9.8 20.2a1.1 1.1 0 0 0 1.1 1.3h2.2a1.1 1.1 0 0 0 1.1-1.3l-.7-5.9" />
    </>
  ),
  shuttlecock: (
    <>
      <path d="M8.2 15.2 5.6 6.4" />
      <path d="M10.4 15.8 9.2 4.8" />
      <path d="M12.2 16.1V4" />
      <path d="M14 15.8 15.2 4.8" />
      <path d="M16.2 15.2 18.8 6.4" />
      <path d="M6.2 9.2c1.8-1.1 3.8-1.6 6-1.6s4.2.5 6 1.6" />
      <path d="M7.2 12.2c1.6-.8 3.2-1.2 5-1.2s3.4.4 5 1.2" />
      <path d="M9.1 16.4c.3 2.2 1.5 3.6 3.1 3.6s2.8-1.4 3.1-3.6c-1 .5-2 .7-3.1.7s-2.1-.2-3.1-.7z" />
    </>
  ),
  turnstile: (
    <>
      <path d="M4.5 20.5h15" />
      <path d="M7 20.5V4" />
      <path d="M17 20.5V4" />
      <path d="M7 8h10" />
      <circle cx="12" cy="14.2" r="1.35" />
      <path d="M12 14.2 8.5 17.8" />
      <path d="M12 14.2 15.5 17.8" />
      <path d="M12 14.2V10.2" />
    </>
  ),
  volleyball: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 3.75c2.4 2.6 3.5 5.4 3.5 8.25S14.4 17.7 12 20.25" />
      <path d="M4.3 8.6c2.8 1.5 5.6 1.7 8.2.4" />
      <path d="M12.2 11.2c2.2-.2 4.6.4 7.1 1.8" />
      <path d="M6.1 16.8c2-2.2 4.2-3.2 6.6-3" />
    </>
  ),
  whistle: (
    <>
      <circle cx="14.4" cy="13.6" r="5" />
      <path d="M9.6 12.2H3.2v3h6.6" />
      <circle cx="14.4" cy="13.6" r="1.25" />
      <path d="M12.8 9.2 11.4 5.8h3.4" />
    </>
  ),
};

export type IconMotion = "bounce" | "wiggle" | "swing" | "float" | "pop";

export function ArenaIcon({
  name,
  className,
  motion,
}: {
  name: ArenaIconName;
  className?: string;
  motion?: IconMotion;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("size-5 shrink-0", motion && `ai-${motion}`, className)}
    >
      {PATHS[name]}
    </svg>
  );
}

export function SportIcon({
  sport,
  className,
  motion,
}: {
  sport: string;
  className?: string;
  motion?: IconMotion;
}) {
  const name: ArenaIconName =
    sport === "basketball" ? "basketball" : sport === "volleyball" ? "volleyball" : "shuttlecock";
  return <ArenaIcon name={name} className={className} motion={motion} />;
}

/** A ring and a tick that draw themselves — the "saved" moment. */
export function CheckDraw({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("size-5 shrink-0", className)}
    >
      <circle cx="12" cy="12" r="9" pathLength={1} className="ai-draw" />
      <path d="M7.8 12.4l3 3 5.6-6.2" pathLength={1} className="ai-draw [animation-delay:0.35s]" />
    </svg>
  );
}

/** A scanner line sweeping over its parent (which must be position: relative). */
export function ScanLine() {
  return <span aria-hidden className="ai-scan" />;
}
