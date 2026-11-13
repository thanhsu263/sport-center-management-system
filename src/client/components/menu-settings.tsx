import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ExternalLink, X } from "lucide-react";
import { SectionTitle } from "@/client/components/section";
import { pageInfo } from "@/client/components/shell";
import { Button, Card, Check, Field, Input, LoadError, Select, Seg, Skeleton } from "@/client/components/ui";
import { Reveal } from "@/client/components/motion";
import { ApiClientError, apiPatch } from "@/client/arena3/client";
import { roleLabel } from "@/shared/arena3/labels";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import {
  LIMITS,
  LIMIT_KEYS,
  LINK_LABEL_MAX,
  MAX_LINKS,
  NAV_PAGES,
  NAV_ROLES,
  defaultNav,
  isLinkTab,
  navProblem,
  uiConfigFrom,
  type LimitKey,
  type NavEntry,
  type NavRole,
  type UiConfig,
} from "@/shared/ui-config";

// Marked here so the extractor sees them; ui-config.ts stays free of imports.
tk("Free hours on the member home");
tk("Bookings shown before \"Show more\"");
tk("Other hours suggested when one is taken");
tk("Days with the most free hours");
tk("Sessions in the coach's \"Below minimum\" list");
tk("Upcoming sessions on the desk");
tk("Recent gate check-ins on the desk");
tk("Peak hours named in the report");
tk("An hour counts as peak from (% of the busiest)");

type Draft = { nav: Record<NavRole, NavEntry[]>; limits: Record<LimitKey, string> };

function draftFrom(ui: UiConfig): Draft {
  return {
    nav: ui.nav,
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(ui.limits[k])])) as Record<LimitKey, string>,
  };
}

function limitProblem(k: LimitKey, v: string): string | null {
  const n = Number(v);
  const { min, max } = LIMITS[k];
  return v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max
    ? null
    : t("Enter a whole number from {min} to {max}.", { min, max });
}

/**
 * Manager › Settings: each role's tabs (which pages, their order, which sit in the phone's bottom
 * bar, links of the centre's own) and how many items the short lists show.
 */
export function MenuSettings() {
  const read = useRead<{ ui?: unknown }>("/flags");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [role, setRole] = useState<NavRole>("member");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  if (read.error) return <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />;
  const d = draft ?? (read.data ? draftFrom(uiConfigFrom(read.data.ui)) : null);
  if (!d) return <Skeleton className="h-64" />;

  const items = d.nav[role];
  const setItems = (next: NavEntry[]) => {
    setDraft({ ...d, nav: { ...d.nav, [role]: next } });
    setErrors(({ [`nav.${role}`]: _gone, ...rest }) => rest);
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setItems(next);
  };
  const unused = NAV_PAGES[role].filter((p) => !items.some((it) => it.to === p.to));
  const links = items.filter((it) => isLinkTab(it.to)).length;
  const problem = errors[`nav.${role}`] ?? (navProblem(role, items) ? tServer(navProblem(role, items)!) : null);

  function addLink() {
    const label = linkLabel.trim();
    const to = linkUrl.trim();
    const next = [...items, { to, label, dock: false }];
    const why = navProblem(role, next);
    if (why) {
      setErrors({ ...errors, link: tServer(why) });
      return;
    }
    setItems(next);
    setLinkLabel("");
    setLinkUrl("");
    setErrors(({ link: _gone, ...rest }) => rest);
  }

  async function save() {
    const found: Record<string, string> = {};
    for (const r of NAV_ROLES) {
      const why = navProblem(r, d!.nav[r]);
      if (why) found[`nav.${r}`] = tServer(why);
    }
    for (const k of LIMIT_KEYS) {
      const why = limitProblem(k, d!.limits[k]);
      if (why) found[`limits.${k}`] = why;
    }
    setErrors(found);
    const firstNav = NAV_ROLES.find((r) => found[`nav.${r}`]);
    if (firstNav) setRole(firstNav);
    if (Object.keys(found).length) {
      toast.error(t("Some settings need fixing before they can be saved."));
      return;
    }
    setSaving(true);
    try {
      const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(d!.limits[k])]));
      const r = await apiPatch<{ ui_config?: unknown }>("/settings", { ui_config: { nav: d!.nav, limits } });
      setDraft(draftFrom(uiConfigFrom(r.ui_config)));
      toast.success(t("Saved. Menus change as people move to their next page."));
    } catch (e) {
      if (e instanceof ApiClientError && e.body.field) {
        const field = e.body.field;
        setErrors({ [field]: tServer(e.message) });
        const r = NAV_ROLES.find((x) => field === `nav.${x}`);
        if (r) setRole(r);
      }
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SectionTitle text={tk("Menus")} className="mb-1 mt-8 font-display text-2xl" />
      <p className="mb-3 max-w-2xl text-sm text-muted">
        {t("Choose the tabs each role sees, in order. Tabs marked for the bottom bar sit there on a phone and stay one click away on a laptop; the rest go under More.")}
      </p>
      <Reveal>
        <Card className="grid gap-4">
          <Seg
            value={role}
            onChange={(v) => setRole(v as NavRole)}
            options={NAV_ROLES.map((r) => ({ value: r, label: t(roleLabel(r)) }))}
          />
          {problem ? (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          ) : null}
          <ol className="grid gap-1.5">
            {items.map((it, i) => {
              const link = isLinkTab(it.to);
              const info = link ? null : pageInfo(role, it.to);
              const Icon = info?.icon ?? ExternalLink;
              const name = link ? (it.label ?? it.to) : info ? t(info.label) : it.to;
              return (
                <li
                  key={it.to}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-1.5"
                >
                  <span className="w-5 text-right font-mono text-xs text-subtle">{i + 1}</span>
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    <span className="block truncate text-xs text-muted">{link ? it.to : t(info?.group ?? "")}</span>
                  </span>
                  <Check
                    checked={it.dock}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, dock: e.target.checked } : x)))}
                    label={t("Bottom bar")}
                  />
                  <span className="flex items-center gap-0.5">
                    <IconButton label={t("Move {name} up", { name })} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton label={t("Move {name} down", { name })} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" />
                    </IconButton>
                    <IconButton label={t("Remove {name}", { name })} disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                      <X className="size-4" />
                    </IconButton>
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("Add a page")} tone="muted" hint={unused.length ? undefined : t("Every page this role can open is already a tab.")}>
              <Select
                value=""
                disabled={!unused.length}
                onChange={(e) => e.target.value && setItems([...items, { to: e.target.value, dock: false }])}
              >
                <option value="">{t("Choose a page")}</option>
                {unused.map((p) => {
                  const info = pageInfo(role, p.to);
                  return (
                    <option key={p.to} value={p.to}>
                      {info ? t(info.label) : p.to}
                    </option>
                  );
                })}
              </Select>
            </Field>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t("Add a link")}</p>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="w-36"
                  aria-label={t("Link name")}
                  placeholder={t("Name")}
                  maxLength={LINK_LABEL_MAX}
                  value={linkLabel}
                  onChange={(e) => setLinkLabel(e.target.value)}
                />
                <Input
                  className="min-w-0 flex-1"
                  type="url"
                  inputMode="url"
                  aria-label={t("Link address")}
                  placeholder="https://"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                />
                <Button size="sm" variant="outline" disabled={links >= MAX_LINKS || !linkLabel.trim() || !linkUrl.trim()} onClick={addLink}>
                  {t("Add")}
                </Button>
              </div>
              <p className={errors.link ? "text-xs text-danger" : "text-xs text-muted"} role={errors.link ? "alert" : undefined}>
                {errors.link ?? t("Opens in a new browser tab: a booking form, a group chat, the centre's page.")}
              </p>
            </div>
          </div>
          <div>
            <Button size="sm" variant="outline" onClick={() => setItems(defaultNav(role))}>
              {t("Put this menu back as it shipped")}
            </Button>
          </div>
        </Card>
      </Reveal>

      <SectionTitle text={tk("List lengths")} className="mb-1 mt-8 font-display text-2xl" />
      <p className="mb-3 max-w-2xl text-sm text-muted">{t("How many items the short lists show before the full page.")}</p>
      <Reveal>
        <Card className="grid gap-3 md:grid-cols-2">
          {LIMIT_KEYS.map((k) => (
            <Field
              key={k}
              label={t(LIMITS[k].label)}
              tone={errors[`limits.${k}`] ? "danger" : "muted"}
              hint={errors[`limits.${k}`] ?? t("{min} to {max}, shipped as {def}", LIMITS[k])}
            >
              <Input
                inputMode="numeric"
                value={d.limits[k]}
                aria-invalid={errors[`limits.${k}`] ? true : undefined}
                onChange={(e) => {
                  setDraft({ ...d, limits: { ...d.limits, [k]: e.target.value } });
                  setErrors(({ [`limits.${k}`]: _gone, ...rest }) => rest);
                }}
              />
            </Field>
          ))}
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? t("Saving…") : t("Save menus and lengths")}
            </Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setDraft({ ...d, limits: draftFrom(uiConfigFrom(null)).limits })}
            >
              {t("Put the lengths back as shipped")}
            </Button>
          </div>
        </Card>
      </Reveal>
    </>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-11 place-items-center rounded-[var(--radius-sm)] text-muted transition-colors duration-150 hover:bg-wood hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent sm:size-8"
    >
      {children}
    </button>
  );
}
