/**
 * Module quản lý tài nguyên truyền thông (media assets) cho giao diện quản trị viên (Manager).
 * Cung cấp hook useManagerMedia điều phối trạng thái hiển thị/thao tác các media slot (hero, banner, cover),
 * cùng các hàm tiện ích tính kích thước khuyến nghị, class tỷ lệ khung hình (aspect ratio) và nén ảnh WebP trên canvas.
 */
import { useState } from "react";
import { toast } from "sonner";
import { apiPatch } from "@/client/arena3/client";
import { type MediaAspectRatio, type MediaSlotGroup } from "@/shared/arena3/media";
import { locale, t } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

type ManagerAsset = {
  slot: string;
  kind: "image" | "video";
  url: string;
  default_path: string;
  alt_en: string;
  alt_vi: string;
  enabled: boolean;
  width: number | null;
  height: number | null;
  version: number;
  updated_at: string;
  updated_by: string | null;
  history_count: number;
  label_en: string;
  label_vi: string;
  location_en: string;
  location_vi: string;
  group: MediaSlotGroup;
  aspect: MediaAspectRatio;
};

type MediaLibraryItem = {
  id: string;
  path: string;
  kind: string;
  category: string;
  tags: string[];
  width: number | null;
  height: number | null;
  alt_en: string;
  alt_vi: string;
  credit: string | null;
  source_url: string | null;
  license: string;
  created_at: string;
  url: string;
  name: string;
};


/**
 * Làm gì: Trả về chuỗi kích thước pixel khuyến nghị (ví dụ: "1920 × 1080") tương ứng với từng tỉ lệ khung hình để hướng dẫn người quản lý tải ảnh đúng chuẩn.
 * Được gọi ở: src/routes/manager.media.tsx trong component Page.
 * @param aspect Tỉ lệ khung hình của vị trí hiển thị ("16:9", "4:5", "3:4" hoặc "1:1").
 * @returns Chuỗi kích thước khuyến nghị dạng "Rộng × Cao".
 */
function recDim(aspect: MediaAspectRatio): string {
  switch (aspect) {
    case "16:9":
      return "1920 × 1080";
    case "4:5":
      return "1200 × 1500";
    case "3:4":
      return "1200 × 1600";
    case "1:1":
      return "800 × 800";
    default:
      return "1920 × 1080";
  }
}


/**
 * Làm gì: Ánh xạ tỉ lệ khung hình (aspect ratio) sang class tiện ích tương ứng của Tailwind CSS để định hình khung chứa ảnh đồng nhất.
 * Được gọi ở: src/routes/manager.media.tsx trong component Page.
 * @param aspect Tỉ lệ khung hình ("16:9", "4:5", "3:4" hoặc "1:1").
 * @returns Tên class Tailwind quy định tỉ lệ khung hình (ví dụ: "aspect-video", "aspect-[4/5]").
 */
function aspectClass(aspect: MediaAspectRatio): string {
  switch (aspect) {
    case "16:9":
      return "aspect-video";
    case "4:5":
      return "aspect-[4/5]";
    case "3:4":
      return "aspect-[3/4]";
    case "1:1":
      return "aspect-square";
    default:
      return "aspect-video";
  }
}


/**
 * Làm gì: Đọc file ảnh từ người dùng, tự động thu nhỏ nếu kích thước vượt quá 2400px và nén sang định dạng WebP để tối ưu dung lượng và tốc độ tải trang.
 * Được gọi ở: src/routes/manager.media.tsx trong UploadModal khi người dùng tải ảnh lên một slot.
 * @param file File ảnh gốc được chọn từ thiết bị của người dùng.
 * @returns Promise chứa Blob ảnh WebP đã nén, chiều rộng, chiều cao thực tế và previewUrl tạm thời để xem trước.
 * @throws Error khi không thể đọc file, không lấy được 2D context của Canvas hoặc nén Blob thất bại.
 */
async function compressImageToWebp(file: File): Promise<{ blob: Blob; width: number; height: number; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    // Bước 1: Khởi tạo FileReader để đọc file ảnh dưới dạng Data URL (base64)
    const reader = new FileReader();
    reader.onload = (e) => {
      // Bước 2: Nạp Data URL vào đối tượng Image để lấy thông tin kích thước gốc
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        // Bước 3: Giới hạn kích thước tối đa 2400px để tránh ảnh quá nặng gây chậm trình duyệt, đồng thời giữ nguyên tỉ lệ khung hình gốc
        const maxDim = 2400;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        // Bước 4: Khởi tạo thẻ Canvas với kích thước đã co giãn và vẽ ảnh lên canvas context 2D
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas context failed"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        // Bước 5: Chuyển đổi nội dung Canvas thành Blob chuẩn WebP với chất lượng 85% để cân bằng giữa độ nét và dung lượng mạng
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Canvas compression failed"));
              return;
            }
            // Tạo object URL cục bộ để hiển thị ảnh xem trước (preview) tức thì trên giao diện mà không cần chờ tải lên máy chủ
            const previewUrl = URL.createObjectURL(blob);
            resolve({ blob, width, height, previewUrl });
          },
          "image/webp",
          0.85,
        );
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Làm gì: Custom hook quản lý toàn bộ trạng thái UI, tải danh sách media asset và điều khiển các modal thao tác cho trang Quản lý Media.
 * Được gọi ở: src/routes/manager.media.tsx trong component Page.
 * @returns Đối tượng chứa các state điều khiển tab, modal, danh sách asset đã lọc, hàm bật/tắt slot và số liệu thống kê.
 */
export function useManagerMedia() {
  // Bước 1: Khởi tạo các state điều khiển tab ("slots" hoặc "library") và dữ liệu danh sách asset từ API
  const [activeTab, setActiveTab] = useState<"slots" | "library">("slots");
  const { data, error, reload } = useRead<{ items: ManagerAsset[] }>("/manager/site-assets");
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  // Quản lý thông tin slot đang được chọn để mở các modal chức năng (upload, chọn từ thư viện, sửa alt text, revert, reset)
  const [uploadSlot, setUploadSlot] = useState<ManagerAsset | null>(null);
  const [librarySlot, setLibrarySlot] = useState<ManagerAsset | null>(null);
  const [altSlot, setAltSlot] = useState<ManagerAsset | null>(null);
  const [confirmRevertSlot, setConfirmRevertSlot] = useState<ManagerAsset | null>(null);
  const [confirmResetSlot, setConfirmResetSlot] = useState<ManagerAsset | null>(null);

  const isVi = locale() === "vi";
  const items = data?.items ?? [];

  const groups: Array<{ value: string; label: string }> = [
    { value: "all", label: t("All groups") },
    { value: "landing", label: t("Homepage") },
    { value: "auth", label: t("Auth & onboarding") },
    { value: "banner", label: t("Inner banners") },
    { value: "sport", label: t("Sport covers") },
    { value: "coach", label: t("Coaches") },
    { value: "brand", label: t("Brand & default") },
  ];

  // Bước 2: Lọc danh sách media slot theo nhóm vị trí (group) đang được chọn trên giao diện
  const filteredItems = items.filter((it) => {
    if (selectedGroup === "all") return true;
    return it.group === selectedGroup;
  });

  /**
   * Làm gì: Bật hoặc tắt trạng thái hoạt động (enabled/disabled) của một media slot trên toàn hệ thống và cập nhật lại danh sách.
   * Được gọi ở: src/routes/manager.media.tsx trong bảng danh sách slot của component Page.
   * @param item Đối tượng thông tin media slot cần thay đổi trạng thái.
   */
  async function toggleEnabled(item: ManagerAsset) {
    try {
      // Gửi yêu cầu PATCH đảo ngược cờ enabled; encodeURIComponent để đảm bảo an toàn cho tên slot chứa ký tự đặc biệt
      await apiPatch(`/manager/site-assets/${encodeURIComponent(item.slot)}`, {
        enabled: !item.enabled,
      });
      // Hiển thị thông báo thành công và gọi reload() để làm mới dữ liệu từ server
      toast.success(t("Status updated"));
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    }
  }

  // Bước 3: Tính toán các chỉ số tổng hợp (tổng slot, đang bật, đã chỉnh sửa, bị tắt) phục vụ các thẻ thống kê
  const totalSlots = items.length;
  const enabledSlots = items.filter((i) => i.enabled).length;
  // Một slot được coi là đã tùy chỉnh nếu đã từng chỉnh sửa (version > 1 hoặc có lịch sử thay đổi ảnh)
  const customSlots = items.filter((i) => i.history_count > 0 || i.version > 1).length;
  const disabledSlots = totalSlots - enabledSlots;
  return {
    activeTab, setActiveTab, data, error, reload, selectedGroup, setSelectedGroup, uploadSlot,
    setUploadSlot, librarySlot, setLibrarySlot, altSlot, setAltSlot, confirmRevertSlot,
    setConfirmRevertSlot, confirmResetSlot, setConfirmResetSlot, isVi, groups, filteredItems,
    toggleEnabled, totalSlots, enabledSlots, customSlots, disabledSlots,
  };
}

export { type ManagerAsset, type MediaLibraryItem, recDim, aspectClass, compressImageToWebp };
