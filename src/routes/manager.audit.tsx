import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { Shell } from "@/client/components/shell";
import { Badge, Button, Card, DateField, EmptyState, Input, LoadError, Pagination, Skeleton } from "@/client/components/ui";
import { Stagger, StaggerItem } from "@/client/components/motion";
import { roleLabel } from "@/shared/arena3/labels";
import { formatVnd } from "@/shared/arena3/time";
import { cn } from "@/client/lib/cn";
import { locale, t, tk } from "@/client/lib/i18n";
import { useManagerAudit, selectCls, detail, changesOf, actionLabel, entityLabel, toneFor, when } from "@/client/lib/pages/manager.audit";


export const Route = createFileRoute("/manager/audit")({
  component: Page,
});

function Page() {
  const {
    offset, setOffset, pageSize, setPageSize, reset, action, setAction, actor, setActor, entity,
    setEntity, from, setFrom, to, setTo, q, setQ, open, setOpen, raw, setRaw, hidden, showHidden,
    setShowHidden, choices, read, data, pick, hide, restoreAll, rows, hiddenHere, filtered,
  } = useManagerAudit();

  return (
    <Shell
      role="manager"
      title={t("Audit")}
      subtitle={t("Who changed what, newest first. Hiding an entry only tidies this screen; the log itself is never edited.")}
    >
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select
          value={action}
          onChange={(e) => pick(setAction)(e.target.value)}
          className={selectCls}
          aria-label={t("Filter by action")}
        >
          <option value="">{t("All actions")}</option>
          {choices.actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
        <select
          value={actor}
          onChange={(e) => pick(setActor)(e.target.value)}
          className={selectCls}
          aria-label={t("Filter by person")}
        >
          <option value="">{t("Anyone")}</option>
          {choices.actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.full_name} · {roleLabel(a.role)}
            </option>
          ))}
        </select>
        <select
          value={entity}
          onChange={(e) => pick(setEntity)(e.target.value)}
          className={selectCls}
          aria-label={t("Filter by what was changed")}
        >
          <option value="">{t("Anything")}</option>
          {choices.entities.map((a) => (
            <option key={a} value={a}>
              {entityLabel(a)}
            </option>
          ))}
        </select>
        <label className="grid gap-0.5 text-2xs text-muted">
          {t("From")}
          <DateField value={from} max={to || undefined} onChange={(v) => pick(setFrom)(v)} aria-label={t("From")} className="sm:h-10" />
        </label>
        <label className="grid gap-0.5 text-2xs text-muted">
          {t("To")}
          <DateField value={to} min={from || undefined} onChange={(v) => pick(setTo)(v)} aria-label={t("To")} className="sm:h-10" />
        </label>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Search this list")}
          aria-label={t("Search the log")}
          className="max-w-[12rem]"
        />
        {filtered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              reset();
              setAction("");
              setActor("");
              setEntity("");
              setFrom("");
              setTo("");
              setQ("");
            }}
          >
            {t("Clear filters")}
          </Button>
        ) : null}
        <span className="ml-auto text-2xs text-muted">
          {read.error ? "" : data && !read.stale ? t("{n} entries", { n: data.total.toLocaleString(locale()) }) : t("Loading")}
        </span>
      </div>
      {hiddenHere ? (
        <p className="mb-3 text-xs text-muted">
          {t("{n} hidden on this screen.", { n: hiddenHere })}{" "}
          <button type="button" className="underline" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? t("Hide them again") : t("Show them")}
          </button>
          {" · "}
          <button type="button" className="underline" onClick={restoreAll}>
            {t("Restore all")}
          </button>
        </p>
      ) : null}

      <SectionTitle text={tk("Activity")} className="mb-3 font-display text-2xl" />

      <div aria-busy={read.stale} className={cn("transition-opacity", read.stale && "opacity-60")}>
      {read.error ? (
        <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
      ) : !data ? (
        <div className="grid gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : rows.length ? (
        <Stagger className="grid gap-1.5" gap={0.02}>
          {rows.map((e) => {
            const isOpen = open === e.id;
            const before = isOpen ? detail(e.before) : null;
            const after = isOpen ? detail(e.after) : null;
            return (
              <StaggerItem key={e.id}>
                <Card className={`p-0 ${hidden.includes(e.id) ? "opacity-60" : ""}`}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : e.id)}
                    className="grid w-full gap-1 px-3 py-2 text-left"
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone={toneFor(e.action)}>{actionLabel(e.action)}</Badge>
                      <span className="min-w-0 text-sm font-medium">{e.subject || entityLabel(e.entity)}</span>
                      {e.subject_vnd != null ? (
                        <span className="text-sm tabular-nums">{formatVnd(e.subject_vnd)}</span>
                      ) : null}
                      <span className="ml-auto text-xs tabular-nums text-muted">{when(e.at)}</span>
                    </span>
                    <span className="text-xs text-muted">
                      {t("By {name}", { name: e.actor_name ?? t("System") })}
                      {e.actor_role ? ` · ${roleLabel(e.actor_role)}` : ""}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="grid gap-2 border-t border-line px-3 py-2 text-xs">
                      {before || after ? (
                        <AuditChanges before={e.before} after={e.after} />
                      ) : null}
                      {(before || after) && raw === e.id ? (
                        <div className="grid gap-2 md:grid-cols-2">
                          {e.entity_id ? (
                            <p className="text-muted md:col-span-2">
                              {t("Record")}: <span className="break-all font-mono">{e.entity_id}</span>
                            </p>
                          ) : null}
                          {before ? (
                            <div>
                              <p className="mb-1 text-muted">{t("Before")}</p>
                              <pre className="max-h-48 overflow-auto rounded-[var(--radius-sm)] bg-wood p-2">{before}</pre>
                            </div>
                          ) : null}
                          {after ? (
                            <div>
                              <p className="mb-1 text-muted">{t("After")}</p>
                              <pre className="max-h-48 overflow-auto rounded-[var(--radius-sm)] bg-wood p-2">{after}</pre>
                            </div>
                          ) : null}
                        </div>
                      ) : before || after ? null : (
                        <p className="text-muted">{t("No further details were recorded.")}</p>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {before || after ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-expanded={raw === e.id}
                            onClick={() => setRaw(raw === e.id ? null : e.id)}
                          >
                            {raw === e.id ? t("Hide raw") : t("Show raw")}
                          </Button>
                        ) : null}
                        {!hidden.includes(e.id) ? (
                          <Button size="sm" variant="ghost" onClick={() => hide(e.id)}>
                            {t("Hide from this screen")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </Card>
              </StaggerItem>
            );
          })}
        </Stagger>
      ) : (
        <EmptyState
          title={filtered ? t("Nothing matches that") : t("Nothing recorded yet")}
          hint={
            filtered
              ? t("Clear the filters, or widen the dates.")
              : t("Entries appear here as staff take payments, change prices and refund.")
          }
        />
      )}
      {!read.error ? (
        <Pagination
          offset={offset}
          total={data?.total ?? 0}
          pageSize={pageSize}
          onChange={(o) => {
            setOpen(null);
            setOffset(o);
          }}
          onPageSizeChange={setPageSize}
          label={t("Audit pages")}
        />
      ) : null}
      </div>
    </Shell>
  );
}

/** Field, old value, new value: only what the action changed. */
function AuditChanges({ before, after }: { before: unknown; after: unknown }) {
  const changes = changesOf(before, after);
  if (!changes.length) return <p className="text-muted">{t("No further details were recorded.")}</p>;
  return (
    <dl className="grid gap-1 rounded-[var(--radius-sm)] bg-wood p-2 sm:grid-cols-[minmax(8rem,auto)_1fr] sm:gap-x-4">
      {changes.map((c) => (
        <div key={c.key} className="contents">
          <dt className="pt-1 text-muted sm:pt-0">{c.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
            {c.from !== null ? (
              <>
                <span className="break-all text-muted line-through decoration-line-strong">{c.from}</span>
                <span aria-hidden className="text-muted">→</span>
                <span className="sr-only">{t("changed to")}</span>
              </>
            ) : null}
            <span className="break-all font-medium text-fg">{c.to}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
