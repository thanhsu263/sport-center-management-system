import { useRef } from "react";
import { Cover } from "@/components/media";
import { t } from "@/lib/i18n";
import { useScene } from "@/lib/gsap";
import { rise } from "./tweens";

export function GalleryScene() {
  const root = useRef<HTMLElement>(null);
  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!motion || !el) return;
    rise(el, "[data-rise]", { stagger: 0.08 });
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
            <Cover
              slot={slot}
              className="aspect-[4/3] w-full"
              imgClassName="transition-transform duration-500 group-hover:scale-105"
            />
          </div>
        ))}
      </div>
    </section>
  );
}
