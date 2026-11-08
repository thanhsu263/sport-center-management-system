import { useRef, type ElementType } from "react";
import { SplitText } from "gsap/SplitText";
import { ScrollTrigger, gsap, registerGsap, useScene } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { countText } from "./tweens";

registerGsap(ScrollTrigger, SplitText);

/*
 * Small pieces every landing scene shares.
 *
 * Anything GSAP rewrites (a split heading, a counting number, scrambled text) is rendered with
 * `key={text}`. GSAP replaces the text node React put there; if React later tried to patch that
 * node it would be patching a node no longer in the page. Keyed, a new text means a new element.
 */

/**
 * A heading whose words rise out of a line mask as it scrolls into view.
 * Split by words and lines, never characters: Vietnamese tone marks must stay with their letter.
 */
export function SplitHeading({
  text,
  as: Tag = "span",
  className,
  delay = 0,
  stagger = 0.06,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  delay?: number;
  stagger?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  useScene(
    ref,
    ({ motion }) => {
      const el = ref.current;
      if (!motion || !el) return;
      SplitText.create(el, {
        type: "words,lines",
        mask: "lines",
        autoSplit: true,
        onSplit: (self) =>
          gsap.fromTo(self.words, { yPercent: 115 }, {
            yPercent: 0,
            duration: 0.85,
            stagger,
            delay,
            ease: "arena-out",
            scrollTrigger: { trigger: el, start: "top 90%", once: true },
          }),
      });
    },
    [text],
  );
  return (
    <Tag key={text} ref={ref} className={cn("block", className)}>
      {text}
    </Tag>
  );
}

/** A number that counts up from zero the first time it scrolls into view. */
export function CountTo({
  value,
  format = (n: number) => String(Math.round(n)),
  suffix = "",
  className,
  duration = 1.4,
}: {
  value: number;
  format?: (n: number) => string;
  suffix?: string;
  className?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useScene(
    ref,
    ({ motion }) => {
      const el = ref.current;
      if (!motion || !el) return;
      const tween = countText(el, value, { format, suffix, duration });
      tween.pause();
      ScrollTrigger.create({ trigger: el, start: "top 92%", once: true, onEnter: () => void tween.play() });
      return () => {
        el.textContent = `${format(value)}${suffix}`;
      };
    },
    [value, suffix],
  );
  return (
    <span key={`${value}${suffix}`} ref={ref} className={cn("tabular-nums", className)}>
      {`${format(value)}${suffix}`}
    </span>
  );
}
