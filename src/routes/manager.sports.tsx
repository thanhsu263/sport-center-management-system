import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Flame,
  LayoutGrid,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trophy,
  Undo2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { CardTitle, SectionTitle } from "@/components/section";
import { Shell } from "@/components/shell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  LoadError,
  Modal,
  PageHero,
  Select,
  Skeleton,
  Stat,
} from "@/components/ui";
import { SportDot, SportThumbnail, invalidateSportsCache } from "@/components/sports-ui";
import { apiDelete, apiPatch, apiPost } from "@/lib/arena3/client";
import { sportLabel } from "@/lib/arena3/labels";
import { cn } from "@/lib/cn";
import { t, tk, tServer } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/manager/sports")({
  component: Page,
});

export type ManagerSport = {
  code: string;
  name_en: string;
  name_vi: string;
  court_prefix: string | null;
  color_key: string;
  glyph_key: string;
  is_scope_all: boolean;
  max_players: number;
  slot_duration_min: number;
  sort_order: number;
  enabled: boolean;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
  active_courts_count: number;
  future_bookings_count: number;
  future_classes_count: number;
  active_plans_count: number;
  photo_url: string;
};

const COLOR_KEYS = [
  { key: "leaf", label: tk("Leaf (Green)") },
  { key: "clay", label: tk("Clay (Terracotta)") },
  { key: "sun", label: tk("Sun (Amber)") },
  { key: "sky", label: tk("Sky (Blue)") },
  { key: "plum", label: tk("Plum (Purple)") },
  { key: "slate", label: tk("Slate (Grey)") },
  { key: "moss", label: tk("Moss (Olive)") },
  { key: "dune", label: tk("Dune (Sand)") },
] as const;

const GLYPH_KEYS = [
  { key: "generic", label: tk("Generic Sport") },
  { key: "badminton", label: tk("Shuttlecock") },
  { key: "basketball", label: tk("Basketball") },
  { key: "volleyball", label: tk("Volleyball") },
] as const;

function Page() {
  const read = useRead<{ items: ManagerSport[] }>("/manager/sports");
  const [items, setItems] = useState<ManagerSport[] | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "retired">("");

  // Create state
  const [creating, setCreating] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [cCode, setCCode] = useState("");
  const [cNameEn, setCNameEn] = useState("");
  const [cNameVi, setCNameVi] = useState("");
  const [cPrefix, setCPrefix] = useState("");
  const [cColor, setCColor] = useState("leaf");
  const [cGlyph, setCGlyph] = useState("generic");
  const [cMaxPlayers, setCMaxPlayers] = useState("4");
  const [cWeekdayPrice, setCWeekdayPrice] = useState("100000");
  const [cWeekdayPeak, setCWeekdayPeak] = useState("150000");
  const [cWeekendPrice, setCWeekendPrice] = useState("120000");
  const [cWeekendPeak, setCWeekendPeak] = useState("180000");
  const [cSubmitting, setCSubmitting] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<ManagerSport | null>(null);
  const [eNameEn, setENameEn] = useState("");
  const [eNameVi, setENameVi] = useState("");
  const [ePrefix, setEPrefix] = useState("");
  const [eColor, setEColor] = useState("leaf");
  const [eGlyph, setEGlyph] = useState("generic");
  const [eSortOrder, setESortOrder] = useState("100");
  const [eEnabled, setEEnabled] = useState(true);
  const [eSubmitting, setESubmitting] = useState(false);

  // Retire / Delete confirmation states
  const [retiring, setRetiring] = useState<ManagerSport | null>(null);
  const [retireBlockers, setRetireBlockers] = useState<string[] | null>(null);
  const [retireSubmitting, setRetireSubmitting] = useState(false);

  const [deleting, setDeleting] = useState<ManagerSport | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  useEffect(() => {
    if (read.data?.items) {
      setItems(read.data.items);
    }
  }, [read.data]);

  const allList = items ?? [];
  const playableList = allList.filter((s) => !s.is_scope_all);

  const filtered = playableList.filter((s) => {
    if (statusFilter === "active" && (!s.enabled || s.retired_at)) return false;
    if (statusFilter === "retired" && !s.retired_at) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      s.code.toLowerCase().includes(q) ||
      s.name_en.toLowerCase().includes(q) ||
      s.name_vi.toLowerCase().includes(q) ||
      (s.court_prefix && s.court_prefix.toLowerCase().includes(q))
    );
  });

  const totalCourts = playableList.reduce((acc, s) => acc + (s.active_courts_count || 0), 0);
  const activeSports = playableList.filter((s) => s.enabled && !s.retired_at).length;

  function openCreate() {
    setCCode("");
    setCNameEn("");
    setCNameVi("");
    setCPrefix("");
    setCColor("leaf");
    setCGlyph("generic");
    setCMaxPlayers("4");
    setCWeekdayPrice("100000");
    setCWeekdayPeak("150000");
    setCWeekendPrice("120000");
    setCWeekendPeak("180000");
    setCreateStep(1);
    setCreating(true);
  }

  function openEdit(sport: ManagerSport) {
    setEditing(sport);
    setENameEn(sport.name_en);
    setENameVi(sport.name_vi);
    setEPrefix(sport.court_prefix ?? "");
    setEColor(sport.color_key);
    setEGlyph(sport.glyph_key);
    setESortOrder(String(sport.sort_order));
    setEEnabled(sport.enabled);
  }

  async function handleCreate() {
    setCSubmitting(true);
    try {
      const res = await apiPost<{ ok: boolean; sport: ManagerSport }>("/manager/sports", {
        code: cCode.trim().toLowerCase(),
        name_en: cNameEn.trim(),
        name_vi: cNameVi.trim(),
        court_prefix: cPrefix.trim().toUpperCase(),
        color_key: cColor,
        glyph_key: cGlyph,
        max_players: Number(cMaxPlayers) || 4,
        weekday_price_vnd: Number(cWeekdayPrice) || 100000,
        weekday_peak_price_vnd: Number(cWeekdayPeak) || 150000,
        weekend_price_vnd: Number(cWeekendPrice) || 120000,
        weekend_peak_price_vnd: Number(cWeekendPeak) || 180000,
      });
      toast.success(t("Sport {name} created", { name: res.sport.name_en }));
      invalidateSportsCache();
      setCreating(false);
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setCSubmitting(false);
    }
  }

  async function handleEdit() {
    if (!editing) return;
    setESubmitting(true);
    try {
      const res = await apiPatch<{ ok: boolean; sport: ManagerSport }>(`/manager/sports/${editing.code}`, {
        name_en: eNameEn.trim(),
        name_vi: eNameVi.trim(),
        court_prefix: ePrefix.trim().toUpperCase() || undefined,
        color_key: eColor,
        glyph_key: eGlyph,
        sort_order: Number(eSortOrder) || 100,
        enabled: eEnabled,
      });
      toast.success(t("Sport updated"));
      invalidateSportsCache();
      setEditing(null);
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setESubmitting(false);
    }
  }

  async function handleRetire(sport: ManagerSport) {
    setRetireSubmitting(true);
    setRetireBlockers(null);
    try {
      await apiPost(`/manager/sports/${sport.code}/retire`, {});
      toast.success(t("Sport retired"));
      invalidateSportsCache();
      setRetiring(null);
      read.reload();
    } catch (e: any) {
      if (e.status === 409 && e.body?.reasons) {
        setRetireBlockers(e.body.reasons);
      } else {
        toast.error(tServer(e.message));
        setRetiring(null);
      }
    } finally {
      setRetireSubmitting(false);
    }
  }

  async function handleRestore(sport: ManagerSport) {
    try {
      await apiPost(`/manager/sports/${sport.code}/restore`, {});
      toast.success(t("Sport restored"));
      invalidateSportsCache();
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    }
  }

  async function handleDelete(sport: ManagerSport) {
    setDeleteSubmitting(true);
    try {
      await apiDelete(`/manager/sports/${sport.code}`);
      toast.success(t("Sport deleted"));
      invalidateSportsCache();
      setDeleting(null);
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setDeleteSubmitting(false);
    }
  }

  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Sports")}
        subtitle={t("Manage centre sports, court prefixes, color themes and default pricing.")}
        stats={[
          { label: t("Playable sports"), value: playableList.length },
          { label: t("Active sports"), value: activeSports },
          { label: t("Total courts"), value: totalCourts },
        ]}
      />

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              type="search"
              className="pl-9"
              placeholder={t("Search by name or prefix...")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
            <option value="">{t("All statuses")}</option>
            <option value="active">{t("Active only")}</option>
            <option value="retired">{t("Retired only")}</option>
          </Select>
        </div>

        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="size-4" />
          {t("Add sport")}
        </Button>
      </div>

      {read.error ? (
        <div className="mt-6">
          <LoadError message={read.error.message} onRetry={read.reload} />
        </div>
      ) : !items ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-48 rounded-[var(--radius-xl)]" />
          <Skeleton className="h-48 rounded-[var(--radius-xl)]" />
          <Skeleton className="h-48 rounded-[var(--radius-xl)]" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title={t("No sports found")}
            hint={t("Add a sport, then add its courts.")}
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => {
            const isRetired = Boolean(s.retired_at);
            return (
              <Card
                key={s.code}
                className={cn(
                  "relative flex flex-col justify-between overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-soft)]",
                  isRetired && "opacity-75 bg-surface/50 border-line/60",
                )}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <SportThumbnail
                        sport={s.code}
                        colorKey={s.color_key}
                        className="size-12 shrink-0 rounded-[var(--radius-lg)]"
                      />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <h3 className="font-semibold text-fg text-base">{s.name_en}</h3>
                          <SportDot sport={s.code} colorKey={s.color_key} />
                        </div>
                        <p className="text-xs text-muted font-medium">{s.name_vi}</p>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      {isRetired ? (
                        <Badge tone="danger">{t("Retired")}</Badge>
                      ) : !s.enabled ? (
                        <Badge tone="hold">{t("Disabled")}</Badge>
                      ) : (
                        <Badge tone="accent">{t("Active")}</Badge>
                      )}
                      {s.court_prefix && (
                        <span className="rounded bg-surface px-1.5 py-0.5 text-2xs font-mono font-bold text-fg border border-line">
                          {s.court_prefix}-##
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2 border-t border-line/60 pt-3 text-xs">
                    <div>
                      <span className="text-muted block text-2xs">{t("Courts")}</span>
                      <span className="font-semibold text-fg">{s.active_courts_count}</span>
                    </div>
                    <div>
                      <span className="text-muted block text-2xs">{t("Future bookings")}</span>
                      <span className="font-semibold text-fg">{s.future_bookings_count}</span>
                    </div>
                    <div>
                      <span className="text-muted block text-2xs">{t("Active classes")}</span>
                      <span className="font-semibold text-fg">{s.future_classes_count}</span>
                    </div>
                    <div>
                      <span className="text-muted block text-2xs">{t("Active plans")}</span>
                      <span className="font-semibold text-fg">{s.active_plans_count}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex items-center justify-between border-t border-line/60 pt-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="size-3 rounded-full border border-line"
                      style={{ backgroundColor: `var(--color-sport-${s.color_key})` }}
                      title={`Color: ${s.color_key}`}
                    />
                    <span className="text-2xs text-muted capitalize">{s.color_key}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                      {t("Edit")}
                    </Button>
                    {isRetired ? (
                      <Button variant="outline" size="sm" onClick={() => handleRestore(s)}>
                        <Undo2 className="size-3.5 mr-1" />
                        {t("Restore")}
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => setRetiring(s)}>
                        {t("Retire")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:text-danger hover:bg-danger/10"
                      onClick={() => setDeleting(s)}
                      title={t("Delete sport permanently")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal: Create Sport (Multi-step) */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={createStep === 1 ? t("Add sport · Step 1: Details") : t("Add sport · Step 2: Pricing")}
      >
        <div className="flex items-center justify-between border-b border-line pb-3 mb-4">
          <p className="text-xs text-muted">
            {createStep === 1
              ? t("Enter sport code, names, court prefix and color palette.")
              : t("Set initial hourly court rental rates for this sport.")}
          </p>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted">
            <span className={cn("size-6 rounded-full flex items-center justify-center", createStep === 1 ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg")}>
              1
            </span>
            <ChevronRight className="size-3.5" />
            <span className={cn("size-6 rounded-full flex items-center justify-center", createStep === 2 ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg")}>
              2
            </span>
          </div>
        </div>

          {createStep === 1 ? (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Sport code (lowercase id)")}</label>
                  <Input
                    placeholder="e.g. pickleball"
                    value={cCode}
                    onChange={(e) => setCCode(e.target.value.toLowerCase())}
                  />
                  <span className="text-2xs text-muted mt-0.5 block">{t("2-24 chars, a-z0-9_-")}</span>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Court prefix (2 letters)")}</label>
                  <Input
                    placeholder="e.g. PB"
                    maxLength={2}
                    value={cPrefix}
                    onChange={(e) => setCPrefix(e.target.value.toUpperCase())}
                  />
                  <span className="text-2xs text-muted mt-0.5 block">{t("Produces courts like PB-01")}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("English name")}</label>
                  <Input
                    placeholder="e.g. Pickleball"
                    value={cNameEn}
                    onChange={(e) => setCNameEn(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Vietnamese name")}</label>
                  <Input
                    placeholder="e.g. Pickleball"
                    value={cNameVi}
                    onChange={(e) => setCNameVi(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">{t("Brand color theme")}</label>
                <div className="grid grid-cols-4 gap-2">
                  {COLOR_KEYS.map((c) => {
                    const isSelected = cColor === c.key;
                    return (
                      <button
                        type="button"
                        key={c.key}
                        onClick={() => setCColor(c.key)}
                        className={cn(
                          "flex items-center gap-2 rounded-[var(--radius-md)] border p-2 text-left text-xs transition-all",
                          isSelected
                            ? "border-accent bg-accent/10 font-medium text-fg shadow-[var(--shadow-border)]"
                            : "border-line bg-surface hover:bg-surface-2 text-muted",
                        )}
                      >
                        <span
                          className="size-4 shrink-0 rounded-full border border-line"
                          style={{ backgroundColor: `var(--color-sport-${c.key})` }}
                        />
                        <span className="truncate">{t(c.label)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Glyph icon")}</label>
                  <Select value={cGlyph} onChange={(e) => setCGlyph(e.target.value)}>
                    {GLYPH_KEYS.map((g) => (
                      <option key={g.key} value={g.key}>
                        {t(g.label)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Max players / court")}</label>
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    value={cMaxPlayers}
                    onChange={(e) => setCMaxPlayers(e.target.value)}
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  {t("Cancel")}
                </Button>
                <Button
                  disabled={!cCode || !cNameEn || !cNameVi || !cPrefix}
                  onClick={() => setCreateStep(2)}
                  className="gap-1"
                >
                  {t("Next: Pricing")}
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <p className="text-xs text-muted">
                {t("Default hourly rates for standard timeslots. You can customize per-court pricing later in Manager > Pricing.")}
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Weekday regular (06:00–17:00)")}</label>
                  <Input
                    type="number"
                    step={10000}
                    value={cWeekdayPrice}
                    onChange={(e) => setCWeekdayPrice(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Weekday peak (17:00–22:00)")}</label>
                  <Input
                    type="number"
                    step={10000}
                    value={cWeekdayPeak}
                    onChange={(e) => setCWeekdayPeak(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Weekend morning (06:00–08:00)")}</label>
                  <Input
                    type="number"
                    step={10000}
                    value={cWeekendPrice}
                    onChange={(e) => setCWeekendPrice(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">{t("Weekend peak (08:00–22:00)")}</label>
                  <Input
                    type="number"
                    step={10000}
                    value={cWeekendPeak}
                    onChange={(e) => setCWeekendPeak(e.target.value)}
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-between border-t border-line pt-4">
                <Button variant="outline" onClick={() => setCreateStep(1)}>
                  {t("Back")}
                </Button>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setCreating(false)}>
                    {t("Cancel")}
                  </Button>
                  <Button disabled={cSubmitting} onClick={handleCreate}>
                    {cSubmitting ? t("Creating...") : t("Create sport")}
                  </Button>
                </div>
              </div>
            </div>
          )}
      </Modal>

      {/* Modal: Edit Sport */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={t("Edit sport: {name}", { name: editing?.name_en ?? "" })}
      >
        <p className="text-xs text-muted font-mono mb-4">{editing?.code}</p>

          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">{t("English name")}</label>
                <Input value={eNameEn} onChange={(e) => setENameEn(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">{t("Vietnamese name")}</label>
                <Input value={eNameVi} onChange={(e) => setENameVi(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">{t("Court prefix")}</label>
                <Input
                  maxLength={2}
                  value={ePrefix}
                  onChange={(e) => setEPrefix(e.target.value.toUpperCase())}
                  disabled={(editing?.active_courts_count ?? 0) > 0}
                />
                {(editing?.active_courts_count ?? 0) > 0 && (
                  <span className="text-2xs text-muted mt-0.5 block">
                    {t("Prefix locked: {n} courts exist.", { n: editing?.active_courts_count ?? 0 })}
                  </span>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">{t("Sort order")}</label>
                <Input
                  type="number"
                  value={eSortOrder}
                  onChange={(e) => setESortOrder(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">{t("Color theme")}</label>
              <div className="grid grid-cols-4 gap-2">
                {COLOR_KEYS.map((c) => {
                  const isSelected = eColor === c.key;
                  return (
                    <button
                      type="button"
                      key={c.key}
                      onClick={() => setEColor(c.key)}
                      className={cn(
                        "flex items-center gap-2 rounded-[var(--radius-md)] border p-2 text-left text-xs transition-all",
                        isSelected
                          ? "border-accent bg-accent/10 font-medium text-fg shadow-[var(--shadow-border)]"
                          : "border-line bg-surface hover:bg-surface-2 text-muted",
                      )}
                    >
                      <span
                        className="size-4 shrink-0 rounded-full border border-line"
                        style={{ backgroundColor: `var(--color-sport-${c.key})` }}
                      />
                      <span className="truncate">{t(c.label)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">{t("Glyph icon")}</label>
                <Select value={eGlyph} onChange={(e) => setEGlyph(e.target.value)}>
                  {GLYPH_KEYS.map((g) => (
                    <option key={g.key} value={g.key}>
                      {t(g.label)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">{t("Availability")}</label>
                <Select value={eEnabled ? "true" : "false"} onChange={(e) => setEEnabled(e.target.value === "true")}>
                  <option value="true">{t("Enabled (Visible)")}</option>
                  <option value="false">{t("Disabled (Hidden)")}</option>
                </Select>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {t("Cancel")}
              </Button>
              <Button disabled={eSubmitting || !eNameEn || !eNameVi} onClick={handleEdit}>
                {eSubmitting ? t("Saving...") : t("Save changes")}
              </Button>
            </div>
          </div>
      </Modal>

      {/* Modal: Retire Sport confirmation / Blockers */}
      <Modal
        open={Boolean(retiring)}
        onClose={() => setRetiring(null)}
        title={t("Retire sport")}
      >
        <div className="flex items-center gap-3 border-b border-line pb-3 mb-4">
          <div className="size-10 rounded-full bg-warning/15 flex items-center justify-center text-warning shrink-0">
            <AlertTriangle className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-fg">{retiring?.name_en} ({retiring?.name_vi})</p>
            <p className="text-xs text-muted font-mono">{retiring?.code}</p>
          </div>
        </div>

          {retireBlockers && retireBlockers.length > 0 ? (
            <div className="mt-4">
              <p className="text-sm font-semibold text-danger mb-2">
                {t("This sport cannot be retired right now due to the following dependencies:")}
              </p>
              <ul className="list-disc pl-5 space-y-1 text-xs text-muted">
                {retireBlockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
              <div className="mt-6 flex justify-end">
                <Button variant="outline" onClick={() => setRetiring(null)}>
                  {t("Close")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <p className="text-sm text-fg">
                {t("Are you sure you want to retire {name}? Retired sports cannot accept new bookings or classes.", {
                  name: retiring?.name_en ?? "",
                })}
              </p>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRetiring(null)}>
                  {t("Cancel")}
                </Button>
                <Button
                  variant="outline"
                  className="border-danger text-danger hover:bg-danger/10"
                  disabled={retireSubmitting}
                  onClick={() => retiring && handleRetire(retiring)}
                >
                  {retireSubmitting ? t("Retiring...") : t("Confirm retire")}
                </Button>
              </div>
            </div>
          )}
      </Modal>

      {/* Modal: Delete Sport confirmation */}
      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={t("Delete sport permanently")}
      >
        <div className="flex items-center gap-3 border-b border-line pb-3 mb-4">
          <div className="size-10 rounded-full bg-danger/15 flex items-center justify-center text-danger shrink-0">
            <Trash2 className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-fg">{deleting?.name_en}</p>
            <p className="text-xs text-muted font-mono">{deleting?.code}</p>
          </div>
        </div>

        <p className="text-sm text-fg">
          {t("This will completely delete {name}. If this sport has any history (courts, bookings, classes, plans), deletion will be rejected.", {
            name: deleting?.name_en ?? "",
          })}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="outline"
            className="border-danger text-danger hover:bg-danger/10"
            disabled={deleteSubmitting}
            onClick={() => deleting && handleDelete(deleting)}
          >
            {deleteSubmitting ? t("Deleting...") : t("Delete permanently")}
          </Button>
        </div>
      </Modal>
    </Shell>
  );
}
