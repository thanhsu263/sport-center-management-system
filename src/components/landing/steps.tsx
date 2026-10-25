import { useRef } from "react";
import { GLBackground } from "@/components/fx";
import { gsap, useScene } from "@/lib/gsap";
import { t } from "@/lib/i18n";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";
import { useVenue } from "./util";

/**
 * How booking works, told as you scroll.
 *
 * On a computer the section holds still while the scroll draws the line from step to step, and
 * each step lights up as the line reaches it: pick, hold, pay, in the order a booking really
 * happens. On a phone the steps simply arrive one after another. The markup at rest is the
 * finished picture (every step lit, the line drawn), which is what reduced motion gets.
 */
export function StepsScene() {
  const venue = useVenue();
  const root = useRef<HTMLElement>(null);
  const steps = [
    {
      n: "01",
      title: t("Pick your slot"),
      body: t("See which courts are free, hour by hour."),
    },
    { n: "02", title: t("Hold it for {n} minutes", { n: venue.holdMinutes }), body: t("The slot is held for you. You do not pay yet.") },
    {
      n: "03",
      title: t("Pay at the desk"),
      body: t("Pay at reception by cash, bank transfer or your plan's court hours."),
    },
  ];

  useScene(root, ({ motion, desktop }) => {
    const el = root.current;
    if (!motion || !el) return;
    rise(el, "[data-rise]");
    const q = gsap.utils.selector(el);
    if (!desktop) {
      rise(el, "[data-step]", { stagger: 0.14 });
      return;
    }
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue("--color-muted").trim() || "#424c6b";
    const lit = css.getPropertyValue("--color-accent-fg").trim() || "#ffffff";
    const tl = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: { trigger: el, start: "center center", end: "+=110%", pin: true, scrub: 0.6 },
    });
    tl.fromTo(q("[data-line]"), { scaleX: 0 }, { scaleX: 1, duration: 3 }, 0);
    q("[data-step]").forEach((step, i) => {
      const at = i * 1.1;
      tl.fromTo(step.querySelector("[data-fill]"), { scale: 0 }, { scale: 1, duration: 0.45, ease: "arena" }, at);
      tl.fromTo(step.querySelector("[data-num]"), { color: muted }, { color: lit, duration: 0.3 }, at + 0.1);
      tl.fromTo(step.querySelectorAll("[data-copy]"), { opacity: 0.28, y: 10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.1 }, at);
    });
  });

  return (
    <section ref={root} id="how" className="relative mx-auto max-w-6xl scroll-mt-20 px-4 py-20">
      {/* Pointer-reactive dot field: costs nothing while the cursor is still. */}
      <GLBackground variant="dotgrid" className="-z-[1]" color="#3f7d20" gap={30} opacity={0.22} />
      <p data-rise className="kicker text-2xs text-muted">
        {t("Booking")}
      </p>
      <h2 className="mt-2 max-w-xl font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("How to book a court")} />
      </h2>

      <div className="relative mt-10">
        <div aria-hidden className="absolute left-0 right-0 top-6 hidden h-px bg-line-strong/60 md:block">
          <div data-line className="h-full origin-left bg-accent" />
        </div>
        <ol className="grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} data-step className="relative">
              <span className="relative z-[1] grid size-12 place-items-center overflow-hidden rounded-full bg-wood shadow-[var(--shadow-accent)]">
                <span data-fill aria-hidden className="absolute inset-0 rounded-full bg-accent" />
                <span data-num className="athletic relative pt-0.5 text-lg tabular-nums text-accent-fg">
                  {s.n}
                </span>
              </span>
              <h3 data-copy className="mt-5 font-display text-2xl">
                {s.title}
              </h3>
              <p data-copy className="mt-2 text-sm leading-relaxed text-muted">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
