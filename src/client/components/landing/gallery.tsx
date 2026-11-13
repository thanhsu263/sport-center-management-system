import { useRef } from "react";
import { Cover } from "@/client/components/media";
import { t } from "@/client/lib/i18n";
import { ScrollTrigger, gsap, useScene } from "@/client/lib/gsap";
import { rise } from "./tweens";

/**
 * Photos of the halls. A hard scroll bends the frames a little in the direction of travel and
 * they spring back when you stop, so the wall of photos feels like it has weight. Without motion
 * the grid simply sits still.
 */
export function GalleryScene() {
  const root = useRef<HTMLElement>(null);
  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el) return;
    rise(el, "[data-rise]", { stagger: 0.08 });

    // The bend lives on an inner wrapper, so it never fights the rise or the hover lift.
    const warps = el.querySelectorAll("[data-warp]");
    const skew = gsap.quickTo(warps, "skewY", { duration: 0.6, ease: "power3.out" });
    const stretch = gsap.quickTo(warps, "scaleY", { duration: 0.6, ease: "power3.out" });
    let rest = 0;
    ScrollTrigger.create({
      trigger: el,
      start: "top bottom",
      end: "bottom top",
      onUpdate: (self) => {
        const v = gsap.utils.clamp(-1, 1, self.getVelocity() / 3000);
        skew(v * -3);
        stretch(1 + Math.abs(v) * 0.04);
        clearTimeout(rest);
        rest = window.setTimeout(() => {
          skew(0);
          stretch(1);
        }, 90);
      },
    });
    return () => clearTimeout(rest);
  });

  const slots = [
    "landing.gallery.1",
    "landing.gallery.2",
    "landing.gallery.3",
    "landing.gallery.4",
    "landing.gallery.5",
    "landing.gallery.6",
    "landing.gallery.7",
    "landing.gallery.8",
  ];

  return (
    <section ref={root} className="mx-4 my-20 md:mx-auto md:max-w-6xl">
      <div data-rise className="mb-8 text-center">
        <p className="font-mono text-2xs uppercase tracking-widest text-accent-text">
          {t("Photos")}
        </p>
        <h2 className="athletic mt-2 text-4xl text-fg sm:text-5xl">
          {t("Courts and matches")}
        </h2>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        {slots.map((slot) => (
          <div
            key={slot}
            data-rise
            className="group relative overflow-hidden rounded-[var(--radius-lg)] border border-line bg-wood shadow-[var(--shadow-soft)] transition-transform duration-300 hover:-translate-y-1"
          >
            <div data-warp className="origin-center will-change-transform">
              <Cover
                slot={slot}
                className="aspect-[4/3] w-full"
                imgClassName="transition-transform duration-500 group-hover:scale-105"
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
