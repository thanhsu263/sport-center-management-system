import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Cover } from "@/client/components/media";
import { Shell, money } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, Input, LoadError, PageHero, Skeleton } from "@/client/components/ui";
import { Lift, Stagger, StaggerItem } from "@/client/components/motion";
import { GlareHover, SpotlightCard } from "@/client/components/fx";
import { cn } from "@/client/lib/cn";
import { apiPost } from "@/client/arena3/client";
import { t, tData } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

export const Route = createFileRoute("/app/plans")({
  component: Page,
});

type Plan = {
  id: string;
  name: string;
  duration_months: number | null;
  duration_days: number | null;
  price_vnd: number;
};

/** Plans sold before months existed still carry days. */
function months(p: Plan) {
  return p.duration_months ?? Math.max(1, Math.round((p.duration_days ?? 30) / 30));
}

function Page() {
  const { data, error, reload } = useRead<{ items: Plan[]; member_court_fee_vnd: number }>("/plans");
  const meRead = useRead<{ subscriptions?: Array<{ id: string; status: string; plan_name: string; end_on: string }> }>("/me");
  const items = data?.items ?? null;
  const activeSub = meRead.data?.subscriptions?.find((s) => s.status === "active");

  // Which plan is mid-request. One at a time: every order extends the one
  // membership, and two buttons spinning at once would look like two memberships.
  const [busy, setBusy] = useState<string | null>(null);
  // Plans already ordered this visit. The desk has not taken the money yet, so
  // pressing the button again does nothing useful — say so instead of firing a
  // request the rate limiter will reject.
  const [ordered, setOrdered] = useState<Record<string, string>>({});
  const [promoCode, setPromoCode] = useState("");
  // The plan that costs least per month is the one filled button on the page.
  const bestId = (items ?? []).reduce<Plan | null>(
    (b, p) => (!b || p.price_vnd / months(p) < b.price_vnd / months(b) ? p : b),
    null,
  )?.id;

  async function order(p: Plan) {
    if (busy) return;
    setBusy(p.id);
    try {
      const res = await apiPost<{
        preview_end: string;
        amount_due_vnd: number;
        promo?: { code: string; discount_vnd: number } | null;
      }>("/subscriptions", {
        plan_id: p.id,
        ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
      });
      setOrdered((o) => ({ ...o, [p.id]: res.preview_end }));
      toast.success(
        t("Order placed, valid through {date}. Pay at the desk.", { date: res.preview_end }),
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
        subtitle={t("One membership, for every sport. A longer plan only costs less per month. Buying again adds to your end date.")}
        fallbackSpot="plans"
        stats={[
          {
            label: t("Available plans"),
            value: items?.length ?? 0,
          },
          {
            label: activeSub ? t("Membership ends") : t("Current plan"),
            value: activeSub ? activeSub.end_on : t("None"),
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
            const best = items.length > 1 && p.id === bestId;
            return (
              <StaggerItem key={p.id} className="h-full">
              <Lift className="h-full">
              <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={340} strength={0.11}>
              <Card interactive className={cn("relative z-[2] flex h-full flex-col overflow-hidden p-0")}>
                <GlareHover>
                  <Cover slot="plan.default" alt="" scrim="none" className="h-36" />
                </GlareHover>
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-2xl">{tData(p.name)}</h2>
                    {best ? <Badge tone="accent">{t("Lowest per month")}</Badge> : null}
                  </div>
                  <p className="mt-3 font-display text-3xl tabular-nums text-fg">{money(p.price_vnd)}</p>
                  <ul className="mt-4 grid gap-2 text-sm text-muted">
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-accent" strokeWidth={1.75} />
                      {t("{price} a month", { price: money(Math.round(p.price_vnd / months(p))) })}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-accent" strokeWidth={1.75} />
                      {t("Courts at {fee} an hour", { fee: money(data?.member_court_fee_vnd ?? 0) })}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="size-4 text-accent" strokeWidth={1.75} />
                      {t("Join classes that end before your plan does")}
                    </li>
                  </ul>
                  <div className="mt-auto pt-5">
                    <Button
                      className="w-full"
                      variant={best ? "primary" : "outline"}
                      disabled={busy !== null || ordered[p.id] !== undefined}
                      onClick={() => void order(p)}
                    >
                      {busy === p.id
                        ? t("Placing order…")
                        : ordered[p.id]
                          ? t("Ordered: pay at the desk")
                          : activeSub
                            ? t("Extend")
                            : t("Buy")}
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

        </>
      )}
    </Shell>
  );
}
