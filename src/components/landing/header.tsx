import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { ArenaMark } from "@/components/mark";
import { LangSwitch } from "@/components/lang-switch";
import { ButtonAnchor, ButtonLink } from "@/components/ui";
import { ScrollTrigger, gsap, useScene } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { t, tk } from "@/lib/i18n";

/**
 * The public nav, in business order.
 *
 * Not everything on this page matters equally. Somebody arriving has one
 * question — when can I get on a court — so the schedule is first and the
 * things that only matter once they have played (coaches, plans) come after.
 * Facilities and "how it works" moved to the footer: they are reassurance, and
 * reassurance does not belong in front of the decision.
 */
const NAV: [string, string][] = [
  ["#schedule", tk("Today's schedule")],
  ["#courts", tk("Courts & pricing")],
  ["#classes", tk("Classes")],
  ["#coaches", tk("Coaches")],
  ["#plans", tk("Plans")],
];

/**
 * The landing header, fixed above the smoothed page.
 *
 * It gets out of the way going down the page and comes back the instant you
 * scroll up, which is what people reach for when they want the nav again. The
 * hamburger below `xl` opens the same links as a sheet. A thin bar along its top
 * edge fills with how far down the page you are.
 */
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const showRef = useRef<() => void>(() => undefined);

  useScene(root, ({ motion }) => {
    const el = root.current;
    if (!el) return;
    // The progress bar is a reading of the scroll position, not motion of its own, so it stays on
    // under reduced motion; it just stops easing.
    gsap.fromTo(
      bar.current,
      { scaleX: 0 },
      { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: motion ? 0.4 : true } },
    );
    if (!motion) return;
    let hidden = false;
    // Made now, inside the scene, so reverting it (breakpoint, unmount) always returns the header.
    const slide = gsap.quickTo(el, "yPercent", { duration: 0.32, ease: "arena" });
    const show = (next: boolean) => {
      if (next === hidden) return;
      hidden = next;
      slide(next ? -100 : 0);
    };
    showRef.current = () => show(false);
    ScrollTrigger.create({
      start: 0,
      end: "max",
      onUpdate: (self) => {
        const y = self.scroll();
        // Ignore the top of the page and the rubber band, and never hide over an open sheet.
        if (y < 96 || openRef.current) return show(false);
        if (Math.abs(self.getVelocity()) < 40) return;
        show(self.direction === 1);
      },
    });
    return () => {
      showRef.current = () => undefined;
    };
  });

  // Opening the sheet brings a hidden header back.
  useEffect(() => {
    if (open) showRef.current();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header ref={root} className="fixed inset-x-0 top-0 z-30 border-b border-line/70 glass">
      <div ref={bar} aria-hidden className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-accent" />
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="group flex min-h-11 items-center gap-2.5" onClick={() => setOpen(false)}>
          <span className="inline-flex transition-transform duration-300 ease-[var(--ease-smooth)] group-hover:-rotate-6 group-hover:scale-105">
            <ArenaMark className="size-8" />
          </span>
          <span className="font-display text-xl font-bold">Lê Long Sport Center</span>
        </Link>
        {/* Same voice as the signed-in header: a row of quiet pills. */}
        <nav className="hidden items-center gap-1 xl:flex">
          {NAV.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="flex h-9 items-center whitespace-nowrap rounded-[var(--radius-md)] px-3 text-xs font-semibold text-muted transition-colors duration-200 hover:bg-wood hover:text-fg"
            >
              {t(label)}
            </a>
          ))}
        </nav>
        {/* Two zones: what the centre sells is left of the rule, what belongs to a person is right. */}
        <div className="hidden items-center gap-2 md:flex">
          <ButtonAnchor href="#schedule">{t("Book a court")}</ButtonAnchor>
          <span aria-hidden className="mx-1 h-6 w-px bg-line-strong/70" />
          <ButtonLink to="/login" variant="ghost">
            {t("Sign in")}
          </ButtonLink>
          <ButtonLink to="/register" variant="outline">
            {t("Join")}
          </ButtonLink>
          <LangSwitch />
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? t("Close menu") : t("Open menu")}
          className="grid size-11 place-items-center rounded-[var(--radius-md)] border border-line bg-surface/70 text-fg transition-colors duration-200 hover:border-accent hover:bg-wood xl:hidden"
        >
          {open ? <X className="size-5" strokeWidth={1.75} /> : <Menu className="size-5" strokeWidth={1.75} />}
        </button>
      </div>

      {/* The sheet opens by growing its row from 0fr to 1fr; `inert` keeps it out of the tab order while shut. */}
      <div
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-[var(--ease-smooth)] xl:hidden",
          open ? "grid-rows-[1fr] border-t border-line/70" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden bg-surface/95 backdrop-blur-sm">
          <nav className="mx-auto grid max-w-6xl gap-1 px-4 py-3">
            <ButtonAnchor href="#schedule" onClick={() => setOpen(false)} className="mb-1 w-full">
              {t("Book a court")}
            </ButtonAnchor>
            {NAV.slice(1).map(([href, label]) => (
              <a
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className="rounded-[var(--radius-md)] px-3 py-3 text-sm font-medium text-fg transition-colors duration-200 hover:bg-wood"
              >
                {t(label)}
              </a>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2 border-t border-line/70 pt-3">
              <ButtonLink to="/login" variant="outline" onClick={() => setOpen(false)} className="w-full">
                {t("Sign in")}
              </ButtonLink>
              <ButtonLink to="/register" onClick={() => setOpen(false)} className="w-full">
                {t("Join")}
              </ButtonLink>
            </div>
            <div className="flex items-center justify-center gap-2 pt-1 md:hidden">
              <LangSwitch />
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
}
