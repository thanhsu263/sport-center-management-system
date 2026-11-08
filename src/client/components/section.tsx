import {
  Bell,
  BookOpenCheck,
  Building2,
  CalendarClock,
  ClipboardCheck,
  DoorOpen,
  Dumbbell,
  History,
  Inbox,
  Landmark,
  type LucideIcon,
  Map,
  MessageSquareText,
  NotebookPen,
  Receipt,
  ScrollText,
  StickyNote,
  Ticket,
  ToggleRight,
  TrendingUp,
  Undo2,
  UserPlus,
  Wallet,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { t, tk } from "@/lib/i18n";

/**
 * Every section heading gets a small icon and, where the screen does not already explain the
 * section in a paragraph of its own, one plain line saying what is in it. Looked up by title so
 * the ~40 headings across the app stay consistent without each one restating its copy.
 * The keys are the English titles (what callers pass); the text shown is translated at render.
 */
const META: Record<string, { icon: LucideIcon; hint?: string }> = {
  "Quick actions": { icon: Zap, hint: tk("Shortcuts to the things you do most.") },
  Notifications: { icon: Bell, hint: tk("Latest receipts, booking changes and replies from reception.") },
  "Up next": { icon: CalendarClock, hint: tk("Your coming sessions, with the plan for each.") },
  Homework: { icon: BookOpenCheck },
  "Coach reviews": { icon: MessageSquareText, hint: tk("Written feedback your coach left for you.") },
  "Recent sessions": { icon: History, hint: tk("The sessions attended most recently.") },
  Level: { icon: TrendingUp, hint: tk("Where this student is now, per sport.") },
  "Progress review": { icon: ClipboardCheck },
  "Coach notes": { icon: StickyNote },
  "Through the gate today": { icon: DoorOpen, hint: tk("Everyone who has checked in today.") },
  "Out on loan": { icon: Dumbbell, hint: tk("Gear that is out right now. Returning it puts the stock back.") },
  "New member": { icon: UserPlus },
  "Requests from the app": { icon: Inbox, hint: tk("Messages members sent from the app that are waiting for an answer.") },
  "Sell another plan": { icon: Ticket, hint: tk("Pick a plan to add to this member's account.") },
  Payments: { icon: Wallet },
  Today: { icon: CalendarClock, hint: tk("Courts this member has booked for today.") },
  "Transfers to check": { icon: Landmark },
  "Waiting for payment": { icon: Wallet },
  "Refunds waiting for a manager": { icon: Undo2 },
  Receipts: { icon: Receipt },
  Activity: { icon: ScrollText, hint: tk("Every change made by staff: what, who and when.") },
  Features: { icon: ToggleRight, hint: tk("Switch parts of the app on or off for the whole centre.") },
  Courts: { icon: Map },
  "Centre details": { icon: Building2, hint: tk("The centre's legal name, address and tax code.") },
  Results: { icon: ClipboardCheck },
  "Session plan": { icon: NotebookPen },
};

/** META is keyed by the English title; a caller that already translated it still finds its entry. */
function metaFor(text: string) {
  if (META[text]) return META[text];
  const en = Object.keys(META).find((k) => t(k) === text);
  return en ? META[en] : undefined;
}

export function SectionTitle({
  text,
  className,
  icon,
  hint,
  id,
}: {
  id?: string;
  text: string;
  className?: string;
  icon?: LucideIcon;
  hint?: string;
}) {
  const meta = metaFor(text);
  const Icon = icon ?? meta?.icon;
  const line = hint ?? meta?.hint;
  return (
    <div className={cn("flex items-center gap-3 font-display text-2xl", className)}>
      {Icon ? (
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-accent/10 text-accent-2"
        >
          <Icon className="size-5" strokeWidth={1.8} />
        </span>
      ) : null}
      <div className="min-w-0">
        <h2 id={id} className="text-balance">
          {t(text)}
        </h2>
        {line ? <p className="mt-0.5 font-sans text-sm font-normal text-muted">{t(line)}</p> : null}
      </div>
    </div>
  );
}

/** Title for a card or chart: icon, a readable name and one line on what it shows. */
export function CardTitle({
  icon: Icon,
  title,
  hint,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-accent/10 text-accent-2"
      >
        <Icon className="size-4" strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-tight">{t(title)}</p>
        {hint ? <p className="mt-0.5 text-xs leading-snug text-muted">{t(hint)}</p> : null}
      </div>
    </div>
  );
}
