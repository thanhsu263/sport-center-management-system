import { useRef } from "react";
import { GLBackground } from "@/client/components/fx";
import { gsap, useScene } from "@/client/lib/gsap";
import { t } from "@/client/lib/i18n";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";

/**
 * How booking works, told as you scroll, on paper.
 *
 * The one light section on a floodlit page, set like a printed programme: a loud three-word
 * heading on the left, the steps as ruled rows on the right. On a computer the section holds
 * still while a floodlit block moves from row to row and a huge numeral rolls on beside the heading:
 * pick, hold, pay, in the order a booking really happens. On a phone the rows simply arrive one after
 * another. The markup at rest is the finished picture, which is what reduced motion gets.
 */
export function StepsScene() {
  const root = useRef<HTMLElement>(null);
  const steps = [
    {
      n: "01",
      title: t("Pick your class"),
      body: t("Choose a sport, a level and a coach. Every class shows its timetable and the seats left."),
      tag: t("Open classes"),
    },
    {
      n: "02",
      title: t("Enrol in the app"),
      body: t("Seats go to whoever signs up first. Your membership has to run past the last session."),
      tag: t("First come, first served"),
    },
    {
      n: "03",
      title: t("Train with your coach"),
      body: t("Every session lands in your schedule. Show your pass at the gate and the coach marks you in."),
      tag: t("Coach-led"),
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
    const ink = css.getPropertyValue("--color-paper-ink").trim() || "#121410";
    const tl = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: { trigger: el, start: "top top", end: "+=170%", pin: true, scrub: 0.6, invalidateOnRefresh: true },
    });
    const rows = q("[data-step]");
    const block = q("[data-block]")[0];
    const roll = q("[data-roll]")[0];
    gsap.set(q("[data-stage]"), { autoAlpha: 1 });
    gsap.set(block, { autoAlpha: 1, y: () => rows[0].offsetTop, height: () => rows[0].offsetHeight });
    tl.fromTo(q("h2"), { y: 28 }, { y: -28, duration: 3.4 }, 0);
    // The dot marks the step you are on, so it keeps breathing even when the scroll rests.
    gsap.to(q("[data-pulse]"), { scale: 1.7, opacity: 0.35, duration: 0.9, ease: "sine.inOut", repeat: -1, yoyo: true });
    rows.forEach((step, i) => {
      const at = i * 1.1;
      if (i > 0) {
        tl.to(block, { y: () => step.offsetTop, height: () => step.offsetHeight, duration: 0.55, ease: "power3.inOut" }, at - 0.3);
        tl.to(roll, { yPercent: (-100 / rows.length) * i, duration: 0.55, ease: "back.inOut(1.6)" }, at - 0.3);
        tl.to(rows[i - 1].querySelectorAll("[data-copy]"), { opacity: 0.6, duration: 0.3 }, at - 0.2);
      }
      tl.fromTo(step, { x: 28 }, { x: 0, duration: 0.6, ease: "power3.out" }, at - 0.1);
      tl.fromTo(step.querySelector("[data-rule]"), { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "power2.out" }, at);
      tl.fromTo(step.querySelector("[data-num]"), { color: "rgb(18 20 16 / 0.18)" }, { color: ink, duration: 0.4 }, at + 0.15);
      tl.fromTo(step.querySelectorAll("[data-copy]"), { opacity: 0.28, y: 10 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.1 }, at);
      tl.fromTo(step.querySelector("[data-tag]"), { autoAlpha: 0, x: 12 }, { autoAlpha: 1, x: 0, duration: 0.4 }, at + 0.4);
    });
  });

  return (
    // Fills the viewport on desktop so the pin never shows the dark page above or below the paper.
    <section ref={root} id="how" className="relative scroll-mt-20 overflow-hidden bg-paper text-paper-ink md:flex md:min-h-svh md:items-center">
      {/* Pointer-reactive dot field, pressed lightly into the paper like a print screen: small dots
          that barely swell, so the cursor leaves a trace and not ink blots. */}
      <GLBackground variant="dotgrid" color="#121410" gap={22} dot={0.9} radius={110} opacity={0.12} />
      {/* Wide screens: the left padding keeps the heading clear of the shuttle's margin lane. */}
      <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-4 pb-14 pt-20 md:grid-cols-2 md:gap-16 md:pb-20 md:pt-24 lg:pl-[max(1rem,calc(9.5rem-(100vw-72rem)/2))]">
        <div>
          <p data-rise className="inline-block rounded-md bg-paper-ink px-2.5 py-1.5 font-mono text-2xs font-bold uppercase tracking-wider text-accent">
            {t("How to join a class")}
          </p>
          <h2 className="font-athletic mt-6 text-5xl leading-[0.95] sm:text-7xl">
            <SplitHeading text={t("Pick. Enrol. Train.")} />
          </h2>
          {/* Which step the scroll has reached, rolling like a scoreboard. Only exists with motion. */}
          <div aria-hidden data-stage className="invisible mt-8 hidden items-end gap-4 md:flex">
            <div className="h-[1em] overflow-hidden font-display text-[clamp(7rem,17vw,14rem)] leading-none tabular-nums">
              <div data-roll>
                {steps.map((s) => (
                  <div key={s.n} className="h-[1em]">{s.n}</div>
                ))}
              </div>
            </div>
            <span data-pulse className="mb-6 size-4 rounded-full bg-accent ring-2 ring-paper-ink" />
          </div>
        </div>

        <ol className="relative self-end">
          <span aria-hidden data-block className="invisible absolute -inset-x-3 top-0 rounded-md bg-accent" />
          {steps.map((s, i) => (
            <li key={s.n} data-step className="relative grid grid-cols-[3.5rem_1fr] items-start gap-x-4 gap-y-3 py-5 sm:grid-cols-[4.5rem_1fr_auto]">
              <span aria-hidden data-rule className="absolute inset-x-0 top-0 h-[1.5px] origin-left bg-paper-ink" />
              {i === steps.length - 1 ? (
                <span aria-hidden className="absolute inset-x-0 bottom-0 h-[1.5px] bg-paper-ink" />
              ) : null}
              <span data-num className="font-display text-3xl leading-none tabular-nums sm:text-4xl">
                {s.n}
              </span>
              <div>
                <h3 data-copy className="text-lg font-bold">
                  {s.title}
                </h3>
                <p data-copy className="mt-0.5 text-sm leading-relaxed text-paper-ink/65">
                  {s.body}
                </p>
              </div>
              <span
                data-tag
                className="col-start-2 justify-self-start rounded-md bg-paper-ink px-2 py-1 font-mono text-2xs font-bold uppercase tracking-wider text-accent sm:col-start-auto sm:mt-0.5 sm:justify-self-end"
              >
                {s.tag}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
