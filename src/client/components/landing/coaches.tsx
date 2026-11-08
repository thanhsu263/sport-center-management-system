import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Flip } from "gsap/Flip";
import { Cover, MediaCaption } from "@/components/media";
import { Button, ButtonAnchor, Card, Modal, Seg } from "@/components/ui";
import { GlareHover, SpotlightCard } from "@/components/fx";
import { initials } from "@/components/shell";
import { COACHES, type CoachCard } from "@/lib/arena3/coaches";
import { sportLabel } from "@/lib/arena3/labels";
import { gsap, motionOff, registerGsap, useScene } from "@/lib/gsap";
import { useCalm } from "@/lib/calm";
import { t, useLang } from "@/lib/i18n";
import { useSports } from "@/components/sports-ui";
import { SplitHeading } from "./kit";
import { rise } from "./tweens";

registerGsap(Flip);

/**
 * One head coach per sport. Filtering by sport is a FLIP: the cards that stay slide to where
 * they now belong, the ones that arrive grow in where they land, so the eye can follow which
 * coach went where instead of reading a fresh grid. Without motion the grid simply changes.
 *
 * A card carries the three things that decide whether you want to read more (face, sport,
 * role); the rest is one click away in the dialog.
 */
export function CoachesScene({
  dbCoaches,
}: {
  dbCoaches?: Array<{ id: string; name: string; sports: string[] }>;
} = {}) {
  const root = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [sport, setSport] = useState("");
  const [open, setOpen] = useState<CoachCard | null>(null);
  const flipState = useRef<Flip.FlipState | null>(null);
  const flipHeight = useRef(0);
  const calm = useCalm();

  const allCoaches = useMemo<CoachCard[]>(() => {
    if (!dbCoaches || !dbCoaches.length) return COACHES;
    return dbCoaches.map((dbc) => {
      const match = COACHES.find((c) => c.userId === dbc.id || c.name === dbc.name);
      if (match) {
        return {
          ...match,
          userId: dbc.id,
          slot: `coach.${dbc.id}`,
        };
      }
      const sp = dbc.sports[0] ?? "";
      return {
        name: dbc.name,
        sport: sp,
        title: `${sportLabel(sp)} Coach`,
        blurb: "Dedicated coach at Lê Long Sport Center.",
        creds: dbc.sports.map((s) => sportLabel(s)),
        userId: dbc.id,
        slot: `coach.${dbc.id}`,
      };
    });
  }, [dbCoaches]);

  const coaches = allCoaches.filter((c) => !sport || c.sport === sport);

  useScene(root, ({ motion }) => {
    if (motion && root.current) rise(root.current);
  });

  const choose = (next: string) => {
    if (next === sport) return;
    if (grid.current && !motionOff(calm)) {
      flipState.current = Flip.getState(grid.current.querySelectorAll("[data-coach]"));
      flipHeight.current = grid.current.offsetHeight;
    }
    setSport(next);
  };

  // After React has laid the new grid out, play from where the cards were.
  useLayoutEffect(() => {
    const state = flipState.current;
    flipState.current = null;
    const box = grid.current;
    if (!state || !box) return;
    // `absolute` lifts the cards out of flow while they fly, so the grid would collapse and the
    // sections below jump up under them. Resize it from the old height to the new one instead,
    // started after Flip has read the new layout and held until the last card lands.
    const to = box.offsetHeight;
    const release = () => void gsap.set(box, { clearProps: "height" });
    const flip = Flip.from(state, {
      targets: box.querySelectorAll("[data-coach]"),
      duration: 0.65,
      ease: "arena",
      stagger: 0.04,
      absolute: true,
      scale: true,
      onEnter: (els) => gsap.fromTo(els, { autoAlpha: 0, scale: 0.86 }, { autoAlpha: 1, scale: 1, duration: 0.5, delay: 0.15 }),
      onComplete: release,
    });
    // Inside the Flip timeline, so it has rendered its last frame before onComplete clears it.
    flip.fromTo(box, { height: flipHeight.current }, { height: to, duration: 0.65, ease: "arena" }, 0);
    return () => {
      flip.kill();
      release();
    };
  }, [sport]);

  const { sports } = useSports();
  const lang = useLang();

  return (
    <section ref={root} id="coaches" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20">
      <p data-rise className="kicker text-2xs text-muted">
        {t("The team")}
      </p>
      <h2 className="mt-2 max-w-2xl font-display text-4xl sm:text-5xl">
        <SplitHeading text={t("Our coaches")} stagger={0.05} />
      </h2>
      <p data-rise className="mt-3 max-w-lg text-muted">
        {t("One head coach per sport. After you join a class, its sessions appear in the app.")}
      </p>

      <div data-rise className="mt-6">
        <Seg
          value={sport}
          onChange={choose}
          options={[
            { value: "", label: t("All") },
            ...sports.map((s) => ({ value: s.code, label: lang === "vi" ? s.name_vi : s.name_en })),
          ]}
        />
      </div>

      <div ref={grid} className="relative mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {coaches.map((c) => (
          <div key={c.name} data-coach data-flip-id={c.name} data-rise className="h-full">
            <SpotlightCard className="h-full rounded-[var(--radius-xl)]">
              <Card interactive className="group flex h-full flex-col overflow-hidden p-0">
                <GlareHover>
                  <Cover
                    slot={c.slot}
                    fallbackInitials={initials(c.name)}
                    initialsClassName="text-3xl font-bold"
                    alt={c.name}
                    scrim="none"
                    className="aspect-[3/4]"
                    imgClassName="transition-transform duration-[900ms] ease-[var(--ease-smooth)] group-hover:scale-105"
                  >
                    <MediaCaption>
                      <p className="kicker text-2xs text-on-media-muted">{sportLabel(c.sport || "")}</p>
                      <p className="athletic mt-1 text-2xl">{c.name}</p>
                    </MediaCaption>
                  </Cover>
                </GlareHover>
                <div className="flex flex-1 flex-col p-4">
                  <p className="flex-1 text-sm font-medium">{t(c.title)}</p>
                  <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => setOpen(c)}>
                    {t("View details")}
                  </Button>
                </div>
              </Card>
            </SpotlightCard>
          </div>
        ))}
      </div>

      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={open?.name ?? ""}
        footer={
          <>
            <ButtonAnchor href="#classes" onClick={() => setOpen(null)}>
              {t("See open classes")}
            </ButtonAnchor>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t("Close")}
            </Button>
          </>
        }
      >
        {open ? (
          <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
            <Cover
              slot={open.slot}
              fallbackInitials={initials(open.name)}
              initialsClassName="text-3xl font-bold"
              alt={open.name}
              scrim="none"
              className="aspect-[3/4] rounded-[var(--radius-lg)]"
            />
            <div>
              <p className="kicker text-2xs text-muted">{sportLabel(open.sport || "")}</p>
              <p className="mt-1 text-sm font-medium">{t(open.title)}</p>
              <p className="mt-3 text-sm text-muted">{t(open.blurb)}</p>
              <ul className="mt-4 grid gap-1.5 text-sm text-muted">
                {open.creds.map((x) => (
                  <li key={x} className="flex gap-2">
                    <span className="text-accent">·</span>
                    {t(x)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
