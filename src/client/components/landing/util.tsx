/**
 * Tiện ích và React Context phục vụ các thành phần trên trang chủ (Landing Page).
 * File này cung cấp các công cụ: định dạng câu đa ngôn ngữ chứa component React (mark, rich),
 * chuyển đổi nhãn thứ trong tuần (wdLabel), Context chia sẻ giờ mở cửa và cấu hình trung tâm (VenueProvider, useVenue),
 * hook lấy giờ hiện tại tại trung tâm theo múi giờ Việt Nam (useVenueHour), và hàm tra cứu bảng giá sân (priceFor).
 * Vị trí trong app: Thuộc tầng client, dùng trực tiếp trong src/routes/index.tsx và các component con tại src/client/components/landing/.
 */
import { useContext, createContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_VENUE, type Venue } from "@/client/lib/venue";
import type { CatalogPrice } from "@/shared/arena3/contracts";
import { weekdayShort } from "@/shared/arena3/labels";
import { t, tk } from "@/client/lib/i18n";

/**
 * Rich sentences: translate the whole sentence with `{name}` placeholders set to `mark("name")`,
 * then `rich()` swaps each marker for a styled node, so word order stays the translator's call.
 */
export const mark = (k: string) => `\u0001${k}\u0002`;
/**
 * Làm gì: Hoán đổi các ký hiệu đánh dấu placeholder (\u0001key\u0002) trong câu dịch thành các ReactNode tương ứng (thẻ span), giữ nguyên thứ tự từ theo từng ngôn ngữ.
 * Được gọi ở: Tiện ích dự phòng cho các câu dịch phức tạp cần lồng ghép component hoặc style đặc biệt trên Landing Page.
 * @param text Chuỗi văn bản chứa các placeholder đã được đánh dấu bởi hàm mark().
 * @param nodes Bản đồ chứa các ReactNode tương ứng với từng khóa placeholder.
 * @returns Mảng ReactNode hoàn chỉnh để hiển thị trên giao diện người dùng.
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  // Tách chuỗi theo cặp ký tự điều khiển \u0001 và \u0002: các phần tử ở chỉ số chẵn là văn bản thường, chỉ số lẻ là tên key cần thay bằng ReactNode.
  // eslint-disable-next-line no-control-regex -- \u0001 and \u0002 are the markers mark() writes; copy never contains them.
  return text.split(/\u0001(\w+)\u0002/).map((part, i) => (i % 2 === 0 ? part : <span key={i}>{nodes[part]}</span>));
}

/** Short weekday for display; `weekdayShort` keeps its English codes for the weekend check. */
const WD_SHORT: Record<string, string> = {
  Mon: tk("Mon"),
  Tue: tk("Tue"),
  Wed: tk("Wed"),
  Thu: tk("Thu"),
  Fri: tk("Fri"),
  Sat: tk("Sat"),
  Sun: tk("Sun"),
};
/**
 * Làm gì: Chuyển đổi chuỗi ngày ISO (YYYY-MM-DD) thành tên viết tắt của thứ trong tuần đã được bản địa hóa (ví dụ: T2, T3... hoặc Mon, Tue...).
 * Được gọi ở:
 * - src/routes/index.tsx: component Landing (hiển thị ngày đã chọn trên nút đặt sân).
 * - src/client/components/landing/schedule.tsx: component ScheduleScene (hiển thị nhãn thứ trên thanh chọn ngày).
 * @param iso Chuỗi ngày định dạng ISO (YYYY-MM-DD).
 * @returns Tên viết tắt của thứ trong tuần theo ngôn ngữ hiện tại.
 */
export const wdLabel = (iso: string) => {
  // Bước 1: Trích xuất mã thứ 3 ký tự tiếng Anh chuẩn (Mon..Sun) từ chuỗi ngày ISO.
  const w = weekdayShort(iso);
  // Bước 2: Tra cứu khóa dịch tương ứng từ WD_SHORT; nếu không tìm thấy thì giữ nguyên mã gốc làm fallback.
  return t(WD_SHORT[w] ?? w);
};

/** Opening hours and hold length for every landing section; the page provides the real ones. */
const VenueCtx = createContext<Venue>(DEFAULT_VENUE);
/**
 * Làm gì: React Context Provider cung cấp dữ liệu cấu hình trung tâm (giờ mở/đóng cửa, thời gian giữ chỗ) cho toàn bộ cây component Landing Page.
 * Được gọi ở: src/routes/index.tsx: component Landing (bọc bên ngoài toàn bộ giao diện trang chủ).
 */
export const VenueProvider = VenueCtx.Provider;
/**
 * Làm gì: Hook tiện ích giúp các component con lấy thông tin cấu hình trung tâm (Venue) từ Context VenueCtx.
 * Được gọi ở:
 * - src/client/components/landing/closing.tsx: ClosingScene, ClosingMap
 * - src/client/components/landing/hero.tsx: HeroScene, HeroBookingWidget, HeroHourPicker
 * - src/client/components/landing/pricing.tsx: PricingScene
 * - src/client/components/landing/schedule.tsx: ScheduleScene, ScheduleGrid
 * @returns Đối tượng Venue chứa thông tin cấu hình giờ mở/đóng cửa và số phút giữ chỗ.
 */
export const useVenue = () => useContext(VenueCtx);

/** Current wall-clock hour at the centre (ICT), or null until the client mounts. */
export function useVenueHour() {
  // Bước 1: Khởi tạo giá trị null ban đầu để tránh lỗi hydration mismatch giữa SSR và client.
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => {
    // Bước 2: Cấu hình bộ định dạng giờ theo múi giờ Việt Nam (ICT - Asia/Ho_Chi_Minh, 24 giờ) bất kể trình duyệt ở múi giờ nào.
    const hourFormatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour: "2-digit",
      hour12: false,
    });
    // Bước 3: Đọc giờ hiện tại ngay khi mount và duy trì cập nhật mỗi 60 giây (60.000 ms).
    const read = () => setHour(Number(hourFormatter.format(new Date())));
    read();
    const id = setInterval(read, 60_000);
    // Bước 4: Xóa interval khi component unmount để tránh rò rỉ bộ nhớ (memory leak).
    return () => clearInterval(id);
  }, []);
  return hour;
}

/** Weekend pricing runs on Saturday and Sunday; everything else is a weekday. */
function dayKindOf(iso: string) {
  // Thứ Bảy và Chủ Nhật áp dụng bảng giá cuối tuần (weekend), các ngày còn lại là ngày thường (weekday).
  const wd = weekdayShort(iso);
  return wd === "Sat" || wd === "Sun" ? "weekend" : "weekday";
}

/** What one hour on one sport costs on a given day, from the centre's own sheet. */
export function priceFor(prices: CatalogPrice[], sport: string, date: string, hour: number) {
  // Bước 1: Phân loại ngày theo lịch (ngày thường weekday hoặc cuối tuần weekend) để chọn đúng bảng giá.
  const kind = dayKindOf(date);
  // Bước 2: Tìm quy tắc giá khớp môn thể thao, loại ngày và khung giờ hoạt động.
  // Lưu ý: !court_id đảm bảo chỉ lấy đơn giá chuẩn chung của môn thể thao trên Landing Page, không áp dụng giá riêng theo từng sân.
  const rule = prices.find(
    (p) =>
      p.sport === sport &&
      p.day_kind === kind &&
      !p.court_id &&
      Number(p.start_local.slice(0, 2)) <= hour &&
      hour < Number(p.end_local.slice(0, 2)),
  );
  // Bước 3: Trả về đơn giá niêm yết (VNĐ) nếu tìm thấy quy tắc giá phù hợp, ngược lại trả về null.
  return rule?.price_vnd ?? null;
}
