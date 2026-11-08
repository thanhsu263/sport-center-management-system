import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Spot illustrations: one small flat picture per kind of screen, drawn in the app's own
 * palette so a page says what it is for before a word of it is read. Plain SVG, no assets.
 */
export type SpotName =
  | "court"
  | "people"
  | "desk"
  | "profile"
  | "gate"
  | "receipt"
  | "calendar"
  | "chart"
  | "clipboard"
  | "tag"
  | "risk"
  | "gear"
  | "plans"
  | "bell"
  | "search"
  | "shield"
  | "settings"
  | "whistle"
  | "wallet"
  | "chat"
  | "empty";

const G = "var(--color-accent)";
const G2 = "var(--color-accent-2)";
const AMBER = "#f5a30a";
const INK = "var(--color-ink)";
const PAPER = "var(--color-surface)";
const WOOD = "var(--color-wood)";
const LINE = "var(--color-line-strong)";

const ART: Record<SpotName, ReactNode> = {
  court: (
    <>
      <rect x="22" y="26" width="76" height="46" rx="5" fill={G} />
      <g fill="none" stroke={PAPER} strokeWidth="1.6">
        <rect x="28" y="31" width="64" height="36" />
        <line x1="60" y1="31" x2="60" y2="67" />
        <line x1="28" y1="49" x2="92" y2="49" strokeDasharray="2 3" />
        <rect x="44" y="31" width="32" height="36" />
      </g>
      <circle cx="84" cy="24" r="7" fill={AMBER} />
      <path d="M79 21c3 1 6 1 10 0M79 27c3-1 6-1 10 0" stroke={PAPER} strokeWidth="1" fill="none" />
    </>
  ),
  people: (
    <>
      <circle cx="60" cy="34" r="11" fill={G} />
      <path d="M38 74c0-13 10-21 22-21s22 8 22 21z" fill={G} />
      <circle cx="32" cy="42" r="8" fill={AMBER} />
      <path d="M17 74c0-10 7-16 15-16 4 0 7 1 9 3-4 4-6 8-6 13z" fill={AMBER} />
      <circle cx="90" cy="42" r="8" fill={G2} />
      <path d="M103 74c0-10-7-16-15-16-4 0-7 1-9 3 4 4 6 8 6 13z" fill={G2} />
    </>
  ),
  desk: (
    <>
      <rect x="20" y="52" width="80" height="26" rx="5" fill={G} />
      <rect x="20" y="48" width="80" height="8" rx="4" fill={G2} />
      <circle cx="42" cy="26" r="9" fill={AMBER} />
      <path d="M26 48c0-11 7-17 16-17s16 6 16 17z" fill={AMBER} />
      <rect x="68" y="30" width="26" height="18" rx="3" fill={INK} />
      <rect x="71" y="33" width="20" height="12" rx="1.500" fill={PAPER} />
      <path d="M74 39h8M74 42h12" stroke={LINE} strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="45" r="3.500" fill={PAPER} stroke={INK} strokeWidth="1.500" />
    </>
  ),
  profile: (
    <>
      <rect x="22" y="22" width="76" height="52" rx="8" fill={PAPER} stroke={LINE} strokeWidth="1.500" />
      <circle cx="46" cy="44" r="9" fill={G} />
      <path d="M32 66c0-9 6-14 14-14s14 5 14 14z" fill={G} />
      <g stroke={LINE} strokeWidth="3" strokeLinecap="round">
        <line x1="68" y1="38" x2="88" y2="38" />
        <line x1="68" y1="48" x2="84" y2="48" />
      </g>
      <line x1="68" y1="58" x2="80" y2="58" stroke={AMBER} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  gate: (
    <>
      <rect x="40" y="14" width="40" height="68" rx="7" fill={INK} />
      <rect x="45" y="22" width="30" height="48" rx="3" fill={PAPER} />
      <g fill={INK}>
        <rect x="50" y="27" width="8" height="8" />
        <rect x="62" y="27" width="8" height="8" />
        <rect x="50" y="39" width="8" height="8" />
        <rect x="63" y="41" width="3" height="3" />
        <rect x="67" y="45" width="3" height="3" />
        <rect x="50" y="52" width="20" height="3" />
      </g>
      <circle cx="84" cy="64" r="13" fill={G} />
      <path d="M77.500 64l5 5 9-10" stroke={PAPER} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  receipt: (
    <>
      <path d="M32 14h48v68l-6-4-6 4-6-4-6 4-6-4-6 4-6-4-6 4z" fill={PAPER} stroke={LINE} strokeWidth="1.5" />
      <g stroke={LINE} strokeWidth="2.500" strokeLinecap="round">
        <line x1="40" y1="28" x2="72" y2="28" />
        <line x1="40" y1="38" x2="64" y2="38" />
        <line x1="40" y1="48" x2="70" y2="48" />
      </g>
      <line x1="40" y1="60" x2="72" y2="60" stroke={INK} strokeWidth="2.500" strokeLinecap="round" />
      <circle cx="88" cy="62" r="15" fill={AMBER} />
      <circle cx="88" cy="62" r="10" fill="none" stroke={PAPER} strokeWidth="2" />
      <path d="M83 62h10M88 55v14" stroke={PAPER} strokeWidth="2.500" strokeLinecap="round" />
    </>
  ),
  calendar: (
    <>
      <rect x="24" y="20" width="72" height="60" rx="7" fill={PAPER} stroke={LINE} strokeWidth="1.5" />
      <path d="M24 27a7 7 0 0 1 7-7h58a7 7 0 0 1 7 7v10H24z" fill={G} />
      <rect x="38" y="13" width="5" height="14" rx="2.500" fill={INK} />
      <rect x="77" y="13" width="5" height="14" rx="2.500" fill={INK} />
      <g fill={WOOD}>
        {[0, 1, 2, 3, 4].map((c) =>
          [0, 1].map((r) => <rect key={`${c}${r}`} x={32 + c * 12.5} y={44 + r * 14} width="9" height="9" rx="2" />),
        )}
      </g>
      <rect x="69.500" y="58" width="9" height="9" rx="2" fill={AMBER} />
    </>
  ),
  chart: (
    <>
      <rect x="22" y="18" width="76" height="60" rx="7" fill={PAPER} stroke={LINE} strokeWidth="1.5" />
      <g fill={G}>
        <rect x="32" y="52" width="10" height="18" rx="2" />
        <rect x="47" y="42" width="10" height="28" rx="2" />
        <rect x="62" y="48" width="10" height="22" rx="2" />
        <rect x="77" y="32" width="10" height="38" rx="2" fill={AMBER} />
      </g>
      <path d="M30 40l18-10 14 6 24-16" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  clipboard: (
    <>
      <rect x="30" y="18" width="60" height="64" rx="7" fill={PAPER} stroke={LINE} strokeWidth="1.5" />
      <rect x="46" y="12" width="28" height="12" rx="4" fill={INK} />
      <g strokeLinecap="round" strokeLinejoin="round" fill="none" strokeWidth="3">
        <path d="M40 40l4 4 7-8" stroke={G} />
        <path d="M40 56l4 4 7-8" stroke={G} />
        <path d="M40 72l4 4 7-8" stroke={AMBER} />
      </g>
      <g stroke={LINE} strokeWidth="3" strokeLinecap="round">
        <line x1="58" y1="41" x2="80" y2="41" />
        <line x1="58" y1="57" x2="76" y2="57" />
        <line x1="58" y1="73" x2="80" y2="73" />
      </g>
    </>
  ),
  tag: (
    <>
      <path d="M26 46L52 20h36a6 6 0 0 1 6 6v36L68 88a6 6 0 0 1-8.500 0L26 54a6 6 0 0 1 0-8z" transform="translate(0 -6)" fill={G} />
      <circle cx="78" cy="30" r="5" fill={PAPER} />
      <text x="58" y="60" textAnchor="middle" fontSize="20" fontWeight="700" fill={PAPER} transform="rotate(-45 58 56)">
        %
      </text>
      <path d="M84 24c8-10 16-8 16 0" stroke={INK} strokeWidth="1.500" fill="none" />
    </>
  ),
  risk: (
    <>
      <circle cx="46" cy="34" r="12" fill={G} opacity="0.35" />
      <path d="M22 78c0-14 11-23 24-23s24 9 24 23z" fill={G} opacity="0.35" />
      <circle cx="46" cy="34" r="12" fill="none" stroke={G} strokeWidth="2" strokeDasharray="3 3" />
      <rect x="72" y="22" width="30" height="40" rx="6" fill={INK} />
      <rect x="76" y="28" width="22" height="26" rx="2" fill={PAPER} />
      <path d="M82 36c0-2 1-3 3-3h1l2 4-2 2c1 3 3 5 6 6l2-2 4 2v1c0 2-1 3-3 3-8 0-13-5-13-13z" fill={AMBER} />
    </>
  ),
  gear: (
    <>
      <g transform="rotate(-35 50 46)">
        <ellipse cx="50" cy="34" rx="18" ry="22" fill="none" stroke={G} strokeWidth="5" />
        <g stroke={G} strokeWidth="1.200" opacity="0.7">
          <line x1="50" y1="14" x2="50" y2="54" />
          <line x1="36" y1="24" x2="64" y2="24" />
          <line x1="33" y1="34" x2="67" y2="34" />
          <line x1="36" y1="44" x2="64" y2="44" />
        </g>
        <rect x="46.500" y="56" width="7" height="26" rx="3" fill={INK} />
      </g>
      <circle cx="88" cy="64" r="11" fill={AMBER} />
      <path d="M81 60c4 3 10 3 14 0M81 68c4-3 10-3 14 0" stroke={PAPER} strokeWidth="1.500" fill="none" />
    </>
  ),
  plans: (
    <>
      <path d="M20 30h80v12a6 6 0 0 0 0 12v12H20V54a6 6 0 0 0 0-12z" fill={G} />
      <line x1="76" y1="30" x2="76" y2="66" stroke={PAPER} strokeWidth="2" strokeDasharray="3 3" />
      <g stroke={PAPER} strokeWidth="3" strokeLinecap="round">
        <line x1="32" y1="43" x2="62" y2="43" />
        <line x1="32" y1="53" x2="52" y2="53" />
      </g>
      <circle cx="88" cy="48" r="6" fill={AMBER} />
    </>
  ),
  bell: (
    <>
      <path d="M60 18c-14 0-22 10-22 24v14l-8 10h60l-8-10V42c0-14-8-24-22-24z" fill={G} />
      <circle cx="60" cy="76" r="7" fill={INK} />
      <circle cx="60" cy="16" r="4" fill={INK} />
      <circle cx="84" cy="26" r="9" fill={AMBER} />
    </>
  ),
  search: (
    <>
      <rect x="20" y="20" width="62" height="14" rx="4" fill={PAPER} stroke={LINE} strokeWidth="1.500" />
      <rect x="20" y="40" width="62" height="14" rx="4" fill={PAPER} stroke={LINE} strokeWidth="1.500" />
      <rect x="20" y="60" width="62" height="14" rx="4" fill={PAPER} stroke={LINE} strokeWidth="1.500" />
      <circle cx="76" cy="46" r="14" fill={PAPER} stroke={G} strokeWidth="5" />
      <line x1="86" y1="56" x2="98" y2="70" stroke={G} strokeWidth="6" strokeLinecap="round" />
    </>
  ),
  shield: (
    <>
      <path d="M60 14l30 10v22c0 20-13 32-30 38C43 78 30 66 30 46V24z" fill={G} />
      <path d="M46 48l10 10 18-20" stroke={PAPER} strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  settings: (
    <>
      <g stroke={LINE} strokeWidth="5" strokeLinecap="round">
        <line x1="26" y1="30" x2="94" y2="30" />
        <line x1="26" y1="48" x2="94" y2="48" />
        <line x1="26" y1="66" x2="94" y2="66" />
      </g>
      <circle cx="44" cy="30" r="9" fill={G} />
      <circle cx="72" cy="48" r="9" fill={AMBER} />
      <circle cx="54" cy="66" r="9" fill={G2} />
    </>
  ),
  whistle: (
    <>
      <circle cx="46" cy="52" r="22" fill={G} />
      <circle cx="46" cy="52" r="8" fill={PAPER} />
      <path d="M62 36l34-4v14l-30 6z" fill={G2} />
      <circle cx="46" cy="24" r="4" fill="none" stroke={INK} strokeWidth="2.500" />
      <path d="M92 24l8-6M96 32l10-2" stroke={AMBER} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  wallet: (
    <>
      <rect x="22" y="28" width="76" height="50" rx="8" fill={G} />
      <rect x="22" y="22" width="60" height="16" rx="5" fill={G2} />
      <rect x="68" y="46" width="34" height="18" rx="9" fill={PAPER} />
      <circle cx="79" cy="55" r="3.500" fill={AMBER} />
    </>
  ),
  chat: (
    <>
      <path d="M26 24h56a8 8 0 0 1 8 8v26a8 8 0 0 1-8 8H52l-14 12V66h-12a8 8 0 0 1-8-8V32a8 8 0 0 1 8-8z" fill={G} />
      <path d="M58 33l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill={PAPER} />
      <circle cx="94" cy="26" r="6" fill={AMBER} />
    </>
  ),
  empty: (
    <>
      <path d="M22 50l12-22h52l12 22v26a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6z" fill={PAPER} stroke={LINE} strokeWidth="1.500" />
      <path d="M22 50h26a6 6 0 0 1 6 6 6 6 0 0 0 12 0 6 6 0 0 1 6-6h26" fill="none" stroke={LINE} strokeWidth="1.500" />
      <circle cx="60" cy="22" r="4" fill={AMBER} />
      <circle cx="42" cy="16" r="2.500" fill={G} />
      <circle cx="80" cy="14" r="3" fill={G} />
    </>
  ),
};

export function Spot({ name, className }: { name: SpotName; className?: string }) {
  return (
    <svg
      viewBox="0 0 120 96"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <ellipse cx="60" cy="86" rx="38" ry="5" fill={INK} opacity="0.08" />
      <circle cx="60" cy="48" r="40" fill={WOOD} opacity="0.75" />
      {ART[name]}
    </svg>
  );
}

/** Which picture belongs to which screen. Longest matching prefix wins. */
const BY_PATH: [string, SpotName][] = [
  ["/desk/gate", "gate"],
  ["/desk/courts", "court"],
  ["/desk/classes", "calendar"],
  ["/desk/payments", "receipt"],
  ["/desk/at-risk", "risk"],
  ["/desk/gear", "gear"],
  ["/desk/member", "profile"],
  ["/desk", "desk"],
  ["/manager/members", "people"],
  ["/manager/staff", "people"],
  ["/manager/classes", "calendar"],
  ["/manager/plans", "plans"],
  ["/manager/promos", "tag"],
  ["/manager/prices", "wallet"],
  ["/manager/attendance", "clipboard"],
  ["/manager/audit", "shield"],
  ["/manager/settings", "settings"],
  ["/manager", "chart"],
  ["/coach/attendance", "clipboard"],
  ["/coach/student", "people"],
  ["/coach", "whistle"],
  ["/alerts", "bell"],
  ["/app/book", "court"],
  ["/app/classes", "calendar"],
  ["/app/plans", "plans"],
  ["/app/train", "whistle"],
  ["/app/pass", "gate"],
  ["/app/notifications", "bell"],
  ["/app/assistant", "chat"],
  ["/app", "court"],
  ["/account", "profile"],
];

export function spotForPath(pathname: string): SpotName {
  let best: SpotName = "empty";
  let len = -1;
  for (const [p, s] of BY_PATH) {
    if ((pathname === p || pathname.startsWith(`${p}/`)) && p.length > len) {
      best = s;
      len = p.length;
    }
  }
  return best;
}
