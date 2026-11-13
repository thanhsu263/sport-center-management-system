import { useRef } from "react";
import { SplitText } from "gsap/SplitText";
import { ScrollTrigger, gsap, registerGsap, useScene } from "@/client/lib/gsap";
import { t } from "@/client/lib/i18n";

registerGsap(ScrollTrigger, SplitText);

/**
 * The one paragraph on the page worth slowing down for, set on a blue court seen from the
 * baseline. Its words resolve out of a blur at whatever pace the reader scrolls (scrubbed, not
 * triggered), and finish well before the text leaves so the last words stay readable for a while.
 */
export function Manifesto() {
  const root = useRef<HTMLElement>(null);
  const text = t(
    "Every class here has a coach, a level and a fixed timetable. Pick the one that fits, enrol in the app, and each session lands in your schedule. The courts are yours to practise on in between.",
  );
  useScene(
    root,
    ({ motion }) => {
      const p = root.current?.querySelector("p");
      if (!motion || !p) return;
      SplitText.create(p, {
        type: "words",
        autoSplit: true,
        onSplit: (self) =>
          gsap.fromTo(
            self.words,
            // Unread words stay at half strength: 3:1 against the page at this size, never invisible.
            { opacity: 0.5, filter: "blur(3px)", y: 6 },
            {
              opacity: 1,
              filter: "blur(0px)",
              y: 0,
              ease: "none",
              stagger: 0.12,
              scrollTrigger: { trigger: p, start: "top 82%", end: "bottom 62%", scrub: 0.6 },
            },
          ),
      });
    },
    [text],
  );
  return (
    <section
      ref={root}
      aria-label={t("What Lê Long Sport is for")}
      className="relative overflow-hidden bg-gradient-to-b from-[#1d58c4] to-court text-white"
    >
      <div aria-hidden className="court-perspective opacity-70" />
      <div className="relative mx-auto max-w-4xl px-4 py-24 sm:py-32">
        <p key={text} className="font-display text-3xl leading-snug sm:text-[2.6rem] sm:leading-[1.2]">
          {text}
        </p>
      </div>
    </section>
  );
}
