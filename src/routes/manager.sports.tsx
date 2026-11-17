/**
 * Quản lý danh mục môn thể thao (/manager/sports) dành cho Quản lý trung tâm (Manager).
 * Tệp này định nghĩa route và giao diện cho phép cấu hình các môn thể thao trong hệ thống Arena3:
 * thiết lập mã môn, tên song ngữ Anh - Việt, tiền tố mã sân, bảng màu nhận diện, biểu tượng glyph,
 * giá thuê sân mặc định theo khung giờ và quản lý vòng đời môn thể thao (kích hoạt, ngưng hoạt động, xóa vĩnh viễn).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, ChevronRight, Plus, Search, Undo2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, Input, LoadError, Modal, PageHero, Select, Skeleton } from "@/client/components/ui";
import { SportDot, SportThumbnail } from "@/client/components/sports-ui";
import { useRefreshAssets } from "@/client/components/media";
import { apiPost } from "@/client/arena3/client";
import { cn } from "@/client/lib/cn";
import { t, tServer } from "@/client/lib/i18n";
import { useManagerSports, type ManagerSport, COLOR_KEYS, GLYPH_KEYS, PHOTO_TYPES, photoProblem, uploadSportPhoto } from "@/client/lib/pages/manager.sports";

export { type ManagerSport } from "@/client/lib/pages/manager.sports";


/**
 * Làm gì: Định nghĩa cấu hình route `/manager/sports` cho TanStack Router, liên kết URL với component Page quản lý môn thể thao.
 * Được gọi ở: URL `/manager/sports` (đăng ký qua TanStack Router trong src/routeTree.gen.ts).
 * @returns Đối tượng route của TanStack Router liên kết với component Page.
 */
export const Route = createFileRoute("/manager/sports")({
  component: Page,
});

/**
 * Làm gì: Component trang quản lý danh mục môn thể thao, hiển thị bảng thống kê, bộ lọc tìm kiếm, lưới thẻ môn và các modal tạo/sửa/retire/xóa môn.
 * Được gọi ở: `src/routes/manager.sports.tsx` thông qua `Route` tại URL `/manager/sports`.
 * @returns JSX.Element giao diện trang quản lý danh mục môn thể thao dành cho Quản lý (Manager).
 */
function Page() {
  // Bước 1: Khởi tạo toàn bộ state, dữ liệu môn thể thao và các handler nghiệp vụ từ useManagerSports (tách biệt logic nghiệp vụ khỏi UI)
  const {
    read, items, query, setQuery, statusFilter, setStatusFilter, creating, setCreating, createStep,
    setCreateStep, cCode, setCCode, cNameEn, setCNameEn, cNameVi, setCNameVi, cPrefix, setCPrefix,
    cColor, setCColor, cGlyph, setCGlyph, cMaxPlayers, setCMaxPlayers, cWeekdayPrice,
    setCWeekdayPrice, cWeekdayPeak, setCWeekdayPeak, cWeekendPrice, setCWeekendPrice, cWeekendPeak,
    setCWeekendPeak, cPhoto, setCPhoto, cSubmitting, editing, setEditing, eNameEn, setENameEn,
    eNameVi, setENameVi, ePrefix, setEPrefix, eColor, setEColor, eGlyph, setEGlyph, eSortOrder,
    setESortOrder, eEnabled, setEEnabled, eSubmitting, retiring, setRetiring, retireBlockers,
    retireSubmitting, deleting, setDeleting, deleteSubmitting, playableList, filtered, totalCourts,
    activeSports, openCreate, openEdit, handleCreate, handleEdit, handleRetire, handleRestore,
    handleDelete,
  } = useManagerSports();

  // Bước 2: Render giao diện quản trị bọc trong Shell role="manager", gồm banner thống kê, thanh tìm kiếm/lọc, lưới thẻ môn và các modal nghiệp vụ
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
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        aria-label={t("Change the photo of {name}", { name: s.name_en })}
                        title={t("Change the photo of {name}", { name: s.name_en })}
                        className="group relative shrink-0 rounded-[var(--radius-lg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <SportThumbnail
                          sport={s.code}
                          colorKey={s.color_key}
                          className="size-12 shrink-0 rounded-[var(--radius-lg)]"
                        />
                        <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full border border-line bg-surface text-muted shadow-[var(--shadow-border)] transition-colors group-hover:text-fg">
                          <Camera aria-hidden="true" className="size-3" />
                        </span>
                      </button>
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

              <NewSportPhotoField file={cPhoto} onFile={setCPhoto} />

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
            {editing ? <SportPhotoField sport={editing} /> : null}

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

/**
 * The sport's photo (site asset `sport.<code>`), shown on its cards and booking screens. A picked
 * photo is saved at once; the form's Save is for the rest. The server's own limits are checked here
 * first so the reason reads in the manager's language.
 */
/**
 * Làm gì: Component hiển thị và cập nhật ảnh đại diện của môn thể thao đã tồn tại; hỗ trợ tải ảnh mới lên thay thế ngay lập tức hoặc khôi phục về ảnh gốc xuất xưởng.
 * Được gọi ở: src/routes/manager.sports.tsx (trong Modal chỉnh sửa môn thể thao Edit Sport, dòng 410).
 * @param sport Thông tin môn thể thao đang chỉnh sửa (ManagerSport).
 * @returns JSX.Element chứa ảnh thumbnail hiện tại, nút đổi ảnh, nút khôi phục ảnh gốc và thông báo trạng thái.
 */
function SportPhotoField({ sport }: { sport: ManagerSport }) {
  // Bước 1: Khởi tạo hook làm mới assets, ref tới thẻ input file ẩn và các state quản lý tiến trình upload cùng thông báo lỗi
  const refresh = useRefreshAssets();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Tên vị trí (slot) tài nguyên media trên server theo quy ước định danh: sport.<mã_môn>
  const slot = `sport.${sport.code}`;

  /**
   * Làm gì: Kiểm tra tính hợp lệ của tệp ảnh được chọn, tải lên server lưu vào slot tài nguyên của môn thể thao và làm mới giao diện.
   * Được gọi ở: src/routes/manager.sports.tsx (sự kiện onChange của input file ẩn trong SportPhotoField, dòng 670).
   * @param file Tệp ảnh người dùng chọn tải lên từ thiết bị.
   * @returns Promise<void>
   */
  async function pick(file: File) {
    // Bước 1: Xóa lỗi cũ và kiểm tra định dạng, dung lượng, kích thước ảnh ở client qua photoProblem
    setProblem(null);
    const why = await photoProblem(file);
    if (why) return setProblem(why);
    // Bước 2: Bật cờ busy để vô hiệu hóa thao tác, ngăn chặn người dùng gửi nhiều yêu cầu upload liên tiếp
    setBusy(true);
    try {
      // Bước 3: Gửi tệp ảnh lên API /manager/site-assets/upload bằng multipart/form-data để gán vào slot của môn thể thao
      await uploadSportPhoto(sport.code, file);
      // Bước 4: Làm mới bộ nhớ đệm SiteAssetsContext toàn ứng dụng để cập nhật hình ảnh trên mọi màn hình và hiển thị toast
      await refresh();
      toast.success(t("Photo changed"));
    } catch (e) {
      // Bước 5: Bắt lỗi nếu quá trình upload thất bại và hiển thị thông báo lỗi đã được bản địa hóa
      setProblem(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Khôi phục ảnh đại diện của môn thể thao về ảnh gốc mặc định xuất xưởng của hệ thống và làm mới context tài nguyên.
   * Được gọi ở: src/routes/manager.sports.tsx (nút "Use the shipped photo" trong SportPhotoField, dòng 654).
   * @returns Promise<void>
   */
  async function reset() {
    // Bước 1: Xóa thông báo lỗi trước đó và bật trạng thái busy
    setProblem(null);
    setBusy(true);
    try {
      // Bước 2: Gọi API POST /manager/site-assets/:slot/reset để xóa ảnh tùy chỉnh và quay về ảnh mặc định gốc xuất xưởng
      await apiPost(`/manager/site-assets/${encodeURIComponent(slot)}/reset`);
      // Bước 3: Cập nhật lại context tài nguyên đa phương tiện và hiển thị thông báo khôi phục thành công
      await refresh();
      toast.success(t("Photo put back as shipped"));
    } catch (e) {
      // Bước 4: Xử lý và ghi nhận thông báo lỗi nếu việc khôi phục ảnh mặc định thất bại
      setProblem(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4 rounded-[var(--radius-md)] border border-line bg-surface p-3">
      <SportThumbnail sport={sport.code} colorKey={sport.color_key} className="size-20 rounded-[var(--radius-lg)]" />
      <div className="grid min-w-0 gap-1.5">
        <span className="text-xs font-medium text-muted">{t("Photo")}</span>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
            <Camera aria-hidden="true" className="mr-1 size-3.5" />
            {busy ? t("Uploading…") : t("Change photo")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reset()}>
            {t("Use the shipped photo")}
          </Button>
        </div>
        <p className={problem ? "text-2xs text-danger" : "text-2xs text-muted"} role={problem ? "alert" : undefined}>
          {problem ?? t("JPEG, PNG or WebP, up to 2 MB, 400 px or more on the shorter side. Saved as soon as you pick it.")}
        </p>
        <input
          ref={input}
          type="file"
          accept={PHOTO_TYPES.join(",")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void pick(file);
          }}
        />
      </div>
    </div>
  );
}

/** A photo for a sport that does not exist yet: checked now, uploaded once the sport is saved. */
/**
 * Làm gì: Thành phần chọn ảnh đại diện khi tạo môn thể thao mới; ảnh được kiểm tra tính hợp lệ và hiển thị xem trước trước khi được upload lúc lưu môn thể thao.
 * Được gọi ở: src/routes/manager.sports.tsx (trong Modal tạo môn thể thao Create Sport Modal, bước 1, dòng 320).
 * @param file Tệp ảnh hiện tại đã chọn (File hoặc null).
 * @param onFile Callback cập nhật đối tượng File được chọn vào form cha (hoặc null khi xóa ảnh).
 * @returns JSX.Element khung xem trước ảnh đại diện và các nút thao tác chọn/gỡ ảnh.
 */
function NewSportPhotoField({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  // Bước 1: Khởi tạo ref tới thẻ input file ẩn và các state lưu lỗi xác thực cùng URL xem trước ảnh (preview)
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Bước 2: Tạo Object URL để xem trước ảnh vừa chọn và tự động thu hồi (revokeObjectURL) khi unmount hoặc đổi file để chống rò rỉ bộ nhớ
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /**
   * Làm gì: Kiểm tra tính hợp lệ của tệp ảnh được chọn (định dạng, kích thước, độ phân giải) và cập nhật vào state của form cha nếu hợp lệ.
   * Được gọi ở: src/routes/manager.sports.tsx (sự kiện onChange của thẻ input file ẩn trong NewSportPhotoField, dòng 730).
   * @param f Tệp ảnh người quản lý vừa chọn từ máy tính.
   * @returns Promise<void>
   */
  async function pick(f: File) {
    // Bước 1: Xóa thông báo lỗi cũ
    setProblem(null);
    // Bước 2: Kiểm tra các điều kiện kỹ thuật của tệp ảnh; nếu vi phạm thì lưu lý do vào state problem và dừng lại
    const why = await photoProblem(f);
    if (why) return setProblem(why);
    // Bước 3: Tệp ảnh hợp lệ, truyền đối tượng File lên form cha qua callback onFile (sẽ upload sau khi tạo môn thành công)
    onFile(f);
  }

  return (
    <div className="flex items-center gap-4 rounded-[var(--radius-md)] border border-line bg-surface p-3">
      {preview ? (
        <img src={preview} alt="" className="size-20 shrink-0 rounded-[var(--radius-lg)] object-cover" />
      ) : (
        <span className="grid size-20 shrink-0 place-items-center rounded-[var(--radius-lg)] border border-dashed border-line text-subtle">
          <Camera aria-hidden="true" className="size-5" />
        </span>
      )}
      <div className="grid min-w-0 gap-1.5">
        <span className="text-xs font-medium text-muted">{t("Photo (optional)")}</span>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
            <Camera aria-hidden="true" className="mr-1 size-3.5" />
            {file ? t("Change photo") : t("Choose a photo")}
          </Button>
          {file ? (
            <Button size="sm" variant="ghost" onClick={() => onFile(null)}>
              {t("Remove")}
            </Button>
          ) : null}
        </div>
        <p className={problem ? "text-2xs text-danger" : "text-2xs text-muted"} role={problem ? "alert" : undefined}>
          {problem ?? t("JPEG, PNG or WebP, up to 2 MB, 400 px or more on the shorter side. Saved with the sport.")}
        </p>
        <input
          ref={input}
          type="file"
          accept={PHOTO_TYPES.join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />
      </div>
    </div>
  );
}
