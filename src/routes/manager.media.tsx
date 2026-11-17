/**
 * Trang quản lý media và tài nguyên hiển thị website (/manager/media).
 * Cung cấp giao diện cho vai trò manager để quản lý các vị trí media trên trang (hero banner, sport cover, logo...),
 * hỗ trợ tải ảnh mới (tự động nén WebP), chọn ảnh từ thư viện media chung, chỉnh sửa alt text đa ngôn ngữ,
 * bật/tắt hiển thị, hoàn tác phiên bản trước đó hoặc khôi phục về ảnh mặc định của hệ thống.
 */
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


/**
 * Làm gì: Định nghĩa route cho trang quản lý media hệ thống tại URL /manager/media.
 * Được gọi ở: TanStack Router, URL: /manager/media (menu điều hướng manager trong src/shared/ui-config.ts).
 * @returns Đối tượng route liên kết với component Page.
 */
export const Route = createFileRoute("/manager/media")({
  component: Page,
});

/**
 * Làm gì: Component trang quản lý media, hiển thị thống kê slot, bộ lọc nhóm, danh sách media slot và điều phối các dialog cập nhật hình ảnh.
 * Được gọi ở: Route /manager/media (src/routes/manager.media.tsx).
 * @returns Giao diện trang quản lý media bọc trong Shell vai trò manager.
 */
function Page() {
  // Bước 1: Lấy toàn bộ trạng thái, danh sách slot media và các hàm điều khiển từ custom hook useManagerMedia
  const {
    activeTab, setActiveTab, data, error, reload, selectedGroup, setSelectedGroup, uploadSlot,
    setUploadSlot, librarySlot, setLibrarySlot, altSlot, setAltSlot, confirmRevertSlot,
    setConfirmRevertSlot, confirmResetSlot, setConfirmResetSlot, isVi, groups, filteredItems,
    toggleEnabled, totalSlots, enabledSlots, customSlots, disabledSlots,
  } = useManagerMedia();

  // Bước 2: Render giao diện quản trị gồm PageHero, chuyển đổi tab (Site slots / Media library), danh sách slot và các modal thao tác
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
              // Lấy nhãn hiển thị và mô tả vị trí đặt media theo ngôn ngữ người dùng đang chọn
              const label = isVi ? asset.label_vi : asset.label_en;
              const location = isVi ? asset.location_vi : asset.location_en;
              // Ghép kích thước ảnh hiện tại nếu có; nếu chưa có thì hiển thị ký hiệu gạch ngang
              const curDim = asset.width && asset.height ? `${asset.width} × ${asset.height}` : "–";
              // Chỉ cho phép hoàn tác (revert) nếu slot đã có lịch sử phiên bản trước đó (history_count > 0)
              const canRevert = asset.history_count > 0;
              // Kiểm tra slot còn ở phiên bản gốc mặc định hay không (chưa có lịch sử và version = 1) để ẩn nút reset
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
              // Gọi API hoàn tác slot media về phiên bản liền trước; encodeURIComponent để bảo vệ tên slot chứa ký tự đặc biệt
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

/**
 * Làm gì: Modal cho phép người quản lý tải lên ảnh mới cho một vị trí (slot) hiển thị, hỗ trợ nén ảnh WebP và xem trước vùng an toàn.
 * Được gọi ở: src/routes/manager.media.tsx (bên trong component Page)
 * @param asset Thông tin vị trí ảnh (ManagerAsset) cần thay đổi
 * @param onClose Callback đóng modal tải ảnh
 * @param onSuccess Callback làm mới danh sách sau khi tải ảnh thành công
 * @returns Giao diện modal tải ảnh lên
 */
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

  /**
   * Làm gì: Kiểm tra định dạng, kích thước file ảnh tải lên và nén sang WebP để tạo bản xem trước.
   * Được gọi ở: src/routes/manager.media.tsx (UploadDialog: input onChange và handleDrop)
   * @param f File ảnh do người dùng chọn hoặc kéo thả vào
   * @returns Không trả về giá trị (cập nhật state file và preview)
   */
  async function handleFileSelect(f: File) {
    // Bước 1: Kiểm tra định dạng tệp phải là hình ảnh (MIME type image/*)
    if (!f.type.startsWith("image/")) {
      toast.error(t("Please select an image file"));
      return;
    }
    // Giới hạn dung lượng tối đa 2MB (2 * 1024 * 1024 bytes) để tối ưu đường truyền và bộ nhớ
    if (f.size > 2 * 1024 * 1024) {
      toast.error(t("Image file must be under 2MB"));
      return;
    }
    // Bước 2: Lưu tệp gốc và nén ảnh sang định dạng WebP phía client để giảm dung lượng
    try {
      setFile(f);
      const res = await compressImageToWebp(f);
      // Bước 3: Cập nhật URL xem trước kèm kích thước ảnh vào state để hiển thị vùng an toàn (safe area)
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

  /**
   * Làm gì: Đóng gói ảnh WebP đã nén vào FormData và gọi API upload để cập nhật hình ảnh cho slot.
   * Được gọi ở: src/routes/manager.media.tsx (UploadDialog: nút Save)
   * @returns Không trả về giá trị (gọi onSuccess khi hoàn tất)
   */
  async function handleSave() {
    // Bước 1: Kiểm tra điều kiện tiên quyết, chỉ thực hiện khi đã có bản xem trước và file gốc hợp lệ
    if (!preview || !file) return;
    setBusy(true);
    try {
      // Bước 2: Đóng gói mã vị trí slot và file blob WebP vào FormData dạng multipart/form-data
      const formData = new FormData();
      formData.append("slot", asset.slot);
      formData.append("file", preview.blob, "asset.webp");
      // Bước 3: Gửi request upload lên backend, thông báo thành công và kích hoạt làm mới dữ liệu
      await apiPost("/manager/site-assets/upload", formData);
      toast.success(t("Asset updated"));
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Xử lý sự kiện kéo thả file vào vùng dropzone của modal tải ảnh.
   * Được gọi ở: src/routes/manager.media.tsx (UploadDialog: sự kiện onDrop của vùng tải ảnh)
   * @param e Sự kiện kéo thả DragEvent của thẻ div
   * @returns Không trả về giá trị
   */
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    // Bước 1: Ngăn hành vi mở file mặc định của trình duyệt và tắt trạng thái viền drag over
    e.preventDefault();
    setIsDragOver(false);
    // Bước 2: Lấy tệp đầu tiên từ danh sách kéo thả để thực hiện kiểm tra và nén ảnh
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

/**
 * Làm gì: Modal cho phép người quản trị chọn một hình ảnh từ thư viện media có sẵn để gán vào vị trí slot hiện tại.
 * Được gọi ở: src/routes/manager.media.tsx (bên trong component Page)
 * @param asset Thông tin vị trí ảnh (ManagerAsset) cần gán ảnh từ thư viện
 * @param onClose Callback đóng modal chọn ảnh từ thư viện
 * @param onSuccess Callback làm mới dữ liệu sau khi cập nhật ảnh thành công
 * @returns Giao diện modal duyệt và chọn ảnh từ thư viện media
 */
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
  // Bước 1: Xây dựng query string từ bộ lọc danh mục và từ khóa tìm kiếm để truy vấn thư viện media
  const query = new URLSearchParams();
  if (category !== "all") query.set("category", category);
  if (search.trim()) query.set("search", search.trim());
  const qs = query.toString();
  const endpoint = `/manager/media-library${qs ? `?${qs}` : ""}`;
  // Lấy danh sách ảnh từ thư viện theo URL động thông qua hook useRead
  const { data, error, reload } = useRead<{ items: MediaLibraryItem[] }>(endpoint);
  const [selectedItem, setSelectedItem] = useState<MediaLibraryItem | null>(null);
  const [busy, setBusy] = useState(false);

  // Bước 2: Lấy danh sách các môn thể thao từ hệ thống để bổ sung vào danh mục bộ lọc
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

  /**
   * Làm gì: Gửi API liên kết vị trí slot hiện tại với ảnh đã chọn từ thư viện media.
   * Được gọi ở: src/routes/manager.media.tsx (LibraryDialog: nút Save selection)
   * @returns Không trả về giá trị (gọi onSuccess khi cập nhật thành công)
   */
  async function handleSelect() {
    // Bước 1: Kiểm tra xem đã có hình ảnh nào trong thư viện được người dùng chọn hay chưa
    if (!selectedItem) return;
    setBusy(true);
    try {
      // Bước 2: Gọi API cập nhật liên kết library_id cho slot mà không cần tải lên file mới
      await apiPatch(`/manager/site-assets/${encodeURIComponent(asset.slot)}`, {
        library_id: selectedItem.id,
      });
      // Bước 3: Thông báo thành công và kích hoạt callback onSuccess để cập nhật giao diện ngoài
      toast.success(t("Asset updated"));
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  // Danh sách ảnh từ thư viện media, mặc định mảng rỗng nếu chưa tải xong
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

/**
 * Làm gì: Modal cho phép quản lý cập nhật văn bản thay thế (alt text) của ảnh vị trí theo 2 ngôn ngữ Anh - Việt, hỗ trợ SEO và khả năng tiếp cận (accessibility).
 * Được gọi ở: `src/routes/manager.media.tsx` trong component `Page` (khi nhấn nút "Edit alt text" trên từng card asset).
 * @param asset Dữ liệu asset vị trí đang được chỉnh sửa (`ManagerAsset`).
 * @param onClose Hàm callback đóng modal khi hủy bỏ.
 * @param onSuccess Hàm callback thông báo thành công để đóng modal và làm mới danh sách.
 * @returns Modal chỉnh sửa văn bản thay thế.
 */
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

  /**
   * Làm gì: Gửi dữ liệu alt text tiếng Anh và tiếng Việt lên server qua API PATCH để cập nhật cho asset.
   * Được gọi ở: `src/routes/manager.media.tsx` trong component `AltDialog` khi nhấn nút Save.
   * @returns Không trả về giá trị (Promise<void>).
   */
  async function handleSave() {
    // Bước 1: Đánh dấu đang xử lý để vô hiệu hóa nút bấm, tránh gửi request trùng lặp.
    setBusy(true);
    try {
      // Bước 2: Gọi API PATCH cập nhật alt_en và alt_vi theo slot của asset.
      await apiPatch(`/manager/site-assets/${encodeURIComponent(asset.slot)}`, {
        alt_en: altEn,
        alt_vi: altVi,
      });
      // Bước 3: Hiển thị thông báo thành công và kích hoạt callback onSuccess để cập nhật giao diện.
      toast.success(t("Alt text updated"));
      onSuccess();
    // Bước 4: Xử lý lỗi nếu gọi API thất bại và hiển thị thông báo lỗi đến người dùng.
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    } finally {
      // Bước 5: Luôn khôi phục trạng thái nút bấm sau khi hoàn tất request.
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

/**
 * Làm gì: Modal xác nhận các thao tác quan trọng (như hoàn tác version ảnh hoặc reset về mặc định), ngăn người dùng lỡ bấm nhầm.
 * Được gọi ở: `src/routes/manager.media.tsx` trong component `Page` (khi hoàn tác ảnh qua `confirmRevertSlot` hoặc reset qua `confirmResetSlot`).
 * @param title Tiêu đề của hộp thoại xác nhận.
 * @param message Nội dung giải thích hoặc cảnh báo hành động cho người dùng.
 * @param onConfirm Hàm bất đồng bộ thực hiện hành động khi xác nhận.
 * @param onClose Callback đóng modal khi hủy bỏ thao tác.
 * @returns Modal xác nhận thao tác.
 */
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

  /**
   * Làm gì: Quản lý trạng thái loading và thực thi hàm xác nhận `onConfirm` khi người dùng chấp nhận.
   * Được gọi ở: `src/routes/manager.media.tsx` trong component `ConfirmDialog` khi nhấn nút Save.
   * @returns Không trả về giá trị (Promise<void>).
   */
  async function handleConfirm() {
    // Bước 1: Khóa các nút bấm để ngăn người dùng thao tác nhiều lần trong khi đang xử lý.
    setBusy(true);
    try {
      // Bước 2: Thực thi hàm xử lý nghiệp vụ bất đồng bộ được truyền vào qua prop onConfirm.
      await onConfirm();
    } finally {
      // Bước 3: Mở khóa lại nút bấm trong khối finally bất kể thành công hay thất bại.
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

/**
 * Làm gì: Component hiển thị kho thư viện media dùng chung, cho phép tìm kiếm, lọc theo thể loại môn thể thao, xem thông tin bản quyền và sao chép đường dẫn ảnh.
 * Được gọi ở: `src/routes/manager.media.tsx` trong component `Page` khi chọn tab "Media library" trên trang `/manager/media`.
 * @returns Giao diện khám phá kho thư viện ảnh với các bộ lọc, thống kê và danh sách thẻ ảnh.
 */
function MediaLibraryExplorer() {
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  // Bước 1: Tạo query string từ danh mục đã chọn và từ khóa tìm kiếm để gọi API.
  const query = new URLSearchParams();
  if (category !== "all") query.set("category", category);
  if (search.trim()) query.set("search", search.trim());
  const qs = query.toString();
  const endpoint = `/manager/media-library${qs ? `?${qs}` : ""}`;
  // Bước 2: Gọi hook useRead để tải danh sách media từ endpoint /manager/media-library.
  const { data, error, reload } = useRead<{ items: MediaLibraryItem[] }>(endpoint);
  const isVi = locale() === "vi";

  const items = data?.items ?? [];

  // Bước 3: Tổng hợp danh mục lọc gồm các môn thể thao động từ hook useSports và các nhóm ảnh tĩnh của hệ thống.
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

  // Bước 4: Tính toán các chỉ số thống kê tổng quan (tổng số ảnh, ảnh có bản quyền bên ngoài, ảnh tải lên, số thể loại).
  const totalCount = items.length;
  const licensedCount = items.filter((i) => i.license !== "project").length;
  const uploadedCount = items.filter((i) => i.category === "uploaded").length;
  const categoriesCount = new Set(items.map((i) => i.category)).size;

  /**
   * Làm gì: Chuẩn hóa đường dẫn tương đối của tài nguyên và sao chép vào bộ nhớ đệm (clipboard).
   * Được gọi ở: `src/routes/manager.media.tsx` trong component `MediaLibraryExplorer` khi click nút "Copy path" trên card ảnh.
   * @param path Đường dẫn gốc của file phương tiện.
   * @returns Không trả về giá trị.
   */
  function handleCopy(path: string) {
    // Bước 1: Chuẩn hóa đường dẫn đảm bảo luôn bắt đầu bằng tiền tố `/media/`.
    const fullRelPath = path.startsWith("/media/") ? path : `/media/${path.replace(/^\//, "")}`;
    // Bước 2: Lưu đường dẫn vào clipboard và hiển thị thông báo toast thành công.
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

