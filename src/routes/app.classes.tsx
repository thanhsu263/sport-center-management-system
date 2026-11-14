import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Cover, MediaCaption, sportPhoto } from "@/client/components/media";
import { MyAttendance } from "@/client/components/my-attendance";
import { Shell, money, when } from "@/client/components/shell";
import { PayOnlineButton } from "@/client/components/pay-online";
import { HoldCountdown } from "@/client/components/moments/hold-countdown";
import { Badge, Button, ButtonLink, Card, EmptyState, Input, LoadError, Modal, PageHero, Seg, Select, ShowMore, Skeleton, SportBadge } from "@/client/components/ui";
import { Lift, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { GlareHover, SpotlightCard } from "@/client/components/fx";
import { cn } from "@/client/lib/cn";
import { apiPost } from "@/client/arena3/client";
import { levelLabel, rruleLabel, sportLabel } from "@/shared/arena3/labels";
import { locale, t, tData, tServer } from "@/client/lib/i18n";
import { HighlightBadge } from "@/client/lib/use-live";
import { useMemberClasses, type Cl } from "@/client/lib/pages/app.classes";


export const Route = createFileRoute("/app/classes")({
  validateSearch: (s: Record<string, unknown>): { sport?: string } => ({
    sport: typeof s.sport === "string" && s.sport.trim() ? s.sport.trim() : undefined,
  }),
  component: Page,
});

function Page() {
  const {
    items, mine, offers, failure, sport, setSport, load, sports, setLimit, detail, setDetail,
    coach, setCoach, day, setDay, part, setPart, coachNames, matching, shown, byClass, leaving,
    setLeaving, enrolling, setEnrolling, enrolCode, setEnrolCode, enrolBusy, openQuote, enrol,
    leaveBusy, seatBusy, askTransfer, releaseSeat, leave,
  } = useMemberClasses(Route.useSearch);

  return (
    <Shell role="member">
      <PageHero
        slot="banner.classes"
        title={t("Classes")}
        subtitle={t("Enrol by sport. When a class is full you join a first-come waitlist.")}
        fallbackSpot="whistle"
        stats={[
          {
            label: t("Active classes"),
            value: items?.length ?? 0,
          },
          {
            label: t("Your enrolments"),
            value: mine.length,
            live: mine.length > 0,
          },
          {
            label: t("Sports"),
            value: sports.length,
          },
        ]}
      />
      {offers.length ? (
        <Card className="mb-4 border border-hold/30 bg-hold/5">
          <p className="text-sm font-medium">{t("A waitlist seat opened up")}</p>
          {offers.map((o) => (
            <div key={o.id} className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {t("{sport} · {level}: claim before {time}", {
                  sport: sportLabel(o.sport),
                  level: levelLabel(o.level),
                  time: new Date(o.expires_at).toLocaleTimeString(locale(), {
                    timeZone: "Asia/Ho_Chi_Minh",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  }),
                })}
              </p>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const r = await apiPost<{ status?: string }>(`/waitlist/${o.id}/accept`);
                    toast.success(
                      r?.status === "confirmed" ? t("You are enrolled") : t("Seat held. Pay before the timer runs out."),
                    );
                    load();
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("This offer has expired"));
                  }
                }}
              >
                {t("Claim seat")}
              </Button>
            </div>
          ))}
        </Card>
      ) : null}
      <div className="mb-4">
        <Seg
          value={sport}
          onChange={setSport}
          options={[
            { value: "", label: t("All") },
            ...sports.map((s) => ({
              value: s.code,
              label: locale() === "vi" ? s.name_vi : s.name_en,
            })),
          ]}
        />
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Select aria-label={t("Coach")} value={coach} onChange={(e) => setCoach(e.target.value)}>
            <option value="">{t("All coaches")}</option>
            {coachNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Day")} value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">{t("Any day")}</option>
            {[
              ["MO", t("Mon")],
              ["TU", t("Tue")],
              ["WE", t("Wed")],
              ["TH", t("Thu")],
              ["FR", t("Fri")],
              ["SA", t("Sat")],
              ["SU", t("Sun")],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Time of day")} value={part} onChange={(e) => setPart(e.target.value)}>
            <option value="">{t("Any time")}</option>
            <option value="morning">{t("Morning (before 12:00)")}</option>
            <option value="afternoon">{t("Afternoon (12:00-17:00)")}</option>
            <option value="evening">{t("Evening (from 17:00)")}</option>
          </Select>
        </div>
      </div>
      {failure ? (
        <LoadError message={failure.message} onRetry={failure.refused ? undefined : load} />
      ) : !items ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <Stagger className="grid gap-3 md:grid-cols-2" gap={0.07}>
          {shown.map((c) => {
            const full = c.enrolled_count >= c.capacity;
            const pct = Math.min(100, Math.round((c.enrolled_count / Math.max(1, c.capacity)) * 100));
            // The class runs once it reaches its minimum; until then the bar marks how far that is.
            const short = c.min_enrolled ? Math.max(0, c.min_enrolled - c.enrolled_count) : 0;
            const minPct = c.min_enrolled ? Math.min(100, (c.min_enrolled / Math.max(1, c.capacity)) * 100) : null;
            const enr = byClass[c.id];
            const mineHere = c.my_enrollment;
            const holding = mineHere?.status === "hold" && !!mineHere.hold_until ? mineHere : null;
            return (
              <StaggerItem key={c.id} className="h-full">
              <Lift className="h-full">
              <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={340} strength={0.11}>
              <Card interactive className="relative z-[2] flex h-full flex-col overflow-hidden p-0">
                <GlareHover>
                  <Cover slot={sportPhoto(c.sport)} alt="" scrim="none" className="h-28 sm:h-32">
                    {/* The few seats left are the reason to act now, so they sit on the photo in lime. */}
                    {!full && c.capacity - c.enrolled_count <= 3 ? (
                      <span className="absolute left-3 top-3 z-[2] rounded-md bg-accent px-2 py-1 font-mono text-2xs font-bold uppercase tracking-wider text-accent-fg">
                        {(c.capacity - c.enrolled_count === 1 ? t("1 seat left") : t("{n} seats left", { n: c.capacity - c.enrolled_count }))}
                      </span>
                    ) : null}
                    <MediaCaption className="flex items-end justify-between">
                      <SportBadge sport={c.sport} className="bg-surface/90 text-fg backdrop-blur-xs" />
                      <p className="tabular-nums text-sm font-semibold">
                        <HighlightBadge value={c.enrolled_count}>{c.enrolled_count}</HighlightBadge>/{c.capacity}
                      </p>
                    </MediaCaption>
                  </Cover>
                </GlareHover>
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-xl font-bold leading-tight tracking-tight sm:text-2xl">
                      {sportLabel(c.sport)}{' '}
                      <span className="whitespace-nowrap">
                        <span className="text-muted">·</span> {levelLabel(c.level)}
                      </span>
                    </h2>
                    <span className="shrink-0 whitespace-nowrap rounded-[var(--radius-pill)] border border-line bg-wood/50 px-2 py-0.5 text-2xs font-medium text-muted">
                      {c.court_code}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-center gap-2.5 border-t border-line/60 pt-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/10 font-bold text-xs text-accent-2 border border-accent/20">
                      {c.coach_name ? c.coach_name.split(" ").slice(-2).map((w) => w[0]).join("").toUpperCase() : "HLV"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-fg">{c.coach_name}</p>
                      <p className="font-mono text-2xs text-muted">{rruleLabel(c.rrule, c.duration_min)}</p>
                    </div>
                  </div>
                  {c.description ? <p className="mt-3 line-clamp-2 text-sm text-muted">{c.description}</p> : null}
                  <button
                    type="button"
                    onClick={() => setDetail(c)}
                    className="mt-2 w-fit text-xs font-semibold text-accent underline-offset-4 hover:underline focus-visible:underline"
                  >
                    {t("Class details")}
                  </button>
                  <div className="mt-4 flex items-baseline justify-between gap-2 text-2xs">
                    {/* The lime tag on the photo already counts the last few seats; say it once. */}
                    <span className="text-muted">
                      {full
                        ? t("Full")
                        : c.capacity - c.enrolled_count <= 3
                          ? t("Seats filled")
                          : t("{n} seats left", { n: c.capacity - c.enrolled_count })}
                    </span>
                    <span className="tabular-nums text-subtle">{pct}%</span>
                  </div>
                  <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-wood">
                    <motion.div
                      className={cn("h-full rounded-full", full ? "bg-danger" : pct >= 80 ? "bg-clay" : "bg-accent")}
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                    />
                    {minPct != null && short > 0 ? (
                      <span aria-hidden className="absolute inset-y-0 w-0.5 bg-fg/60" style={{ left: `calc(${minPct}% - 1px)` }} />
                    ) : null}
                  </div>
                  {short > 0 ? (
                    <p className="mt-1.5 text-2xs text-clay">
                      {t("{n} more needed for this class to run", { n: short })}
                    </p>
                  ) : null}
                  {/* `mt-auto` pins the action to the bottom of the card. The
                      cards in a row stretch to the tallest one, and without it
                      each button sat directly under its own text — so a row of
                      four classes showed four buttons at four heights. */}
                  <div className="mt-auto pt-5">
                  {/* The enrol button carries the price; the line above it is for seats already taken or held. */}
                  {(holding?.price_vnd ?? c.price_vnd) != null && (holding || enr) && (
                    <p className="mb-2 font-display text-xl tabular-nums">{money((holding?.price_vnd ?? c.price_vnd)!)}</p>
                  )}
                  {holding ? (
                    <div className="grid gap-2">
                      <HoldCountdown until={holding.hold_until!} onExpire={load} label={t("Holding your seat")} />
                      {holding.transfer_requested_at ? (
                        <p className="text-sm text-muted">{t("Waiting for the desk to confirm your transfer")}</p>
                      ) : (
                        <>
                          <PayOnlineButton
                            refType="enrollment"
                            refId={holding.id}
                            size="md"
                            variant="primary"
                            label={t("Pay online")}
                            onPaid={load}
                          />
                          <Button
                            className="w-full"
                            variant="outline"
                            disabled={seatBusy === holding.id}
                            onClick={() => void askTransfer(holding.id)}
                          >
                            {t("Pay by transfer")}
                          </Button>
                        </>
                      )}
                      <Button
                        className="w-full"
                        variant="ghost"
                        disabled={seatBusy === holding.id}
                        onClick={() => void releaseSeat(holding.id)}
                      >
                        {t("Release seat")}
                      </Button>
                    </div>
                  ) : enr?.status === "confirmed" ? (
                    (() => {
                      const locked = !!enr.leave_until && Date.now() >= new Date(enr.leave_until).getTime();
                      return (
                        <div className="grid gap-2">
                          <Badge tone="accent" className="w-fit">
                            {t("You are in this class")}
                          </Badge>
                          {locked ? (
                            <p className="text-xs text-muted">
                              {t("Leaving closes {hours} hours before a session. The next one starts {when}; ask the front desk if you cannot come.", {
                                hours: Math.round((new Date(enr.next_session_at!).getTime() - new Date(enr.leave_until!).getTime()) / 3600000),
                                when: when(enr.next_session_at!),
                              })}
                            </p>
                          ) : null}
                          <Button
                            className="w-full"
                            variant="ghost"
                            disabled={locked}
                            onClick={() => setLeaving({ enr, cls: c })}
                          >
                            {t("Leave class…")}
                          </Button>
                        </div>
                      );
                    })()
                  ) : enr?.status === "waitlisted" ? (
                    <div className="grid gap-2">
                      {/* The position is a status, not part of the button that leaves (C-1). */}
                      <Badge tone="hold" className="w-fit">
                        {t("Waitlist position #{pos}", { pos: enr.waitlist_pos ?? "-" })}
                      </Badge>
                      <Button className="w-full" variant="ghost" onClick={() => setLeaving({ enr, cls: c })}>
                        {t("Leave the waitlist…")}
                      </Button>
                    </div>
                  ) : (
                    (() => {
                      return (
                        <div className="grid gap-2">
                          <Button
                            className="w-full"
                            variant={full ? "outline" : "primary"}
                            disabled={c.price_vnd == null || enrolBusy}
                            onClick={() => {
                              setEnrolCode("");
                              void (full ? enrol(c) : openQuote(c));
                            }}
                          >
                            {c.price_vnd == null
                              ? t("Not open yet")
                              : full
                                ? t("Join the waitlist")
                                : t("Enrol · {price}", { price: money(c.price_vnd) })}
                          </Button>
                        </div>
                      );
                    })()
                  )}
                  </div>
                </div>
              </Card>
              </SpotlightCard>
              </Lift>
              </StaggerItem>
            );
          })}
          {!shown.length && (coach || day || part) ? (
            <EmptyState assetSlot="empty.default" title={t("No class matches these filters")} hint={t("Change the coach, day or time above.")} />
          ) : !shown.length ? (
            <EmptyState assetSlot="empty.default" title={t("No open classes")} hint={t("The manager publishes the weekly timetable.")} />
          ) : null}
        </Stagger>
      )}
      {items ? <ShowMore shown={shown.length} total={matching.length} step={6} onMore={() => setLimit((n) => n + 6)} /> : null}
      <Modal
        open={!!leaving}
        onClose={() => (leaveBusy ? undefined : setLeaving(null))}
        title={
          leaving?.enr.status === "waitlisted"
            ? t("Leave the waitlist for {cls}?", { cls: leaving ? `${sportLabel(leaving.cls.sport)} ${levelLabel(leaving.cls.level)}` : "" })
            : t("Leave {cls}?", { cls: leaving ? `${sportLabel(leaving.cls.sport)} ${levelLabel(leaving.cls.level)}` : "" })
        }
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setLeaving(null)} disabled={leaveBusy}>
              {t("Stay")}
            </Button>
            <Button variant="danger" onClick={() => void leave()} disabled={leaveBusy}>
              {leaving?.enr.status === "waitlisted" ? t("Leave the waitlist") : t("Leave class")}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          {leaving?.enr.status === "waitlisted"
            ? t("You lose your place in the queue. Joining again puts you at the back.")
            : t("Your seat goes to the next person on the waitlist. No refund: tuition and membership days already paid stay paid.")}
        </p>
      </Modal>
      <Modal
        open={!!enrolling}
        onClose={() => setEnrolling(null)}
        title={t("Before you enrol")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEnrolling(null)}>
              {t("Cancel")}
            </Button>
            {enrolling && !enrolling.quote.eligible ? (
              <ButtonLink to="/app/plans">{t("See plans")}</ButtonLink>
            ) : (
              <Button disabled={enrolBusy} onClick={() => enrolling && void enrol(enrolling.cls, enrolCode)}>
                {enrolling ? t("Hold my seat · {price}", { price: money(enrolling.quote.total_vnd) }) : null}
              </Button>
            )}
          </>
        }
      >
        {enrolling ? (
          <div className="grid gap-3 text-sm">
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2">
              <dt className="text-muted">{t("Class tuition")}</dt>
              <dd className="text-right tabular-nums">
                {money(enrolling.quote.tuition_vnd)}
                {enrolling.quote.promo ? (
                  <span className="ml-2 text-xs text-accent-2">
                    {enrolling.quote.promo.code}: −{money(enrolling.quote.promo.discount_vnd)}
                  </span>
                ) : null}
              </dd>
              <dt className="font-medium">{t("Total")}</dt>
              <dd className="text-right font-display text-xl tabular-nums">{money(enrolling.quote.total_vnd)}</dd>
            </dl>
            {enrolling.quote.eligible ? (
              <p className="text-muted">
                {t("Your membership runs through {end}, after this class ends on {date}.", {
                  end: enrolling.quote.current_end ?? "",
                  date: enrolling.quote.class_end,
                })}
              </p>
            ) : (
              <p className="rounded-[var(--radius-md)] bg-wood px-3 py-2">
                {enrolling.quote.current_end
                  ? t("Your membership ends on {end}. It must end after this class ends on {date}.", {
                      end: enrolling.quote.current_end,
                      date: enrolling.quote.class_end,
                    })
                  : t("You need an active membership that ends after this class ends on {date}.", {
                      date: enrolling.quote.class_end,
                    })}
                {enrolling.quote.suggested_plan
                  ? ` ${t("The {name} plan, at {price}, is the cheapest that is long enough.", {
                      name: tData(enrolling.quote.suggested_plan.name),
                      price: money(enrolling.quote.suggested_plan.price_vnd),
                    })}`
                  : ""}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={enrolCode}
                onChange={(e) => setEnrolCode(e.target.value.toUpperCase())}
                placeholder={t("Promo code (optional)")}
                aria-label={t("Promo code")}
                maxLength={32}
              />
              <Button variant="outline" disabled={enrolBusy || !enrolCode.trim()} onClick={() => void openQuote(enrolling.cls, enrolCode)}>
                {t("Apply")}
              </Button>
            </div>
            <p className="text-xs text-muted">{t("A code lowers the tuition only.")}</p>
          </div>
        ) : null}
      </Modal>
      <ClassDetailModal cls={detail} onClose={() => setDetail(null)} />
      <div id="attendance" className="scroll-mt-20">
        <MyAttendance />
      </div>
    </Shell>
  );
}

/** Everything a member needs to decide on a class before enrolling: what it is, who it suits, what each session covers. */
function ClassDetailModal({ cls, onClose }: { cls: Cl | null; onClose: () => void }) {
  const c = cls;
  const lines = (c?.syllabus ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const dateFmt = (d?: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(locale() === "vi" ? "vi-VN" : "en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  const seats = c ? Math.max(0, c.capacity - c.enrolled_count) : 0;
  return (
    <Modal
      open={!!c}
      onClose={onClose}
      title={c ? `${sportLabel(c.sport)} · ${levelLabel(c.level)}` : ""}
      footer={
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      }
    >
      {c ? (
        <div className="grid gap-5 text-sm">
          <p className="leading-relaxed text-fg">{c.description ?? t("The coach has not written a description for this class yet.")}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-[var(--radius-lg)] border border-line bg-wood/40 p-4">
            <div>
              <dt className="text-2xs uppercase tracking-wider text-subtle">{t("Coach")}</dt>
              <dd className="font-semibold">{c.coach_name}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wider text-subtle">{t("Court")}</dt>
              <dd className="font-semibold">{c.court_code}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wider text-subtle">{t("When")}</dt>
              <dd className="font-semibold">{rruleLabel(c.rrule, c.duration_min)}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wider text-subtle">{t("Seats")}</dt>
              <dd className="font-semibold tabular-nums">
                {seats > 0 ? (seats === 1 ? t("1 seat left") : t("{n} seats left", { n: seats })) : t("Full")} · {c.enrolled_count}/{c.capacity}
              </dd>
            </div>
            {c.start_on && c.end_on ? (
              <div className="col-span-2">
                <dt className="text-2xs uppercase tracking-wider text-subtle">{t("Course dates")}</dt>
                <dd className="font-semibold">
                  {dateFmt(c.start_on)} – {dateFmt(c.end_on)}
                </dd>
              </div>
            ) : null}
            <div className="col-span-2">
              <dt className="text-2xs uppercase tracking-wider text-subtle">{t("Price")}</dt>
              <dd className="font-display text-lg tabular-nums">{c.price_vnd == null ? t("Not open yet") : money(c.price_vnd)}</dd>
            </div>
          </dl>
          {c.who_for ? (
            <section>
              <h3 className="font-semibold">{t("Who it is for")}</h3>
              <p className="mt-1 text-muted">{c.who_for}</p>
            </section>
          ) : null}
          {lines.length ? (
            <section>
              <h3 className="font-semibold">{t("What you will learn")}</h3>
              <ol className="mt-2 grid gap-1.5">
                {lines.map((l, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-2xs font-bold text-accent">
                      {i + 1}
                    </span>
                    <span className="pt-0.5 text-muted">{l}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {c.bring ? (
            <section>
              <h3 className="font-semibold">{t("What to bring")}</h3>
              <p className="mt-1 text-muted">{c.bring}</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
