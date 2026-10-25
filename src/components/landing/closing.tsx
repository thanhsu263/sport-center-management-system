import { useRef } from "react";
import { ArrowUpRight, Clock, MapPin, Phone } from "lucide-react";
import { ArenaMark } from "@/components/mark";
import { Cover } from "@/components/media";
import { ButtonLink } from "@/components/ui";
import { gsap, useScene } from "@/lib/gsap";
import { t } from "@/lib/i18n";
import { rise } from "./tweens";
import { useVenue } from "./util";
import { hhmm } from "@/lib/venue";

/** The last ask: opening hours and the two ways in, over the frontage at dusk. */
export function ClosingCta() {
  const venue = useVenue();
  const root = useRef<HTMLElement>(null);
  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el) return;
    rise(el, "[data-rise]", { stagger: 0.1 });
    // The photograph drifts against the scroll inside its frame; the copy stays put.
    const img = el.querySelector("img");
    if (img) {
      gsap.fromTo(
        img,
        { yPercent: -7, scale: 1.14 },
        { yPercent: 7, scale: 1.14, ease: "none", scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true } },
      );
    }
  });
  return (
    <section ref={root} className="relative mx-4 mb-16 overflow-hidden rounded-[var(--radius-xl)] md:mx-auto md:max-w-6xl">
      <Cover slot="landing.closing" alt={t("The Lê Long Sport Center frontage at dusk")} className="min-h-[26rem]" scrim="hero">
        <div className="relative flex min-h-[26rem] flex-col justify-end p-6 sm:p-12">
          <p data-rise className="athletic max-w-md text-5xl text-on-media on-media sm:text-6xl">
            {t("{open}-{close} · seven days", { open: hhmm(venue.open), close: hhmm(venue.close) })}
          </p>
          <p data-rise className="mt-3 max-w-sm text-on-media-muted on-media">
            {t("Reception is open during all opening hours. You can book at the desk without an account.")}
          </p>
          <div data-rise className="mt-6 flex flex-wrap gap-3">
            <ButtonLink to="/register" size="lg" className="group bg-on-media text-night hover:bg-on-media">
              {t("Create an account")}
              <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </ButtonLink>
            <ButtonLink
              to="/login"
              size="lg"
              variant="outline"
              className="border-on-media/40 bg-transparent text-on-media hover:bg-on-media/10"
            >
              {t("Sign in")}
            </ButtonLink>
          </div>
        </div>
      </Cover>
    </section>
  );
}

export function SiteFooter() {
  const venue = useVenue();
  return (
    <footer className="border-t border-line bg-surface/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <ArenaMark className="size-8" />
            <span className="font-display text-xl font-bold">Lê Long Sport Center</span>
          </div>
          <p className="mt-4 max-w-xs text-sm text-muted">
            {t("Indoor sports centre with court booking, classes and membership plans.")}
          </p>
        </div>

        <div>
          <p className="kicker text-2xs text-muted">{t("Visit")}</p>
          <ul className="mt-4 grid gap-3 text-sm">
            <li className="flex gap-2.5 text-muted">
              <Clock className="mt-0.5 size-4 shrink-0 text-accent" strokeWidth={1.75} />
              {t("{open}-{close}, seven days", { open: hhmm(venue.open), close: hhmm(venue.close) })}
            </li>
            <li className="flex gap-2.5 text-muted">
              <MapPin className="mt-0.5 size-4 shrink-0 text-accent" strokeWidth={1.75} />
              {t("Ho Chi Minh City")}
            </li>
            <li className="flex gap-2.5 text-muted">
              <Phone className="mt-0.5 size-4 shrink-0 text-accent" strokeWidth={1.75} />
              {t("Front desk, during opening hours")}
            </li>
          </ul>
        </div>

        <div>
          <p className="kicker text-2xs text-muted">{t("Explore")}</p>
          <ul className="mt-3 grid gap-0 text-sm sm:mt-4 sm:gap-1">
            {[
              ["#schedule", t("Today's schedule")],
              ["#courts", t("Courts & pricing")],
              ["#classes", t("Open classes")],
              ["#how", t("How booking works")],
              ["#facilities", t("Facilities")],
              ["#coaches", t("Coaches")],
              ["#plans", t("Membership plans")],
              ["/credits", t("Media Credits")],
            ].map(([href, label]) => (
              <li key={href}>
                <a href={href} className="link-underline hit text-muted hover:text-fg">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="border-t border-line">
        <div className="kicker mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-2xs text-subtle">
          <span>© {new Date().getFullYear()} Lê Long Sport Center</span>
          <div className="flex items-center gap-4">
            <a href="/credits" className="hover:text-fg underline">{t("Media Credits")}</a>
            <span>{t("Badminton · Basketball · Volleyball")}</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
