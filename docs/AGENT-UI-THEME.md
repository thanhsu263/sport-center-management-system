# AGENT-UI-THEME — Đổi theme sang xanh mạ + nâu (phong cách sân cỏ, sân gỗ)

Đọc hết file này trước khi làm. **Chỉ sửa giao diện (màu sắc)**. Làm tuần tự mục 1 → 6. Xong thì báo cáo theo mục 6 rồi DỪNG.

## 0. Bối cảnh

- Theme hiện tại là xanh dương (`--color-accent: #1e4fd8`), nền tối navy khi bật dark mode.
- Nền tối mà người dùng thấy là do **Windows đang để chế độ tối**, nên trang tự chuyển sang dark mode (`@media (prefers-color-scheme: dark)` trong `src/styles.css`). Đây không phải lỗi. Dark mode vẫn giữ, nhưng đổi sang tông xanh rêu đậm + nâu đất thay cho navy.
- Mục tiêu: màu chủ đạo **xanh mạ** (lúa non, cỏ sân), màu phụ **nâu** (sàn gỗ, đất nện, da bóng rổ). Cảm giác tự nhiên, thể thao, không chói.
- Mọi màu đều đã đi qua token trong `src/styles.css`. Việc chính là **thay giá trị token**, rồi dọn các chỗ còn hard-code xanh dương.

## 1. Ràng buộc cứng

- Chỉ được sửa: `src/styles.css`, `src/components/**`, `src/routes/**` (chỉ className/style/màu), `public/` (favicon, manifest `theme_color` nếu có), `src/lib/arena3/pdf.ts` (chỉ màu), `docs/UI-REDESIGN.md` (cập nhật bảng màu).
- **CẤM** sửa: `src/lib/arena3/handlers/**`, `router.ts`, `session.ts`, `helpers.ts`, `tx.ts`, `validate.ts`, `jobs.ts`, `payos.ts`, `migrations/**`, `scripts/tests/**`, `.env*`, `agent/`, `.agents/`, `graft/`, `attachments/`, `eslint.config.mjs`.
- Không đổi câu chữ, bố cục, logic, lời gọi API. Chỉ đổi màu.
- Git: chỉ `status`, `diff`. **KHÔNG** `commit`, `push`, `stash`, `reset`, `checkout`. Không `npm install`.
- Chỉ test trên 127.0.0.1:8090 (safe server + fake clock như các vòng trước). Không Neon, payOS hay SMTP thật. Không build, deploy hay `db:migrate`.
- Tiết kiệm: **không** chạy lại toàn bộ suite 2,946 case (đổi màu không ảnh hưởng nghiệp vụ). Chỉ chạy những gì ở mục 4–5.

## 2. Bảng màu mới (thay vào `src/styles.css`)

### 2a. Light (khối `:root` / `@theme` hiện có, dòng ~21–60)

| Token | Cũ | Mới | Ghi chú |
| --- | --- | --- | --- |
| `--color-bg` | `#f4f6fc` | `#f6f5ee` | trắng ngà ấm |
| `--color-fg` | `#0b1230` | `#1c2616` | xanh rêu gần đen |
| `--color-surface` | `#ffffff` | `#ffffff` | giữ |
| `--color-muted` | `#424c6b` | `#4a5443` | |
| `--color-subtle` | `#56617f` | `#5f6857` | |
| `--color-line` | `#dde3f2` | `#e4e1d3` | |
| `--color-line-strong` | `#bcc6e0` | `#c9c4ae` | |
| `--color-accent` | `#1e4fd8` | `#3f7d20` | **xanh mạ đậm** (đủ tương phản với chữ trắng) |
| `--color-accent-fg` | `#ffffff` | `#ffffff` | giữ |
| `--color-accent-hover` | `#15348f` | `#2f6118` | |
| `--color-accent-strong` | `#15348f` | `#2f6118` | |
| `--color-accent-text` | `#1e4fd8` | `#356b1b` | chữ link/nhấn trên nền sáng |
| `--color-slot-class` | `#0b1230` | `#6b4423` | **nâu**: ô lớp học trên lưới sân |
| `--color-hold` | `#9a5200` | `#b25e09` | cam hổ phách, phải khác nâu slot-class |
| `--color-danger` | `#b4232a` | `#b4232a` | giữ |
| `--color-ink` | `#0b1230` | `#1c2616` | |
| `--color-wood` | `#e8edf9` | `#efe5d4` | **nâu gỗ nhạt**: nền ô/khối phụ |
| `--color-on-media` | `#ffffff` | `#ffffff` | giữ |
| `--color-on-media-muted` | `#dbe5ff` | `#e6eed9` | |
| `--color-pass` | `#0c1b57` | `#4a2f17` | **nâu đậm**: thẻ hội viên |
| `--color-pass-fg` | `#ffffff` | `#fffaf0` | |
| `--color-pass-muted` | `#c3d0f5` | `#e3d2b8` | |
| `--color-volt` | `#c8f31d` | `#b5e04a` | xanh mạ sáng (điểm nhấn) |
| `--color-night` | `#0b1230` | `#141d0f` | |

Thêm 2 token mới (đặt ngay dưới `--color-wood`), dùng cho chỗ cần nâu đậm làm điểm nhấn phụ (huy hiệu, viền thẻ thành tích, icon phụ):

```
--color-earth: #7a4a24;
--color-earth-fg: #ffffff;
```

Shadow: thay mọi `rgba(11, 18, 48, …)` thành `rgba(28, 38, 22, …)` (giữ nguyên độ alpha).

### 2b. Dark (khối `@media (prefers-color-scheme: dark)`, dòng ~106–131)

| Token | Mới |
| --- | --- |
| `--color-bg` | `#10150d` |
| `--color-fg` | `#e9eee0` |
| `--color-surface` | `#182114` |
| `--color-muted` | `#b2bba5` |
| `--color-subtle` | `#97a28b` |
| `--color-line` | `#27331f` |
| `--color-line-strong` | `#3b4a32` |
| `--color-accent` | `#8bc34a` |
| `--color-accent-fg` | `#10180a` (chữ tối trên nút xanh mạ sáng) |
| `--color-accent-hover` | `#9ccf5c` |
| `--color-accent-strong` | `#6fa335` |
| `--color-accent-text` | `#a5d46a` |
| `--color-hold` | `#f0a24a` |
| `--color-danger` | `#f47b74` |
| `--color-ink` | `#e9eee0` |
| `--color-wood` | `#231d14` |
| `--color-earth` | `#c08a5a` |
| `--color-earth-fg` | `#10150d` |
| `--color-pass` | `#3d2815` |
| `--color-slot-class` | `#a07850` |

Shadow trong dark: giữ như cũ, chỉ đổi `rgba(166, 180, 214, 0.12)` thành `rgba(180, 200, 160, 0.12)`.

**Lưu ý nút chính trong dark mode:** `--color-accent-fg` chuyển sang chữ tối. Kiểm tra mọi nút/badge dùng `text-white` cứng trên nền accent: đổi sang `text-accent-fg` (hoặc class token tương đương đang có trong repo).

## 3. Dọn màu xanh dương còn hard-code

Chạy và xử lý từng kết quả trong `src/` (bỏ qua `routeTree.gen.ts`):

```
grep -rniE "#1e4fd8|#15348f|#3a6af2|#7b9bff|#2f5ee0|#2448b8|#0b1230|#0c1b57|#132257|#0a0f1d|#111829|dbe5ff|c3d0f5|rgba\(11, ?18, ?48" src public
grep -rnE "\b(bg|text|border|ring|from|to|via|fill|stroke)-(blue|indigo|sky|navy)-[0-9]+" src
```

- Mỗi chỗ → thay bằng token tương ứng (`var(--color-accent)`, `bg-accent`, `text-accent-text`, `bg-wood`, `bg-earth`…). Không thêm hex mới ngoài `src/styles.css`.
- Landing (`src/components/landing/**`, `src/routes/index.tsx`): gradient/ảnh phủ màu xanh dương → đổi sang xanh mạ hoặc nâu theo token. Phần hero nên dùng tông `--color-night` + điểm nhấn `--color-volt`.
- Logo/favicon trong `public/` nếu có nền xanh dương: đổi nền sang `#3f7d20`. Nếu là ảnh PNG không sửa được thì ghi vào báo cáo, đừng tự vẽ lại.
- `<meta name="theme-color">` (tìm trong `src/routes/__root.tsx`) và `manifest` (nếu có): đổi thành `#3f7d20`.
- `src/lib/arena3/pdf.ts`: chỉ thay mã màu xanh dương sang `#3f7d20` / nâu `#7a4a24`. Không đụng số tiền hay dữ liệu.

Chỗ nào **không chắc** là màu thương hiệu hay màu trạng thái (ví dụ màu VietQR, màu payOS, màu biểu đồ có ý nghĩa riêng) → để nguyên, ghi vào báo cáo.

## 4. Sửa kèm một lỗi nhỏ (C9 «Ngay lúc này»)

Trên màn quầy lễ tân (S17), mỗi dòng của khối «Ngay lúc này» hiện «18:00 · Sân», thiếu tên sân/người đặt. Tìm component của khối này (trong `src/routes/desk.index.tsx` hoặc `src/components/`). Nếu dữ liệu API **đã có** field tên sân/tên khách mà giao diện chưa hiển thị → hiển thị ra. Nếu API không có field đó → **không sửa backend**, chỉ ghi vào báo cáo.

## 5. Kiểm tra

1. `npx --no-install tsc --noEmit`, `npx --no-install eslint .`, `node scripts/i18n-check.mjs`, `npm test`: tất cả PASS.
2. `node scripts/tests/agent/regression.mjs`: vẫn 27/27 FIXED.
3. Kiểm tra tương phản (WCAG AA ≥ 4.5:1 cho chữ thường, ≥ 3:1 cho chữ lớn/nút): tính cho các cặp `fg/bg`, `muted/bg`, `accent-fg/accent`, `accent-text/surface`, `pass-fg/pass` ở **cả light và dark**. Ghi bảng tỉ lệ vào báo cáo. Cặp nào dưới ngưỡng → chỉnh **độ sáng** của màu đó (giữ cùng tông xanh mạ/nâu), ghi giá trị đã đổi.
4. Chụp màn hình trên safe server, lưu vào `test-output/ui-theme/`, mỗi màn chụp **light và dark**, desktop 1440px:
   - S01 trang chủ, S02 đăng nhập, S07 đặt sân (lưới sân: ô trống, đang giữ, đã đặt, lớp học phải phân biệt rõ), S17 quầy lễ tân, S20 thanh toán, thẻ hội viên (trang pass).
   - Thêm S07 bản điện thoại 390px (light).
5. Với mỗi màn: không lỗi console, không còn mảng xanh dương nào sót.

## 6. Báo cáo (ngắn) rồi DỪNG

- Danh sách file đã sửa (`git diff --stat`).
- `git diff --stat` của nhóm file cấm ở mục 1 (phải rỗng).
- Kết quả mục 5.1 và 5.2.
- Bảng tương phản (mục 5.3) và màu nào đã phải chỉnh.
- Những chỗ để nguyên có chủ ý (mục 3) và kết quả mục 4.
- Danh sách ảnh trong `test-output/ui-theme/`.
- Không commit. DỪNG.
