import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Plus, RefreshCw } from "lucide-react";
import { Shell } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { RowActions } from "@/client/components/row-actions";
import { SportBadge } from "@/client/components/sports-ui";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, Modal, Pagination, Seg, Select, Skeleton } from "@/client/components/ui";
import { sportLabel } from "@/shared/arena3/labels";
import { cn } from "@/client/lib/cn";
import { t, tServer } from "@/client/lib/i18n";
import { useManagerCourts, STATUS_OPTS } from "@/client/lib/pages/manager.courts";


export const Route = createFileRoute("/manager/courts")({
  component: Page,
});

function Page() {
  const {
    read, items, sport, setSport, statusFilter, setStatusFilter, offset, setOffset, pageSize,
    sports, creating, setCreating, createSport, setCreateSport, createCode, setCreateCode,
    createName, setCreateName, createSortOrder, setCreateSortOrder, createSubmitting, editing,
    setEditing, editCode, setEditCode, editName, setEditName, editSortOrder, setEditSortOrder,
    editSport, setEditSport, editSubmitting, retiring, setRetiring, retireSubmitting,
    blockedRetire, setBlockedRetire, actionBusy, total, filtered, pagedItems, handleCreate,
    startEdit, handleEdit, handleStatusChange, handleRetire, handleRestore, statItems,
  } = useManagerCourts();

  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Courts")}
        subtitle={t("Manage courts and sports")}
      />
      <StatStrip className="mb-4" items={statItems} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 size-4" />
            {t("Add court")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void read.reload()}>
            <RefreshCw className="mr-1.5 size-3.5" />
            {t("Refresh")}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-4 grid gap-3 p-4 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            value={sport}
            onChange={(v) => {
              setSport(v);
              setOffset(0);
            }}
            options={[
              { value: "", label: t("All") },
              ...sports.map((s) => ({ value: s.code, label: sportLabel(s.code) })),
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t("Status")}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">{t("Any status")}</option>
            <option value="ready">{t("Open")}</option>
            <option value="maintenance">{t("Maintenance")}</option>
            <option value="closed">{t("Closed")}</option>
            <option value="retired">{t("Retired")}</option>
          </Select>
        </div>
      </Card>

      {/* Courts List */}
      <div aria-busy={read.stale} className={cn("transition-opacity", read.stale && "opacity-60")}>
        {read.error ? (
          <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
        ) : !items ? (
          <Skeleton className="h-48" />
        ) : !filtered.length ? (
          <EmptyState
            title={t("No courts match those filters")}
            hint={t("Clear filters to see all courts.")}
          >
            <Button onClick={() => setCreating(true)}>{t("Add court")}</Button>
          </EmptyState>
        ) : (
          <div className="grid gap-3">
            {pagedItems.map((c) => {
              const isRetired = !!c.retired_at;
              return (
                <Card
                  key={c.id}
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-4 p-4 transition-all duration-200",
                    isRetired && "border-line/50 bg-wood/40 opacity-70",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-lg font-bold">{c.court_code}</span>
                      {c.display_name ? (
                        <span className="text-sm font-medium text-fg">{c.display_name}</span>
                      ) : null}
                      <SportBadge sport={c.sport} />
                      {isRetired ? (
                        <Badge tone="muted">{t("Retired")}</Badge>
                      ) : (
                        <Badge
                          tone={
                            c.status === "ready"
                              ? "accent"
                              : c.status === "maintenance"
                                ? "hold"
                                : "danger"
                          }
                        >
                          {t(c.status === "ready" ? "Open" : c.status === "maintenance" ? "Maintenance" : "Closed")}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                      <span>{t("{n} upcoming bookings", { n: c.upcoming_bookings })}</span>
                      <span>·</span>
                      <span>{t("{n} active classes", { n: c.active_classes })}</span>
                      <span>·</span>
                      <span>{c.has_custom_price ? t("Custom pricing") : t("Standard pricing")}</span>
                      {c.sort_order != null ? (
                        <>
                          <span>·</span>
                          <span>{t("Order: {n}", { n: c.sort_order })}</span>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    {!isRetired ? (
                      <>
                        {/* Status switcher */}
                        <div
                          role="group"
                          aria-label={t("Status for {code}", { code: c.court_code })}
                          className="inline-flex rounded-[var(--radius-md)] bg-wood p-0.5"
                        >
                          {STATUS_OPTS.map((st) => {
                            const on = c.status === st.value;
                            return (
                              <button
                                key={st.value}
                                type="button"
                                aria-pressed={on}
                                disabled={actionBusy === c.id}
                                onClick={() => void handleStatusChange(c, st.value)}
                                className={cn(
                                  "min-h-9 rounded-[var(--radius-sm)] px-2.5 text-2xs font-semibold transition-colors duration-200 disabled:opacity-50",
                                  on
                                    ? st.tone === "accent"
                                      ? "bg-accent text-accent-fg"
                                      : st.tone === "hold"
                                        ? "bg-hold text-bg"
                                        : "bg-danger text-on-media"
                                    : "text-muted hover:text-fg",
                                )}
                              >
                                {t(st.label)}
                              </button>
                            );
                          })}
                        </div>

                        <RowActions
                          primary={{
                            label: t("Edit"),
                            onClick: () => startEdit(c),
                          }}
                          secondary={[
                            {
                              label: t("Retire court"),
                              danger: true,
                              confirm: t("Are you sure you want to retire this court?"),
                              disabled: actionBusy === c.id,
                              onClick: () => setRetiring(c),
                            },
                          ]}
                        />
                      </>
                    ) : (
                      <RowActions
                        primary={{
                          label: t("Restore court"),
                          disabled: actionBusy === c.id,
                          onClick: () => void handleRestore(c),
                        }}
                      />
                    )}
                  </div>
                </Card>
              );
            })}

            {filtered.length > pageSize ? (
              <Pagination offset={offset} total={filtered.length} pageSize={pageSize} onChange={setOffset} />
            ) : null}
          </div>
        )}
      </div>

      {/* Create Court Modal */}
      <Modal open={creating} onClose={() => setCreating(false)} title={t("Add court")}>
        <form onSubmit={(e) => void handleCreate(e)} className="grid gap-4">
          <Field label={t("Sport")}>
            <Select value={createSport} onChange={(e) => setCreateSport(e.target.value)}>
              {sports.map((s) => (
                <option key={s.code} value={s.code}>
                  {sportLabel(s.code)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("Court code")} hint={t("Leave blank to auto-generate code")}>
            <Input
              value={createCode}
              onChange={(e) => setCreateCode(e.target.value)}
              placeholder="e.g. CL-13"
            />
          </Field>
          <Field label={t("Display name")}>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g. Court VIP 1"
            />
          </Field>
          <Field label={t("Sort order")}>
            <Input
              type="number"
              value={createSortOrder}
              onChange={(e) => setCreateSortOrder(e.target.value)}
              placeholder="1, 2, 3…"
            />
          </Field>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setCreating(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={createSubmitting}>
              {createSubmitting ? t("Saving…") : t("Add court")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Court Modal */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={t("Edit court")}>
        <form onSubmit={(e) => void handleEdit(e)} className="grid gap-4">
          <Field label={t("Sport")}>
            <Select value={editSport} onChange={(e) => setEditSport(e.target.value)}>
              {sports.map((s) => (
                <option key={s.code} value={s.code}>
                  {sportLabel(s.code)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("Court code")}>
            <Input
              value={editCode}
              onChange={(e) => setEditCode(e.target.value)}
              required
            />
          </Field>
          <Field label={t("Display name")}>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="e.g. Court VIP 1"
            />
          </Field>
          <Field label={t("Sort order")}>
            <Input
              type="number"
              value={editSortOrder}
              onChange={(e) => setEditSortOrder(e.target.value)}
              placeholder="1, 2, 3…"
            />
          </Field>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setEditing(null)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={editSubmitting}>
              {editSubmitting ? t("Saving…") : t("Save")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Retire Confirm Modal */}
      <Modal open={!!retiring} onClose={() => setRetiring(null)} title={t("Retire this court?")}>
        <div className="grid gap-4">
          <p className="text-sm text-muted">
            {t("Are you sure you want to retire {code}?", { code: retiring?.court_code ?? "" })}
          </p>
          <p className="text-xs text-muted">
            {t("This will remove the court from booking grids. Past bookings and invoices will remain intact.")}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setRetiring(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={retireSubmitting}
              onClick={() => retiring && void handleRetire(retiring)}
            >
              {retireSubmitting ? t("Saving…") : t("Retire court")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Blocked Retire Modal (409) */}
      <Modal
        open={!!blockedRetire}
        onClose={() => setBlockedRetire(null)}
        title={t("Cannot retire court")}
      >
        <div className="grid gap-4">
          <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-danger/25 bg-danger/5 p-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
            <div className="text-sm">
              <p className="font-semibold text-danger">
                {tServer(blockedRetire?.message ?? "")}
              </p>
              <p className="mt-1 text-xs text-muted">
                {t("Please reschedule or cancel upcoming bookings and classes before retiring this court.")}
              </p>
            </div>
          </div>

          {blockedRetire?.affected && blockedRetire.affected.length > 0 ? (
            <div>
              <p className="mb-2 text-xs font-semibold text-fg">
                {t("Affected bookings & sessions")}
              </p>
              <div className="max-h-48 overflow-y-auto rounded-[var(--radius-md)] border border-line p-2">
                <ul className="grid gap-2 text-xs">
                  {blockedRetire.affected.map((item, idx) => (
                    <li key={idx} className="flex items-center justify-between border-b border-line/40 pb-1.5 last:border-b-0 last:pb-0">
                      <span className="font-medium text-fg">{item.description}</span>
                      <span className="tabular-nums text-muted">
                        {new Date(item.start_at).toLocaleDateString()} {new Date(item.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <div className="mt-2 flex justify-end">
            <Button onClick={() => setBlockedRetire(null)}>
              {t("OK")}
            </Button>
          </div>
        </div>
      </Modal>
    </Shell>
  );
}
