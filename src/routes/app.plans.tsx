import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Cover, MediaCaption, sportPhoto } from "@/components/media";
import { Shell, money } from "@/components/shell";
import { Badge, Button, Card, EmptyState, Input, LoadError, PageHero, Skeleton, SportBadge } from "@/components/ui";
import { Lift, Stagger, StaggerItem } from "@/components/motion";
import { GlareHover, SpotlightCard, StarBorder } from "@/components/fx";
import { cn } from "@/lib/cn";
import { apiPost } from "@/lib/arena3/client";
import { t, tData } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/app/plans")({
  component: Page,
});

type Plan = {
  id: string;
  name: string;
  sport_scope: string;
  duration_days: number | null;
  session_quota: number | null;
  court_hours: number;
  court_discount_pct: number;
  price_vnd: number;
};

function Page() {
  const { data, error, reload } = useRead<{ items: Plan[] }>("/plans");
  const meRead = useRead<{ subscriptions?: Array<{ id: string; status: string; plan_name: string; sport_scope: string; end_on: string }> }>("/me");
  const items = data?.items ?? null;
  const activeSub = meRead.data?.subscriptions?.find((s) => s.status === "active");

  // Which plan is mid-request. One at a time: the server refuses a second live
  // subscription on the same sport anyway, and letting two buttons spin at once
  // only makes it look as though both worked.
  const [busy, setBusy] = useState<string | null>(null);
  // Plans already ordered this visit. The desk has not taken the money yet, so
  // pressing the button again does nothing useful — say so instead of firing a
  // request the rate limiter will reject.
  const [ordered, setOrdered] = useState<Record<string, string>>({});
  const [promoCode, setPromoCode] = useState("");

  async function order(p: Plan) {
    if (busy) return;
    setBusy(p.id);
    try {
      const res = await apiPost<{
        preview_end: string;
        renewal?: boolean;
        amount_due_vnd: number;
        promo?: { code: string; discount_vnd: number } | null;
      }>("/subscriptions", {
        plan_id: p.id,
        ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
      });
      setOrdered((o) => ({ ...o, [p.id]: res.preview_end }));
      toast.success(
        res.renewal
          ? t("Renewed through {date}: pay at the desk", { date: res.preview_end })
          : t("Order placed, valid through {date}. Pay at the desk.", { date: res.preview_end }),
        {
          description: res.promo
            ? t("{code} takes {off} off, so you pay {total}.", {
                code: res.promo.code,
                off: money(res.promo.discount_vnd),
                total: money(res.amount_due_vnd),
              })
            : t("You pay {total}.", { total: money(res.amount_due_vnd) }),
        },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell role="member">
      <PageHero
        slot="banner.train"
        title={t("Membership plans")}
        subtitle={t("Order here, pay at the desk. You see the new end date before anything is charged.")}
        fallbackSpot="plans"
        stats={[
          {
            label: t("Available plans"),
            value: items?.length ?? 0,
          },
          {
            label: t("Current plan"),
            value: activeSub?.plan_name ? tData(activeSub.plan_name) : t("None"),
            live: Boolean(activeSub),
          },
        ]}
      />

      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : !items ? (
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <>
        <div className="mb-4 flex max-w-sm items-center gap-2">
          <Input
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
            placeholder={t("Promo code (optional)")}
            aria-label={t("Promo code")}
            autoCapitalize="characters"
            maxLength={32}
          />
        </div>
        <Stagger className="grid gap-3 md:grid-cols-3" gap={0.08}>
          {items.map((p) => {
            const isActive = activeSub?.plan_name === p.name;

            return (
              <StaggerItem key={p.id} className="h-full">
              <Lift className="h-full">
              <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={340} strength={isActive ? 0.22 : 0.11}>
              <Card interactive className={cn("relative z-[2] flex h-full flex-col overflow-hidden p-0", isActive && "border-accent/40 shadow-[var(--shadow-accent-lg)]")}>
                <GlareHover>
                  <Cover slot={p.sport_scope === "all" ? "plan.default" : sportPhoto(p.sport_scope)} alt="" scrim="none" className="h-36">
                    <MediaCaption className="flex items-end justify-between">
                      <SportBadge sport={p.sport_scope} className="bg-surface/90 text-fg backdrop-blur-xs" />
                      {isActive ? (
                        <StarBorder speed={6}>
                          <Badge tone="accent" className="font-semibold text-2xs">
                            {t("Current plan")}
                          </Badge>
                        </StarBorder>
                      ) : null}
                    </MediaCaption>
                  </Cover>
                </GlareHover>
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-2xl">{tData(p.name)}</h2>
                    {isActive ? (
                      <span className="rounded-[var(--radius-pill)] bg-accent/15 px-2 py-0.5 text-2xs font-semibold text-accent-2">
                        {t("Active")}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-3 font-display text-3xl tabular-nums text-fg">{money(p.price_vnd)}</p>
                  <ul className="mt-4 grid gap-2 text-sm text-muted">
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-accent" strokeWidth={1.75} />
                      {p.duration_days ? t("{n} days", { n: p.duration_days }) : t("Per session")}
                    </li>
                    {p.session_quota ? (
                      <li className="flex items-center gap-2">
                        <Check className="size-4 text-accent" strokeWidth={1.75} />
                        {t("{n} class sessions", { n: p.session_quota })}
                      </li>
                    ) : null}
                    {p.court_hours > 0 ? (
                      <li className="flex items-center gap-2">
                        <Check className="size-4 text-accent" strokeWidth={1.75} />
                        {t("{n} court hours", { n: p.court_hours })}
                      </li>
                    ) : null}
                    {p.court_discount_pct > 0 ? (
                      <li className="flex items-center gap-2">
                        <Check className="size-4 text-accent" strokeWidth={1.75} />
                        {t("{n}% off court rental", { n: p.court_discount_pct })}
                      </li>
                    ) : null}
                  </ul>
                  <div className="mt-auto pt-5">
                    <Button
                      className="w-full"
                      variant={isActive ? "outline" : "primary"}
                      disabled={busy !== null || ordered[p.id] !== undefined}
                      onClick={() => void order(p)}
                    >
                      {busy === p.id
                        ? t("Placing order…")
                        : ordered[p.id]
                          ? t("Ordered: pay at the desk")
                          : isActive
                            ? t("Renew plan")
                            : t("Buy or renew")}
                    </Button>
                    {ordered[p.id] ? (
                      <p className="mt-2 text-center text-xs text-muted">{t("Valid through {date}", { date: ordered[p.id] })}</p>
                    ) : null}
                  </div>
                </div>
              </Card>
              </SpotlightCard>
              </Lift>
              </StaggerItem>
            );
          })}
          {!items.length ? <EmptyState title={t("No plans on sale right now")} /> : null}
        </Stagger>

        {/* Quick comparison strip */}
        {items.length > 0 ? (
          <div className="mt-8 rounded-[var(--radius-xl)] border border-line bg-surface p-5 shadow-[var(--shadow-soft)]">
            <h3 className="font-display text-lg font-bold text-fg mb-3">{t("Quick compare")}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="pb-2.5 font-semibold">{t("Plan")}</th>
                    <th className="pb-2.5 font-semibold">{t("Sport")}</th>
                    <th className="pb-2.5 font-semibold">{t("Validity")}</th>
                    <th className="pb-2.5 font-semibold">{t("Court hours")}</th>
                    <th className="pb-2.5 font-semibold">{t("Classes")}</th>
                    <th className="pb-2.5 font-semibold">{t("Discount")}</th>
                    <th className="pb-2.5 font-semibold text-right">{t("Price")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  {items.map((p) => {
                    const isActive = activeSub?.plan_name === p.name;
                    return (
                      <tr key={p.id} className={cn("transition-colors hover:bg-wood/30", isActive && "bg-accent/5 font-medium")}>
                        <td className="py-2.5 font-semibold text-fg flex items-center gap-2">
                          {tData(p.name)}
                          {isActive ? <Badge tone="accent" className="text-2xs">{t("Current plan")}</Badge> : null}
                        </td>
                        <td className="py-2.5"><SportBadge sport={p.sport_scope} /></td>
                        <td className="py-2.5 text-muted">{p.duration_days ? t("{n} days", { n: p.duration_days }) : t("Per session")}</td>
                        <td className="py-2.5 text-fg">{p.court_hours > 0 ? `${p.court_hours}h` : "—"}</td>
                        <td className="py-2.5 text-fg">{p.session_quota ? `${p.session_quota} buổi` : "—"}</td>
                        <td className="py-2.5 text-accent-2 font-medium">{p.court_discount_pct > 0 ? `${p.court_discount_pct}%` : "—"}</td>
                        <td className="py-2.5 text-right font-bold tabular-nums text-fg">{money(p.price_vnd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        </>
      )}
    </Shell>
  );
}
