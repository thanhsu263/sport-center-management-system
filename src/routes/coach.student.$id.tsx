import { Link, createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Target } from "lucide-react";
import { SectionTitle } from "@/client/components/section";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { StepTabs } from "@/client/components/coach-ui";
import { Shell } from "@/client/components/shell";
import { useSports } from "@/client/components/sports-ui";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  LoadError,
  Select,
  Skeleton,
  Textarea,
} from "@/client/components/ui";
import { apiPost, apiPut } from "@/client/arena3/client";
import { formatDate, levelLabel, sportLabel } from "@/shared/arena3/labels";
import { cn } from "@/client/lib/cn";
import { t, tServer, tk, tData } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

export const Route = createFileRoute("/coach/student/$id")({ component: Page });

const GOALS: Record<string, string> = {
  weight: tk("Lose weight"),
  technique: tk("Improve technique"),
  compete: tk("Compete"),
  fun: tk("Have fun"),
};
const LEVELS = ["beginner", "intermediate", "advanced"];
const METRIC_LABEL: Record<string, string> = {
  smash_count: tk("Smashes"),
  freethrow_pct: tk("Free throws"),
  serve_pct: tk("Serves in"),
};
// Same colours as the register, so a number here reads the same as a button there.
const ATT = [
  { k: "present", l: tk("Present"), bar: "border-accent" },
  { k: "late", l: tk("Late"), bar: "border-hold" },
  { k: "absent", l: tk("Absent"), bar: "border-danger" },
  { k: "excused", l: tk("Excused"), bar: "border-fg" },
];

type Profile = {
  student: { id: string; full_name: string; member_code: string | null; date_of_birth: string | null; health_notes: string | null };
  goal: string | null;
  levels: Array<{ sport: string; level: string }>;
  notes: Array<{ id: string; body: string; created_at: string; coach_name: string }>;
  reviews: Array<{
    id: string;
    sport: string;
    period_weeks: number;
    technique: number;
    fitness: number;
    attitude: number;
    comment: string | null;
    created_at: string;
    coach_name: string;
  }>;
  results: Array<{
    session_id: string;
    plan_pct: number | null;
    metrics: Record<string, number> | null;
    note: string | null;
    start_at: string;
    sport: string;
  }>;
  attendance: Record<string, number>;
  homework: Array<{ id: string; title: string; due_on: string | null; checklist: string[]; done_items: number[]; completed_at: string | null }>;
};

const say = (e: unknown) => (e instanceof Error ? tServer(e.message) : t("Something went wrong"));

function Page() {
  const { id } = Route.useParams();
  const read = useRead<Profile>(`/students/${id}/profile`);
  const p = read.data;
  const { sports } = useSports();
  const [tab, setTab] = useState("progress");
  const [note, setNote] = useState("");
  const [lvl, setLvl] = useState({ sport: "", level: "beginner" });
  const [rev, setRev] = useState({ sport: "", period_weeks: "4", technique: "3", fitness: "3", attitude: "3", comment: "" });
  useEffect(() => {
    if (sports.length > 0) {
      if (!lvl.sport) setLvl((prev) => ({ ...prev, sport: sports[0].code }));
      if (!rev.sport) setRev((prev) => ({ ...prev, sport: sports[0].code }));
    }
  }, [sports]);
  // One save at a time: a second tap on "Save review" used to put the same review on record twice.
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function run(fn: () => Promise<unknown>, ok: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      read.reload();
    } catch (e) {
      toast.error(say(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const att = p?.attendance ?? {};

  return (
    <Shell role="coach" title={p?.student.full_name ?? t("Student")} subtitle={p ? (p.student.member_code ?? "") : ""}>
      <Link
        to="/coach/attendance"
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg sm:min-h-9"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t("Back to attendance")}
      </Link>
      {!p ? (
        read.error ? (
          read.error.refused ? (
            <EmptyState title={t("This student isn't available")} hint={t("You can see students in the classes you teach.")} />
          ) : (
            <div className="mt-4">
              <LoadError message={read.error.message} onRetry={read.reload} />
            </div>
          )
        ) : (
          <Skeleton className="mt-4 h-40" />
        )
      ) : (
        <div className="mx-auto mt-4 grid max-w-3xl gap-6">
          <Card className="grid gap-4 p-5">
            <div className="flex items-center gap-4">
              <span
                aria-hidden
                className="grid size-14 shrink-0 place-items-center rounded-full bg-accent/12 text-xl font-bold text-accent-2"
              >
                {p.student.full_name.trim().split(/\s+/).slice(-1)[0]?.[0]?.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
                  <Target aria-hidden className="size-4" />
                  {t("Goal")}:{" "}
                  <span className="font-medium text-fg">
                    {p.goal && GOALS[p.goal] ? t(GOALS[p.goal]!) : t("Not set yet")}
                  </span>
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {p.levels.length ? (
                    p.levels.map((l) => (
                      <Badge key={l.sport} tone="accent">
                        {sportLabel(l.sport)} · {levelLabel(l.level)}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted">{t("No level assessed yet.")}</span>
                  )}
                </div>
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-muted">{t("Attendance")}</p>
              <div className="grid grid-cols-4 gap-2">
                {ATT.map((a) => (
                  <div key={a.k} className={cn("rounded-[var(--radius-md)] border-t-[3px] bg-wood/70 px-1 py-2 text-center", a.bar)}>
                    <p className="figure text-2xl tabular-nums">{att[a.k] ?? 0}</p>
                    <p className="text-xs text-muted">{t(a.l)}</p>
                  </div>
                ))}
              </div>
            </div>
            {p.student.health_notes ? (
              <div className="flex gap-2.5 rounded-[var(--radius-md)] bg-danger/10 px-3 py-2.5 text-sm text-danger">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-semibold">{t("Health notes")}</p>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{tData(p.student.health_notes)}</p>
                </div>
              </div>
            ) : null}
          </Card>

          <StepTabs
            numbered={false}
            value={tab}
            onChange={setTab}
            steps={[
              { value: "progress", label: t("Progress") },
              { value: "notes", label: t("Coach notes") },
              { value: "history", label: t("History") },
            ]}
          />

          {tab === "progress" ? (
            <>
              <section>
                <SectionTitle text={t("Level")} className="font-display text-xl" />
                <Card className="mt-3 grid gap-3">
                  <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Field label={t("Sport")}>
                      <Select value={lvl.sport} onChange={(e) => setLvl({ ...lvl, sport: e.target.value })}>
                        {sports.map((s) => (
                          <option key={s.code} value={s.code}>
                            {sportLabel(s.code)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("Level")}>
                      <Select value={lvl.level} onChange={(e) => setLvl({ ...lvl, level: e.target.value })}>
                        {LEVELS.map((s) => (
                          <option key={s} value={s}>
                            {levelLabel(s)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button className="col-span-2 sm:col-span-1" variant="outline" disabled={busy} onClick={() => run(() => apiPut(`/students/${id}/level`, lvl), t("Level updated"))}>
                      {t("Set level")}
                    </Button>
                  </div>
                </Card>
              </section>

              <section>
                <SectionTitle text={t("Progress review")} className="font-display text-xl" />
                <p className="mt-1 text-sm text-muted">
                  {t("A review stays on record and the student is told about it. It can't be edited afterwards.")}
                </p>
                <Card className="mt-3 grid gap-3">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <Field label={t("Sport")}>
                      <Select value={rev.sport} onChange={(e) => setRev({ ...rev, sport: e.target.value })}>
                        {sports.map((s) => (
                          <option key={s.code} value={s.code}>
                            {sportLabel(s.code)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("Period")}>
                      <Select value={rev.period_weeks} onChange={(e) => setRev({ ...rev, period_weeks: e.target.value })}>
                        <option value="2">{t("{n} weeks", { n: 2 })}</option>
                        <option value="4">{t("{n} weeks", { n: 4 })}</option>
                      </Select>
                    </Field>
                    {(["technique", "fitness", "attitude"] as const).map((k) => (
                      <Field
                        key={k}
                        label={k === "technique" ? t("Technique (1-5)") : k === "fitness" ? t("Fitness (1-5)") : t("Attitude (1-5)")}
                      >
                        <Select value={rev[k]} onChange={(e) => setRev({ ...rev, [k]: e.target.value })}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ))}
                  </div>
                  <Field label={t("Comment")}>
                    <Textarea rows={3} maxLength={2000} value={rev.comment} onChange={(e) => setRev({ ...rev, comment: e.target.value })} />
                  </Field>
                  <div>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await apiPost(`/students/${id}/reviews`, rev);
                          setRev({ ...rev, comment: "" });
                        }, t("Review saved"))
                      }
                    >
                      {t("Save review")}
                    </Button>
                  </div>
                </Card>
                <div className="mt-3 grid gap-2">
                  {p.reviews.map((r) => (
                    <Card key={r.id} className="p-4">
                      <p className="text-xs text-muted">
                        {formatDate(r.created_at)} · {sportLabel(r.sport)} · {t("{n} weeks", { n: r.period_weeks })} · {r.coach_name}
                      </p>
                      <p className="mt-1 text-sm">
                        {t("Technique {technique}/5 · Fitness {fitness}/5 · Attitude {attitude}/5", {
                          technique: r.technique,
                          fitness: r.fitness,
                          attitude: r.attitude,
                        })}
                      </p>
                      {r.comment ? <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{r.comment}</p> : null}
                    </Card>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {tab === "notes" ? (
            <section>
              <SectionTitle text={t("Coach notes")} className="font-display text-xl" />
              <p className="mt-1 text-sm text-muted">{t("Private to staff. The student never sees these.")}</p>
              <Card className="mt-3 grid gap-3">
                <Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("Observation, injury watch, what to work on…")} />
                <div>
                  <Button
                    disabled={busy || !note.trim()}
                    onClick={() =>
                      run(async () => {
                        await apiPost(`/students/${id}/notes`, { body: note });
                        setNote("");
                      }, t("Note added"))
                    }
                  >
                    {t("Add note")}
                  </Button>
                </div>
              </Card>
              <div className="mt-3 grid gap-2">
                {p.notes.map((n) => (
                  <Card key={n.id} className="p-4">
                    <p className="text-xs text-muted">
                      {formatDate(n.created_at)} · {n.coach_name}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{n.body}</p>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          {tab === "history" ? (
            <>
              <section>
                <SectionTitle text={t("Recent sessions")} className="font-display text-xl" />
                <div className="mt-3 grid gap-2">
                  {p.results.length ? (
                    p.results.map((r) => (
                      <Card key={r.session_id} className="p-4">
                        <p className="text-xs text-muted">
                          {formatDate(r.start_at)} · {sportLabel(r.sport)}
                        </p>
                        <p className="mt-1 text-sm">
                          {r.plan_pct == null ? t("No plan score") : t("{pct}% of the plan", { pct: r.plan_pct })}
                          {Object.entries(r.metrics ?? {}).map(([k, v]) => ` · ${METRIC_LABEL[k] ? t(METRIC_LABEL[k]) : k} ${v}`)}
                        </p>
                        {r.note ? <p className="mt-1 text-sm text-muted">{r.note}</p> : null}
                      </Card>
                    ))
                  ) : (
                    <p className="text-sm text-muted">{t("No results recorded yet.")}</p>
                  )}
                </div>
              </section>

              <section>
                <SectionTitle text={t("Homework")} className="font-display text-xl" />
                <div className="mt-3 grid gap-2">
                  {p.homework.length ? (
                    p.homework.map((h) => (
                      <Card key={h.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                        <div>
                          <p className="font-medium">{h.title}</p>
                          <p className="text-xs text-muted">
                            {h.due_on ? t("Due {date}", { date: formatDate(h.due_on) }) : t("No due date")} ·{" "}
                            {t("{done}/{total} items", { done: h.done_items.length, total: h.checklist.length })}
                          </p>
                        </div>
                        <Badge tone={h.completed_at ? "accent" : "muted"}>{h.completed_at ? t("Done") : t("Open")}</Badge>
                      </Card>
                    ))
                  ) : (
                    <p className="text-sm text-muted">{t("No homework assigned.")}</p>
                  )}
                </div>
              </section>
            </>
          ) : null}
        </div>
      )}
    </Shell>
  );
}
