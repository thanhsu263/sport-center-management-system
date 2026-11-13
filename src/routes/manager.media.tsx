import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Edit3, ExternalLink, FolderOpen, RotateCcw, Search, Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { Shell } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { useSports } from "@/client/components/sports-ui";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, Modal, Seg, Skeleton } from "@/client/components/ui";
import { apiPatch, apiPost } from "@/client/arena3/client";
import { locale, t, tk } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useManagerMedia, type ManagerAsset, type MediaLibraryItem, recDim, aspectClass, compressImageToWebp } from "@/client/lib/pages/manager.media";

export { type ManagerAsset, type MediaLibraryItem } from "@/client/lib/pages/manager.media";


export const Route = createFileRoute("/manager/media")({
  component: Page,
});

function Page() {
  const {
    activeTab, setActiveTab, data, error, reload, selectedGroup, setSelectedGroup, uploadSlot,
    setUploadSlot, librarySlot, setLibrarySlot, altSlot, setAltSlot, confirmRevertSlot,
    setConfirmRevertSlot, confirmResetSlot, setConfirmResetSlot, isVi, groups, filteredItems,
    toggleEnabled, totalSlots, enabledSlots, customSlots, disabledSlots,
  } = useManagerMedia();

  return (
    <Shell role="manager">
      <PageHero
        slot="banner.manager"
        title={t("Site media")}
        subtitle={t("Hero, banners, sport covers and brand imagery across the app.")}
        className="mb-6"
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <Seg
          value={activeTab}
          onChange={(v) => setActiveTab(v as "slots" | "library")}
          options={[
            { value: "slots", label: t("Site slots") },
            { value: "library", label: t("Media library") },
          ]}
        />
      </div>

      {activeTab === "library" ? (
        <MediaLibraryExplorer />
      ) : (
        <>
          <StatStrip
            stats={[
              { label: tk("Total slots"), value: totalSlots },
              { label: tk("Active slots"), value: enabledSlots },
              { label: tk("Custom uploads"), value: customSlots },
              { label: tk("Disabled slots"), value: disabledSlots },
            ]}
            className="mb-6"
          />

          <div className="grid gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Seg value={selectedGroup} onChange={setSelectedGroup} options={groups} />
        </div>

        {error ? (
          <LoadError message={error.message} onRetry={reload} />
        ) : !data ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-72 rounded-[var(--radius-xl)]" />
            ))}
          </div>
        ) : filteredItems.length === 0 ? (
          <EmptyState
            title={t("No assets found")}
            hint={t("No slots match the selected group filter.")}
            action={
              selectedGroup !== "all" ? (
                <Button variant="outline" onClick={() => setSelectedGroup("all")}>
                  {t("Show all")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {filteredItems.map((asset) => {
              const label = isVi ? asset.label_vi : asset.label_en;
              const location = isVi ? asset.location_vi : asset.location_en;
              const curDim = asset.width && asset.height ? `${asset.width} × ${asset.height}` : "–";
              const canRevert = asset.history_count > 0;
              const isDefault = !asset.history_count && asset.version === 1;

              return (
                <Card key={asset.slot} className="flex flex-col overflow-hidden p-0">
                  {/* Media Visual Area */}
                  <div
                    className={`relative overflow-hidden bg-wood/50 ${aspectClass(
                      asset.aspect,
                    )}`}
                  >
                    {asset.kind === "video" ? (
                      <video
                        src={asset.url}
                        className={`h-full w-full object-cover transition-opacity ${
                          asset.enabled ? "opacity-100" : "opacity-30"
                        }`}
                        muted
                        loop
                        playsInline
                        autoPlay
                      />
                    ) : (
                      <img
                        src={asset.url}
                        alt={isVi ? asset.alt_vi || label : asset.alt_en || label}
                        className={`h-full w-full object-cover transition-opacity ${
                          asset.enabled ? "opacity-100" : "opacity-30"
                        }`}
                        loading="lazy"
                      />
                    )}

                    {!asset.enabled ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                        <Badge tone="hold">{t("Slot is currently disabled")}</Badge>
                      </div>
                    ) : null}

                    {/* Safe Area Guide indicator overlay */}
                    {asset.aspect === "16:9" && (
                      <div
                        className="pointer-events-none absolute inset-x-4 inset-y-6 rounded border border-dashed border-white/40"
                        title={t("Safe text area")}
                      />
                    )}

                    <div className="absolute left-3 top-3 flex items-center gap-1.5">
                      <Badge tone={asset.enabled ? "accent" : "muted"}>
                        {asset.enabled ? t("Enabled") : t("Disabled")}
                      </Badge>
                      <Badge tone="muted" className="font-mono text-2xs uppercase">
                        {asset.aspect}
                      </Badge>
                    </div>
                  </div>

                  {/* Card Content */}
                  <div className="flex flex-1 flex-col p-4 sm:p-5">
                    <div className="mb-2">
                      <p className="font-mono text-2xs text-muted">{asset.slot}</p>
                      <h2 className="text-base font-semibold leading-tight">{label}</h2>
                      <p className="mt-1 text-xs text-muted">
                        {t("Used in: {components}", { components: location })}
                      </p>
                    </div>

                    <div className="my-2 grid grid-cols-2 gap-2 rounded-[var(--radius-sm)] bg-wood/60 p-2.5 text-2xs">
                      <div>
                        <span className="text-muted">{t("Recommended: {dim}", { dim: "" })}</span>
                        <p className="font-medium text-fg">{recDim(asset.aspect)}</p>
                      </div>
                      <div>
                        <span className="text-muted">{t("Current: {dim}", { dim: "" })}</span>
                        <p className="font-medium text-fg">{curDim}</p>
                      </div>
                    </div>

                    <div className="mb-4 mt-auto pt-2 text-2xs text-muted">
                      {asset.updated_at && asset.updated_by
                        ? t("Updated by {name} · {when}", {
                            name: asset.updated_by,
                            when: new Date(asset.updated_at).toLocaleDateString(
                              isVi ? "vi-VN" : "en-US",
                              { month: "short", day: "numeric" },
                            ),
                          })
                        : t("System default")}
                    </div>

                    {/* Actions */}
                    <div className="grid gap-2 border-t border-line pt-3">
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setUploadSlot(asset)}
                          className="w-full text-xs"
                        >
                          <Upload className="mr-1.5 size-3.5" />
                          {t("Change image")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setLibrarySlot(asset)}
                          className="w-full text-xs"
                        >
                          <FolderOpen className="mr-1.5 size-3.5" />
                          {t("From library")}
                        </Button>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setAltSlot(asset)}
                            className="inline-flex items-center rounded px-2 py-1 text-2xs font-medium text-muted hover:bg-wood hover:text-fg"
                          >
                            <Edit3 className="mr-1 size-3" />
                            {t("Edit alt text")}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleEnabled(asset)}
                            className="inline-flex items-center rounded px-2 py-1 text-2xs font-medium text-muted hover:bg-wood hover:text-fg"
                          >
                            {asset.enabled ? t("Disabled") : t("Enabled")}
                          </button>
                        </div>

                        <div className="flex items-center gap-1">
                          {canRevert && (
                            <button
                              type="button"
                              onClick={() => setConfirmRevertSlot(asset)}
                              className="inline-flex items-center rounded px-2 py-1 text-2xs font-medium text-accent hover:bg-accent/10"
                            >
                              <RotateCcw className="mr-1 size-3" />
                              {t("Revert")}
                            </button>
                          )}
                          {!isDefault && (
                            <button
                              type="button"
                              onClick={() => setConfirmResetSlot(asset)}
                              className="inline-flex items-center rounded px-2 py-1 text-2xs font-medium text-muted hover:bg-wood hover:text-fg"
                            >
                              {t("Reset to default")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}

      {/* Upload Dialog */}
      {uploadSlot && (
        <UploadDialog
          asset={uploadSlot}
          onClose={() => setUploadSlot(null)}
          onSuccess={() => {
            setUploadSlot(null);
            reload();
          }}
        />
      )}

      {/* Library Dialog */}
      {librarySlot && (
        <LibraryDialog
          asset={librarySlot}
          onClose={() => setLibrarySlot(null)}
          onSuccess={() => {
            setLibrarySlot(null);
            reload();
          }}
        />
      )}

      {/* Alt Text Dialog */}
      {altSlot && (
        <AltDialog
          asset={altSlot}
          onClose={() => setAltSlot(null)}
          onSuccess={() => {
            setAltSlot(null);
            reload();
          }}
        />
      )}

      {/* Revert Confirm */}
      {confirmRevertSlot && (
        <ConfirmDialog
          title={t("Revert to previous version")}
          message={t("Are you sure you want to revert this image to its previous version?")}
          onConfirm={async () => {
            try {
              await apiPost(`/manager/site-assets/${encodeURIComponent(confirmRevertSlot.slot)}/revert`);
              toast.success(t("Asset reverted"));
              setConfirmRevertSlot(null);
              reload();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : t("Something went wrong"));
            }
          }}
          onClose={() => setConfirmRevertSlot(null)}
        />
      )}

      {/* Reset Confirm */}
      {confirmResetSlot && (
        <ConfirmDialog
          title={t("Reset to system default")}
          message={t("Are you sure you want to reset this slot to the system default asset?")}
          onConfirm={async () => {
            try {
              await apiPost(`/manager/site-assets/${encodeURIComponent(confirmResetSlot.slot)}/reset`);
              toast.success(t("Asset reset to default"));
              setConfirmResetSlot(null);
              reload();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : t("Something went wrong"));
            }
          }}
          onClose={() => setConfirmResetSlot(null)}
        />
      )}
    </Shell>
  );
}

function UploadDialog({
  asset,
  onClose,
  onSuccess,
}: {
  asset: ManagerAsset;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; blob: Blob } | null>(null);
  const [busy, setBusy] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelect(f: File) {
    if (!f.type.startsWith("image/")) {
      toast.error(t("Please select an image file"));
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      toast.error(t("Image file must be under 2MB"));
      return;
    }
    try {
      setFile(f);
      const res = await compressImageToWebp(f);
      setPreview({
        url: res.previewUrl,
        width: res.width,
        height: res.height,
        blob: res.blob,
      });
    } catch {
      toast.error(t("Something went wrong"));
    }
  }

  async function handleSave() {
    if (!preview || !file) return;
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append("slot", asset.slot);
      formData.append("file", preview.blob, "asset.webp");
      await apiPost("/manager/site-assets/upload", formData);
      toast.success(t("Asset updated"));
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  }

  return (
    <Modal open onClose={onClose} title={t("Upload new image")}>
      <div className="grid gap-4">
        {!preview ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-[var(--radius-lg)] border-2 border-dashed p-8 text-center transition-colors ${
              isDragOver
                ? "border-accent bg-accent/5"
                : "border-line-strong/60 hover:border-accent hover:bg-wood/40"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
            />
            <Upload className="mb-2 size-8 text-muted" />
            <p className="text-sm font-medium">{t("Drop an image here or click to browse")}</p>
            <p className="mt-1 text-2xs text-muted">WebP, PNG, JPEG &lt; 2MB</p>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="relative overflow-hidden rounded-[var(--radius-md)] bg-black/10">
              <img
                src={preview.url}
                alt={t("Preview")}
                className="max-h-72 w-full object-contain"
              />
              <div
                className="pointer-events-none absolute inset-x-4 inset-y-6 rounded border border-dashed border-white/50"
                title={t("Text overlay safe area")}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>{t("Compressed WebP")}</span>
              <span className="font-mono">
                {preview.width} × {preview.height} px · {Math.round(preview.blob.size / 1024)} KB
              </span>
            </div>

            <p className="text-2xs text-muted">
              {t("The highlighted zone indicates where text overlays will appear.")}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          {preview && (
            <Button size="sm" onClick={handleSave} disabled={busy}>
              {busy ? t("Uploading…") : t("Save")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function LibraryDialog({
  asset,
  onClose,
  onSuccess,
}: {
  asset: ManagerAsset;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const query = new URLSearchParams();
  if (category !== "all") query.set("category", category);
  if (search.trim()) query.set("search", search.trim());
  const qs = query.toString();
  const endpoint = `/manager/media-library${qs ? `?${qs}` : ""}`;
  const { data, error, reload } = useRead<{ items: MediaLibraryItem[] }>(endpoint);
  const [selectedItem, setSelectedItem] = useState<MediaLibraryItem | null>(null);
  const [busy, setBusy] = useState(false);

  const { sports } = useSports();
  const categories = [
    { value: "all", label: t("All categories") },
    ...sports.map((s) => ({ value: s.code, label: s.name })),
    { value: "other-sports", label: t("Other sports") },
    { value: "facility", label: t("Facility") },
    { value: "coach", label: t("Coach") },
    { value: "class", label: t("Class") },
    { value: "equipment", label: t("Equipment") },
    { value: "event", label: t("Event") },
    { value: "uploaded", label: t("Uploaded") },
    { value: "legacy", label: t("Legacy") },
  ];

  async function handleSelect() {
    if (!selectedItem) return;
    setBusy(true);
    try {
      await apiPatch(`/manager/site-assets/${encodeURIComponent(asset.slot)}`, {
        library_id: selectedItem.id,
      });
      toast.success(t("Asset updated"));
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  const items = data?.items ?? [];

  return (
    <Modal open onClose={onClose} title={t("Select image from library")}>
      <div className="grid gap-4">
        {/* Category Pills & Search */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1">
            {categories.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className={`rounded-full px-2.5 py-0.5 text-2xs font-medium transition-colors ${
                  category === c.value
                    ? "bg-accent text-accent-fg"
                    : "bg-wood/60 text-muted hover:bg-wood hover:text-fg"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Search by keyword or tag...")}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        {error ? (
          <LoadError message={error.message} onRetry={reload} />
        ) : !data ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-32 rounded-[var(--radius-md)]" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title={t("No media items match the selected filter.")}
            hint=""
          />
        ) : (
          <div className="max-h-96 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {items.map((item) => {
                const isSelected = selectedItem?.id === item.id;
                const isCoach = item.category === "coach";
                const aspectStyle = isCoach ? "aspect-[4/5]" : "aspect-video";
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedItem(item)}
                    className={`group relative flex flex-col overflow-hidden rounded-[var(--radius-md)] border text-left transition-all ${
                      isSelected
                        ? "border-accent ring-2 ring-accent"
                        : "border-line hover:border-line-strong"
                    }`}
                  >
                    <div className={`relative w-full bg-wood ${aspectStyle}`}>
                      <img
                        src={item.url}
                        alt={item.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                      <Badge
                        tone="muted"
                        className="absolute bottom-1 left-1 bg-black/60 text-3xs text-white uppercase"
                      >
                        {item.license}
                      </Badge>
                    </div>
                    <div className="p-2 text-2xs">
                      <p className="truncate font-medium text-fg">{item.name}</p>
                      <p className="mt-0.5 truncate text-muted">
                        {item.width && item.height ? `${item.width}×${item.height}` : item.category}
                      </p>
                    </div>
                    {isSelected && (
                      <div className="absolute right-1.5 top-1.5 rounded-full bg-accent p-1 text-accent-fg shadow">
                        <Check className="size-3" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selectedItem && (
          <div className="flex items-center justify-between rounded-[var(--radius-sm)] bg-wood/60 px-3 py-2 text-2xs">
            <span className="truncate font-medium">{selectedItem.name}</span>
            <span className="text-muted font-mono">{selectedItem.license}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={handleSelect} disabled={!selectedItem || busy}>
            {busy ? t("Uploading…") : t("Save selection")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AltDialog({
  asset,
  onClose,
  onSuccess,
}: {
  asset: ManagerAsset;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [altEn, setAltEn] = useState(asset.alt_en || "");
  const [altVi, setAltVi] = useState(asset.alt_vi || "");
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    setBusy(true);
    try {
      await apiPatch(`/manager/site-assets/${encodeURIComponent(asset.slot)}`, {
        alt_en: altEn,
        alt_vi: altVi,
      });
      toast.success(t("Alt text updated"));
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t("Edit alt text")}>
      <div className="grid gap-4">
        <Field label={t("Alt text (English)")}>
          <Input
            value={altEn}
            onChange={(e) => setAltEn(e.target.value)}
            placeholder="Descriptive English text..."
          />
        </Field>
        <Field label={t("Alt text (Vietnamese)")}>
          <Input
            value={altVi}
            onChange={(e) => setAltVi(e.target.value)}
            placeholder="Mô tả hình ảnh bằng tiếng Việt..."
          />
        </Field>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={busy}>
            {t("Save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ConfirmDialog({
  title,
  message,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={title}>
      <div className="grid gap-4">
        <p className="text-sm text-muted">{message}</p>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={busy}>
            {busy ? t("Uploading…") : t("Save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MediaLibraryExplorer() {
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const query = new URLSearchParams();
  if (category !== "all") query.set("category", category);
  if (search.trim()) query.set("search", search.trim());
  const qs = query.toString();
  const endpoint = `/manager/media-library${qs ? `?${qs}` : ""}`;
  const { data, error, reload } = useRead<{ items: MediaLibraryItem[] }>(endpoint);
  const isVi = locale() === "vi";

  const items = data?.items ?? [];

  const { sports } = useSports();
  const categories = [
    { value: "all", label: t("All categories") },
    ...sports.map((s) => ({ value: s.code, label: s.name })),
    { value: "other-sports", label: t("Other sports") },
    { value: "facility", label: t("Facility") },
    { value: "coach", label: t("Coach") },
    { value: "class", label: t("Class") },
    { value: "equipment", label: t("Equipment") },
    { value: "event", label: t("Event") },
    { value: "uploaded", label: t("Uploaded") },
    { value: "legacy", label: t("Legacy") },
  ];

  const totalCount = items.length;
  const licensedCount = items.filter((i) => i.license !== "project").length;
  const uploadedCount = items.filter((i) => i.category === "uploaded").length;
  const categoriesCount = new Set(items.map((i) => i.category)).size;

  function handleCopy(path: string) {
    const fullRelPath = path.startsWith("/media/") ? path : `/media/${path.replace(/^\//, "")}`;
    void navigator.clipboard.writeText(fullRelPath);
    toast.success(t("Path copied to clipboard"));
  }

  return (
    <div className="grid gap-6">
      <StatStrip
        stats={[
          { label: tk("Total library assets"), value: totalCount },
          { label: tk("Curated categories"), value: categoriesCount },
          { label: tk("Licensed / CC"), value: licensedCount },
          { label: tk("Uploaded media"), value: uploadedCount },
        ]}
        className="mb-2"
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map((c) => {
            const isSelected = category === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  isSelected
                    ? "bg-accent text-accent-fg"
                    : "bg-wood/60 text-muted hover:bg-wood hover:text-fg"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search library...")}
            className="pl-9"
          />
        </div>
      </div>

      {error ? (
        <LoadError message={error.message} onRetry={reload} />
      ) : !data ? (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <Skeleton key={i} className="h-64 rounded-[var(--radius-lg)]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("No media items match the selected filter.")}
          hint={t("Browse and manage all curated photography and uploaded assets.")}
          action={
            category !== "all" || search ? (
              <Button
                variant="outline"
                onClick={() => {
                  setCategory("all");
                  setSearch("");
                }}
              >
                {t("Show all")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => {
            const isCoach = item.category === "coach";
            const aspectStyle = isCoach ? "aspect-[4/5]" : "aspect-video";

            return (
              <Card key={item.id} className="flex flex-col overflow-hidden p-0">
                <div className={`relative overflow-hidden bg-wood ${aspectStyle}`}>
                  <img
                    src={item.url}
                    alt={isVi ? item.alt_vi || item.alt_en : item.alt_en || item.alt_vi}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                  <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1">
                    <Badge tone="muted" className="text-2xs capitalize">
                      {item.category}
                    </Badge>
                    <Badge tone="accent" className="font-mono text-2xs uppercase">
                      {item.license}
                    </Badge>
                  </div>
                </div>

                <div className="flex flex-1 flex-col p-3.5 text-xs">
                  <div className="mb-2">
                    <p className="truncate font-semibold text-fg" title={item.name}>
                      {item.name}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-2xs text-muted">
                      <span>
                        {item.width && item.height ? `${item.width} × ${item.height}` : "–"}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopy(item.path)}
                        className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
                        title={t("Copy path")}
                      >
                        <Copy className="size-3" />
                        <span>{t("Copy path")}</span>
                      </button>
                    </div>
                  </div>

                  <p className="mb-2 line-clamp-2 text-2xs text-muted">
                    {isVi ? item.alt_vi : item.alt_en}
                  </p>

                  <div className="mt-auto border-t border-line/60 pt-2 text-2xs text-muted">
                    {item.credit && (
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate">{item.credit}</span>
                        {item.source_url && (
                          <a
                            href={item.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center text-accent hover:underline"
                            title={t("Source")}
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

