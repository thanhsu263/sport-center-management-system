import { useRef } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { SplitText } from "gsap/SplitText";
import { HeroVideo, useBootOpen } from "@/components/media";
import { ButtonAnchor } from "@/components/ui";
import { GLBackground, ShinyText } from "@/components/fx";
import { money } from "@/components/shell";
import { ScrollTrigger, gsap, registerGsap, useScene } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";
import { t, useLang } from "@/lib/i18n";
import { useSports } from "@/components/sports-ui";
import { CountTo } from "./kit";
import { mark, rich, useVenue } from "./util";
import { hhmm } from "@/lib/venue";
import type { CatalogCourt } from "@/lib/arena3/catalog";

registerGsap(ScrollTrigger, SplitText, ScrambleTextPlugin, MotionPathPlugin);

/**
 * The first screen, played as one timeline.
 *
 * The hall settles into frame, the open/closed line decodes itself, the headline rises line by
 * line, and the live number of free court hours counts up: the one thing a photograph cannot
 * say. Then a shuttle is served in from the right and lands on "Book a court", which is the
 * sentence the whole page is building to. Scrolling away, the copy drifts up faster than the
 * footage behind it.
 *
 * Elements marked `data-enter` start hidden in CSS (styles.css) only when motion is allowed, so
 * the server-rendered page never shows the copy for a frame before the timeline hides it.
 */
export function Hero({
  isOpen,
  freeHours,
  day,
  cheapestHour,
}: {
  isOpen: boolean | null;
  freeHours: number;
  day: string;
  cheapestHour: number;
}) {
  const root = useRef<HTMLElement>(null);
  const calm = useCalm();
  // The intro plays once the boot cover lifts; run under the cover, nobody would see it.
  const open = useBootOpen();
  const venue = useVenue();
  const status =
    isOpen == null
      ? t("Indoor sports centre")
      : isOpen
        ? t("Open now · until {time}", { time: hhmm(venue.close) })
        : t("Closed · opens {time}", { time: hhmm(venue.open) });

  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el || !open) return;
    const q = gsap.utils.selector(el);

    // Measure the serve before any entrance tween moves the button.
    const shuttle = q("[data-shuttle]")[0];
    const target = q("[data-cta] > :first-child")[0];
    let path: { x: number; y: number }[] | null = null;
    if (shuttle && target) {
      const box = el.getBoundingClientRect();
      const tb = target.getBoundingClientRect();
      const end = { x: tb.left - box.left + tb.width * 0.82, y: tb.top - box.top - 6 };
      const start = { x: box.width + 60, y: box.height * 0.18 };
      const apex = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - box.height * 0.16 };
      path = [start, apex, end];
    }

    gsap.set(q("[data-enter]"), { visibility: "visible" });

    const tl = gsap.timeline({ defaults: { ease: "arena-out" } });
    tl.fromTo(q("[data-media]"), { scale: 1.12 }, { scale: 1, duration: 2.4 }, 0);

    const line1 = q("[data-line1]")[0];
    if (line1) {
      const split = SplitText.create(line1, { type: "words,lines", mask: "lines" });
      tl.fromTo(split.words, { yPercent: 115 }, { yPercent: 0, duration: 0.9, stagger: 0.08 }, 0.35);
    }
    // The payoff line keeps its gradient whole, so it is unveiled rather than split.
    tl.fromTo(
      q("[data-line2]"),
      { clipPath: "inset(-20% 100% -20% 0)", x: -18 },
      { clipPath: "inset(-20% 0% -20% 0)", x: 0, duration: 1.1 },
      0.8,
    );
    tl.fromTo(q("[data-status]"), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.6 }, 0.15);
    tl.fromTo(q("[data-sub]"), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.7 }, 1.15);
    tl.fromTo(q("[data-cta] > *"), { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.08 }, 1.3);
    tl.fromTo(q("[data-free]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6 }, 1.5);
    tl.fromTo(q("[data-cue]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6 }, 1.9);

    // The serve: in from off-screen right, over the top, down onto the primary button.
    if (shuttle && target && path) {
      tl.set(shuttle, { autoAlpha: 1, x: path[0].x, y: path[0].y }, 1.45);
      tl.to(
        shuttle,
        { duration: 1.5, ease: "sine.inOut", motionPath: { path, curviness: 1.25, autoRotate: -90 } },
        1.45,
      );
      tl.to(shuttle, { autoAlpha: 0, scale: 0.4, duration: 0.25, ease: "power2.in" });
      tl.fromTo(target, { scale: 1 }, { scale: 1.06, duration: 0.14, yoyo: true, repeat: 1, ease: "power1.inOut" }, "<");
    }

    // The scroll cue's runner, and the copy lifting away faster than the hall as you leave.
    gsap.fromTo(q("[data-cue-run]"), { y: -20 }, { y: 48, duration: 2.1, ease: "sine.inOut", repeat: -1, delay: 2 });
    // Plain scroll positions from layout (the hero's top reaching the top of the view, then its
    // bottom leaving it), with no trigger element on purpose. The footage's data-speed="auto"
    // makes the smoother use this section as that effect's trigger and shift any other trigger on
    // it by the effect's offset; measured mid-intro, while the footage still scales, that shift was
    // hundreds of pixels and left the copy half faded at the very top of the page.
    gsap.to(q("[data-copy]"), {
      yPercent: -18,
      autoAlpha: 0.15,
      ease: "none",
      scrollTrigger: {
        start: () => el.offsetTop,
        end: () => el.offsetTop + el.offsetHeight,
        scrub: true,
        invalidateOnRefresh: true,
      },
    });
  }, [open]);

  return (
    <section ref={root} className="grain relative min-h-[88dvh] overflow-hidden">
      {/* Taller than the frame and slowed by the smoother, so the hall lags behind the copy. */}
      <div data-media data-speed="auto" className="absolute inset-x-0 -top-[8%] h-[116%]">
        <HeroVideo slot="landing.hero.video" posterSlot="landing.hero.image" priority />
      </div>
      <div className="hero-scrim pointer-events-none absolute inset-0" />
      <GLBackground
        variant="threads"
        className="opacity-60 mix-blend-screen"
        color="#e6eed9"
        amplitude={1.2}
        speed={0.55}
        opacity={0.32}
      />

      <div className="relative mx-auto flex min-h-[88dvh] max-w-6xl flex-col justify-end px-4 pb-16 pt-24">
        {/* No panel: the headline sits on the footage, the scrim and `.on-media` shadow carry it. */}
        <div data-copy className="max-w-2xl text-on-media on-media">
          <div data-enter data-status className="flex items-center gap-2.5">
            <span className="relative inline-flex size-2 text-on-media">
              {isOpen ? <span className="ping-ring" /> : null}
              <span
                className={`relative inline-flex size-2 rounded-full ${
                  isOpen === false ? "bg-on-media-muted/55" : "bg-on-media"
                }`}
              />
            </span>
            <p className="kicker text-2xs text-on-media-muted">
              <ShinyText className="shiny-on-media" speed={6}>
                <Scramble text={status} />
              </ShinyText>
            </p>
          </div>

          {/* One headline, two lines: the setup in white, the payoff tinted. */}
          <h1 data-enter className="mt-4">
            <span key={t("Book courts and classes")} data-line1 className="block font-display text-4xl font-bold leading-[1.05] sm:text-6xl">
              {t("Book courts and classes")}
            </span>
            <span className="media-glow block font-display text-4xl font-bold leading-[1.05] sm:text-6xl">
              <span data-line2 className="text-gradient-media inline-block py-[0.3em] -my-[0.3em]">
                {t("at Lê Long Sport Center.")}
              </span>
            </span>
          </h1>

          <p data-enter data-sub className="mt-5 max-w-lg text-on-media-muted">
            {t("Indoor sports centre. Open {open}-{close}, every day. Book a court online or at the front desk.", {
              open: hhmm(venue.open),
              close: hhmm(venue.close),
            })}
          </p>

          {/* The order is the funnel: see a free hour, take it, come back. Membership is the third visit. */}
          <div data-enter data-cta className="mt-8 flex flex-wrap gap-3">
            <ButtonAnchor
              href="#schedule"
              size="lg"
              className="group bg-volt text-night font-semibold shadow-[var(--shadow-soft)] hover:bg-volt/90 hover:shadow-[var(--shadow-soft)]"
            >
              {t("Book a court")}
              <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
            </ButtonAnchor>
            <ButtonAnchor
              href="#courts"
              variant="outline"
              size="lg"
              className="group border-on-media/40 bg-on-media/10 text-on-media shadow-none backdrop-blur-sm hover:border-on-media/70 hover:bg-on-media/20"
            >
              {t("See courts & pricing")}
              <ArrowUpRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </ButtonAnchor>
          </div>

          {/* The live number is the argument for the button above. */}
          <p data-enter data-free className="mt-4 text-sm text-on-media-muted">
            {rich(
              t("{n} court hours free {day} · from {price}/hr · a slot you pick is held for {hold} minutes.", {
                hold: venue.holdMinutes,
                n: mark("n"),
                day,
                price: mark("price"),
              }),
              {
                n: <LiveCount value={freeHours} className="text-on-media" />,
                price: <span className="tabular-nums text-on-media">{money(cheapestHour)}</span>,
              },
            )}
            <span className="mt-1 block">
              <a href="#plans" className="link-underline hit text-on-media">
                {t("Or see membership plans")}
              </a>
            </span>
          </p>
        </div>
      </div>

      {/* The shuttle that is served onto "Book a court". Decorative, so hidden from readers. */}
      <Shuttle />

      {/* Scroll cue: the word says what it is, the running rule does the pointing. */}
      {calm ? null : (
        <div
          data-cue
          aria-hidden
          className="pointer-events-none absolute bottom-7 right-6 hidden flex-col items-center gap-2 lg:flex"
        >
          <span className="kicker text-2xs text-on-media-muted">{t("Scroll")}</span>
          <span className="relative block h-12 w-px overflow-hidden bg-on-media/25">
            <span data-cue-run className="absolute inset-x-0 top-0 block h-5 bg-on-media/80" />
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * The live count of free hours. It first counts up as the hero finishes arriving; after that, when
 * the clock moves an hour along and the number changes, it rolls from the old figure to the new.
 */
function LiveCount({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<number | null>(null);
  const born = useRef<number | null>(null);
  useScene(
    ref,
    ({ motion }) => {
      const el = ref.current;
      born.current ??= performance.now();
      // The line fades in 1.6s after the hero starts; until then the count waits and starts from 0,
      // even if the figure was corrected in the meantime (the clock arrives a tick after mount).
      const wait = 1.6 - (performance.now() - born.current) / 1000;
      const from = wait > 0 ? 0 : (prev.current ?? 0);
      prev.current = value;
      if (!motion || !el) return;
      const o = { v: from };
      const paint = () => {
        el.textContent = String(Math.round(o.v));
      };
      paint();
      gsap.to(o, { v: value, duration: 1.2, delay: Math.max(0, wait), ease: "power3.out", onUpdate: paint, onComplete: paint });
      return () => {
        el.textContent = String(value);
      };
    },
    [value],
  );
  return (
    <span key={value} ref={ref} className={`tabular-nums ${className ?? ""}`}>
      {value}
    </span>
  );
}

/** Text that decodes into place, and decodes again whenever it changes (closed → open). */
function Scramble({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useScene(
    ref,
    ({ motion }) => {
      const el = ref.current;
      if (!motion || !el) return;
      gsap.to(el, { duration: 1, scrambleText: { text, chars: "upperCase", speed: 0.5, revealDelay: 0.15 } });
      return () => {
        el.textContent = text;
      };
    },
    [text],
  );
  return (
    <span key={text} ref={ref}>
      {text}
    </span>
  );
}

function Shuttle() {
  return (
    <span
      data-shuttle
      aria-hidden
      className="pointer-events-none invisible absolute left-0 top-0 z-[2] block size-9 -translate-x-1/2 -translate-y-1/2 text-on-media drop-shadow-[0_6px_14px_rgba(4,8,28,0.55)]"
    >
      <svg viewBox="0 0 32 32" className="size-full" fill="none" stroke="currentColor" strokeLinejoin="round">
        {/* Cork at the bottom, feathers fanning up: the cork leads when it flies. */}
        <path d="M11.5 26a4.5 4.5 0 0 0 9 0z" fill="currentColor" stroke="none" />
        <path d="M11.5 26 7 5h18l-4.5 21" strokeWidth="1.6" />
        <path d="M16 26V5M13.6 26 12 5M18.4 26 20 5M8.4 11.5h15.2M9.9 18.5h12.2" strokeWidth="1.1" />
      </svg>
    </span>
  );
}

/**
 * The band that earns the centre's credibility in three seconds: each figure carries the line
 * that makes it checkable, and the first is today's live count. The numbers count up as the band
 * arrives; the cells rise in one after another.
 */
export function StatsBand({ freeHours, day, courts }: { freeHours: number; day: string; courts?: CatalogCourt[] }) {
  const venue = useVenue();
  const root = useRef<HTMLElement>(null);
  useScene(root, ({ motion }) => {
    if (!motion || !root.current) return;
    gsap.fromTo(root.current.querySelectorAll("[data-cell]"), { autoAlpha: 0, y: 26 }, {
      autoAlpha: 1,
      y: 0,
      duration: 0.8,
      stagger: 0.09,
      scrollTrigger: { trigger: root.current, start: "top 85%", once: true },
    });
  });
  const { sports } = useSports();
  const lang = useLang();
  const liveCourts = courts ? courts.filter((c) => c.status !== "retired") : [];
  const totalCourts = liveCourts.length || 16;
  const sportsSummary = sports
    .map((s) => {
      const cnt = liveCourts.filter((c) => c.sport === s.code).length;
      return `${cnt} ${lang === "vi" ? s.name_vi : s.name_en}`;
    })
    .join(" · ");
  const courtsNote = sportsSummary || t("All active courts and halls");

  const stats = [
    { to: freeHours, suffix: "", label: t("Court hours free"), note: t("Live from the booking grid · {day}", { day }), href: "#schedule" },
    { to: totalCourts, suffix: "", label: t("Courts & bays"), note: courtsNote, href: "#courts" },
    { to: venue.close - venue.open, suffix: "h", label: t("Open every day"), note: t("{open}-{close}, every day", { open: hhmm(venue.open), close: hhmm(venue.close) }), href: "#schedule" },
    { to: 4, suffix: "", label: t("Head coaches"), note: t("One head coach per sport"), href: "#coaches" },
  ];
  return (
    <section ref={root} className="grain relative overflow-hidden bg-night text-on-media">
      <GLBackground
        variant="aurora"
        colors={["#3f7d20", "#8bc34a", "#b5e04a"]}
        amplitude={1.15}
        speed={0.85}
        opacity={0.6}
        fallback={<div className="wash wash-accent -left-24 -top-32 size-80 opacity-70" />}
      />
      <div className="relative z-[1] grid grid-cols-2 gap-px bg-on-media/12 lg:grid-cols-4">
        {stats.map((s) => (
          <a
            key={s.label}
            data-cell
            href={s.href}
            className="group bg-night/72 px-5 py-8 text-center backdrop-blur-[2px] transition-colors duration-200 hover:bg-night/60 sm:py-11"
          >
            <p className="figure text-5xl tabular-nums sm:text-6xl">
              <CountTo value={s.to} suffix={s.suffix} />
            </p>
            <p className="kicker mt-3 text-2xs text-on-media">{s.label}</p>
            <p className="mx-auto mt-1.5 max-w-[16rem] text-xs leading-relaxed text-on-media-muted">{s.note}</p>
          </a>
        ))}
      </div>
    </section>
  );
}
