# Arena3: quy tắc giao diện sau đợt redesign (10/2026)

Tài liệu này ghi lại các quyết định thiết kế của đợt redesign, để mọi màn mới làm theo cùng một chuẩn. Đợt này không đụng dữ liệu: không sửa seed, migration hay API.

## Định hướng

- **Landing (public):** trung tâm thể thao trong nhà cho người chơi ở TP.HCM. Ngôn ngữ thiết kế thể thao, gọn, đáng tin. Chuyển động nhẹ, chỉ dùng cho lúc vào trang và khi cuộn tới từng phần.
- **App nội bộ (hội viên, lễ tân, HLV, quản lý):** công cụ làm việc. Không có hiệu ứng trang trí. Chuyển động chỉ để báo trạng thái thay đổi: đồng hồ giữ chỗ, chấm "đang diễn ra", mở/đóng panel.
- **Ngôn ngữ mặc định là tiếng Việt.** Server render tiếng Việt, tiếng Anh là lựa chọn phụ.

## Tokens (`src/styles.css`)

| Token | Dùng cho |
| --- | --- |
| `accent` `#3f7d20` | Màu nhấn duy nhất: nút chính, ô sân trống, liên kết (xanh mạ đậm) |
| `accent-2` `#2f6118` | Chữ màu nhấn trên nền nhạt (tab đang chọn). Tự đổi sáng ở dark mode |
| `accent-hover`, `accent-strong` | Hover của nút chính; sân đang có người chơi |
| `earth` `#7a4a24` | Nâu đất: điểm nhấn phụ (huy hiệu, viền thẻ thành tích, trạng thái điểm xuyết) |
| `pass` `#4a2f17` | Nâu đậm: thẻ hội viên |
| `hold`, `danger` | Cảnh báo, giữ chỗ / lỗi, huỷ. Chỉ dùng theo nghĩa, không để trang trí |
| `wood` `#efe5d4` | Nền phụ trung tính: hàng hover, chip, track (nâu gỗ nhạt) |
| `slot-class` `#6b4423` | Ô "Lớp" trên lưới sân (nâu) |
| `volt` `#b5e04a` | Xanh mạ sáng (điểm nhấn phát sáng) |

Dark mode tự theo cài đặt của thiết bị (`prefers-color-scheme`). **Không hard-code màu** (`bg-white`, `#hex`, `rgba(...)`) trong component. Thêm token mới vào cả khối sáng lẫn khối tối.

## Bo góc

Ô nhập và nút nhỏ 8px · nút 10px · panel 12px · thẻ 14px · chip, badge: bo tròn hẳn (pill). Không dùng giá trị nào khác.

## Chuyển động

- `fx.tsx` chỉ còn các bản tĩnh để code cũ vẫn chạy. **Code mới không dùng nữa:** SpotlightCard, GlareHover, Magnet, ShinyText, SplitText, StarBorder, GLBackground, ClickSpark.
- `Reveal` / `Stagger` hiển thị tĩnh khi nằm trong `Shell` (app nội bộ). Ở landing, chúng chỉ là một lần mờ dần vào, ngắn.
- Mọi animation đều phải tắt được bằng `prefers-reduced-motion`.

## Bố cục

- Đầu trang nội bộ chỉ gồm tiêu đề và một dòng mô tả. Không dùng banner ảnh hay hình minh hoạ trang trí.
- Thanh điều hướng dưới trên điện thoại có tối đa 5 mục. Các trang còn lại để trong "Thêm". Menu "Thêm" của quản lý chia thành 3 nhóm: Kinh doanh, Vận hành, Hệ thống.
- **Lưới sân:**
  - Ô trống là thứ nổi bật nhất: viền xanh và dấu "+".
  - Ô đã đặt dùng nền nhạt.
  - Giờ đã qua mặc định được ẩn.
  - Trên điện thoại có thêm dải "Giờ còn trống" để chọn theo giờ.
- Ảnh dùng `Cover`, mặc định lazy-load. Chỉ ảnh hero dùng `eager`. Không dùng video nền.

## Câu chữ

- Không dùng em-dash (—) hay en-dash (–) trong chữ hiển thị. Thay bằng dấu phẩy, dấu chấm hoặc dấu hai chấm. Khoảng số và giờ dùng "-" (06:00-22:00).
- Không hiện mã nội bộ ra giao diện: tên bảng, UUID, mã tính năng F4/F5/F6.
- Không hiện quyền lợi bằng 0 ("0 giờ sân").
- Chuỗi mới: viết tiếng Anh trong `t()`, thêm bản dịch vào `src/lib/i18n/vi.redesign.ts`, rồi chạy `node scripts/i18n-check.mjs`.

## Việc thuộc về dữ liệu (chưa làm vì đợt này không sửa data)

- Sân `DEMO-01` xuất hiện ở lịch công khai và bảng giá.
- Hội viên demo đã có sẵn 2 lượt đặt mỗi ngày, nên không demo được luồng đặt sân.
- Tên người lúc có dấu lúc không; ghi chú và yêu cầu hỗ trợ viết bằng tiếng Anh; thông báo seed thiếu mã đặt sân.
