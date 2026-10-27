import { useRef } from "react";
import { Sparkles } from "lucide-react";
import { Cover, MediaCaption, sportPhoto } from "@/components/media";
import { ButtonLink, Card } from "@/components/ui";
import { GLBackground, GlareHover, SpotlightCard, StarBorder } from "@/components/fx";
import type { CatalogClass, CatalogPlan } from "@/lib/arena3/catalog";
import { levelLabel, rruleLabel, sportLabel } from "@/lib/arena3/labels";
import { gsap, useScene } from "@/lib/gsap";
import { t, tData } from "@/lib/i18n";
import { CountTo, SplitHeading } from "./kit";
import { moneyCount, rise } from "./tweens";

/** Memberships for sale. The featured plan alone carries the travelling border. */
export function PlansScene({ plans }: { plans: CatalogPlan[] }) {
  const root = useRef<HTMLElement>(null);
  useScene(root, ({ motion }) => {
    if (motion && root.current) rise(root.current, "[data-rise]", { stagger: 0.1 });
  });
  return (
    <section ref={root} id="plans" className="relative mx-auto max-w-6xl scroll-mt-20 overflow-hidden px-4 pb-20">
      {/* Folded-cloth sheen at very low opacity, so the cards do not float on flat cream. */}
      <GLBackground variant="silk" className="-z-[1] opacity-70" color="#3f7d20" speed={0.5} scale={1.7} opacity={0.13} />
      <p data-rise className="kicker text-2xs text-muted">
        {t("Memberships")}
      </p>
      <h2 className="mt-2 font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("Buy in the app, pay at the desk")} />
      </h2>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {plans.map((p, i) => {
          const featured = i === 1;
          const buy = (
            <ButtonLink to="/register" className="w-full" aria-label={`${t("Join to buy")}: ${tData(p.name)}`}>
              {t("Join to buy")}
            </ButtonLink>
          );
          return (
            <div key={p.id} data-rise className="h-full">
              <SpotlightCard className="lift h-full rounded-[var(--radius-xl)]">
                <Card interactive className="group flex h-full flex-col overflow-hidden p-0">
                  <GlareHover>
                    <Cover
                      slot={sportPhoto(p.sport_scope)}
                      alt=""
                      scrim="none"
                      className="h-36"
                      imgClassName="transition-transform duration-[900ms] ease-[var(--ease-smooth)] group-hover:scale-110"
                    >
                      <MediaCaption>
                        <p className="kicker text-2xs">{sportLabel(p.sport_scope)}</p>
                      </MediaCaption>
                    </Cover>
                  </GlareHover>
                  <div className="relative z-[2] flex flex-1 flex-col p-5">
                    {featured ? (
                      <span className="mb-2 inline-flex w-fit items-center gap-1 rounded-full bg-accent/12 px-2.5 py-1 text-2xs font-medium text-accent-2">
                        <Sparkles className="size-3" /> {t("Most picked")}
                      </span>
                    ) : null}
                    <h3 className="font-display text-2xl">{tData(p.name)}</h3>
                    <p className="mt-3 font-display text-3xl tabular-nums">
                      <CountTo value={p.price_vnd} format={moneyCount} duration={1.2} />
                    </p>
                    <p className="mt-2 flex-1 text-sm text-muted">
                      {p.duration_days ? t("{n} days", { n: p.duration_days }) : t("Per session")} ·{" "}
                      {t("{n} court hours", { n: p.court_hours })} · {t("{n}% off", { n: p.court_discount_pct })}
                    </p>
                    <div className="mt-5">
                      {featured ? (
                        <StarBorder className="w-full" innerClassName="bg-surface">
                          {buy}
                        </StarBorder>
                      ) : (
                        buy
                      )}
                    </div>
                  </div>
                </Card>
              </SpotlightCard>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Classes with seats left. The enrol button sits next to the seat count that decides it, and each
 * seat meter fills to how full the class really is as it scrolls in.
 */
export function ClassesScene({ classes }: { classes: CatalogClass[] }) {
  const root = useRef<HTMLElement>(null);
  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el) return;
    rise(el, "[data-rise]", { stagger: 0.08 });
    gsap.utils.toArray<HTMLElement>("[data-meter]", el).forEach((m) => {
      gsap.fromTo(m, { scaleX: 0 }, {
        scaleX: 1,
        transformOrigin: "left center",
        duration: 1,
        ease: "arena",
        scrollTrigger: { trigger: m, start: "top 92%", once: true },
      });
    });
  });
  return (
    <section ref={root} id="classes" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("Open classes")}
      </p>
      <h2 className="mt-2 font-display text-4xl">
        <SplitHeading text={t("Classes open for enrolment")} />
      </h2>
      <p data-rise className="mt-3 max-w-lg text-muted">
        {t("Classes with a coach. They never overlap court hours you have booked. Seats go to whoever signs up first.")}
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {classes.map((c) => {
          const pct = c.capacity ? Math.min(100, (c.enrolled_count / c.capacity) * 100) : 0;
          const nearlyFull = pct >= 80;
          const full = c.enrolled_count >= c.capacity;
          const left = Math.max(0, c.capacity - c.enrolled_count);
          return (
            <div key={c.id} data-rise className="h-full">
              <Card interactive className="flex h-full gap-4 p-3">
                <Cover slot={sportPhoto(c.sport)} alt="" className="h-28 w-28 shrink-0 rounded-[var(--radius-lg)]" />
                <div className="flex min-w-0 flex-1 flex-col py-1">
                  <p className="kicker text-2xs text-muted">{sportLabel(c.sport)}</p>
                  <p className="font-display text-xl">{levelLabel(c.level)}</p>
                  <p className="text-sm text-muted">
                    {c.coach_name} · {c.court_code}
                  </p>
                  <p className="text-sm">{rruleLabel(c.rrule, c.duration_min)}</p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-wood">
                      <span
                        data-meter
                        className={`block h-full rounded-full ${nearlyFull ? "bg-hold" : "bg-accent"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-subtle">
                      {c.enrolled_count}/{c.capacity}
                    </span>
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                    <span className={`text-xs ${nearlyFull ? "text-hold" : "text-muted"}`}>
                      {full ? t("Full, waitlist open") : left === 1 ? t("1 seat left") : t("{n} seats left", { n: left })}
                    </span>
                    <ButtonLink
                      to="/register"
                      size="sm"
                      variant={full ? "outline" : "primary"}
                      aria-label={`${full ? t("Join the waitlist") : t("Enrol")}: ${sportLabel(c.sport)} ${levelLabel(c.level)}`}
                    >
                      {full ? t("Join the waitlist") : t("Enrol")}
                    </ButtonLink>
                  </div>
                </div>
              </Card>
            </div>
          );
        })}
        {!classes.length ? <p className="text-sm text-muted">{t("No classes published yet.")}</p> : null}
      </div>
    </section>
  );
}
