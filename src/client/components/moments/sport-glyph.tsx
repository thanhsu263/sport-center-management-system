/**
 * File: src/client/components/moments/sport-glyph.tsx
 * Vai trò: Biểu tượng môn thể thao dạng vector SVG với hiệu ứng biến đổi hình dạng (morph SVG) mượt mà qua GSAP MorphSVGPlugin.
 * Vị trí trong app: Thuộc nhóm micro-interactions (moments) ở client, tạo phản hồi thị giác tức thì khi người dùng thay đổi bộ lọc môn thể thao trước khi hình ảnh nền kịp tải xong.
 */
import { useRef } from "react";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { gsap, motionOff, registerGsap, useGSAP } from "@/client/lib/gsap";
import { useCalm } from "@/client/lib/calm";

// Đăng ký MorphSVGPlugin một lần duy nhất ở client để kích hoạt tính năng biến đổi path SVG (morphSVG) cho GSAP
registerGsap(MorphSVGPlugin);

/*
 * The sport icons from arena-icons.tsx, each folded into one compound path so one shape can
 * morph into another. "all" is a court seen from above.
 */
const GLYPHS: Record<string, string> = {
  badminton:
    "M8.2 15.2 5.6 6.4M10.4 15.8 9.2 4.8M12.2 16.1V4M14 15.8 15.2 4.8M16.2 15.2 18.8 6.4M6.2 9.2c1.8-1.1 3.8-1.6 6-1.6s4.2.5 6 1.6M9.1 16.4c.3 2.2 1.5 3.6 3.1 3.6s2.8-1.4 3.1-3.6c-1 .5-2 .7-3.1.7s-2.1-.2-3.1-.7z",
  basketball:
    "M12 3.75a8.25 8.25 0 1 1 0 16.5a8.25 8.25 0 1 1 0-16.5zM12 3.75v16.5M3.75 12h16.5M6.7 5.4c-2.1 2.4-2.1 10.8 0 13.2M17.3 5.4c2.1 2.4 2.1 10.8 0 13.2",
  volleyball:
    "M12 3.75a8.25 8.25 0 1 1 0 16.5a8.25 8.25 0 1 1 0-16.5zM12 3.75c2.4 2.6 3.5 5.4 3.5 8.25S14.4 17.7 12 20.25M4.3 8.6c2.8 1.5 5.6 1.7 8.2.4M12.2 11.2c2.2-.2 4.6.4 7.1 1.8M6.1 16.8c2-2.2 4.2-3.2 6.6-3",
  all: "M3.25 5.5h17.5v13H3.25zM12 5.5v13M3.25 12h17.5M7.5 9v6M16.5 9v6",
};

/**
 * The sport on show, as a line drawing that turns into the next sport when the filter changes:
 * the shuttle's feathers fold into a basketball's seams, the seams into a volleyball's panels.
 * It says "you are now looking at volleyball" before the photo behind it has finished loading.
 */
/**
 * Làm gì: Hiển thị icon vector SVG của môn thể thao dạng nét vẽ đơn, tự động biến đổi hình dạng (morph) mượt mà sang môn khác khi prop sport thay đổi.
 * Được gọi ở: Component micro-interaction trong nhóm moments (src/client/components/moments/sport-glyph.tsx), sẵn sàng dùng cho các bộ lọc môn thể thao trên client.
 * @param sport Mã định danh môn thể thao ("badminton", "basketball", "volleyball", hoặc "all").
 * @param className Tùy chọn class CSS bổ sung để định kiểu hoặc căn chỉnh kích thước phần tử SVG.
 * @returns Phần tử JSX <svg> chứa đường dẫn path có hiệu ứng morph animation.
 */
export function SportGlyph({ sport, className }: { sport: string; className?: string }) {
  // Bước 1: Xác định dữ liệu đường dẫn SVG (d) tương ứng với môn thể thao, mặc định về sơ đồ toàn sân ("all") nếu không khớp
  const d = GLYPHS[sport] ?? GLYPHS.all;
  const path = useRef<SVGPathElement>(null);
  // Lưu chuỗi path trước đó vào ref để làm mốc bắt đầu (from) khi GSAP thực hiện biến đổi hình dạng
  const prev = useRef(d);
  const calm = useCalm();
  // Bước 2: Thiết lập hiệu ứng morph SVG khi dữ liệu path hoặc tùy chọn giảm chuyển động (calm) thay đổi
  useGSAP(
    () => {
      const from = prev.current;
      prev.current = d;
      // Bỏ qua hoạt ảnh nếu icon không đổi, DOM chưa sẵn sàng, hoặc người dùng bật chế độ giảm chuyển động (motionOff)
      if (from === d || !path.current || motionOff(calm)) return;
      // Biến đổi mượt mà path cũ sang path mới trong 0.75s với đường cong gia tốc "arena" đặc trưng của hệ thống
      gsap.fromTo(path.current, { morphSVG: from }, { morphSVG: d, duration: 0.75, ease: "arena" });
    },
    { dependencies: [d, calm] },
  );
  // Bước 3: Render thẻ SVG; áp dụng màu thương hiệu theo môn qua biến CSS var(--color-sport-*) nếu không phải là "all"
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
      style={sport && sport !== "all" ? { color: `var(--color-sport-${sport})` } : undefined}
    >
      <path ref={path} d={d} />
    </svg>
  );
}
