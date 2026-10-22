import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bell,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  DoorOpen,
  Dumbbell,
  Ellipsis,
  FileText,
  HandCoins,
  Image,
  LandPlot,
  LayoutGrid,
  LogOut,
  Map,
  MessageSquare,
  QrCode,
  Repeat,
  Star,
  ScrollText,
  Settings,
  Tag,
  Coins,
  Ticket,
  Trophy,
  UserCog,
  UserMinus,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import { type FocusEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArenaMark, AssistantMark } from "./mark";
import { AnimatePresence, PageIn, motion } from "./motion";
import { GradualBlur } from "./fx";
import { Spot, spotForPath } from "./illustrations";
import { UserAvatar } from "./user-avatar";
import { cn } from "@/lib/cn";
import { useLive } from "@/lib/use-live";
import {
  apiGet,
  apiPost,
  clearSession,
  getStoredUser,
  getToken,
  homeFor,
  onStoredUserChange,
  type SessionUser,
} from "@/lib/arena3/client";
import { roleLabel } from "@/lib/arena3/labels";
import { locale, t, tk } from "@/lib/i18n";
import { ConnectionBanner } from "./connection-banner";
import { LangSwitch } from "./lang-switch";
import { useDialog } from "./ui";

export function useSessionUser(): SessionUser | null {
  const [u, setU] = useState<SessionUser | null>(null);
  useEffect(() => {
    setU(getStoredUser());
    // A profile edit rewrites the cached copy; follow it so the header shows the new name without
    // reloading the page (a reload also threw away the "Saved" the person had just been shown).
    return onStoredUserChange(() => setU(getStoredUser()));
  }, []);
  return u;
}

/**
 * `more` tucks a tab into the "More" menu on a laptop and `dock: false` keeps it out of the
 * phone's bottom bar (it goes in the "More" sheet instead). Eleven tabs in one row ran off the
 * edge of the screen, and seven on a phone were too small to read or hit.
 */
type NavItem = { to: string; label: string; icon: typeof Map; more?: boolean; dock?: boolean; group?: string };

/** Headings for the manager's "More" menu, so sixteen destinations read as three jobs. */
const G_BUSINESS = tk("Sales & pricing");
const G_OPS = tk("Operations");
const G_SYSTEM = tk("System");

const NAV: Record<string, NavItem[]> = {
  member: [
    { to: "/app", label: tk("Schedule"), icon: CalendarDays },
    { to: "/app/book", label: tk("Book"), icon: Map },
    { to: "/app/classes", label: tk("Classes"), icon: Ticket },
    // A phone's bottom bar holds five: the four things a member does on the way to court, then More.
    { to: "/app/train", label: tk("Progress"), icon: Activity, dock: false },
    { to: "/app/plans", label: tk("Plans"), icon: Wallet, dock: false },
    { to: "/app/points", label: tk("Points"), icon: Star, dock: false },
    { to: "/chat", label: tk("Messages"), icon: MessageSquare, dock: false },
    { to: "/app/pass", label: tk("Pass"), icon: QrCode },
  ],
  receptionist: [
    { to: "/desk", label: tk("Desk"), icon: Users },
    { to: "/desk/gate", label: tk("Gate"), icon: DoorOpen },
    // The court map is open all shift long, so it is in the phone's bottom bar.
    { to: "/desk/courts", label: tk("Courts"), icon: Map },
    { to: "/desk/classes", label: tk("Classes"), icon: Ticket, more: true, dock: false },
    { to: "/desk/payments", label: tk("Payments"), icon: Wallet },
    // Setting up a regular booking is a front-desk job done regularly, so
    // it comes before the retention list. The row shows as many tabs as fit, in this order.
    { to: "/desk/series", label: tk("Fixed bookings"), icon: Repeat, dock: false },
    { to: "/desk/at-risk", label: tk("At risk"), icon: UserMinus, dock: false },
    { to: "/chat", label: tk("Messages"), icon: MessageSquare, more: true, dock: false },
    // `/desk/gear` is a complete equipment-hire screen that nothing linked to,
    // so reception could only reach it by typing the URL.
    { to: "/desk/gear", label: tk("Gear"), icon: Dumbbell, more: true, dock: false },
    { to: "/desk/maintenance", label: tk("Maintenance"), icon: Wrench, more: true, dock: false },
  ],
  // The coach had one tab, which `showNav` hides, so the screen had no menu at
  // all (B-10). Schedule, register and profile are three different jobs.
  coach: [
    { to: "/coach", label: tk("Schedule"), icon: CalendarDays },
    { to: "/coach/classes", label: tk("Classes"), icon: Ticket },
    { to: "/coach/attendance", label: tk("Attendance"), icon: ClipboardList },
    { to: "/chat", label: tk("Messages"), icon: MessageSquare },
    { to: "/coach/earnings", label: tk("Earnings"), icon: HandCoins },
    { to: "/account", label: tk("Profile"), icon: UserCog },
  ],
  manager: [
    { to: "/manager", label: tk("Reports"), icon: LayoutGrid },
    { to: "/manager/classes", label: tk("Classes"), icon: Ticket, dock: false },
    { to: "/manager/members", label: tk("Members"), icon: Users },
    { to: "/manager/plans", label: tk("Plans"), icon: Wallet, more: true, dock: false, group: G_BUSINESS },
    { to: "/manager/promos", label: tk("Promos"), icon: Tag, more: true, dock: false, group: G_BUSINESS },
    { to: "/manager/attendance", label: tk("Attendance"), icon: ClipboardList },
    // Refund sign-off lives on the payments screen, which has always taken a
    // manager — nothing in this menu pointed at it (B-02).
    { to: "/desk/payments", label: tk("Payments"), icon: Wallet },
    { to: "/manager/staff", label: tk("Staff"), icon: UserCog, dock: false, group: G_SYSTEM },
    { to: "/chat", label: tk("Messages"), icon: MessageSquare, more: true, dock: false, group: G_OPS },
    { to: "/manager/prices", label: tk("Pricing"), icon: Coins, more: true, dock: false, group: G_BUSINESS },
    { to: "/manager/commission", label: tk("Commission"), icon: HandCoins, more: true, dock: false, group: G_BUSINESS },
    { to: "/manager/invoices", label: tk("E-invoices"), icon: FileText, more: true, dock: false, group: G_BUSINESS },
    { to: "/desk/series", label: tk("Fixed bookings"), icon: Repeat, more: true, dock: false, group: G_OPS },
    { to: "/desk/maintenance", label: tk("Maintenance"), icon: Wrench, more: true, dock: false, group: G_OPS },
    { to: "/manager/courts", label: tk("Courts"), icon: LandPlot, more: true, dock: false, group: G_OPS },
    { to: "/manager/sports", label: tk("Sports"), icon: Trophy, more: true, dock: false, group: G_OPS },
    { to: "/manager/media", label: tk("Media"), icon: Image, more: true, dock: false, group: G_SYSTEM },
    { to: "/manager/audit", label: tk("Audit"), icon: ScrollText, more: true, dock: false, group: G_SYSTEM },
    { to: "/manager/settings", label: tk("Settings"), icon: Settings, more: true, dock: false, group: G_SYSTEM },
  ],
};

function navActive(pathname: string, to: string, items: { to: string }[]) {
  const list = Array.isArray(items) ? items : [];
  // A student's profile is reached from the register, so that is the tab it belongs to.
  if (pathname.startsWith("/coach/student/")) pathname = "/coach/attendance";
  // These have their own header buttons, not tabs; "/app" must not claim them as Schedule.
  if (/^\/(app\/(assistant|notifications)|alerts|chat)(\/|$)/.test(pathname) && to === "/app") return false;
  const matches = list.filter((it) => pathname === it.to || pathname.startsWith(`${it.to}/`));
  const best = [...matches].sort((a, b) => b.to.length - a.to.length)[0];
  return best?.to === to;
}

export function initials(name: string | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A3";
  // Vietnamese names put the given name last, and that is the one people answer
  // to — so take the first and last word rather than the first two.
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * The member's notifications, on their own button beside the account menu
 * (G-08): what is new is not an account setting, and an unread count on the
 * avatar menu is somewhere nobody looks. The count is re-read on every page
 * change, which is cheap and keeps it honest after a notification is opened.
 */
function NotificationBell({ active, to }: { active: boolean; to: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [unread, setUnread] = useState(0);

  const fetchUnread = () => {
    void apiGet<{ unread: number }>("/me/notifications?limit=1", { background: true })
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  };

  useEffect(() => {
    fetchUnread();
  }, [pathname]);

  useLive("notifications", fetchUnread);

  return (
    <Link
      to={to}
      aria-label={unread ? t("Notifications, {n} unread", { n: unread }) : t("Notifications")}
      className={cn(
        "relative grid size-11 place-items-center rounded-[var(--radius-pill)] transition-colors duration-150",
        active ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]" : "text-fg hover:bg-wood",
      )}
    >
      <Bell className="size-4" strokeWidth={1.9} />
      {unread ? (
        <span className="absolute right-0 top-0 grid min-w-5 place-items-center rounded-full bg-danger px-1 text-xs font-bold leading-5 text-on-media tabular-nums motion-safe:animate-pulse">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Link>
  );
}

function ChatBell({ active }: { active: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [unread, setUnread] = useState(0);

  const fetchUnread = () => {
    void apiGet<{ conversations: Array<{ unread_count: number }> }>("/conversations", { background: true })
      .then((r) => {
        const total = (r.conversations ?? []).reduce((acc, c) => acc + (Number(c.unread_count) || 0), 0);
        setUnread(total);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchUnread();
  }, [pathname]);

  useLive("chat", fetchUnread);
  useLive("notifications", fetchUnread);

  return (
    <Link
      to="/chat"
      search={{}}
      aria-label={unread ? t("Messages, {n} unread", { n: unread }) : t("Messages")}
      className={cn(
        "relative grid size-11 place-items-center rounded-[var(--radius-pill)] transition-colors duration-150",
        active ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]" : "text-fg hover:bg-wood",
      )}
    >
      <MessageSquare className="size-4" strokeWidth={1.9} />
      {unread ? (
        <span className="absolute right-0 top-0 grid min-w-5 place-items-center rounded-full bg-danger px-1 text-xs font-bold leading-5 text-on-media tabular-nums motion-safe:animate-pulse">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Open/close state shared by the header's two drop-downs. They are disclosure widgets (a button
 * that reveals a list of links), not ARIA menus, which would promise arrow-key navigation we do
 * not provide. So it is a plain list of links: Tab walks through it, Escape closes it and hands
 * focus back to the button, and tabbing out of it closes it instead of leaving it hanging open.
 */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  // Only a Tab that lands somewhere else counts: some browsers report no target when a mouse
  // press moves focus onto a link, and closing then would swallow the click.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (open && next instanceof Node && !e.currentTarget.contains(next)) setOpen(false);
  };
  return { open, setOpen, ref, button, panelId, onBlur };
}

/** Avatar button that opens the account menu. */
/** `compact` drops the name beside the avatar (it is still the first line of the menu) for roles whose tab row is long. */
function AccountMenu({
  user,
  role,
  onLogout,
  compact = false,
}: {
  user: SessionUser | null;
  role: SessionUser["role"];
  onLogout: () => void;
  compact?: boolean;
}) {
  const { open, setOpen, ref, button, panelId, onBlur } = useDropdown();

  return (
    <div ref={ref} onBlur={onBlur} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="flex items-center gap-2 rounded-[var(--radius-pill)] py-1 pl-1 pr-1 transition-colors duration-150 hover:bg-wood sm:pr-3"
        aria-label={t("Account menu: {name}", { name: user?.full_name ?? "" })}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold tracking-wide text-accent-fg">
          <UserAvatar
            url={user?.avatar_url}
            name={user?.full_name}
            className="size-full bg-accent"
            initialsClassName="text-xs font-bold tracking-wide text-accent-fg"
          />
        </span>
        <span className={cn("hidden text-left", compact ? "" : "xl:block")}>
          <span className="block max-w-[10rem] truncate text-sm font-medium leading-tight">{user?.full_name ?? "-"}</span>
          <span className="kicker text-2xs text-muted">{roleLabel(role)}</span>
        </span>
        <ChevronDown aria-hidden="true" className={cn("hidden size-4 text-muted transition-transform duration-200 sm:block", open && "rotate-180")} />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-56 origin-top-right overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface p-1.5 shadow-[0_24px_50px_-28px_rgba(11,18,48,0.8)]"
          >
            <div className={cn("border-b border-line/70 px-3 pb-2.5 pt-2", compact ? "" : "xl:hidden")}>
              <p className="truncate text-sm font-medium">{user?.full_name ?? "-"}</p>
              <p className="kicker text-2xs text-muted">{roleLabel(role)}</p>
            </div>
            <ul>
              <li>
                <Link
                  to="/account"
                  onClick={() => setOpen(false)}
                  className="flex min-h-11 items-center gap-2.5 rounded-[var(--radius-sm)] px-3 text-sm transition-colors duration-150 hover:bg-wood"
                >
                  <UserCog aria-hidden="true" className="size-4 text-muted" strokeWidth={1.75} />
                  {t("Account settings")}
                </Link>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onLogout();
                  }}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-3 text-left text-sm text-danger transition-colors duration-150 hover:bg-danger/10"
                >
                  <LogOut aria-hidden="true" className="size-4" strokeWidth={1.75} />
                  {t("Sign out")}
                </button>
              </li>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Shape of a header tab; the real tab and its invisible twin (see `useFittingTabs`) must agree on it. */
const tabShape = (dense: boolean) =>
  cn(dense ? "px-2.5" : "px-3.5", "relative flex h-9 items-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium");
const MORE_SHAPE = "flex h-9 items-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] px-3.5 text-sm font-medium";
/** Gap between header tabs, in px (`gap-1`). */
const TAB_GAP = 4;

/**
 * How many of the header tabs fit beside the logo and the buttons on the right; the rest go under
 * "More", so the row never runs off the edge whatever the screen width, zoom level or language
 * (Vietnamese labels are wider than English ones). No guessed breakpoints: an invisible twin of
 * every tab, and of "More", is measured and the real widths are added up. The nav that holds the
 * tabs is `flex-1`, so its width does not depend on what is in it and this cannot loop.
 */
function useFittingTabs(count: number, staticMore: boolean) {
  const box = useRef<HTMLElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(count);
  const measure = useRef<() => void>(() => undefined);
  measure.current = () => {
    const nav = box.current;
    const twin = ruler.current;
    if (!nav || !twin) return;
    const room = nav.clientWidth;
    // On a phone the row is display:none; keep the last answer rather than collapsing to nothing.
    if (room === 0) return;
    const w = [...twin.children].map((c) => c.getBoundingClientRect().width);
    const moreW = w.pop() ?? 0;
    let used = 0;
    let k = 0;
    for (; k < count; k++) {
      const next = used + (k ? TAB_GAP : 0) + (w[k] ?? 0);
      // Anything left over (or a tab that always lives under "More") needs the button's room too.
      const reserve = k + 1 < count || staticMore ? TAB_GAP + moreW : 0;
      if (next + reserve > room) break;
      used = next;
    }
    setFit(k);
  };
  // After every render: a language switch changes the label widths.
  useLayoutEffect(() => measure.current());
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const run = () => measure.current();
    const ro = new ResizeObserver(run);
    ro.observe(el);
    // The web font arrives after first paint and changes every width.
    void document.fonts?.ready.then(run);
    return () => ro.disconnect();
  }, []);
  return { box, ruler, fit: Math.min(fit, count) };
}

/** Items split into their groups: ungrouped first, then each group in the order it first appears. */
function grouped(items: NavItem[]) {
  const out: { group?: string; items: NavItem[] }[] = [{ group: undefined, items: [] }];
  for (const it of items) {
    const bucket = out.find((g) => g.group === it.group);
    if (bucket) bucket.items.push(it);
    else out.push({ group: it.group, items: [it] });
  }
  return out.filter((g) => g.items.length > 0);
}

/** Desktop: the tabs that did not fit in the row live under one "More" button. */
function MoreMenu({ items, pathname, all }: { items: NavItem[]; pathname: string; all: NavItem[] }) {
  const { open, setOpen, ref, button, panelId, onBlur } = useDropdown();
  // The button lights up when the page you are on is one of the hidden tabs.
  const inside = items.some((it) => navActive(pathname, it.to, all));
  return (
    <div ref={ref} onBlur={onBlur} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          MORE_SHAPE,
          "transition-colors duration-150",
          inside ? "bg-accent/10 text-accent-2" : "text-muted hover:bg-wood hover:text-fg",
        )}
      >
        <Ellipsis aria-hidden="true" className="size-4" strokeWidth={1.75} />
        {t("More")}
        <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={panelId} className="absolute left-0 top-[calc(100%+0.5rem)] z-30 w-56 rounded-[var(--radius-lg)] border border-line bg-surface p-1.5 shadow-[0_24px_50px_-28px_rgba(11,18,48,0.8)]">
          {grouped(items).map((g, gi) => (
            <div key={g.group ?? gi} className={cn(gi > 0 && "mt-1 border-t border-line pt-1")}>
              {g.group ? <p className="px-3 pb-1 pt-2 text-xs font-semibold text-subtle">{t(g.group)}</p> : null}
              <ul>
                {g.items.map((it) => {
                  const Icon = it.icon;
                  const active = navActive(pathname, it.to, all);
                  return (
                    <li key={it.to}>
                      <Link
                        to={it.to}
                        aria-current={active ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex min-h-10 items-center gap-2.5 rounded-[var(--radius-sm)] px-3 text-sm transition-colors duration-150 hover:bg-wood",
                          active && "bg-wood font-semibold",
                        )}
                      >
                        <Icon aria-hidden="true" className="size-4 text-muted" strokeWidth={1.75} />
                        {t(it.label)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Phone: a slide-up sheet with the tabs that do not fit in the bottom bar. */
function MoreSheet({
  items,
  pathname,
  all,
  open,
  onClose,
}: {
  items: NavItem[];
  pathname: string;
  all: NavItem[];
  open: boolean;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Focus moves into the sheet, Tab stays in it, Escape closes it, focus returns to "More".
  useDialog(open, panel, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div role="presentation" aria-hidden="true" className="absolute inset-0 bg-fg/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("More pages")}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 rounded-t-[var(--radius-xl)] bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-soft)] outline-none"
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong/60" />
        {grouped(items).map((g, gi) => (
          <div key={g.group ?? gi} className={cn(gi > 0 && "mt-3")}>
            {g.group ? <p className="mb-1.5 px-1 text-xs font-semibold text-subtle">{t(g.group)}</p> : null}
            <ul className="grid grid-cols-3 gap-2">
              {g.items.map((it) => {
                const Icon = it.icon;
                const active = navActive(pathname, it.to, all);
                return (
                  <li key={it.to} className="grid">
                    <Link
                      to={it.to}
                      aria-current={active ? "page" : undefined}
                      onClick={onClose}
                      className={cn(
                        "flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-[var(--radius-lg)] px-1 text-center text-xs font-medium transition-colors duration-150",
                        active ? "bg-accent text-accent-fg" : "bg-wood text-fg",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
                      {t(it.label)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export { roleLabel };

export function Shell({
  children,
  title,
  subtitle,
  role,
}: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  role: SessionUser["role"];
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const user = useSessionUser();
  const items = NAV[role] ?? [];
  const home = homeFor(role);
  // A single tab is not a choice — it just repeats the page heading back at
  // you, which is why the coach screen read "Teaching / Teaching". Roles with
  // one destination get a plain wordmark and no nav at all.
  const showNav = items.length > 1;
  // Roles with a long tab row (and Vietnamese labels run longer) drop the wordmark text and the
  // name beside the avatar, and tighten the tabs.
  const dense = items.length > 4;
  const wantedRow = items.filter((it) => !it.more);
  const alwaysMore = items.filter((it) => it.more);
  const { box, ruler, fit } = useFittingTabs(wantedRow.length, alwaysMore.length > 0);
  const rowItems = wantedRow.slice(0, fit);
  // The tabs that did not fit join the ones that always live under "More", in tab order.
  const moreItems = [...wantedRow.slice(fit), ...alwaysMore];
  const dockItems = items.filter((it) => it.dock !== false);
  const sheetItems = items.filter((it) => it.dock === false);
  const [sheet, setSheet] = useState(false);
  // Moving to another page closes the sheet.
  useEffect(() => setSheet(false), [pathname]);

  // The browser tab and history say which screen this is, not just "Lê Long Sport" on every one.
  const navLabel = [...items]
    .filter((it) => pathname === it.to || pathname.startsWith(`${it.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]?.label;
  const pageName = title ?? (navLabel ? t(navLabel) : undefined);
  useEffect(() => {
    document.title = pageName ? `${pageName} · Lê Long Sport` : "Lê Long Sport";
  }, [pageName]);

  async function logout() {
    // Drop the local session immediately, before awaiting the server call.
    // `api()` reads the token synchronously, so the logout request still carries
    // it — but any fetch a page fires while that request is in flight would
    // otherwise go out with a token the server has already deleted and pop an
    // alarming "That session is not valid." toast on a *successful* sign-out.
    const done = apiPost("/auth/logout").catch(() => undefined);
    clearSession();
    navigate({ to: "/" });
    await done;
  }

  return (
    // `isolate` gives the page its own stacking context, so a background field at `-z-[1]` (the
    // desk's dot grid) paints above the body's own background instead of disappearing behind it.
    <div className="isolate min-h-dvh text-fg">
      <header className="sticky top-0 z-20 border-b border-line/80 bg-surface/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to={home} aria-label={t("Lê Long Sport home")} className="-ml-1.5 flex min-h-11 min-w-11 items-center justify-center gap-2 sm:ml-0 sm:justify-start">
            <ArenaMark className="size-8" />
            {/* The header is the same width on every wide screen, so a long row never gets the wordmark back. */}
            <span className={cn("hidden font-display text-xl font-bold tracking-tight", dense ? "" : "sm:inline")}>Lê Long Sport</span>
          </Link>
          {/* Laptop and wider. A tablet gets the bottom bar, like a phone: it is the thumb-friendly one. */}
          <nav
            ref={box}
            aria-label={t("Main menu")}
            className={cn("relative ml-3 min-w-0 flex-1 items-center gap-1", showNav ? "hidden lg:flex" : "hidden")}
          >
            {/* Invisible twin of every tab (and of "More"), measured to see how many fit. */}
            <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex h-0 gap-1 overflow-hidden">
              {wantedRow.map((it) => {
                const Icon = it.icon;
                return (
                  <span key={it.to} className={tabShape(dense)}>
                    <Icon className="size-4" strokeWidth={1.75} />
                    <span>{t(it.label)}</span>
                  </span>
                );
              })}
              <span className={MORE_SHAPE}>
                <Ellipsis className="size-4" strokeWidth={1.75} />
                {t("More")}
                <ChevronDown className="size-3.5" />
              </span>
            </div>
            {rowItems.map((it) => {
              const active = navActive(pathname, it.to, items);
              const Icon = it.icon;
              return (
                <Link
                  key={it.to}
                  to={it.to}
                  activeOptions={{ exact: true }}
                  className={cn(
                    tabShape(dense),
                    "transition-colors duration-150",
                    active ? "text-accent-2" : "text-muted hover:bg-wood hover:text-fg",
                  )}
                >
                  {/* Highlight slides between tabs rather than cutting. */}
                  {active ? (
                    <motion.span
                      layoutId="shell-nav-active"
                      className="absolute inset-0 rounded-[var(--radius-md)] bg-accent/10"
                      transition={{ type: "spring", stiffness: 400, damping: 34 }}
                    />
                  ) : null}
                  <Icon className="relative z-[1] size-4" strokeWidth={1.75} />
                  <span className="relative z-[1]">{t(it.label)}</span>
                </Link>
              );
            })}
            {moreItems.length ? <MoreMenu items={moreItems} pathname={pathname} all={items} /> : null}
          </nav>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <LangSwitch />
            <ChatBell active={pathname.startsWith("/chat")} />
            <NotificationBell
              to={role === "member" ? "/app/notifications" : "/alerts"}
              active={pathname.startsWith("/app/notifications") || pathname.startsWith("/alerts")}
            />
            {role === "member" ? (
              <Link
                to="/app/assistant"
                aria-label={t("Assistant")}
                className={cn(
                  "grid size-11 place-items-center rounded-[var(--radius-pill)] transition-colors duration-150",
                  pathname.startsWith("/app/assistant")
                    ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]"
                    : "text-fg hover:bg-wood",
                )}
              >
                <AssistantMark className="size-4" strokeWidth={1.9} />
              </Link>
            ) : null}
            <AccountMenu user={user} role={role} onLogout={() => void logout()} compact={dense} />
          </div>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          "mx-auto max-w-6xl px-4 py-6 lg:pb-10",
          // Only reserve room for the dock when there is a dock.
          showNav ? "pb-[calc(5.5rem+env(safe-area-inset-bottom))]" : "pb-10",
        )}
      >
        <ConnectionBanner />
        <PageIn key={pathname}>
          {title ? (
            <header className="mb-6 flex items-center justify-between gap-4 px-1">
              <div className="min-w-0">
                <h1 className="font-display text-2xl font-bold text-balance sm:text-3xl">{title}</h1>
                {subtitle ? <p className="mt-1.5 max-w-2xl text-[0.95rem] leading-snug text-muted">{subtitle}</p> : null}
              </div>
              <Spot name={spotForPath(pathname)} className="hidden sm:block sm:h-20 sm:w-24" />
            </header>
          ) : null}
          {children}
        </PageIn>
      </main>
      {showNav ? (
        <>
      {/* The page fades out under the floating bar instead of being cut by it. */}
      <GradualBlur side="bottom" position="fixed" height="5.5rem" strength={1.6} className="z-[19] lg:hidden" />
      {/* A dock rather than a bar: it floats clear of the page, but every item is
          still a real <Link>, so prefetch, long-press and "open in new tab" work
          the way a tab bar should on a touch device. */}
      <nav aria-label={t("Main menu")} className="fixed inset-x-0 bottom-0 z-20 px-3 pb-[calc(0.65rem+env(safe-area-inset-bottom))] lg:hidden">
        <div className="mx-auto grid max-w-md auto-cols-fr grid-flow-col rounded-[var(--radius-xl)] border border-line bg-surface p-1.5 shadow-[0_8px_30px_-12px_rgba(11,18,48,0.28)]">
          {dockItems.map((it) => {
            const active = navActive(pathname, it.to, items);
            const Icon = it.icon;
            return (
              <Link
                key={it.to}
                to={it.to}
                activeOptions={{ exact: true }}
                className={cn(
                  "relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-lg)] px-0.5 text-xs transition-colors duration-200",
                  active ? "font-semibold text-accent-2" : "font-medium text-muted",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId="shell-dock-active"
                    className="absolute inset-0 rounded-[var(--radius-lg)] bg-accent/10"
                    transition={{ type: "spring", stiffness: 420, damping: 36 }}
                  />
                ) : null}
                <motion.span
                  className="relative z-[1]"
                  animate={{ y: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 26 }}
                >
                  <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} />
                </motion.span>
                <span className="relative z-[1] whitespace-nowrap">{t(it.label)}</span>
              </Link>
            );
          })}
          {sheetItems.length ? (
            <button
              type="button"
              onClick={() => setSheet(true)}
              aria-haspopup="dialog"
              className={cn(
                "relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-lg)] px-0.5 text-xs",
                sheetItems.some((it) => navActive(pathname, it.to, items))
                  ? "bg-accent/10 font-semibold text-accent-2"
                  : "font-medium text-muted",
              )}
            >
              <Ellipsis className="size-5" strokeWidth={1.75} />
              {t("More")}
            </button>
          ) : null}
        </div>
      </nav>
      <MoreSheet items={sheetItems} pathname={pathname} all={items} open={sheet} onClose={() => setSheet(false)} />
        </>
      ) : null}
    </div>
  );
}

export function Guard({
  roles,
  children,
}: {
  roles: SessionUser["role"][];
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);

  // Callers pass `roles` as an inline array literal, so its identity changes on
  // every render. Depend on the contents instead — otherwise this effect re-runs
  // forever (each run stores a freshly parsed user object, forcing a re-render)
  // and fires a /me request per cycle.
  const roleKey = roles.join(",");

  useEffect(() => {
    const allowed = roleKey.split(",") as SessionUser["role"][];
    const u = getStoredUser();
    const tok = getToken();
    if (!tok || !u) {
      navigate({ to: "/login" });
      return;
    }
    if (!allowed.includes(u.role)) {
      navigate({ to: homeFor(u.role) });
      return;
    }
    setUser(u);
    setReady(true);
    // Checks in the background that the session is still good. A 401 is handled inside the client
    // (it ends the session and sends the person to sign in); any other failure is a network or
    // server problem, which the connection banner explains. Signing out on every failed request
    // threw a till operator out of a working session whenever the signal dipped.
    void apiGet("/me", { background: true }).catch(() => {});
  }, [navigate, roleKey]);

  if (!ready || !user) {
    return (
      // Visible in the server render (no initial opacity: 0), so the first frame is the brand
      // rather than a white page; the mark keeps its bounce while the session is checked.
      <div className="grid min-h-dvh place-items-center bg-bg text-muted">
        <div className="flex flex-col items-center gap-3" role="status" aria-label={t("Loading")}>
          <motion.span
            initial={false}
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          >
            <ArenaMark />
          </motion.span>
          <p className="font-display text-lg">Lê Long Sport</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

/** Prices stay in dong; grouping follows the UI language (140,000đ / 140.000đ). */
export function money(n: number) {
  return new Intl.NumberFormat(locale()).format(n) + "đ";
}

export function when(iso: string) {
  return new Date(iso).toLocaleString(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
    hour12: false,
  });
}

export function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
