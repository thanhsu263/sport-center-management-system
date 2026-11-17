/**
 * Quản lý danh mục môn thể thao và các thành phần giao diện (UI) ở phía client.
 * Cung cấp hook useSports để tải và đệm dữ liệu môn thể thao từ API /v1/sports,
 * đồng thời cung cấp các component trực quan như SportDot (chấm màu),
 * SportBadge (huy hiệu môn thể thao) và SportThumbnail (ảnh đại diện môn thể thao).
 */
import { useEffect, useState } from "react";
import { cn } from "@/client/lib/cn";
import { registerSportNames, sportLabel } from "@/shared/arena3/labels";
import { locale } from "@/client/lib/i18n";
import { useSportPhoto } from "./media";

export type SportInfo = {
  code: string;
  name?: string;
  name_en: string;
  name_vi: string;
  court_prefix?: string | null;
  color_key?: string;
  glyph_key?: string;
  photo_url?: string;
};

/**
 * Làm gì: Bổ sung thuộc tính name cho từng môn thể thao dựa trên ngôn ngữ hiện tại của người dùng (name_vi nếu là tiếng Việt, ngược lại dùng name_en).
 * Được gọi ở: src/client/components/sports-ui.tsx: hàm load() bên trong hook useSports.
 * @param items Danh sách các môn thể thao gốc nhận về từ API /v1/sports.
 * @returns Mảng môn thể thao mới đã được bổ sung thuộc tính name phù hợp với ngôn ngữ hiển thị.
 * @throws Không có.
 */
function enrichSports(items: SportInfo[]): SportInfo[] {
  const isVi = locale() === "vi";
  return items.map((s) => ({
    ...s,
    name: isVi ? s.name_vi : s.name_en,
  }));
}

export type UseSportsResult = SportInfo[] & { sports: SportInfo[]; items: SportInfo[] };

/**
 * Làm gì: Ép kiểu và gán các thuộc tính alias (.sports, .items) trỏ về chính mảng dữ liệu, giúp phía gọi hook useSports có thể truy cập linh hoạt theo kiểu mảng hoặc destructuring object.
 * Được gọi ở: src/client/components/sports-ui.tsx: bên trong hook useSports (khởi tạo state và cập nhật dữ liệu).
 * @param items Mảng danh sách thông tin môn thể thao SportInfo[].
 * @returns Mảng đối tượng kiểu UseSportsResult có sẵn các thuộc tính alias .sports và .items.
 * @throws Không có.
 */
function toResult(items: SportInfo[]): UseSportsResult {
  const arr = [...items] as UseSportsResult;
  // Gán alias .sports và .items trỏ về chính mảng arr để hỗ trợ cả 2 cách dùng: const list = useSports() hoặc const { sports } = useSports().
  arr.sports = arr;
  arr.items = arr;
  return arr;
}

// Bộ nhớ đệm (in-memory cache) cấp module lưu danh sách môn thể thao, giúp tránh gọi lại API /v1/sports nhiều lần khi nhiều component cùng mount.
let cachedSports: SportInfo[] | null = null;

/**
 * Làm gì: Xóa bộ nhớ đệm cachedSports và phát sự kiện arena3:sports-changed trên window để thông báo cho tất cả hook useSports đang hoạt động tải lại dữ liệu mới nhất.
 * Được gọi ở: src/client/lib/pages/manager.sports.ts: sau khi quản lý thêm mới, chỉnh sửa, xóa hoặc cập nhật môn thể thao.
 * @returns void
 * @throws Không có.
 */
export function invalidateSportsCache() {
  // Bước 1: Xóa bộ nhớ đệm trong RAM để lần nạp kế tiếp sẽ gọi API lấy dữ liệu mới nhất từ cơ sở dữ liệu.
  cachedSports = null;
  // Bước 2: Phát sự kiện toàn cục để kích hoạt hàm load() trong các hook useSports đang active trên giao diện.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("arena3:sports-changed"));
  }
}

/**
 * Làm gì: React hook cung cấp danh sách môn thể thao đã bản địa hóa; tự động gọi API /v1/sports nếu chưa có cache, đăng ký tên vào từ điển nhãn và lắng nghe sự kiện để cập nhật theo thời gian thực.
 * Được gọi ở: src/client/components/shell.tsx:Shell (tải sẵn danh mục toàn cục), các trang landing page (coaches, courts, hero...), trang đặt sân (app.book.ts) và các trang quản lý (manager.*).
 * @returns Đối tượng UseSportsResult chứa mảng môn thể thao, truy cập được cả theo dạng mảng hoặc qua thuộc tính .sports, .items.
 * @throws Không có.
 */
export function useSports(): UseSportsResult {
  // Khởi tạo state từ cachedSports nếu đã có sẵn trong bộ nhớ đệm để component render ngay tức thì mà không bị giật giao diện.
  const [sports, setSports] = useState<UseSportsResult>(() => toResult(cachedSports ?? []));

  // Quản lý vòng đời tải dữ liệu môn thể thao và lắng nghe sự kiện cập nhật danh mục.
  useEffect(() => {
    // Cờ chống race condition: tránh cập nhật state khi component đã unmount trước lúc API trả kết quả về.
    let cancelled = false;

    // Bước 1: Định nghĩa hàm load để gọi API /v1/sports lấy danh mục môn thể thao từ server.
    function load() {
      fetch("/v1/sports")
        .then((res) => {
          if (!res.ok) return null;
          return res.json() as Promise<{ items?: SportInfo[] }>;
        })
        .then((data) => {
          // Bước 1.1: Khi API trả về mảng hợp lệ, tiến hành bản địa hóa, ghi đệm cache, đăng ký nhãn dùng chung và cập nhật state.
          if (data && Array.isArray(data.items) && data.items.length > 0) {
            const enriched = enrichSports(data.items);
            cachedSports = enriched;
            registerSportNames(enriched);
            if (!cancelled) setSports(toResult(enriched));
          }
        })
        .catch(() => {});
    }

    // Bước 2: Nếu chưa có dữ liệu trong cache thì gọi API nạp mới; nếu đã có thì cập nhật state từ cache.
    if (!cachedSports || cachedSports.length === 0) {
      load();
    } else {
      setSports(toResult(cachedSports));
    }

    // Bước 3: Đăng ký hàm xử lý khi nhận được sự kiện arena3:sports-changed để tự động tải lại dữ liệu mới nhất.
    const onSportsChanged = () => {
      load();
    };

    // Lắng nghe sự kiện thay đổi danh mục môn thể thao phát ra từ invalidateSportsCache().
    window.addEventListener("arena3:sports-changed", onSportsChanged);
    // Bước 4: Dọn dẹp (cleanup) khi unmount: bật cờ cancelled và hủy lắng nghe sự kiện trên window để tránh rò rỉ bộ nhớ.
    return () => {
      cancelled = true;
      window.removeEventListener("arena3:sports-changed", onSportsChanged);
    };
  }, []);

  return sports;
}

/**
 * Làm gì: Hiển thị chấm tròn màu đại diện cho môn thể thao bằng biến CSS định trước, thường dùng trên lịch, danh sách sân và báo cáo.
 * Được gọi ở: src/client/components/sports-ui.tsx:SportBadge, src/client/components/report-panels.tsx, src/routes/manager.sports.tsx.
 * @param props Thuộc tính component:
 *   - sport: Mã môn thể thao (ví dụ: 'badminton', 'tennis', 'pickleball').
 *   - colorKey: Khóa màu tùy chọn nếu muốn dùng màu khác với mã môn.
 *   - className: Lớp CSS tùy biến kích thước hoặc khoảng cách.
 * @returns Thẻ span hình tròn mang màu sắc đại diện cho môn thể thao, có aria-hidden="true" để ẩn khỏi trình đọc màn hình.
 * @throws Không có.
 */
export function SportDot({
  sport,
  colorKey,
  className,
}: {
  sport?: string | null;
  colorKey?: string | null;
  className?: string;
}) {
  // Chuẩn hóa mã môn về chữ thường và xác định khóa màu (ưu tiên colorKey nếu có, ngược lại dùng chính code).
  const code = (sport || "").toLowerCase();
  const color = colorKey || code;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 rounded-full shrink-0", className)}
      style={{
        backgroundColor: color ? `var(--color-sport-${color}, var(--color-accent))` : "var(--color-accent)",
      }}
    />
  );
}

/**
 * Làm gì: Hiển thị huy hiệu dạng viên thuốc (badge pill) gồm chấm tròn màu (SportDot) và tên tiếng Việt/Anh của môn thể thao.
 * Được gọi ở: Các trang quản lý và nhân viên: src/routes/app.classes.tsx, src/routes/coach.index.tsx, src/routes/desk.index.tsx, src/routes/manager.classes.tsx, src/routes/manager.courts.tsx, src/routes/manager.prices.tsx, src/routes/manager.promos.tsx, src/routes/manager.staff.tsx.
 * @param props Thuộc tính component:
 *   - sport: Mã định danh môn thể thao (ví dụ: 'badminton', 'football').
 *   - colorKey: Khóa màu tùy chọn truyền vào cho SportDot.
 *   - className: Lớp CSS tùy biến kiểu dáng, màu nền hoặc phông chữ.
 *   - showDot: Cờ bật/tắt hiển thị chấm màu SportDot (mặc định là true).
 * @returns Thẻ span chứa chấm tròn màu và nhãn tên môn thể thao.
 * @throws Không có.
 */
export function SportBadge({
  sport,
  colorKey,
  className,
  showDot = true,
}: {
  sport?: string | null;
  colorKey?: string | null;
  className?: string;
  showDot?: boolean;
}) {
  // Chuẩn hóa mã code và tra cứu tên hiển thị qua sportLabel(); nếu chưa có nhãn thì fallback về mã code.
  const code = (sport || "").toLowerCase();
  const label = sportLabel(code) || code;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-line bg-surface/80 px-2 py-0.5 text-2xs font-medium text-fg shadow-[var(--shadow-border)]",
        className,
      )}
    >
      {showDot ? <SportDot sport={code} colorKey={colorKey} /> : null}
      <span>{label}</span>
    </span>
  );
}

/**
 * Làm gì: Hiển thị ảnh đại diện cho môn thể thao; tự động chuyển sang hiển thị ô màu kèm 2 chữ cái viết tắt đại diện nếu ảnh bị thiếu hoặc lỗi tải.
 * Được gọi ở: src/routes/manager.sports.tsx: màn hình danh sách và form chỉnh sửa môn thể thao.
 * @param props Thuộc tính component:
 *   - sport: Mã môn thể thao (ví dụ: 'badminton', 'tennis').
 *   - colorKey: Khóa màu tùy chỉnh để hiển thị màu nền dự phòng.
 *   - className: Lớp CSS tùy biến kích thước và bo góc khung thumbnail.
 *   - alt: Văn bản thay thế cho thẻ ảnh img hỗ trợ tiếp cận (mặc định là tên môn thể thao).
 * @returns Khung ảnh thumbnail hoặc ô màu kèm 2 chữ cái viết tắt đại diện cho môn thể thao.
 * @throws Không có.
 */
export function SportThumbnail({
  sport,
  colorKey,
  className,
  alt,
}: {
  sport?: string | null;
  colorKey?: string | null;
  className?: string;
  alt?: string;
}) {
  // Lấy thông tin URL ảnh từ hook useSportPhoto và tra cứu nhãn tên hiển thị của môn thể thao.
  const code = (sport || "").toLowerCase();
  const color = colorKey || code;
  const asset = useSportPhoto(code);
  const label = sportLabel(code) || code;
  // A file that is missing shows the sport's colour and letters, not a broken picture.
  // Lưu URL ảnh bị tải lỗi để kích hoạt giao diện fallback thay vì hiển thị biểu tượng ảnh vỡ.
  const [broken, setBroken] = useState<string | null>(null);

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-line bg-wood/50",
        className,
      )}
    >
      {asset.enabled && asset.url && broken !== asset.url ? (
        <img
          src={asset.url}
          onError={() => setBroken(asset.url)}
          alt={alt || label}
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center font-bold text-2xs uppercase text-white"
          style={{
            backgroundColor: color ? `var(--color-sport-${color}, var(--color-accent))` : "var(--color-accent)",
          }}
        >
          {code.slice(0, 2)}
        </div>
      )}
    </div>
  );
}
