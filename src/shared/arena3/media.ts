/**
 * Tệp này định nghĩa danh mục registry và cấu hình các vị trí media (media slots) dùng chung trong Arena 3.
 * Vai trò trong ứng dụng:
 * - Chuẩn hóa định danh (slot ID), loại media (image/video), nhóm hiển thị (landing, auth, banner, sport, coach, brand) và tỉ lệ khung hình (aspect ratio).
 * - Cung cấp nhãn và vị trí hiển thị song ngữ (EN/VI) cho từng vị trí media trên giao diện người dùng và trang quản trị (manager).
 * - Được dùng chung giữa client (hiển thị hình ảnh/banner/video) và server (quản lý upload và gán tài nguyên media).
 */
export type MediaSlotKind = "image" | "video";
export type MediaAspectRatio = "16:9" | "4:5" | "1:1" | "3:4";
export type MediaSlotGroup =
  | "landing"
  | "auth"
  | "banner"
  | "sport"
  | "coach"
  | "brand";

export type MediaSlotDef = {
  slot: string;
  kind: MediaSlotKind;
  group: MediaSlotGroup;
  labelEn: string;
  labelVi: string;
  locationEn: string;
  locationVi: string;
  aspect: MediaAspectRatio;
};

/**
 * Làm gì: Danh sách đăng ký toàn bộ các vị trí media (media slots) tĩnh mặc định của hệ thống Arena 3.
 *   Xác định rõ loại media (image/video), nhóm hiển thị (landing, auth, banner, sport, coach, brand),
 *   nhãn song ngữ và tỉ lệ khung hình (aspect ratio) chuẩn cho từng vị trí.
 * Được gọi ở: src/shared/arena3/media.ts (hàm findSlotDef); gián tiếp phục vụ API quản lý media tại src/server/controllers/handlers/assets.ts.
 * @returns Mảng hằng số MediaSlotDef[] chứa các định nghĩa vị trí media mặc định.
 */
export const MEDIA_REGISTRY: MediaSlotDef[] = [
  // Landing
  {
    slot: "landing.hero.image",
    kind: "image",
    group: "landing",
    labelEn: "Hero background / poster",
    labelVi: "Ảnh nền / poster đầu trang",
    locationEn: "Home Hero section",
    locationVi: "Mục đầu trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.hero.video",
    kind: "video",
    group: "landing",
    labelEn: "Hero background video",
    labelVi: "Video nền đầu trang",
    locationEn: "Home Hero section",
    locationVi: "Mục đầu trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.courts.badminton",
    kind: "image",
    group: "landing",
    labelEn: "Badminton court card",
    labelVi: "Thẻ sân cầu lông",
    locationEn: "Home Courts section",
    locationVi: "Mục sân đấu trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.courts.basketball",
    kind: "image",
    group: "landing",
    labelEn: "Basketball court card",
    labelVi: "Thẻ sân bóng rổ",
    locationEn: "Home Courts section",
    locationVi: "Mục sân đấu trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.courts.volleyball",
    kind: "image",
    group: "landing",
    labelEn: "Volleyball court card",
    labelVi: "Thẻ sân bóng chuyền",
    locationEn: "Home Courts section",
    locationVi: "Mục sân đấu trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.facilities.badminton",
    kind: "image",
    group: "landing",
    labelEn: "Badminton facility",
    labelVi: "Cơ sở vật chất cầu lông",
    locationEn: "Home Facilities section",
    locationVi: "Mục cơ sở vật chất trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.facilities.basketball",
    kind: "image",
    group: "landing",
    labelEn: "Basketball facility",
    labelVi: "Cơ sở vật chất bóng rổ",
    locationEn: "Home Facilities section",
    locationVi: "Mục cơ sở vật chất trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.facilities.volleyball",
    kind: "image",
    group: "landing",
    labelEn: "Volleyball facility",
    labelVi: "Cơ sở vật chất bóng chuyền",
    locationEn: "Home Facilities section",
    locationVi: "Mục cơ sở vật chất trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.facilities.reception",
    kind: "image",
    group: "landing",
    labelEn: "Reception desk",
    labelVi: "Quầy lễ tân",
    locationEn: "Home Facilities section",
    locationVi: "Mục cơ sở vật chất trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.facilities.hall",
    kind: "image",
    group: "landing",
    labelEn: "Main hall overview",
    labelVi: "Toàn cảnh cụm sân",
    locationEn: "Home Facilities section",
    locationVi: "Mục cơ sở vật chất trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.pricing.image",
    kind: "image",
    group: "landing",
    labelEn: "Court detail (pricing)",
    labelVi: "Chi tiết mặt sân (bảng giá)",
    locationEn: "Home Pricing section",
    locationVi: "Mục bảng giá trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.pricing.video",
    kind: "video",
    group: "landing",
    labelEn: "Smash action video",
    labelVi: "Video đập bóng (bảng giá)",
    locationEn: "Home Pricing section",
    locationVi: "Mục bảng giá trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.closing",
    kind: "image",
    group: "landing",
    labelEn: "Frontage at dusk",
    labelVi: "Mặt tiền trung tâm lúc hoàng hôn",
    locationEn: "Home Closing section",
    locationVi: "Mục cuối trang chủ",
    aspect: "16:9",
  },

  // Auth
  {
    slot: "auth.login.image",
    kind: "image",
    group: "auth",
    labelEn: "Sign-in side photo",
    labelVi: "Ảnh bên cạnh đăng nhập",
    locationEn: "Sign-in page",
    locationVi: "Trang đăng nhập",
    aspect: "4:5",
  },
  {
    slot: "auth.login.video",
    kind: "video",
    group: "auth",
    labelEn: "Sign-in video background",
    labelVi: "Video nền đăng nhập",
    locationEn: "Sign-in page",
    locationVi: "Trang đăng nhập",
    aspect: "16:9",
  },
  {
    slot: "auth.register.image",
    kind: "image",
    group: "auth",
    labelEn: "Register athlete photo",
    labelVi: "Ảnh vận động viên đăng ký",
    locationEn: "Register page",
    locationVi: "Trang đăng ký",
    aspect: "4:5",
  },

  // Banner
  {
    slot: "banner.book",
    kind: "image",
    group: "banner",
    labelEn: "Booking banner",
    labelVi: "Banner đặt sân",
    locationEn: "Court booking page",
    locationVi: "Trang đặt sân",
    aspect: "16:9",
  },
  {
    slot: "banner.classes",
    kind: "image",
    group: "banner",
    labelEn: "Classes banner",
    labelVi: "Banner lớp học",
    locationEn: "Classes page",
    locationVi: "Trang lớp học",
    aspect: "16:9",
  },
  {
    slot: "banner.train",
    kind: "image",
    group: "banner",
    labelEn: "Training banner",
    labelVi: "Banner tập luyện",
    locationEn: "Training page",
    locationVi: "Trang tập luyện",
    aspect: "16:9",
  },
  {
    slot: "banner.coach",
    kind: "image",
    group: "banner",
    labelEn: "Coach banner",
    labelVi: "Banner huấn luyện viên",
    locationEn: "Coach schedule",
    locationVi: "Lịch huấn luyện viên",
    aspect: "16:9",
  },
  {
    slot: "banner.gate",
    kind: "image",
    group: "banner",
    labelEn: "Gate check-in banner",
    labelVi: "Banner cổng soát vé",
    locationEn: "Reception check-in gate",
    locationVi: "Cổng check-in lễ tân",
    aspect: "16:9",
  },
  {
    slot: "banner.manager",
    kind: "image",
    group: "banner",
    labelEn: "Manager overview banner",
    labelVi: "Banner tổng quan quản lý",
    locationEn: "Manager dashboard",
    locationVi: "Bảng điều khiển quản lý",
    aspect: "16:9",
  },

  // Sport
  {
    slot: "sport.badminton",
    kind: "image",
    group: "sport",
    labelEn: "Badminton sport photo",
    labelVi: "Ảnh môn cầu lông",
    locationEn: "Plans & booking: Badminton",
    locationVi: "Gói tập & đặt sân: Cầu lông",
    aspect: "16:9",
  },
  {
    slot: "sport.basketball",
    kind: "image",
    group: "sport",
    labelEn: "Basketball sport photo",
    labelVi: "Ảnh môn bóng rổ",
    locationEn: "Plans & booking: Basketball",
    locationVi: "Gói tập & đặt sân: Bóng rổ",
    aspect: "16:9",
  },
  {
    slot: "sport.volleyball",
    kind: "image",
    group: "sport",
    labelEn: "Volleyball sport photo",
    labelVi: "Ảnh môn bóng chuyền",
    locationEn: "Plans & booking: Volleyball",
    locationVi: "Gói tập & đặt sân: Bóng chuyền",
    aspect: "16:9",
  },
  {
    slot: "sport.all",
    kind: "image",
    group: "sport",
    labelEn: "All-sports photo",
    labelVi: "Ảnh đa môn thể thao",
    locationEn: "Plans & booking: All sports",
    locationVi: "Gói tập & đặt sân: Đa môn",
    aspect: "16:9",
  },


  // Coaches (seeded demo coaches)
  {
    slot: "coach.00000000-0000-0000-0000-000000000011",
    kind: "image",
    group: "coach",
    labelEn: "Coach Nguyen Minh Khoa",
    labelVi: "HLV Nguyễn Minh Khoa",
    locationEn: "Coaches section & classes",
    locationVi: "Mục HLV & thông tin lớp học",
    aspect: "1:1",
  },
  {
    slot: "coach.00000000-0000-0000-0000-000000000012",
    kind: "image",
    group: "coach",
    labelEn: "Coach Tran Thi Lan",
    labelVi: "HLV Trần Thị Lan",
    locationEn: "Coaches section & classes",
    locationVi: "Mục HLV & thông tin lớp học",
    aspect: "1:1",
  },
  {
    slot: "coach.00000000-0000-0000-0000-000000000013",
    kind: "image",
    group: "coach",
    labelEn: "Coach Pham Duc Anh",
    labelVi: "HLV Phạm Đức Anh",
    locationEn: "Coaches section & classes",
    locationVi: "Mục HLV & thông tin lớp học",
    aspect: "1:1",
  },
  {
    slot: "coach.00000000-0000-0000-0000-000000000014",
    kind: "image",
    group: "coach",
    labelEn: "Coach Le Quoc Viet",
    labelVi: "HLV Lê Quốc Việt",
    locationEn: "Coaches section & classes",
    locationVi: "Mục HLV & thông tin lớp học",
    aspect: "1:1",
  },
  {
    slot: "coach.00000000-0000-0000-0000-000000000003",
    kind: "image",
    group: "coach",
    labelEn: "Coach Đỗ Minh Quân",
    labelVi: "HLV Đỗ Minh Quân",
    locationEn: "Coaches section & classes",
    locationVi: "Mục HLV & thông tin lớp học",
    aspect: "1:1",
  },

  // Brand & default slots
  {
    slot: "plan.default",
    kind: "image",
    group: "brand",
    labelEn: "Default membership plan card",
    labelVi: "Ảnh mặc định thẻ gói tập",
    locationEn: "Plans & pricing cards",
    locationVi: "Thẻ gói tập & bảng giá",
    aspect: "16:9",
  },
  {
    slot: "class.default",
    kind: "image",
    group: "brand",
    labelEn: "Default class session image",
    labelVi: "Ảnh mặc định lớp học",
    locationEn: "Classes schedule & list",
    locationVi: "Lịch và danh sách lớp học",
    aspect: "16:9",
  },
  {
    slot: "empty.default",
    kind: "image",
    group: "brand",
    labelEn: "Default empty state graphic",
    labelVi: "Ảnh mặc định trạng thái trống",
    locationEn: "Empty states across app",
    locationVi: "Màn hình trống trong ứng dụng",
    aspect: "16:9",
  },

  // Landing gallery
  {
    slot: "landing.gallery.1",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 1",
    labelVi: "Bộ sưu tập trang chủ 1",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.gallery.2",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 2",
    labelVi: "Bộ sưu tập trang chủ 2",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.gallery.3",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 3",
    labelVi: "Bộ sưu tập trang chủ 3",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.gallery.4",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 4",
    labelVi: "Bộ sưu tập trang chủ 4",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.gallery.5",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 5",
    labelVi: "Bộ sưu tập trang chủ 5",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.gallery.6",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 6",
    labelVi: "Bộ sưu tập trang chủ 6",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.gallery.7",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 7",
    labelVi: "Bộ sưu tập trang chủ 7",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
  {
    slot: "landing.gallery.8",
    kind: "image",
    group: "landing",
    labelEn: "Landing gallery 8",
    labelVi: "Bộ sưu tập trang chủ 8",
    locationEn: "Home Gallery section",
    locationVi: "Mục bộ sưu tập trang chủ",
    aspect: "16:9",
  },
];

/**
 * Làm gì: Tìm định nghĩa cấu hình (metadata) của một slot media theo mã slot.
 * Tự động sinh cấu hình mặc định (fallback) cho HLV mới ("coach.<id>") và môn thể thao mới ("sport.<code>") nếu chưa có trong MEDIA_REGISTRY.
 * Được gọi ở: src/server/controllers/handlers/assets.ts (hàm managerAssetsList / API GET /v1/site-assets)
 * @param slot Mã định danh vị trí media (ví dụ: "landing.hero.image", "coach.<id>", "sport.badminton")
 * @returns Đối tượng MediaSlotDef chứa thông tin hiển thị (nhãn, vị trí, tỉ lệ aspect ratio), hoặc undefined nếu không tìm thấy
 */
export function findSlotDef(slot: string): MediaSlotDef | undefined {
  // Bước 1: Xử lý riêng cho các slot thuộc nhóm HLV (bắt đầu bằng "coach.")
  if (slot.startsWith("coach.")) {
    // Ưu tiên kiểm tra trong danh mục tĩnh nếu HLV đã được khai báo sẵn từ trước
    const existing = MEDIA_REGISTRY.find((r) => r.slot === slot);
    if (existing) return existing;
    // Với HLV mới tạo trong database, tự động sinh cấu hình mặc định (ảnh vuông 1:1, nhóm coach)
    return {
      slot,
      kind: "image",
      group: "coach",
      labelEn: "Coach Avatar",
      labelVi: "Ảnh đại diện HLV",
      locationEn: "Coaches section & classes",
      locationVi: "Mục HLV & thông tin lớp học",
      aspect: "1:1",
    };
  }
  // Bước 2: Tìm kiếm slot trong danh mục tĩnh MEDIA_REGISTRY
  const known = MEDIA_REGISTRY.find((r) => r.slot === slot);
  // Nếu đã có cấu hình hoặc slot không thuộc nhóm môn thể thao ("sport."), trả về kết quả ngay
  if (known || !slot.startsWith("sport.")) return known;
  // Bước 3: Tự động sinh cấu hình ảnh tỉ lệ 16:9 cho các môn thể thao mới được quản lý thêm sau
  // A sport the manager added later: its photo belongs with the other sport photos.
  return {
    slot,
    kind: "image",
    group: "sport",
    labelEn: "Sport photo",
    labelVi: "Ảnh môn",
    locationEn: "Courts & booking",
    locationVi: "Sân & đặt sân",
    aspect: "16:9",
  };
}

/**
 * Làm gì: Chuẩn hóa tên hoặc mã môn thể thao thành mã slot media tương ứng (dạng "sport.<mã>").
 * Giúp các màn hình lấy đúng ảnh đại diện của từng môn thể thao, hoặc dùng ảnh chung "sport.all" khi không có môn.
 * Được gọi ở:
 * - src/client/components/media.tsx: hook useSportPhoto
 * - src/client/components/landing/plans.tsx: component PlansSection
 * - src/routes/app.book.tsx: route /app/book (chọn banner theo môn)
 * - src/routes/app.classes.tsx: route /app/classes (ảnh bìa lớp học theo môn)
 * @param sport Tên hoặc mã môn thể thao (ví dụ: "badminton", "basketball", "volleyball")
 * @returns Chuỗi mã slot media tương ứng (ví dụ: "sport.badminton" hoặc "sport.all")
 */
export function sportPhoto(sport: string): string {
  // Bước 1: Chuẩn hóa tên môn thể thao (loại bỏ khoảng trắng thừa và chuyển về chữ thường)
  const s = (sport || "").trim().toLowerCase();
  // Bước 2: Ghép thành slot "sport.<mã>", fallback về "sport.all" nếu không xác định được môn
  return s ? `sport.${s}` : "sport.all";
}

