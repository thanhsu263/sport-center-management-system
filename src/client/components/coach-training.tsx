import { useEffect, useState } from "react";
import { SectionTitle } from "@/components/section";
import { toast } from "sonner";
import { Badge, Button, Card, EmptyState, DateField, Field, Input, LoadError, Select, Skeleton, Textarea } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { hhmm } from "@/components/shell";
import { sessionDay } from "@/components/class-detail";
import { apiGet, apiPatch, apiPost, apiPut } from "@/lib/arena3/client";
import { addDaysISO, formatDate } from "@/lib/arena3/labels";
import { scrollBehavior } from "@/lib/calm";
import { t, tk, tServer } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

type Msg = (e: unknown) => string;
const say: Msg = (e) => (e instanceof Error ? e.message : t("Something went wrong"));

export type TrainingSession = {
  id: string;
  class_id: string;
  start_at: string;
  sport: string;
  level: string;
  status: string;
};

const METRICS = [
  { key: "smash_count", label: tk("Smashes"), hint: tk("count") },
  { key: "freethrow_pct", label: tk("Free throws %"), hint: "0-100" },
  { key: "serve_pct", label: tk("Serves in %"), hint: "0-100" },
] as const;

const PHASES = [tk("warm-up"), tk("technique"), tk("fitness"), tk("match"), tk("cool-down")] as const;

/* ------------------------------------------------------------------ *
 * Results — plan completion and numbers per student (FR-TRN-05)        *
 * ------------------------------------------------------------------ */

type ResultRow = {
  user_id: string;
  full_name: string;
  member_code: string | null;
  attendance: string | null;
  plan_pct: number | null;
  metrics: Record<string, number> | null;
  note: string | null;
};

type Draft = { pct: string; note: string } & Record<string, string>;

function toDraft(r: ResultRow): Draft {
  const d: Draft = { pct: r.plan_pct == null ? "" : String(r.plan_pct), note: r.note ?? "" };
  for (const m of METRICS) d[m.key] = r.metrics?.[m.key] == null ? "" : String(r.metrics[m.key]);
  return d;
}

export function ResultsPanel({ sessionId, cancelled }: { sessionId: string; cancelled: boolean }) {
  const { data, error, reload } = useRead<{ items: ResultRow[] }>(`/sessions/${sessionId}/results`);
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

  // What the server holds is where the form starts; typing after that stays in the form until it is saved.
  useEffect(() => {
    setRows(data?.items ?? null);
    setDraft(Object.fromEntries((data?.items ?? []).map((x) => [x.user_id, toDraft(x)])));
  }, [data]);

  async function save() {
    setSaving(true);
    try {
      const items = (rows ?? []).map((r) => {
        const d = draft[r.user_id]!;
        const metrics: Record<string, number> = {};
        for (const m of METRICS) if (d[m.key] !== "") metrics[m.key] = Number(d[m.key]);
        return {
          user_id: r.user_id,
          plan_pct: d.pct === "" ? null : Number(d.pct),
          metrics,
          note: d.note,
        };
      });
      const res = await apiPut<{ items: ResultRow[] }>(`/sessions/${sessionId}/results`, { items });
      setRows(res.items);
      setDraft(Object.fromEntries(res.items.map((x) => [x.user_id, toDraft(x)])));
      toast.success(t("Results saved"));
    } catch (e) {
      toast.error(say(e));
    } finally {
      setSaving(false);
    }
  }

  const set = (id: string, k: string, v: string) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id]!, [k]: v } as Draft }));

  return (
    <div>
      <SectionTitle text={t("Results")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("How much of the plan each student got through, and any numbers worth tracking. Leave a row blank to record nothing.")}
      </p>
      {cancelled ? (
        <p className="mt-3 text-sm text-muted">{t("This session was cancelled, so there is nothing to record.")}</p>
      ) : error ? (
        <div className="mt-3">
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        </div>
      ) : !rows ? (
        <Skeleton className="mt-3 h-24" />
      ) : !rows.length ? (
        <p className="mt-3 text-sm text-muted">{t("Nobody is enrolled in this class yet.")}</p>
      ) : (
        <>
          {/* One row per student, columns shared: numbers line up so a column can be filled straight down. */}
          <Card className="mt-3 overflow-hidden p-0">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_repeat(4,5.5rem)] gap-2 border-b border-line bg-wood/60 px-4 py-2 text-xs font-semibold text-muted md:grid">
              <span>{t("Student")}</span>
              <span>{t("Plan done %")}</span>
              {METRICS.map((m) => (
                <span key={m.key}>{t(m.label)}</span>
              ))}
            </div>
            <ul className="divide-y divide-line">
              {rows.map((r) => {
                const d = draft[r.user_id];
                if (!d) return null;
                return (
                  <li key={r.user_id} className="grid gap-2 px-4 py-3">
                    <div className="grid items-center gap-2 md:grid-cols-[minmax(0,1.4fr)_repeat(4,5.5rem)]">
                      <p className="flex min-w-0 flex-wrap items-center gap-x-2 font-medium">
                        {r.full_name}
                        {r.attendance ? (
                          <Badge tone={r.attendance === "absent" ? "danger" : "muted"}>{t(r.attendance)}</Badge>
                        ) : null}
                      </p>
                      <div className="grid grid-cols-2 gap-2 md:contents">
                        <label className="grid gap-1">
                          <span className="text-xs text-muted md:sr-only">{t("Plan done %")}</span>
                          <Input
                            inputMode="numeric"
                            placeholder="0-100"
                            value={d.pct}
                            onChange={(e) => set(r.user_id, "pct", e.target.value)}
                          />
                        </label>
                        {METRICS.map((m) => (
                          <label key={m.key} className="grid gap-1">
                            <span className="text-xs text-muted md:sr-only">{t(m.label)}</span>
                            <Input
                              inputMode="numeric"
                              placeholder={t(m.hint)}
                              value={d[m.key]}
                              onChange={(e) => set(r.user_id, m.key, e.target.value)}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                    <Input
                      aria-label={t("Note")}
                      maxLength={1000}
                      placeholder={t("What stood out today")}
                      value={d.note}
                      onChange={(e) => set(r.user_id, "note", e.target.value)}
                    />
                  </li>
                );
              })}
            </ul>
          </Card>
          <div className="sticky bottom-24 z-10 mt-4 md:bottom-4">
            <Button size="lg" className="w-full shadow-[var(--shadow-soft)]" onClick={save} disabled={saving}>
              {saving ? t("Saving…") : t("Save results")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Plans — build, publish, copy last week (FR-TRN-04)                   *
 * Blocks carry intensity, a description, equipment and a target so a   *
 * plan can be run by someone other than its author (BR-49). A published *
 * plan that changes keeps its earlier versions (BR-48).                *
 * ------------------------------------------------------------------ */

type Block = {
  title: string;
  minutes: string;
  phase: string;
  intensity: string;
  description: string;
  equipment: string;
  target: string;
};
type PlanBlock = {
  title: string;
  minutes: number;
  phase?: string;
  intensity?: string;
  description?: string;
  equipment?: string;
  target?: string;
};
type PlanPayload = {
  blocks?: PlanBlock[];
  note?: string;
  goal?: string;
  sport?: string;
  level?: string;
};
type PlanRow = {
  id: string;
  title: string | null;
  published: boolean;
  source: string;
  version?: number;
  session_id: string | null;
  session_start: string | null;
  payload: PlanPayload;
};
type Template = { id: string; title: string | null; payload: PlanPayload };
type Version = { version: number; title: string | null; payload: PlanPayload; created_at: string };
type PlanWarning = { message: string };

const INTENSITIES = [tk("light"), tk("medium"), tk("hard")] as const;
const MAX_BLOCKS = 12;

const blocksLabel = (n: number) => (n === 1 ? t("1 block") : t("{n} blocks", { n }));

const blank = (): Block => ({
  title: "",
  minutes: "10",
  phase: "technique",
  intensity: "medium",
  description: "",
  equipment: "",
  target: "",
});

const fromPlanBlocks = (list: PlanBlock[] | undefined): Block[] =>
  list?.length
    ? list.map((b) => ({
        title: b.title.replace(/\s*\d+\s*[′']$/, ""),
        minutes: String(b.minutes),
        phase: b.phase ?? "",
        intensity: b.intensity ?? "",
        description: b.description ?? "",
        equipment: b.equipment ?? "",
        target: b.target ?? "",
      }))
    : [blank()];

/** Only what the coach filled in goes to the server — empty strings would fail its checks. */
const toPlanBlocks = (list: Block[]): PlanBlock[] =>
  list.map((b) => ({
    title: b.title,
    minutes: Number(b.minutes),
    ...(b.phase ? { phase: b.phase } : {}),
    ...(b.intensity ? { intensity: b.intensity } : {}),
    ...(b.description.trim() ? { description: b.description.trim() } : {}),
    ...(b.equipment.trim() ? { equipment: b.equipment.trim() } : {}),
    ...(b.target.trim() ? { target: b.target.trim() } : {}),
  }));

const planMinutes = (list: Block[]) => list.reduce((n, b) => n + (Number.isFinite(Number(b.minutes)) ? Number(b.minutes) : 0), 0);

/** Monday of the week before the one holding `iso` (the centre's calendar). */
function lastWeekMonday(iso: string) {
  const day = new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return addDaysISO(day, -((dow + 6) % 7) - 7);
}

export function PlanPanel({ session, f5 }: { session: TrainingSession; f5: boolean }) {
  const plansRead = useRead<{ items: PlanRow[] }>(`/training-plans?class_id=${session.class_id}`);
  const plans = plansRead.data?.items ?? null;
  // Templates are an extra: if they do not come, the coach simply builds the plan from scratch.
  const tplRead = useRead<{ items: Template[] }>(`/training-plans/templates?sport=${session.sport}&level=${session.level}`);
  const templates = tplRead.data?.items ?? [];
  const [blocks, setBlocks] = useState<Block[]>([blank()]);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [focus, setFocus] = useState("core technique");
  const [busy, setBusy] = useState(false);
  // The plan being changed. Its payload is carried so goal / sport / level survive an edit.
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });
  const [history, setHistory] = useState<{ plan: PlanRow; items: Version[] } | null>(null);

  function reset() {
    setBlocks([blank()]);
    setTitle("");
    setNote("");
    setEditing(null);
    setTemplateId("");
    setOpen({ 0: true });
  }

  function warn(warnings: PlanWarning[] | undefined) {
    for (const w of warnings ?? []) toast.warning(tServer(w.message));
  }

  async function suggest() {
    try {
      const r = await apiPost<{ payload: PlanPayload }>("/training-plans/suggest", {
        sport: session.sport,
        level: session.level,
        goal: focus,
      });
      // The suggestion writes its length into the title ("Net shots 10′"); the minutes box already says it.
      const next = fromPlanBlocks(r.payload.blocks);
      if (r.payload.blocks?.length) setBlocks(next);
      toast.success(t("Suggestion added. Edit anything before you publish."));
    } catch (e) {
      toast.error(say(e));
    }
  }

  async function loadTemplate() {
    if (!templateId) return;
    const tpl = templates.find((x) => x.id === templateId);
    if (!tpl) return;
    setBlocks(fromPlanBlocks(tpl.payload.blocks));
    if (!title && tpl.title) setTitle(tpl.title);
    if (!note && tpl.payload.note) setNote(tpl.payload.note);
    setEditing(null);
    toast.success(t("Template loaded. Change anything, then save or publish."));
  }

  async function submit(published: boolean) {
    setBusy(true);
    try {
      const payload = {
        ...(editing?.payload ?? {}),
        goal: title || editing?.payload.goal || focus,
        note,
        blocks: toPlanBlocks(blocks),
      };
      if (editing) {
        const r = await apiPatch<{ warnings?: PlanWarning[] }>(`/training-plans/${editing.id}`, {
          title,
          payload,
          published,
        });
        toast.success(published ? t("Plan updated for the class") : t("Draft updated"));
        warn(r.warnings);
      } else {
        const r = await apiPost<{ warnings?: PlanWarning[] }>("/training-plans", {
          class_id: session.class_id,
          session_id: session.id,
          title,
          published,
          source: "coach",
          payload,
        });
        toast.success(published ? t("Plan published to the class") : t("Draft saved"));
        warn(r.warnings);
      }
      reset();
      plansRead.reload();
    } catch (e) {
      toast.error(say(e));
    } finally {
      setBusy(false);
    }
  }

  function edit(p: PlanRow) {
    setEditing(p);
    setTitle(p.title ?? "");
    setNote(p.payload.note ?? "");
    setBlocks(fromPlanBlocks(p.payload.blocks));
    setOpen({ 0: true });
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }

  async function toggle(p: PlanRow) {
    try {
      await apiPatch(`/training-plans/${p.id}`, { published: !p.published });
    } catch (e) {
      toast.error(say(e));
    }
    // Either way the list shows what the server holds now, so a plan someone else changed does not linger.
    plansRead.reload();
  }

  async function saveTemplate(p: PlanRow) {
    try {
      await apiPost(`/training-plans/${p.id}/save-template`, {
        title: p.title ?? undefined,
        sport: p.payload.sport ?? session.sport,
        level: p.payload.level ?? session.level,
      });
      toast.success(t("Saved as a template for this sport and level"));
      tplRead.reload();
    } catch (e) {
      toast.error(say(e));
    }
  }

  async function showHistory(p: PlanRow) {
    if (history?.plan.id === p.id) {
      setHistory(null);
      return;
    }
    try {
      const r = await apiGet<{ items: Version[] }>(`/training-plans/${p.id}/versions`);
      setHistory({ plan: p, items: r.items });
    } catch (e) {
      toast.error(say(e));
    }
  }

  async function copyLastWeek() {
    try {
      const r = await apiPost<{ copied: number; skipped: unknown[] }>(
        `/classes/${session.class_id}/plans/duplicate-week`,
        { from: lastWeekMonday(session.start_at) },
      );
      const skipped = r.skipped.length;
      toast.success(
        r.copied
          ? skipped
            ? r.copied === 1
              ? t("Copied 1 plan as a draft, skipped {s}.", { s: skipped })
              : t("Copied {n} plans as drafts, skipped {s}.", { n: r.copied, s: skipped })
            : r.copied === 1
              ? t("Copied 1 plan as a draft.")
              : t("Copied {n} plans as drafts.", { n: r.copied })
          : skipped
            ? skipped === 1
              ? t("Nothing copied: 1 session already planned, past or missing.")
              : t("Nothing copied: {n} sessions already planned, past or missing.", { n: skipped })
            : t("Last week had no plans to copy."),
      );
      plansRead.reload();
    } catch (e) {
      toast.error(say(e));
    }
  }

  const setBlock = (i: number, patch: Partial<Block>) =>
    setBlocks((l) => l.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const move = (i: number, by: -1 | 1) =>
    setBlocks((l) => {
      const j = i + by;
      if (j < 0 || j >= l.length) return l;
      const next = [...l];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <div>
      <SectionTitle text={t("Session plan")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("Plan this session block by block: what to do, how hard, with what, and what good looks like.")}{" "}
        {f5 ? `${t("The AI only suggests. You decide what students see.")} ` : ""}
        {t("Published plans appear under My progress for everyone in the class.")}
      </p>
      <Reveal>
        <Card className="mt-3 grid gap-4">
          {editing ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-hold/10 px-3 py-2 text-sm">
              <span>
                {editing.published
                  ? t("Editing “{title}”. Students will be told it changed and the old version is kept.", {
                      title: editing.title || t("plan"),
                    })
                  : t("Editing “{title}”.", { title: editing.title || t("plan") })}
              </span>
              <Button size="sm" variant="ghost" onClick={reset}>
                {t("Cancel edit")}
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("Title")}>
              <Input maxLength={120} placeholder={t("Footwork and net play")} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            {f5 ? (
              <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <Field label={t("Focus")}>
                  <Select value={focus} onChange={(e) => setFocus(e.target.value)}>
                    <option value="core technique">{t("Core technique")}</option>
                    <option value="conditioning">{t("Conditioning")}</option>
                    <option value="match play">{t("Match play")}</option>
                  </Select>
                </Field>
                <Button variant="outline" onClick={suggest}>
                  {t("Suggest")}
                </Button>
              </div>
            ) : null}
          </div>

          {templates.length && !editing ? (
            <div className="grid grid-cols-[1fr_auto] items-end gap-2 md:max-w-md">
              <Field label={t("Start from a template")}>
                <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">{t("Choose…")}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.title || t("Untitled template")} · {blocksLabel((tpl.payload.blocks ?? []).length)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="outline" disabled={!templateId} onClick={() => void loadTemplate()}>
                {t("Use")}
              </Button>
            </div>
          ) : null}

          <div className="grid gap-2">
            {blocks.map((b, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-line p-3">
                <div className="grid grid-cols-[1fr_5rem] gap-2 md:grid-cols-[1fr_8rem_7rem_5rem]">
                  <Input
                    aria-label={t("Block {n} title", { n: i + 1 })}
                    maxLength={120}
                    placeholder={t("Block {n}", { n: i + 1 })}
                    value={b.title}
                    onChange={(e) => setBlock(i, { title: e.target.value })}
                  />
                  <Input
                    aria-label={t("Block {n} minutes", { n: i + 1 })}
                    inputMode="numeric"
                    className="md:order-4"
                    value={b.minutes}
                    onChange={(e) => setBlock(i, { minutes: e.target.value })}
                  />
                  <Select
                    aria-label={t("Block {n} phase", { n: i + 1 })}
                    className="md:order-2"
                    value={b.phase}
                    onChange={(e) => setBlock(i, { phase: e.target.value })}
                  >
                    <option value="">{t("Phase")}</option>
                    {PHASES.map((p) => (
                      <option key={p} value={p}>
                        {t(p)}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={t("Block {n} intensity", { n: i + 1 })}
                    className="md:order-3"
                    value={b.intensity}
                    onChange={(e) => setBlock(i, { intensity: e.target.value })}
                  >
                    <option value="">{t("Intensity")}</option>
                    {INTENSITIES.map((p) => (
                      <option key={p} value={p}>
                        {t(p)}
                      </option>
                    ))}
                  </Select>
                </div>
                {open[i] ? (
                  <div className="grid gap-2">
                    <Textarea
                      rows={2}
                      maxLength={600}
                      aria-label={t("Block {n} description", { n: i + 1 })}
                      placeholder={t("How it runs: drill set-up, reps, rotation…")}
                      value={b.description}
                      onChange={(e) => setBlock(i, { description: e.target.value })}
                    />
                    <div className="grid gap-2 md:grid-cols-2">
                      <Input
                        aria-label={t("Block {n} equipment", { n: i + 1 })}
                        maxLength={200}
                        placeholder={t("Equipment: shuttles, cones, ladder…")}
                        value={b.equipment}
                        onChange={(e) => setBlock(i, { equipment: e.target.value })}
                      />
                      <Input
                        aria-label={t("Block {n} target", { n: i + 1 })}
                        maxLength={200}
                        placeholder={t("Target: 8 of 10 clears past the line…")}
                        value={b.target}
                        onChange={(e) => setBlock(i, { target: e.target.value })}
                      />
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}>
                    {open[i] ? t("Hide details") : t("Details")}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("Move block {n} up", { n: i + 1 })}>
                    {t("Up")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={i === blocks.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={t("Move block {n} down", { n: i + 1 })}
                  >
                    {t("Down")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={blocks.length === 1}
                    onClick={() => setBlocks((l) => l.filter((_, j) => j !== i))}
                  >
                    {t("Remove")}
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" size="sm" disabled={blocks.length >= MAX_BLOCKS} onClick={() => setBlocks((l) => [...l, blank()])}>
                {t("Add block")}
              </Button>
              <span className="text-xs text-muted">
                {t("{n} of {max} blocks · {min} min in total", { n: blocks.length, max: MAX_BLOCKS, min: planMinutes(blocks) })}
              </span>
            </div>
          </div>

          <Field label={t("Note for students")}>
            <Input maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || session.status === "cancelled"} onClick={() => submit(true)}>
              {editing ? t("Save and publish") : t("Publish to the class")}
            </Button>
            <Button variant="outline" disabled={busy || session.status === "cancelled"} onClick={() => submit(false)}>
              {t("Save as draft")}
            </Button>
            {!editing ? (
              <Button variant="ghost" onClick={copyLastWeek}>
                {t("Copy plans from last week")}
              </Button>
            ) : null}
          </div>
        </Card>
      </Reveal>

      <div className="mt-4 grid gap-2">
        {plansRead.error ? (
          <LoadError
            message={plansRead.error.message}
            onRetry={plansRead.error.refused ? undefined : plansRead.reload}
          />
        ) : !plans ? (
          <Skeleton className="h-16" />
        ) : !plans.length ? (
          <EmptyState title={t("No plans for this class yet")} hint={t("Build one above, or copy last week's.")} />
        ) : (
          plans.map((p) => (
            <Card key={p.id} className="grid gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{p.title || (p.payload.blocks?.[0]?.title ?? t("Plan"))}</p>
                  <p className="text-xs text-muted">
                    {p.session_start ? `${sessionDay(p.session_start)} · ${hhmm(p.session_start)}` : t("Whole class")} ·{" "}
                    {blocksLabel((p.payload.blocks ?? []).length)} ·{" "}
                    {t("{n} min", { n: (p.payload.blocks ?? []).reduce((n, b) => n + b.minutes, 0) })}
                    {p.version && p.version > 1 ? ` · v${p.version}` : ""}
                    {p.source === "ai" ? ` · ${t("AI draft")}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={p.published ? "accent" : "muted"}>{p.published ? t("Published") : t("Draft")}</Badge>
                  <Button size="sm" variant="outline" onClick={() => edit(p)}>
                    {t("Edit")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toggle(p)}>
                    {p.published ? t("Unpublish") : t("Publish")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void saveTemplate(p)}>
                    {t("Save as template")}
                  </Button>
                  {p.version && p.version > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => void showHistory(p)}>
                      {history?.plan.id === p.id ? t("Hide history") : t("History")}
                    </Button>
                  ) : null}
                </div>
              </div>
              {history?.plan.id === p.id ? (
                <ul className="grid gap-1 border-t border-line pt-2 text-xs text-muted">
                  {history.items.map((v) => (
                    <li key={v.version}>
                      v{v.version} · {formatDate(v.created_at)} · {blocksLabel((v.payload.blocks ?? []).length)},{" "}
                      {t("{n} min", { n: (v.payload.blocks ?? []).reduce((n, b) => n + b.minutes, 0) })}
                      {v.title ? ` · ${v.title}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Homework (FR-TRN-07)                                                 *
 * ------------------------------------------------------------------ */

type HwRow = {
  id: string;
  title: string;
  due_on: string | null;
  checklist: string[];
  recipients: number;
  completed: number;
  student_name: string | null;
};

export function HomeworkPanel({ classId }: { classId: string }) {
  const { data, error, reload } = useRead<{ items: HwRow[] }>(`/homework?class_id=${classId}`);
  const items = data?.items ?? null;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [lines, setLines] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);

  async function assign() {
    setBusy(true);
    try {
      const r = await apiPost<{ recipients: number }>("/homework", {
        class_id: classId,
        title,
        body,
        due_on: due || null,
        checklist: lines
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      toast.success(
        r.recipients === 1 ? t("Homework sent to 1 student") : t("Homework sent to {n} students", { n: r.recipients }),
      );
      setTitle("");
      setBody("");
      setLines("");
      setDue("");
      reload();
    } catch (e) {
      toast.error(say(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SectionTitle text={t("Homework")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">{t("Something to practise before the next class. Students tick items off as they go.")}</p>
      <Card className="mt-3 grid gap-3">
        <div className="grid gap-3 md:grid-cols-[1fr_12rem]">
          <Field label={t("Title")}>
            <Input maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label={t("Due")}>
            <DateField aria-label={t("Due date")} value={due} onChange={setDue} />
          </Field>
        </div>
        <Field label={t("Description")}>
          <Textarea rows={2} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label={t("Checklist")} hint={t("One item per line, up to 20.")} tone="muted">
          <Textarea rows={3} value={lines} onChange={(e) => setLines(e.target.value)} placeholder={`${t("50 wall shots")}\n${t("10 minutes of footwork")}`} />
        </Field>
        <div>
          <Button onClick={assign} disabled={busy || !title.trim()}>
            {t("Assign to the class")}
          </Button>
        </div>
      </Card>
      <div className="mt-3 grid gap-2">
        {error ? (
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        ) : !items ? (
          <Skeleton className="h-16" />
        ) : items.length === 0 ? (
          <EmptyState title={t("No homework assigned.")} />
        ) : (
          items.map((h) => (
            <Card key={h.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">{h.title}</p>
                <p className="text-xs text-muted">
                  {h.due_on ? t("Due {date}", { date: formatDate(h.due_on) }) : t("No due date")} ·{" "}
                  {h.checklist.length === 1 ? t("1 item") : t("{n} items", { n: h.checklist.length })}
                </p>
              </div>
              <Badge tone={h.completed === h.recipients ? "accent" : "muted"}>
                {t("{done}/{total} done", { done: h.completed, total: h.recipients })}
              </Badge>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
