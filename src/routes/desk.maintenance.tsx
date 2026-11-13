import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/client/components/section";
import { Shell, money, useSessionUser, when } from "@/client/components/shell";
import {
  Badge,
  Button,
  Card,
  Check,
  EmptyState,
  Field,
  Input,
  LoadError,
  MoneyInput,
  Select,
  Skeleton,
  Stat,
  Pagination,
} from "@/client/components/ui";
import { Reveal, Stagger, StaggerItem } from "@/client/components/motion";
import { ApiClientError, apiPatch, apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";
import { usePageState } from "@/client/lib/use-page-state";
import { useRead } from "@/client/lib/use-read";

export const Route = createFileRoute("/desk/maintenance")({ component: Page });

type Court = { id: string; court_code: string };
type WO = {
  id: string;
  code: string;
  court_id: string | null;
  court_code: string | null;
  title: string;
  description: string | null;
  priority: "low" | "normal" | "urgent";
  status: "open" | "in_progress" | "done" | "cancelled";
  blocks_court: boolean;
  assignee: string | null;
  cost_vnd: number;
  resolution: string | null;
  created_at: string;
  closed_at: string | null;
  reporter: string | null;
};
type Data = { items: WO[]; total: number; open: number; urgent: number; cost_month_vnd: number };

const prio = (p: string) => (p === "urgent" ? t("Urgent") : p === "low" ? t("Low") : t("Normal"));
const stat = (s: string) => (s === "open" ? t("Open") : s === "in_progress" ? t("In progress") : s === "done" ? t("Done") : t("Cancelled"));

function Page() {
  const user = useSessionUser();
  const role = user?.role === "manager" ? "manager" : user?.role === "coach" ? "coach" : "receptionist";
  const canEdit = role !== "coach";
  const [filter, setFilter] = useState("active");
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("desk.maintenance", 25);
  useEffect(reset, [filter, reset]);
  const woParams = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (filter !== "all") woParams.set("status", filter);
  const read = useRead<Data>(`/work-orders?${woParams}`, { keepPrevious: true });
  // null = not known yet (still asking, or the question failed) — never zero tickets.
  const data = read.data;
  const courtsRead = useRead<{ items: Court[] }>("/courts");
  const courts = courtsRead.data?.items ?? [];
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [courtId, setCourtId] = useState("");
  const [priority, setPriority] = useState("normal");
  const [blocks, setBlocks] = useState(false);
  const [fe, setFe] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<{ id: string; cost: string; note: string } | null>(null);

  async function create() {
    setFe(null);
    setBusy(true);
    try {
      const r = await apiPost<{ code: string }>("/work-orders", {
        title,
        description: desc || undefined,
        court_id: courtId || undefined,
        priority,
        blocks_court: blocks,
      });
      toast.success(t("Ticket {code} created", { code: r.code }));
      setTitle("");
      setDesc("");
      setBlocks(false);
      read.reload();
    } catch (e) {
      if (e instanceof ApiClientError) setFe({ field: e.body.field, message: e.message });
      else setFe({ message: e instanceof Error ? tServer(e.message) : t("Something went wrong") });
    } finally {
      setBusy(false);
    }
  }

  /** True when the change went through, so a form the person typed into is only closed once it has been saved. */
  async function patch(id: string, body: Record<string, unknown>, ok?: string) {
    try {
      await apiPatch(`/work-orders/${id}`, body);
      if (ok) toast.success(ok);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
      return false;
    } finally {
      // Either way the list is asked again: after a refusal it may be someone else's change that got in first.
      read.reload();
    }
  }

  // The server applies the view ("active" = open or in progress) and pages it.
  const shown = data?.items ?? [];
  const f = (k: string) => (fe?.field === k ? fe.message : undefined);

  return (
    <Shell
      role={role}
      title={t("Maintenance")}
      subtitle={t("Report what is broken. A ticket can take a court out of booking until it is fixed.")}
    >
      <Reveal from="down">
        <Card className="mb-4 grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <Field label={t("What is wrong?")} hint={f("title")}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("e.g. Net on court 3 is torn")} />
            </Field>
          </div>
          <Field label={t("Court")} hint={courtsRead.error?.message}>
            <Select value={courtId} onChange={(e) => setCourtId(e.target.value)}>
              <option value="">{t("Not about one court")}</option>
              {courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.court_code}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("How urgent?")} hint={f("priority")}>
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="low">{t("Low")}</option>
              <option value="normal">{t("Normal")}</option>
              <option value="urgent">{t("Urgent")}</option>
            </Select>
          </Field>
          <div className="md:col-span-3">
            <Field label={t("Details (optional)")}>
              <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <Check checked={blocks} disabled={!courtId} onChange={(e) => setBlocks(e.target.checked)} label={t("Close the court until fixed")} />
            <Button disabled={busy || !title.trim()} onClick={() => void create()}>
              {t("Report it")}
            </Button>
          </div>
          {fe && !fe.field ? <p role="alert" className="text-sm text-danger md:col-span-4">{fe.message}</p> : null}
        </Card>
      </Reveal>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={t("Open tickets")} value={data ? String(data.open) : "-"} />
        <Stat label={t("Urgent")} value={data ? String(data.urgent) : "-"} />
        <Stat label={t("Repair cost this month")} value={data ? money(data.cost_month_vnd) : "-"} />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionTitle text={t("Tickets")} className="font-display text-2xl" />
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("Show")}>
          <option value="active">{t("Still to fix")}</option>
          <option value="done">{t("Done")}</option>
          <option value="all">{t("All")}</option>
        </Select>
      </div>

      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <Skeleton className="h-24" />
      ) : shown.length === 0 ? (
        <EmptyState title={t("Nothing here")} hint={t("No tickets match this view.")} />
      ) : (
        <Stagger className="grid gap-2" gap={0.04}>
          {shown.map((w) => (
            <StaggerItem key={w.id}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {w.title} <span className="font-mono text-xs text-muted">{w.code}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {w.court_code ?? t("General")} · {w.reporter ?? "-"} · {when(w.created_at)}
                      {w.assignee ? ` · ${w.assignee}` : ""}
                    </p>
                    {w.description ? <p className="mt-1 text-sm">{w.description}</p> : null}
                    {w.resolution ? <p className="mt-1 text-sm text-muted">{w.resolution}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {w.blocks_court && (w.status === "open" || w.status === "in_progress") ? <Badge tone="danger">{t("Court closed")}</Badge> : null}
                    <Badge tone={w.priority === "urgent" ? "danger" : w.priority === "low" ? "muted" : "hold"}>{prio(w.priority)}</Badge>
                    <Badge tone={w.status === "done" ? "accent" : w.status === "cancelled" ? "muted" : "ink"}>{stat(w.status)}</Badge>
                    {w.cost_vnd > 0 ? <span className="text-xs tabular-nums text-muted">{money(w.cost_vnd)}</span> : null}
                  </div>
                </div>
                {canEdit && (w.status === "open" || w.status === "in_progress") ? (
                  closing?.id === w.id ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto] sm:items-end">
                      <Field label={t("Cost (đ)")}>
                        <MoneyInput value={closing.cost} onChange={(v) => setClosing({ ...closing, cost: v })} />
                      </Field>
                      <Field label={t("What was done?")}>
                        <Input value={closing.note} onChange={(e) => setClosing({ ...closing, note: e.target.value })} />
                      </Field>
                      <Button
                        size="sm"
                        onClick={() => {
                          void patch(w.id, { status: "done", cost_vnd: Number(closing.cost) || 0, resolution: closing.note }, t("Ticket closed")).then((saved) => {
                            if (saved) setClosing(null);
                          });
                        }}
                      >
                        {t("Mark done")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setClosing(null)}>
                        {t("Back")}
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {w.status === "open" ? (
                        <Button size="sm" variant="outline" onClick={() => void patch(w.id, { status: "in_progress" })}>
                          {t("Start work")}
                        </Button>
                      ) : null}
                      <Button size="sm" onClick={() => setClosing({ id: w.id, cost: "", note: "" })}>
                        {t("Fixed")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void patch(w.id, { status: "cancelled" }, t("Ticket cancelled"))}>
                        {t("Cancel ticket")}
                      </Button>
                    </div>
                  )
                ) : null}
              </Card>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      <Pagination
        offset={offset}
        total={data?.total ?? 0}
        pageSize={pageSize}
        onChange={setOffset}
        onPageSizeChange={setPageSize}
        label={t("Ticket pages")}
      />
    </Shell>
  );
}
