import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Quote } from "lucide-react";
import { Card } from "@/components/ui";
import { gsap, motionOff, useGSAP, useScene } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";
import { t, tk } from "@/lib/i18n";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";

/** Demo member quotes, keyed to the seeded member profiles. */
const TESTIMONIALS = [
  {
    quote: tk(
      "I book between meetings and the court is simply there when I arrive. The five-minute hold is the reason I stopped ringing ahead.",
    ),
    name: "Nguyễn Văn Nam",
    meta: tk("Badminton · A3-2026-0001"),
  },
  {
    quote: tk(
      "The beginner ladder moved me onto a real training plan without it ever feeling like a test, and my knee has been fine since the coach reworked my footwork.",
    ),
    name: "Trần Mỹ Linh",
    meta: tk("Badminton · A3-2026-0002"),
  },
  {
    quote: tk(
      "Plan hours come straight off at the desk. No cash, no working out what counts as peak, no arguing about the price on a Saturday morning.",
    ),
    name: "Phạm Hoàng Long",
    meta: tk("Badminton · A3-2026-0003"),
  },
];

const OFFSET = 24;
/** Where a card sits `d` places behind the front one. */
const at = (d: number, n: number) => ({
  x: d * OFFSET,
  y: d * -OFFSET * 0.55,
  scale: 1 - d * 0.055,
  rotation: d * 1.6,
  autoAlpha: d > 2 ? 0 : 1,
  zIndex: n - d,
});

/**
 * Quote deck: the cards sit in a physical stack and the reader moves them.
 *
 * Nothing here is time-sensitive, so it never advances on its own; the arrows, the dots and a
 * click on a card behind are the only things that turn it. The server renders the stack in its
 * first position; from then on GSAP alone moves the cards, so React and GSAP never fight over the
 * same transform. The cards behind are `aria-hidden`; the controls are what keyboard and
 * screen-reader users drive.
 */
export function Testimonials() {
  const root = useRef<HTMLElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const calm = useCalm();
  const n = TESTIMONIALS.length;
  const step = (d: number) => setI((prev) => (prev + d + n) % n);

  useScene(root, ({ motion }) => {
    if (motion && root.current) rise(root.current, "[data-rise]");
  });

  useGSAP(
    () => {
      const cards = gsap.utils.toArray<HTMLElement>("[data-quote]", deck.current);
      const still = motionOff(calm);
      cards.forEach((card, k) => {
        const { zIndex, ...pose } = at((k - i + n) % n, n);
        // The new front card comes up on top at once; everything else glides to its place.
        gsap.set(card, { zIndex });
        gsap.to(card, { ...pose, duration: still ? 0 : 0.65, ease: "arena", overwrite: true });
      });
    },
    { dependencies: [i, calm], scope: deck },
  );

  return (
    <section ref={root} aria-label={t("What members say")} className="mx-auto max-w-6xl px-4 pb-24">
      <p data-rise className="kicker text-2xs text-muted">
        {t("Members")}
      </p>
      <h2 className="mt-2 font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("What the regulars say")} />
      </h2>

      {/* Right/top padding leaves room for the offset cards behind. */}
      <div data-rise className="mt-10 pr-14 pt-8">
        <div ref={deck} className="relative h-[23rem] sm:h-[19rem]">
          {TESTIMONIALS.map((q, k) => {
            const d = (k - i + n) % n;
            const p = at(k, n);
            return (
              <div
                key={q.name}
                data-quote
                aria-hidden={d !== 0}
                onClick={d === 0 ? undefined : () => setI(k)}
                className={`absolute inset-0 ${d === 0 ? "" : "cursor-pointer"}`}
                // First position only; GSAP owns these from the first change on.
                style={{
                  transform: `translate(${p.x}px, ${p.y}px) rotate(${p.rotation}deg) scale(${p.scale})`,
                  opacity: p.autoAlpha,
                  zIndex: p.zIndex,
                }}
              >
                <Card className="relative flex h-full flex-col overflow-hidden p-0">
                  <div className="wash wash-accent -right-24 -top-28 size-72 opacity-40" />
                  <blockquote className="relative flex h-full flex-col p-6 sm:p-10">
                    <Quote className="size-8 shrink-0 text-accent/45" strokeWidth={1.5} />
                    <p className="mt-5 max-w-3xl flex-1 font-display text-xl leading-snug sm:text-3xl">“{t(q.quote)}”</p>
                    <footer className="mt-5 shrink-0">
                      <p className="athletic text-lg">{q.name}</p>
                      <p className="kicker mt-1.5 text-2xs text-muted">{t(q.meta)}</p>
                    </footer>
                  </blockquote>
                </Card>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-7 flex items-center gap-4">
        <div className="flex gap-2">
          <button
            type="button"
            aria-label={t("Previous quote")}
            onClick={() => step(-1)}
            className="grid size-11 place-items-center rounded-full border border-line bg-surface text-fg transition-[background-color,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-accent hover:bg-wood active:scale-95"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label={t("Next quote")}
            onClick={() => step(1)}
            className="grid size-11 place-items-center rounded-full border border-line bg-surface text-fg transition-[background-color,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-accent hover:bg-wood active:scale-95"
          >
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex gap-2">
          {TESTIMONIALS.map((x, k) => (
            <button
              key={x.name}
              type="button"
              aria-label={t("Show quote {k} of {n}", { k: k + 1, n })}
              aria-current={k === i}
              onClick={() => setI(k)}
              className="group grid h-11 min-w-11 place-items-center px-1 sm:h-6 sm:min-w-6"
            >
              <span
                className={`block h-1.5 rounded-full transition-all duration-300 ${
                  k === i ? "w-9 bg-accent" : "w-3.5 bg-line-strong group-hover:bg-muted"
                }`}
              />
            </button>
          ))}
        </div>
        <span className="ml-auto kicker text-2xs tabular-nums text-muted">
          {i + 1} / {n}
        </span>
      </div>
    </section>
  );
}
