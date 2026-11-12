/**
 * The menus and list lengths a manager sets (`center_settings.ui_config`), with what the centre
 * shipped with as the default for every key.
 *
 * Pure, no imports: the server checks a patch against the same pages and ranges the screens
 * draw from, and the node test runner can load it directly.
 */

export type NavRole = "member" | "receptionist" | "coach" | "manager";
export const NAV_ROLES: NavRole[] = ["member", "receptionist", "coach", "manager"];

/**
 * One tab. `to` is a page the role can open, or an `https://` link the centre added, which
 * needs a `label` because there is no page to name it.
 */
export type NavEntry = { to: string; dock: boolean; label?: string };

type PageSpec = { to: string; dock: boolean; shown: boolean };

/**
 * Every page each role can open, in the order they ship. `shown: false` pages are not in the
 * menu until a manager adds them; `dock` is whether the tab sits in the phone's bottom bar.
 */
export const NAV_PAGES: Record<NavRole, PageSpec[]> = {
  member: [
    { to: "/app", dock: true, shown: true },
    { to: "/app/book", dock: true, shown: true },
    { to: "/app/classes", dock: true, shown: true },
    { to: "/app/train", dock: false, shown: true },
    { to: "/app/points", dock: false, shown: true },
    { to: "/app/plans", dock: false, shown: true },
    { to: "/chat", dock: false, shown: true },
    { to: "/app/pass", dock: true, shown: true },
    { to: "/app/assistant", dock: false, shown: false },
    { to: "/app/notifications", dock: false, shown: false },
    { to: "/account", dock: false, shown: false },
  ],
  receptionist: [
    { to: "/desk", dock: true, shown: true },
    { to: "/desk/gate", dock: true, shown: true },
    { to: "/desk/courts", dock: true, shown: true },
    { to: "/desk/classes", dock: false, shown: true },
    { to: "/desk/series", dock: false, shown: true },
    { to: "/desk/payments", dock: true, shown: true },
    { to: "/desk/at-risk", dock: false, shown: true },
    { to: "/chat", dock: false, shown: true },
    { to: "/desk/gear", dock: false, shown: true },
    { to: "/desk/maintenance", dock: false, shown: true },
    { to: "/account", dock: false, shown: false },
  ],
  coach: [
    { to: "/coach", dock: true, shown: true },
    { to: "/coach/classes", dock: true, shown: true },
    { to: "/coach/attendance", dock: true, shown: true },
    { to: "/chat", dock: true, shown: true },
    { to: "/coach/earnings", dock: true, shown: true },
    { to: "/account", dock: true, shown: true },
  ],
  manager: [
    { to: "/manager", dock: true, shown: true },
    { to: "/manager/members", dock: true, shown: true },
    { to: "/manager/attendance", dock: true, shown: true },
    { to: "/desk/payments", dock: true, shown: true },
    { to: "/manager/plans", dock: false, shown: true },
    { to: "/manager/promos", dock: false, shown: true },
    { to: "/manager/prices", dock: false, shown: true },
    { to: "/manager/commission", dock: false, shown: true },
    { to: "/manager/invoices", dock: false, shown: true },
    { to: "/manager/classes", dock: false, shown: true },
    { to: "/desk/series", dock: false, shown: true },
    { to: "/manager/courts", dock: false, shown: true },
    { to: "/manager/sports", dock: false, shown: true },
    { to: "/desk/maintenance", dock: false, shown: true },
    { to: "/chat", dock: false, shown: true },
    { to: "/manager/staff", dock: false, shown: true },
    { to: "/manager/media", dock: false, shown: true },
    { to: "/manager/audit", dock: false, shown: true },
    { to: "/manager/settings", dock: false, shown: true },
    { to: "/account", dock: false, shown: false },
  ],
};

/** The menu as shipped. */
export function defaultNav(role: NavRole): NavEntry[] {
  return NAV_PAGES[role].filter((p) => p.shown).map(({ to, dock }) => ({ to, dock }));
}

/** Links the centre adds per role, on top of its pages. */
export const MAX_LINKS = 6;
export const LINK_LABEL_MAX = 24;
export const LINK_URL_MAX = 300;

export function isLinkTab(to: string): boolean {
  return to.startsWith("https://");
}

/** How many items the short lists show. `min`/`max` are what the settings form accepts. */
export const LIMITS = {
  member_free_hours: { label: "Free hours on the member home", def: 6, min: 1, max: 24 },
  member_bookings: { label: "Bookings shown before \"Show more\"", def: 4, min: 1, max: 50 },
  book_alternatives: { label: "Other hours suggested when one is taken", def: 3, min: 1, max: 10 },
  book_best_days: { label: "Days with the most free hours", def: 4, min: 1, max: 14 },
  coach_below_min: { label: "Sessions in the coach's \"Below minimum\" list", def: 5, min: 1, max: 50 },
  desk_upcoming: { label: "Upcoming sessions on the desk", def: 4, min: 1, max: 20 },
  desk_checkins: { label: "Recent gate check-ins on the desk", def: 6, min: 1, max: 50 },
  report_peak_hours: { label: "Peak hours named in the report", def: 3, min: 1, max: 10 },
  report_peak_pct: { label: "An hour counts as peak from (% of the busiest)", def: 85, min: 50, max: 100 },
  landing_coaches: { label: "Coaches shown on the landing page", def: 4, min: 1, max: 24 },
} as const;

export type LimitKey = keyof typeof LIMITS;
export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];
export type Limits = Record<LimitKey, number>;

export type UiConfig = { nav: Record<NavRole, NavEntry[]>; limits: Limits };

export const DEFAULT_LIMITS: Limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, LIMITS[k].def])) as Limits;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validLink(to: string): boolean {
  if (to.length > LINK_URL_MAX) return false;
  try {
    return new URL(to).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The problem with one role's menu, or null if it can be saved. Shared by the server (which
 * refuses the save) and the form (which says so before sending).
 */
export function navProblem(role: NavRole, items: NavEntry[]): string | null {
  if (items.length === 0) return "Keep at least one tab.";
  const pages = new Set(NAV_PAGES[role].map((p) => p.to));
  const seen = new Set<string>();
  let links = 0;
  for (const it of items) {
    if (seen.has(it.to)) return "Each page can be a tab only once.";
    seen.add(it.to);
    if (isLinkTab(it.to)) {
      links += 1;
      if (!validLink(it.to)) return "A link must be a full https:// address.";
      const label = (it.label ?? "").trim();
      if (!label || label.length > LINK_LABEL_MAX) return `Name each link (${LINK_LABEL_MAX} characters at most).`;
    } else if (!pages.has(it.to)) {
      return "That page is not one this role can open.";
    }
  }
  if (links > MAX_LINKS) return `A menu holds ${MAX_LINKS} links at most.`;
  return null;
}

function entryFrom(v: unknown): NavEntry | null {
  if (!isRecord(v) || typeof v.to !== "string") return null;
  const to = v.to.trim();
  const label = typeof v.label === "string" ? v.label.trim() : undefined;
  return isLinkTab(to) ? { to, dock: v.dock === true, label } : { to, dock: v.dock === true };
}

/**
 * The config to draw with, from whatever is stored. Never throws: a role whose menu cannot be
 * used, or a number out of range, falls back to the default on its own.
 */
export function uiConfigFrom(raw: unknown): UiConfig {
  const r = isRecord(raw) ? raw : {};
  const navRaw = isRecord(r.nav) ? r.nav : {};
  const limitsRaw = isRecord(r.limits) ? r.limits : {};
  const nav = {} as Record<NavRole, NavEntry[]>;
  for (const role of NAV_ROLES) {
    const list = Array.isArray(navRaw[role]) ? navRaw[role].map(entryFrom) : null;
    const items = list && list.every((x): x is NavEntry => x !== null) ? list : null;
    nav[role] = items && navProblem(role, items) === null ? items : defaultNav(role);
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const k of LIMIT_KEYS) {
    const n = Number(limitsRaw[k]);
    if (Number.isInteger(n) && n >= LIMITS[k].min && n <= LIMITS[k].max) limits[k] = n;
  }
  return { nav, limits };
}

/**
 * A patch checked for saving. Returns the config to store, or the field and message to show.
 * Only what was sent is checked; the rest of the stored config stays.
 */
export function parseUiConfigPatch(
  raw: unknown,
  stored: unknown,
): { ok: true; value: { nav: Partial<Record<NavRole, NavEntry[]>>; limits: Partial<Limits> } } | { ok: false; field: string; message: string } {
  if (!isRecord(raw)) return { ok: false, field: "ui_config", message: "The menu settings could not be read." };
  const base = isRecord(stored) ? stored : {};
  const nav: Partial<Record<NavRole, NavEntry[]>> = isRecord(base.nav) ? { ...(base.nav as Partial<Record<NavRole, NavEntry[]>>) } : {};
  const limits: Partial<Limits> = isRecord(base.limits) ? { ...(base.limits as Partial<Limits>) } : {};
  if (raw.nav !== undefined) {
    if (!isRecord(raw.nav)) return { ok: false, field: "ui_config", message: "The menu settings could not be read." };
    for (const role of NAV_ROLES) {
      const v = raw.nav[role];
      if (v === undefined) continue;
      if (v === null) {
        delete nav[role];
        continue;
      }
      if (!Array.isArray(v)) return { ok: false, field: `nav.${role}`, message: "The menu settings could not be read." };
      const items = v.map(entryFrom);
      if (items.some((x) => x === null)) return { ok: false, field: `nav.${role}`, message: "The menu settings could not be read." };
      const problem = navProblem(role, items as NavEntry[]);
      if (problem) return { ok: false, field: `nav.${role}`, message: problem };
      nav[role] = items as NavEntry[];
    }
  }
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) return { ok: false, field: "ui_config", message: "The list lengths could not be read." };
    for (const k of LIMIT_KEYS) {
      const v = raw.limits[k];
      if (v === undefined) continue;
      if (v === null || v === "") {
        delete limits[k];
        continue;
      }
      const n = Number(v);
      const { min, max } = LIMITS[k];
      if (!Number.isInteger(n) || n < min || n > max) {
        return { ok: false, field: `limits.${k}`, message: `Enter a whole number from ${min} to ${max}.` };
      }
      limits[k] = n;
    }
  }
  return { ok: true, value: { nav, limits } };
}
