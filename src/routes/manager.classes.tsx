import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Shell, money } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { SportBadge, useSports } from "@/client/components/sports-ui";
import { Button, Card, DateField, EmptyState, Field, Input, LoadError, Select, ShowMore, Skeleton, StatusBadge } from "@/client/components/ui";
import { Lift, Reveal, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { SpotlightCard } from "@/client/components/fx";
import { ClassDetailModal } from "@/client/components/class-detail";
import { MinSizeBadge } from "@/client/components/class-extras";
import { apiPost } from "@/client/arena3/client";
import { classSlotMatches, composeWeeklyRrule, levelLabel, rruleLabel, sportLabel, todayISO, addDaysISO } from "@/shared/arena3/labels";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useCentre } from "@/client/lib/use-centre";
import { hoursOf } from "@/client/lib/venue";
import { HighlightBadge, useLive } from "@/client/lib/use-live";

export const Route = createFileRoute("/manager/classes")({
  component: Page,
});

/** Matches MAX_CLASS_CAPACITY in the classes handler, which refuses anything above it. */
const MAX_CAPACITY = 200;

const DAYS = [
  { k: "MO", l: tk("Mon") },
  { k: "TU", l: tk("Tue") },
  { k: "WE", l: tk("Wed") },
  { k: "TH", l: tk("Thu") },
  { k: "FR", l: tk("Fri") },
  { k: "SA", l: tk("Sat") },
  { k: "SU", l: tk("Sun") },
];

type ClassRow = {
  id: string;
  code: string;
  sport: string;
  level: string;
  status: string;
  court_code: string;
  coach_name: string;
  enrolled_count: number;
  capacity: number;
  rrule?: string;
  duration_min?: number;
  price_vnd?: number | null;
  min_enrolled?: number | null;
};

function Page() {
  const { venue } = useCentre();
  const [limit, setLimit] = useState(8);
  const classesRead = useRead<{ items: ClassRow[] }>("/classes");
  const courtsRead = useRead<{ items: Array<{ id: string; court_code: string; sport: string }> }>("/courts");
  const coachesRead = useRead<{ items: Array<{ id: string; full_name: string; sports: string[] | null }> }>(
    "/staff?role=coach&status=active",
  );
  const items = classesRead.data?.items ?? null;
  // Cancelled classes stay on record but are folded away; the server sends the newest first.
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelledCount = items?.filter((c) => c.status === "cancelled").length ?? 0;
  // The same coach, weekday and time-of-day filters members have, to find a class without scrolling.
  const [coach, setCoach] = useState("");
  const [day, setDay] = useState("");
  const [part, setPart] = useState("");
  const filtering = !!(coach || day || part);
  const coachNames = [...new Set((items ?? []).map((c) => c.coach_name))].sort((a, b) => a.localeCompare(b, "vi"));
  const listed = items
    ? (showCancelled ? items : items.filter((c) => c.status !== "cancelled"))
        .filter((c) => !coach || c.coach_name === coach)
        .filter((c) => classSlotMatches(c.rrule, day, part))
    : null;
  useEffect(() => setLimit(8), [coach, day, part]);
  const courts = useMemo(() => courtsRead.data?.items ?? [], [courtsRead.data]);
  const coaches = useMemo(() => coachesRead.data?.items ?? [], [coachesRead.data]);
  // The form can only say "no coach teaches this" once the coaches have really been read.
  const loaded = !!courtsRead.data && !!coachesRead.data;
  const formError = courtsRead.error ?? coachesRead.error;
  // The class whose sessions and roster are open (B-08).
  const [detail, setDetail] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [days, setDays] = useState<string[]>(["TU", "TH"]);
  const [hour, setHour] = useState(19);
  const { sports } = useSports();
  const [form, setForm] = useState({
    sport: "",
    level: "beginner",
    coach_id: "",
    court_id: "",
    capacity: "12",
    min: "",
    price: "",
    duration_min: 60,
    start_on: todayISO(),
    end_on: addDaysISO(todayISO(), 60),
  });
  useEffect(() => {
    if (!form.sport && sports.length > 0) {
      setForm((prev) => ({ ...prev, sport: sports[0].code }));
    }
  }, [form.sport, sports]);

  // After a change, the class list is read again (a published class is a new row or a new status).
  const load = classesRead.reload;
  useLive("classes", load);

  // The people and courts a class of this sport can actually use. Nothing is
  // assumed about which accounts exist: a centre that issued its own coach
  // logins has none of the seed ids.
  const sportCourts = useMemo(() => courts.filter((c) => c.sport === form.sport), [courts, form.sport]);
  const sportCoaches = useMemo(
    () => coaches.filter((c) => (c.sports ?? []).some((s) => s === form.sport || s === "all")),
    [coaches, form.sport],
  );
  useEffect(() => {
    setForm((f) => {
      const court_id = sportCourts.some((c) => c.id === f.court_id) ? f.court_id : (sportCourts[0]?.id ?? "");
      const coach_id = sportCoaches.some((c) => c.id === f.coach_id) ? f.coach_id : (sportCoaches[0]?.id ?? "");
      return court_id === f.court_id && coach_id === f.coach_id ? f : { ...f, court_id, coach_id };
    });
  }, [sportCourts, sportCoaches]);
  const missing = !loaded
    ? null
    : !sportCoaches.length
      ? t("No active coach teaches this sport yet.")
      : !sportCourts.length
        ? t("There is no court for this sport.")
        : null;

  // The same limits the server holds the class to, said beside the box before the click rather
  // than after it. Typed as text so a half-typed or emptied box is shown as wrong, not as 0.
  const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  const capacityN = whole(form.capacity);
  const capacityError =
    Number.isInteger(capacityN) && capacityN >= 1 && capacityN <= MAX_CAPACITY
      ? null
      : t("Capacity must be a whole number from 1 to {max}.", { max: MAX_CAPACITY });
  const minN = whole(form.min);
  const minError =
    form.min.trim() === "" || (Number.isInteger(minN) && minN >= 1 && (capacityError || minN <= capacityN))
      ? null
      : t("The minimum must be a whole number from 1 up to the capacity.");
  const priceError =
    form.price.trim() === "" || Number.isInteger(whole(form.price)) ? null : t("Price must be a whole number of dong, or empty.");
  const invalid = !!(capacityError || minError || priceError);

  function toggleDay(k: string) {
    setDays((prev) => (prev.includes(k) ? prev.filter((d) => d !== k) : [...prev, k]));
  }

  const totalClasses = items?.length ?? 0;
  const publishedClasses = items?.filter((c) => c.status === "open").length ?? 0;
  const draftClasses = items?.filter((c) => c.status === "draft").length ?? 0;
  const totalEnrolled = items?.reduce((sum, c) => sum + (c.enrolled_count || 0), 0) ?? 0;

  return (
    <Shell role="manager">
      <PageHero
        slot="banner.classes"
        title={t("Classes")}
        subtitle={t("Pick the days and the hour. Clashes on court or coach are blocked for you.")}
        className="mb-6"
      />

      <StatStrip
        stats={[
          { label: t("Active classes"), value: publishedClasses },
          { label: t("Drafts"), value: draftClasses },
          { label: t("Enrolled students"), value: totalEnrolled },
          { label: t("Total classes"), value: totalClasses },
        ]}
        className="mb-6"
      />

      <details className="group mb-6 rounded-[var(--radius-xl)] border border-line bg-surface">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radius-xl)] p-4 font-semibold text-fg focus-visible:outline-2 focus-visible:outline-accent">
          {t("Create class")}
          <span aria-hidden="true" className="text-xl text-accent group-open:rotate-45">+</span>
        </summary>
      {formError ? (
        // Without the courts and coaches the form would offer nothing to pick, so it says why instead.
        <div className="mb-6">
          <LoadError
            message={formError.message}
            onRetry={
              formError.refused
                ? undefined
                : () => {
                    courtsRead.reload();
                    coachesRead.reload();
                  }
            }
          />
        </div>
      ) : (
      <Reveal from="down">
      <Card className="mb-6 grid gap-3 md:grid-cols-3">
        <Field label={t("Sport")}>
          <Select value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })}>
            {sports.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name_en || (s as any).name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Level")}>
          <Select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
            <option value="beginner">{t("Beginner")}</option>
            <option value="intermediate">{t("Intermediate")}</option>
            <option value="advanced">{t("Advanced")}</option>
            <option value="team">{t("Squad")}</option>
          </Select>
        </Field>
        <Field label={t("Court")}>
          <Select value={form.court_id} onChange={(e) => setForm({ ...form, court_id: e.target.value })}>
            {sportCourts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.court_code} · {sportLabel(c.sport)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Coach")}>
          <Select value={form.coach_id} onChange={(e) => setForm({ ...form, coach_id: e.target.value })}>
            {sportCoaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="md:col-span-2">
          <p className="text-2xs font-medium text-muted">{t("Repeats weekly on")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {DAYS.map((d) => (
              <button
                key={d.k}
                type="button"
                onClick={() => toggleDay(d.k)}
                className={`relative min-h-11 min-w-11 rounded-[var(--radius-sm)] px-2 text-sm font-medium sm:min-h-9 transition-colors duration-200 active:scale-95 ${
                  days.includes(d.k) ? "text-bg" : "bg-wood text-muted hover:bg-wood/70"
                }`}
              >
                {days.includes(d.k) ? (
                  <motion.span
                    layoutId={`byday-${d.k}`}
                    className="absolute inset-0 rounded-[var(--radius-sm)] bg-fg"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                ) : null}
                <span className="relative">{t(d.l)}</span>
              </button>
            ))}
          </div>
        </div>
        <Field label={t("Start time")}>
          <Select value={String(hour)} onChange={(e) => setHour(Number(e.target.value))}>
            {hoursOf(venue).map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("First day")}>
          <DateField value={form.start_on} onChange={(v) => setForm({ ...form, start_on: v })} aria-label={t("Start date")} />
        </Field>
        <Field label={t("Capacity")} hint={capacityError ?? undefined}>
          <Input
            type="number"
            min={1}
            max={MAX_CAPACITY}
            step={1}
            inputMode="numeric"
            aria-invalid={capacityError ? true : undefined}
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
          />
        </Field>
        <Field
          label={t("Minimum to run")}
          hint={minError ?? t("Leave empty for no minimum. Below it the class is only flagged.")}
          tone={minError ? "danger" : "muted"}
        >
          <Input
            type="number"
            min={1}
            max={capacityError ? MAX_CAPACITY : capacityN}
            step={1}
            inputMode="numeric"
            aria-invalid={minError ? true : undefined}
            value={form.min}
            onChange={(e) => setForm({ ...form, min: e.target.value })}
          />
        </Field>
        <Field
          label={t("Price (VND)")}
          hint={priceError ?? t("Leave empty until the class is ready to sell.")}
          tone={priceError ? "danger" : "muted"}
        >
          <Input
            type="number"
            min={0}
            step={1000}
            inputMode="numeric"
            aria-invalid={priceError ? true : undefined}
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
          />
        </Field>
        <div className="flex flex-col justify-end gap-1">
          {missing ? (
            <p className="text-xs text-danger">
              {missing}{" "}
              {!sportCoaches.length ? (
                <Link to="/manager/staff" className="underline">
                  {t("Add a coach")}
                </Link>
              ) : null}
            </p>
          ) : null}
          <Button
            className="w-full"
            disabled={creating || invalid || !!missing || !form.coach_id || !form.court_id}
            onClick={async () => {
              // One click used to land many identical classes: the button stayed
              // live for the whole create-and-publish round trip.
              if (creating || invalid) return;
              setCreating(true);
              try {
                const { price, min, ...rest } = form;
                const row = await apiPost<{ id: string }>("/classes", {
                  ...rest,
                  capacity: capacityN,
                  min_enrolled: min.trim() === "" ? null : Number(min),
                  price_vnd: price.trim() === "" ? null : Number(price),
                  rrule: composeWeeklyRrule(days, hour),
                });
                toast.success(t("Draft created"));
                const pub = await apiPost<{ sessions: unknown[]; skipped: unknown[] }>(`/classes/${row.id}/publish`);
                toast.success(t("Published {n} sessions", { n: pub.sessions.length }));
                load();
              } catch (e) {
                toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
              } finally {
                setCreating(false);
              }
            }}
          >
            {creating ? t("Publishing…") : t("Create & publish")}
          </Button>
        </div>
      </Card>
      </Reveal>
      )}
      </details>
      {classesRead.error ? (
        <LoadError message={classesRead.error.message} onRetry={classesRead.error.refused ? undefined : classesRead.reload} />
      ) : !items ? (
        <Skeleton className="h-40" />
      ) : null}
      {items?.length ? (
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
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
            {DAYS.map((d) => (
              <option key={d.k} value={d.k}>
                {t(d.l)}
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
      ) : null}
      <Stagger className="grid gap-3 md:grid-cols-2" gap={0.06}>
        {(listed ?? []).slice(0, limit).map((c) => (
          <StaggerItem key={c.id} className="h-full">
          <Lift className="h-full">
          <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={320} strength={0.1}>
          <Card interactive className="relative z-[2] h-full">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <SportBadge sport={c.sport} />
                <StatusBadge status={c.status} />
                <MinSizeBadge enrolled={c.enrolled_count} min={c.min_enrolled} status={c.status} />
              </div>
              <span className="text-2xs tabular-nums text-muted">{c.code}</span>
            </div>
            <h2 className="mt-2 font-display text-2xl">
              {sportLabel(c.sport)} · {levelLabel(c.level)}
            </h2>
            <p className="text-sm text-muted">
              {c.coach_name} · {c.court_code} · <HighlightBadge value={c.enrolled_count}>{c.enrolled_count}</HighlightBadge>/{c.capacity}
            </p>
            {c.rrule ? <p className="text-sm">{rruleLabel(c.rrule, c.duration_min)}</p> : null}
            <p className="text-sm tabular-nums text-muted">{c.price_vnd == null ? t("Price: not set") : money(c.price_vnd)}</p>
            <Button className="mt-3" variant="outline" onClick={() => setDetail(c.id)}>
              {t("Sessions & students")}
            </Button>
            {c.status === "draft" ? (
              <Button
                className="mt-3 ml-2"
                onClick={async () => {
                  try {
                    await apiPost(`/classes/${c.id}/publish`);
                    toast.success(t("Published"));
                    load();
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
                  }
                }}
              >
                {t("Publish")}
              </Button>
            ) : null}
          </Card>
          </SpotlightCard>
          </Lift>
          </StaggerItem>
        ))}
      </Stagger>
      {listed ? (
        <ShowMore shown={Math.min(limit, listed.length)} total={listed.length} step={8} onMore={() => setLimit((n) => n + 8)} />
      ) : null}
      {cancelledCount ? (
        <div className="mt-3 text-center">
          <Button variant="ghost" onClick={() => setShowCancelled((v) => !v)}>
            {showCancelled ? t("Hide cancelled classes") : t("Show {n} cancelled classes", { n: cancelledCount })}
          </Button>
        </div>
      ) : null}
      {filtering && listed && !listed.length ? (
        <EmptyState title={t("No class matches these filters")} hint={t("Change the coach, day or time above.")} />
      ) : null}
      {items && !items.length ? (
        <EmptyState
          title={t("No classes yet")}
          hint={t("Open Create class, pick a sport, coach and days, then press Create & publish. Members can book as soon as it is published.")}
        />
      ) : null}
      <ClassDetailModal classId={detail} onClose={() => setDetail(null)} manage onChanged={() => void load()} />
    </Shell>
  );
}
