import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { AssistantWidget } from "@/client/components/assistant-widget";
import {
  Activity,
  Bell,
  CheckCheck,
  X,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  DoorOpen,
  ExternalLink,
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
  Sparkles,
  Tag,
  Coins,
  Ticket,
  Trophy,
  UserCog,
  UserMinus,
  Users,
  Wallet,
  Wrench,
  Languages,
  Moon,
  Sun,
} from "lucide-react";
import { type FocusEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ArenaMark, AssistantMark } from "./mark";
import { AnimatePresence, PageIn, motion } from "./motion";
import { GradualBlur } from "./fx";
import { Spot, spotForPath } from "./illustrations";
import { UserAvatar } from "./user-avatar";
import { useSports } from "./sports-ui";
import { cn } from "@/client/lib/cn";
import { useLive } from "@/client/lib/use-live";
import { useRead } from "@/client/lib/use-read";
import { useCentre } from "@/client/lib/use-centre";
import { isLinkTab, type NavEntry, type NavRole } from "@/shared/ui-config";
import {
  apiGet,
  apiPost,
  clearSession,
  getStoredUser,
  getToken,
  homeFor,
  onStoredUserChange,
  type SessionUser,
} from "@/client/arena3/client";
import { roleLabel } from "@/shared/arena3/labels";
import { locale, t, tk } from "@/client/lib/i18n";
import { ConnectionBanner } from "./connection-banner";
import { LangSwitch } from "./lang-switch";
import { useTheme } from "@/client/lib/theme";
import { useDialog } from "./ui";
import { NotificationList, type Notification } from "./notifications";

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
 * Every page sits in one `group`. A laptop shows one drop-down per group, and a phone lists the
 * pages under the same headings in its "More" sheet. `dock: false` keeps a page out of the phone's
 * bottom bar, so it goes in that sheet instead.
 */
type NavItem = { to: string; label: string; icon: typeof Map; group: string; dock?: boolean; external?: boolean };
type NavGroup = { group: string; items: NavItem[] };

/** Group headings. Module scope, so they are marked with `tk` and translated where they are drawn. */
const G_PLAY = tk("Courts & classes");
const G_ACCOUNT = tk("My account");
const G_TEACHING = tk("Teaching");
const G_FRONT = tk("Front desk");
const G_CUSTOMERS = tk("Customers");
const G_EQUIPMENT = tk("Gear & upkeep");
const G_OVERVIEW = tk("Overview");
const G_BUSINESS = tk("Sales & pricing");
const G_OPS = tk("Operations");
const G_SYSTEM = tk("System");
const G_LINKS = tk("Links");

/**
 * Whether the assistant / support / chat module is switched on.
 *
 * `/flags` is public and already carries every flag, so this needs nothing new
 * from the server. It returns `true` while the read is in flight: showing the
 * UI and letting a rare 403 through beats hiding the nav on every page load and
 * then putting it back.
 *
 * A manager toggling F6 reaches other screens on their next navigation —
 * `apiGet` de-duplicates concurrent calls but does not cache, so each mount
 * asks again.
 */
export function useF6(): boolean {
  const { data } = useRead<{ flags?: Record<string, boolean> }>("/flags");
  return data?.flags?.F6 !== false;
}

type PageInfo = Omit<NavItem, "to" | "dock" | "external">;

/**
 * What each page a role can open is called and the group it sits under. Which of them are tabs,
 * in what order, and which go in the phone's bottom bar is the manager's call (`ui_config`; what
 * ships is `NAV_PAGES` in ui-config.ts).
 */
const PAGE_INFO: Record<NavRole, Record<string, PageInfo>> = {
  member: {
    "/app": { label: tk("Schedule"), icon: CalendarDays, group: G_PLAY },
    "/app/book": { label: tk("Book"), icon: Map, group: G_PLAY },
    "/app/classes": { label: tk("Classes"), icon: Ticket, group: G_PLAY },
    "/app/train": { label: tk("Progress"), icon: Activity, group: G_ACCOUNT },
    "/app/plans": { label: tk("Plans"), icon: Wallet, group: G_ACCOUNT },
    "/app/points": { label: tk("Points"), icon: Star, group: G_ACCOUNT },
    "/chat": { label: tk("Messages"), icon: MessageSquare, group: G_ACCOUNT },
    "/app/pass": { label: tk("Pass"), icon: QrCode, group: G_ACCOUNT },
    "/app/assistant": { label: tk("Assistant"), icon: Sparkles, group: G_ACCOUNT },
    "/app/notifications": { label: tk("Notifications"), icon: Bell, group: G_ACCOUNT },
    "/account": { label: tk("Profile"), icon: UserCog, group: G_ACCOUNT },
  },
  receptionist: {
    "/desk": { label: tk("Desk"), icon: Users, group: G_FRONT },
    "/desk/gate": { label: tk("Gate"), icon: DoorOpen, group: G_FRONT },
    "/desk/courts": { label: tk("Courts"), icon: Map, group: G_FRONT },
    "/desk/classes": { label: tk("Classes"), icon: Ticket, group: G_FRONT },
    "/desk/series": { label: tk("Fixed bookings"), icon: Repeat, group: G_FRONT },
    "/desk/payments": { label: tk("Payments"), icon: Wallet, group: G_CUSTOMERS },
    "/desk/at-risk": { label: tk("At risk"), icon: UserMinus, group: G_CUSTOMERS },
    "/chat": { label: tk("Messages"), icon: MessageSquare, group: G_CUSTOMERS },
    // `/desk/gear` is a complete equipment-hire screen that nothing linked to before.
    "/desk/gear": { label: tk("Gear"), icon: Dumbbell, group: G_EQUIPMENT },
    "/desk/maintenance": { label: tk("Maintenance"), icon: Wrench, group: G_EQUIPMENT },
    "/account": { label: tk("Profile"), icon: UserCog, group: G_CUSTOMERS },
  },
  coach: {
    "/coach": { label: tk("Schedule"), icon: CalendarDays, group: G_TEACHING },
    "/coach/classes": { label: tk("Classes"), icon: Ticket, group: G_TEACHING },
    "/coach/attendance": { label: tk("Attendance"), icon: ClipboardList, group: G_TEACHING },
    "/chat": { label: tk("Messages"), icon: MessageSquare, group: G_TEACHING },
    "/coach/earnings": { label: tk("Earnings"), icon: HandCoins, group: G_ACCOUNT },
    "/account": { label: tk("Profile"), icon: UserCog, group: G_ACCOUNT },
  },
  manager: {
    "/manager": { label: tk("Reports"), icon: LayoutGrid, group: G_OVERVIEW },
    "/manager/members": { label: tk("Members"), icon: Users, group: G_OVERVIEW },
    "/manager/attendance": { label: tk("Attendance"), icon: ClipboardList, group: G_OVERVIEW },
    // Refund sign-off lives on the payments screen, which has always taken a manager (B-02).
    "/desk/payments": { label: tk("Payments"), icon: Wallet, group: G_BUSINESS },
    "/manager/plans": { label: tk("Plans"), icon: Wallet, group: G_BUSINESS },
    "/manager/promos": { label: tk("Promos"), icon: Tag, group: G_BUSINESS },
    "/manager/prices": { label: tk("Pricing"), icon: Coins, group: G_BUSINESS },
    "/manager/commission": { label: tk("Commission"), icon: HandCoins, group: G_BUSINESS },
    "/manager/invoices": { label: tk("E-invoices"), icon: FileText, group: G_BUSINESS },
    "/manager/classes": { label: tk("Classes"), icon: Ticket, group: G_OPS },
    "/desk/series": { label: tk("Fixed bookings"), icon: Repeat, group: G_OPS },
    "/manager/courts": { label: tk("Courts"), icon: LandPlot, group: G_OPS },
    "/manager/sports": { label: tk("Sports"), icon: Trophy, group: G_OPS },
    "/desk/maintenance": { label: tk("Maintenance"), icon: Wrench, group: G_OPS },
    "/chat": { label: tk("Messages"), icon: MessageSquare, group: G_OPS },
    "/manager/staff": { label: tk("Staff"), icon: UserCog, group: G_SYSTEM },
    "/manager/media": { label: tk("Media"), icon: Image, group: G_SYSTEM },
    "/manager/audit": { label: tk("Audit"), icon: ScrollText, group: G_SYSTEM },
    "/manager/settings": { label: tk("Settings"), icon: Settings, group: G_SYSTEM },
    "/account": { label: tk("Profile"), icon: UserCog, group: G_SYSTEM },
  },
};

/** A page's name and icon, for the settings screen that arranges the menus. */
export function pageInfo(role: NavRole, to: string): PageInfo | undefined {
  return PAGE_INFO[role][to];
}

/** The role's tabs as the manager arranged them. A link the centre added opens in a new tab. */
function navItems(role: NavRole, entries: NavEntry[]): NavItem[] {
  return entries.flatMap((e): NavItem[] => {
    if (isLinkTab(e.to)) return [{ to: e.to, label: e.label ?? e.to, icon: ExternalLink, group: G_LINKS, dock: e.dock, external: true }];
    const info = PAGE_INFO[role][e.to];
    return info ? [{ ...info, to: e.to, dock: e.dock }] : [];
  });
}

/** A tab's name: a page's is translated, a link's is what the manager typed. */
const tabName = (it: NavItem) => (it.external ? it.label : t(it.label));

/** A tab: a router link for a page, a plain link in a new tab for an address the centre added. */
function NavLink({
  item,
  ...rest
}: { item: NavItem; className?: string; children: ReactNode; onClick?: () => void; "aria-current"?: "page" }) {
  if (item.external) return <a href={item.to} target="_blank" rel="noopener noreferrer" {...rest} />;
  return <Link to={item.to} {...rest} />;
}

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

export { initials } from "@/client/lib/initials";

/**
 * The member's notifications, on their own button beside the account menu
 * (G-08): what is new is not an account setting, and an unread count on the
 * avatar menu is somewhere nobody looks. The count is re-read on every page
 * change, which is cheap and keeps it honest after a notification is opened.
 */
function NotificationBell({ active, to }: { active: boolean; to: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [onlyNew, setOnlyNew] = useState(false);
  const { open, setOpen, ref, button, panelId, onBlur } = useDropdown();

  const fetchUnread = () => {
    void apiGet<{ unread: number }>("/me/notifications?limit=1", { background: true })
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  };
  const fetchList = () => {
    void apiGet<{ items: Notification[]; unread: number }>("/me/notifications?limit=10", { background: true })
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch(() => setItems((cur) => cur ?? []));
  };

  useEffect(() => {
    fetchUnread();
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (open) fetchList();
  }, [open]);

  useLive("notifications", () => (open ? fetchList() : fetchUnread()));

  return (
    <div ref={ref} onBlur={onBlur} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={unread ? t("Notifications, {n} unread", { n: unread }) : t("Notifications")}
        className={cn(
          "relative grid size-11 place-items-center rounded-[var(--radius-pill)] transition-colors duration-150",
          active || open ? "bg-wood text-accent ring-1 ring-inset ring-accent/40" : "text-fg hover:bg-wood",
        )}
      >
        <Bell className="size-4" strokeWidth={1.9} />
        {unread ? (
          <span className="absolute right-0 top-0 grid min-w-5 place-items-center rounded-full bg-danger px-1 text-xs font-bold leading-5 text-on-media tabular-nums motion-safe:animate-pulse">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-x-3 top-16 z-40 origin-top-right overflow-hidden rounded-[1.25rem] border border-line bg-surface shadow-[0_30px_70px_-30px_rgba(11,18,48,0.55)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+0.5rem)] sm:w-[30rem]"
          >
            <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
              <p className="font-display text-2xl font-bold tracking-tight">{t("Notifications")}</p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!items?.some((n) => !n.read_at)}
                  onClick={async () => {
                    try {
                      await apiPost("/me/notifications/read", {});
                      setItems((cur) => (cur ?? []).map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
                      setUnread(0);
                    } catch {
                      /* the list stays as the server has it */
                    }
                  }}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 text-xs font-medium text-muted transition-colors hover:bg-wood hover:text-fg disabled:pointer-events-none disabled:opacity-50"
                >
                  <CheckCheck aria-hidden="true" className="size-3.5" />
                  {t("Mark all as read")}
                </button>
                <button
                  type="button"
                  aria-label={t("Close")}
                  onClick={() => setOpen(false)}
                  className="grid size-9 place-items-center rounded-full text-muted transition-colors hover:bg-wood hover:text-fg"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </div>
            </div>
            <div role="tablist" aria-label={t("Show")} className="flex gap-6 border-b border-line px-5 text-sm font-medium">
              {[false, true].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  role="tab"
                  aria-selected={onlyNew === v}
                  onClick={() => setOnlyNew(v)}
                  className={cn(
                    "-mb-px min-h-10 border-b-2 transition-colors duration-150",
                    onlyNew === v ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {v ? t("Unread") : t("All")}
                </button>
              ))}
            </div>
            <div className="max-h-[min(60vh,28rem)] overflow-y-auto overscroll-contain px-3 pb-2">
              {!items ? (
                <div className="mt-3 grid gap-2">
                  <div className="h-14 animate-pulse rounded-[var(--radius-md)] bg-wood" />
                  <div className="h-14 animate-pulse rounded-[var(--radius-md)] bg-wood" />
                </div>
              ) : (onlyNew ? !items.some((n) => !n.read_at) : !items.length) ? (
                <div className="grid place-items-center gap-1.5 px-6 py-16 text-center">
                  <Bell aria-hidden="true" className="mb-2 size-8 text-muted" strokeWidth={1.5} />
                  <p className="font-display text-base font-bold text-fg">{onlyNew ? t("Nothing unread") : t("No notifications yet")}</p>
                  <p className="text-sm text-muted">{t("Bookings, payments and class updates will appear here.")}</p>
                </div>
              ) : (
                <NotificationList
                  items={items}
                  limit={10}
                  hideRead={onlyNew}
                  hideMarkAll
                  onRead={(ids) => {
                    setItems((cur) =>
                      (cur ?? []).map((n) => (ids.includes(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n)),
                    );
                    setUnread((u) => Math.max(0, u - ids.length));
                  }}
                />
              )}
            </div>
            <Link
              to={to}
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center justify-center border-t border-line text-sm font-medium text-accent-text hover:bg-wood"
            >
              {t("See all notifications")}
            </Link>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
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

  // "chat" is not a topic the server streams — only "chat:<id>" — so the unread
  // count rides on `notifications`, which is what has been carrying it anyway.
  useLive("notifications", fetchUnread);

  return (
    <Link
      to="/chat"
      search={{}}
      aria-label={unread ? t("Messages, {n} unread", { n: unread }) : t("Messages")}
      className={cn(
        "relative grid size-11 place-items-center rounded-[var(--radius-pill)] transition-colors duration-150",
        active ? "bg-wood text-accent ring-1 ring-inset ring-accent/40" : "text-fg hover:bg-wood",
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
      const el = e.target as Element;
      // A notification opened from the bell shows in a dialog; clicking in it, or on the dimmed page
      // behind it, closes at most the dialog.
      if (el.closest?.("[role=dialog],[role=presentation]")) return;
      if (!ref.current?.contains(el)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape belongs to the dialog while one is up; the panel it was opened from stays.
      if (document.querySelector("[role=dialog]")) return;
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
  // press moves focus onto a link, and closing then would swallow the click. Focus moving into a
  // dialog does not count either: the dialog is opened from inside the panel and takes focus as it
  // appears, and closing the panel then would unmount the dialog a moment after it opened.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (!open || !(next instanceof Element) || e.currentTarget.contains(next)) return;
    if (!next.closest("[role=dialog]")) setOpen(false);
  };
  return { open, setOpen, ref, button, panelId, onBlur };
}

/** Avatar button that opens the account menu. */
function AccountMenu({
  user,
  role,
  showName,
  onLogout,
  up,
}: {
  user: SessionUser | null;
  role: SessionUser["role"];
  showName: boolean;
  onLogout: () => void;
  /** In the sidebar foot: the menu opens upward and the name shows only when the rail is wide. */
  up?: boolean;
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
        <span className={cn("text-left", up ? "sidebar-label block" : cn("hidden", showName && "xl:block"))}>
          <span className="block max-w-[10rem] truncate text-sm font-medium leading-tight">{user?.full_name ?? "-"}</span>
          <span className="kicker text-2xs text-muted">{roleLabel(role)}</span>
        </span>
        <ChevronDown aria-hidden="true" className={cn("hidden size-4 text-muted transition-transform duration-200", up ? "sidebar-label ml-auto lg:block" : "sm:block", open && "rotate-180")} />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className={cn("absolute z-30 w-56 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface p-1.5 shadow-[0_24px_50px_-28px_rgba(11,18,48,0.8)]", up ? "bottom-[calc(100%+0.5rem)] left-0 origin-bottom-left" : "right-0 top-[calc(100%+0.5rem)] origin-top-right")}
          >
            <div className="border-b border-line/70 px-3 pb-2.5 pt-2 xl:hidden">
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

/** Items split into their groups, in the order each group first appears in the role's list. */
function grouped(items: NavItem[]): NavGroup[] {
  const out: NavGroup[] = [];
  for (const it of items) {
    const bucket = out.find((g) => g.group === it.group);
    if (bucket) bucket.items.push(it);
    else out.push({ group: it.group, items: [it] });
  }
  return out;
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
          <div key={g.group} className={cn(gi > 0 && "mt-3")}>
            <p className="mb-1.5 px-1 text-xs font-semibold text-subtle">{t(g.group)}</p>
            <ul className="grid grid-cols-3 gap-2">
              {g.items.map((it) => {
                const Icon = it.icon;
                const active = navActive(pathname, it.to, all);
                return (
                  <li key={it.to} className="grid">
                    <NavLink
                      item={it}
                      aria-current={active ? "page" : undefined}
                      onClick={onClose}
                      className={cn(
                        "flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-[var(--radius-lg)] px-1 text-center text-xs font-medium transition-colors duration-150",
                        active ? "bg-accent text-accent-fg" : "bg-wood text-fg",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
                      {tabName(it)}
                    </NavLink>
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

/** Light/dark switch. `wide` shows the label beside the icon (sidebar expanded, phone sheet). */
function ThemeToggle({ className, showLabel }: { className?: string; showLabel?: boolean }) {
  const [theme, set] = useTheme();
  const light = theme === "light";
  const label = light ? t("Dark mode") : t("Light mode");
  return (
    <button
      type="button"
      onClick={() => set(light ? "dark" : "light")}
      aria-label={label}
      title={label}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm text-muted transition-colors duration-150 hover:bg-wood hover:text-fg",
        className,
      )}
    >
      {light ? <Moon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} /> : <Sun aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />}
      <span className={cn("whitespace-nowrap", !showLabel && "sidebar-label")}>{label}</span>
    </button>
  );
}

/**
 * Laptop: a rail of icons down the left edge. Hovering or tabbing into it widens it over the
 * page (the page does not move) and shows each name. Language, light/dark and the account live
 * at its foot, so the top bar keeps only what is new: messages and notifications.
 */
function Sidebar({
  items,
  pathname,
  extra,
  user,
  role,
  onLogout,
}: {
  items: NavItem[];
  pathname: string;
  extra: NavItem[];
  user: SessionUser | null;
  role: SessionUser["role"];
  onLogout: () => void;
}) {
  const all = [...items, ...extra];
  return (
    <aside
      aria-label={t("Main menu")}
      className="group/side fixed inset-y-0 left-0 z-30 hidden w-16 flex-col overflow-hidden border-r border-line/80 bg-surface/95 backdrop-blur-md transition-[width,box-shadow] duration-200 ease-out hover:w-60 hover:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.55)] focus-within:w-60 motion-reduce:transition-none lg:flex"
    >
      <nav className="scroll-quiet flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 pt-[4.25rem]">
        {grouped(all).map((g, gi) => (
          <div key={g.group} className={cn(gi > 0 && "mt-2 border-t border-line/60 pt-2")}>
            <p className="sidebar-label h-6 px-3 text-2xs font-semibold uppercase tracking-wide text-subtle">{t(g.group)}</p>
            <ul className="grid gap-0.5">
              {g.items.map((it) => {
                const Icon = it.icon;
                const active = it.to.includes("#") ? false : navActive(pathname, it.to, items);
                return (
                  <li key={it.to}>
                    <NavLink
                      item={it}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex min-h-11 items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm transition-colors duration-150",
                        active ? "bg-accent/10 font-semibold text-accent-2" : "text-muted hover:bg-wood hover:text-fg",
                      )}
                    >
                      {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" /> : null}
                      <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={active ? 2.25 : 1.75} />
                      <span className="sidebar-label truncate">{tabName(it)}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="grid gap-1 border-t border-line/80 p-2">
        <div className="flex min-h-11 items-center gap-3 px-1.5">
          <Languages aria-hidden="true" className="size-5 shrink-0 text-muted" strokeWidth={1.75} />
          <span className="sidebar-label">
            <LangSwitch />
          </span>
        </div>
        <ThemeToggle />
        <div className="sidebar-account">
          <AccountMenu user={user} role={role} showName onLogout={onLogout} up />
        </div>
      </div>
    </aside>
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
  const f6 = useF6();
  // With F6 switched off the assistant, chat and WebRTC routes all answer 403
  // (BR-52), so a tab pointing at them is a tab that cannot work. While the
  // flag is still loading they stay — a nav that flickers away and back reads
  // worse than a button that briefly 403s.
  const { ui } = useCentre();
  useSports(); // loads the sport catalog so sportLabel() shows DB names everywhere
  const navRole = role in ui.nav ? (role as NavRole) : null;
  const items = (navRole ? navItems(navRole, ui.nav[navRole]) : []).filter(
    (it) => f6 || (it.to !== "/chat" && it.to !== "/app/assistant"),
  );
  const home = homeFor(role);
  // A single tab is not a choice — it just repeats the page heading back at
  // you, which is why the coach screen read "Teaching / Teaching". Roles with
  // one destination get a plain wordmark and no nav at all.
  const showNav = items.length > 1;
  const dockItems = items.filter((it) => it.dock !== false);
  const sheetItems = items.filter((it) => it.dock === false);
  // On a laptop the pages people open every day (the same ones as the phone's bottom bar) are
  // plain tabs, one click away; the rest wait in a drop-down per group.
  const menuGroups = grouped(sheetItems);
  // The header never grows past the 6xl column. A role with several drop-downs (manager, front
  // desk) has no room for the tabs on a small laptop, so there every group is a drop-down; on a
  // wide one the tabs come back and the wordmark's text and the user's name make way for them.
  const crowded = menuGroups.length > 1;
  const [sheet, setSheet] = useState(false);
  // Moving to another page closes the sheet.
  useEffect(() => setSheet(false), [pathname]);

  // The browser tab and history say which screen this is, not just "Lê Long Sport" on every one.
  const navLabel = [...items]
    .filter((it) => pathname === it.to || pathname.startsWith(`${it.to}/`))
    .sort((a, b) => b.to.length - a.to.length)
    .map(tabName)[0];
  const pageName = title ?? navLabel;
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
      {showNav ? (
        <Sidebar
          items={items}
          extra={role === "member" ? [{ to: "/app/classes#attendance", label: tk("Attendance"), icon: ClipboardList, group: G_PLAY }] : []}
          pathname={pathname}
          user={user}
          role={role}
          onLogout={() => void logout()}
        />
      ) : null}
      <header className={cn("sticky top-0 z-[31] border-b border-line/80 bg-surface/80 backdrop-blur-md", showNav && "lg:z-20 lg:pl-16")}>
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to={home} aria-label={t("Lê Long Sport home")} className="-ml-1.5 flex min-h-11 min-w-11 items-center justify-center gap-2 sm:ml-0 sm:justify-start">
            <ArenaMark className="size-8" />
            <span className={cn("hidden whitespace-nowrap font-display text-xl font-bold tracking-tight sm:inline")}>
              Lê Long Sport
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
            <span className={cn("flex items-center", showNav && "lg:hidden")}>
              <LangSwitch />
            </span>
            <span aria-hidden className={cn("mx-1 hidden h-6 w-px bg-line sm:block", showNav && "lg:hidden")} />
            {f6 ? <ChatBell active={pathname.startsWith("/chat")} /> : null}
            <NotificationBell
              to={role === "member" ? "/app/notifications" : "/alerts"}
              active={pathname.startsWith("/app/notifications") || pathname.startsWith("/alerts")}
            />
            {role === "member" && f6 ? (
              <Link
                to="/app/assistant"
                aria-label={t("Assistant")}
                className={cn(
                  "grid size-11 place-items-center rounded-[var(--radius-pill)] transition-colors duration-150",
                  pathname.startsWith("/app/assistant")
                    ? "bg-wood text-accent ring-1 ring-inset ring-accent/40"
                    : "text-fg hover:bg-wood",
                )}
              >
                <AssistantMark className="size-4" strokeWidth={1.9} />
              </Link>
            ) : null}
            <span aria-hidden className={cn("mx-1 hidden h-6 w-px bg-line sm:block", showNav && "lg:hidden")} />
            <span className={cn(showNav && "lg:hidden")}>
              <AccountMenu user={user} role={role} showName={!crowded} onLogout={() => void logout()} />
            </span>
          </div>
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className={cn(
          "mx-auto max-w-6xl px-4 py-6 lg:pb-10",
          showNav && "lg:box-content lg:pl-20",
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
      {role === "member" && f6 && !pathname.startsWith("/app/assistant") ? <AssistantWidget docked={showNav} /> : null}
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
              <NavLink
                key={it.to}
                item={it}
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
                <span className="relative z-[1] whitespace-nowrap">{tabName(it)}</span>
              </NavLink>
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
      // Come back here after sign-in, so a scanned link (desk QR) still finishes the check-in.
      try {
        sessionStorage.setItem("arena3:after-login", window.location.pathname + window.location.search);
      } catch {
        /* storage blocked: the member lands on their home page instead */
      }
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
