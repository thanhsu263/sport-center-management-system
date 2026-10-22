# AGENT-UI-ROUND2 — Lấy phần UI còn thiếu từ `arena3-ui-ux` + tinh chỉnh theme xanh mạ + nâu

Đọc hết file này trước khi làm. Làm tuần tự **Phần A → Phần B → Phần C**. Xong thì báo cáo theo mục D rồi DỪNG.

## 0. Bối cảnh

- Lần merge trước (`24ca809`) chỉ lấy nhánh `arena3-ui-ux` tới commit `f6b8332` (12/10). Sau đó nhánh có thêm **14 commit**, tới `7955c01`. Trong đó có:
  - `e358519` «Inner pages: restored UI…»: **khôi phục ảnh banner, ảnh đầu thẻ, hình minh hoạ góc trang (`illustrations.tsx`, `Spot`, `PhotoBanner`, `Cover`)** cho Lớp học, Gói tập, Tiến độ, Cổng, Lịch dạy, Báo cáo… Bản đánh giá chê «trang trống trải» chính vì thiếu commit này.
  - `d252e89`, `5bebd5b`: phân trang 10/25/50/100 phía server (C1).
  - `61105e2`: VietQR (C2) (`bank.ts`, `vietqr.ts`).
  - `0d7c587`, `63cad67`: giới hạn lượt/ngày và giờ theo gói (C3, C4).
  - `902aa73`: lớp học (C5).
  - `bed849c`: điều khoản và dữ liệu cá nhân khi đăng ký (C6) (`legal.ts`).
  - `ac6f681`: giờ mở cửa và thời gian giữ chỗ lấy từ Cài đặt (C7) (`venue.ts`).
  - `97eedf1`, `dd80539`, `2320d8e`, `48dc0a6`, `7955c01`: sửa nhỏ, lint, tài liệu.
- Những commit này **có sửa backend** (handlers, router, validate, helpers). Lần này được phép nhận phần backend đó, với điều kiện **mọi bản sửa lỗi của đợt QA (27 finding) phải còn nguyên** và bộ test không được tụt.
- Theme hiện tại là **xanh mạ + nâu** (`docs/AGENT-UI-THEME.md`). Nhánh vẫn dùng xanh dương, nên mọi màu đến từ nhánh phải được đổi về token của theme mới.

## 1. Ràng buộc cứng

- Git chỉ được dùng: `git fetch`, `git merge --no-commit --no-ff origin/arena3-ui-ux`, `git merge --abort`, `git add`, `git rm`, `git status`, `git diff`, `git show <commit>:<file>` (để xem), `git checkout --ours|--theirs -- <file>` (chỉ trong lúc giải xung đột). **KHÔNG** `commit`, `push`, `stash`, `reset`.
- **CẤM** sửa/xoá: `migrations/**` (nhánh không có migration mới; nếu thấy có → dừng, báo cáo), `.env`, `.env.local`, `agent/`, `.agents/`, `graft/`, `attachments/`, `eslint.config.mjs` (giữ nguyên bản của `working`). `.env.example`: được nhận bản của nhánh (chỉ thêm tên biến `BANK_*`, không có giá trị bí mật).
- Không đọc, in hay copy `.env`, `.env.local`. Chỉ test trên **127.0.0.1:8090** (safe server + fake clock). Không Neon, payOS hay SMTP thật. Không build, deploy, `db:migrate`, `db:push`, `db:seed`.
- Không `npm install`. Nếu `package.json` của nhánh thêm package mới thì chạy `npm install` **đúng một lần**, rồi ghi tên package vào báo cáo.
- Không đổi expected value trong test chỉ để có PASS. Lỗi 500 luôn là bug.

## Phần A — Merge phần còn lại của nhánh

```
git fetch origin
git merge --no-commit --no-ff origin/arena3-ui-ux
```

### A1. Quy tắc giải xung đột

| Nhóm file | Cách xử lý |
| --- | --- |
| `src/lib/arena3/handlers/**`, `router.ts`, `helpers.ts`, `validate.ts`, `tx.ts`, `jobs.ts` | **`working` thắng về các bản sửa lỗi**, nhánh được thêm tính năng mới (phân trang, VietQR, giới hạn lượt, giờ theo gói, giờ mở cửa). Gộp tay từng hunk. Bắt buộc còn nguyên: `ops.ts` AT-12 (từ chối điểm danh khi buổi chưa bắt đầu, `Date.now()`); `desk.ts` paymentsCreate `expected = sub.sub_price_vnd ?? sub.price_vnd` và `coalesce(s.price_vnd, p.price_vnd)`; `online.ts` `basePrice = sub.price_vnd ?? plan?.price_vnd ?? 0`; `plans.ts` ghi `price_vnd`; `auth.ts` thu hồi phiên bằng `revoked_at is null`; `extras.ts` `csvCell`; idempotency (`user_id, key`) và `next_member_code`. |
| Mọi thứ liên quan **day pass** (route, handler, phân trang day passes trong `5bebd5b`, nhãn menu) | **Bỏ**. `working` đã xoá tính năng này (migration 0029). |
| Phân trang server (C1) | Response phải **tương thích ngược**: giữ các field cũ mà test và client đang đọc, chỉ thêm field mới (`total`, `page`, `page_size`…). Nếu nhánh đổi hẳn shape (ví dụ trả object thay mảng) → bọc lại cho tương thích, hoặc ghi vào báo cáo nếu không làm được. |
| `src/styles.css` | **Giữ toàn bộ giá trị màu và token của `working`** (xanh mạ + nâu, light + dark, `--color-earth*`). Chỉ nhận thêm phần CSS mới không phải màu của nhánh (class mới, keyframe, layout). |
| `src/routes/**`, `src/components/**` | **Nhánh thắng về giao diện** (ảnh, Spot, PhotoBanner, Cover, GSAP, bố cục). **`working` thắng về hành vi** (tên field gửi đi, validate, xử lý lỗi). Giữ thay đổi của `desk.index.tsx` khối «Ngay lúc này» (hiện «Sân CL-xx · giờ · môn»). |
| `src/lib/i18n/**` | Gộp cả hai bên, không mất khoá nào. Bỏ khoá day pass nếu không còn chỗ dùng. |
| `scripts/screen-dictionary.mjs`, `docs/Arena3-Screen-Dictionary.pdf`, `docs/screen-dictionary/**` | Lấy bản của `working` (`git checkout --ours`). Sẽ sinh lại ở Phần C. |
| `CLAUDE.md`, `AGENTS.md`, `.claude/**`, `eslint.config.mjs` | Lấy bản của `working`. |
| `scripts/tests/**` | Lấy bản của `working`. Chỉ thêm test mới của nhánh nếu không trùng tên file. |
| `src/routeTree.gen.ts` | Sinh lại theo cách repo đang làm (không được có `/desk/day-passes`). |

### A2. Đổi màu phần mới về theme xanh mạ + nâu

Sau khi giải xong xung đột, chạy lại hai lệnh grep ở **mục 3 của `docs/AGENT-UI-THEME.md`**. Đổi mọi màu xanh dương mà nhánh vừa mang vào sang token. `illustrations.tsx` phần lớn đã dùng token. Riêng mã `#f5a30a` (vàng) đổi thành `var(--color-hold)` hoặc `var(--color-earth)`, tuỳ chỗ nào hợp.

### A3. Kiểm tra sau merge

1. `grep -rn "day-passes\|day_pass\|Vé ngày" src`: chỉ còn nhãn lịch sử trong `labels.ts` và `vi.ops.ts`.
2. Kiểm tra tĩnh: `npx --no-install tsc --noEmit`, `npx --no-install eslint .`, `node scripts/i18n-check.mjs`, `npm test`. Tất cả phải PASS.
3. Chạy sạch **toàn bộ suite** dưới fake clock như Vòng 9, rồi `node scripts/tests/agent/status-transitions.mjs test-output/bugfix/G-UI/results test-output/results`. Kỳ vọng vẫn **2,940 PASS / 0 FAIL / 0 WARN / 6 BLOCKED**, không có PASS→FAIL/WARN.
4. `node scripts/tests/agent/regression.mjs`: **27/27 FIXED**.
5. Có case tụt → sửa **code** cho đúng (không sửa expected). Riêng case UI tụt chỉ vì selector hoặc câu chữ đổi → được sửa selector, ghi vào `test-output/bugfix/FIXTURE-DIFF.md` mục «UI round 2».
6. Lưu kết quả sang `test-output/bugfix/G-UI2/results/`.

**Chưa PASS hết mục A3 thì không làm Phần B.**

## Phần B — Tinh chỉnh theme (chọn lọc từ bản đánh giá)

Chỉ làm các mục dưới đây. Mọi màu phải đặt thành token trong `src/styles.css` (light + dark). Không viết hex rải rác trong component.

### B1. Độ sâu giữa nền và thẻ

- Light: `--color-bg: #f4f2ea`, `--color-surface: #ffffff`, `--color-line: #e2dec9`.
- `--shadow-soft` (light): `0 2px 8px -2px rgba(45, 55, 30, 0.06), 0 8px 24px -4px rgba(61, 40, 21, 0.05)`.
- Đảm bảo component thẻ chung (Card/surface trong `src/components/ui/index.tsx`) có viền `1px var(--color-line)` + `--shadow-soft`. Dark: giữ như hiện tại, chỉ kiểm tra thẻ vẫn tách khỏi nền.

### B2. Đưa sắc nâu lên tiền cảnh

- Thẻ hội viên và khối «Gói đang dùng / Chưa có gói» (trang chủ hội viên, trang pass): nền `var(--color-pass)` (nâu đậm) ở **cả chế độ sáng**, chữ `--color-pass-fg`, nhãn gói dùng `--color-volt`.
- Thêm token `--color-espresso: #2c1d11` (dark: `#e9dcc8`) cùng `--color-espresso-fg: #fffaf0` (dark: `#1a120a`). Nút phụ tối màu hiện đang nền đen/`ink` (ví dụ «Sơ đồ sân» ở quầy lễ tân, «Quay lại quầy» ở thanh toán) đổi sang `bg-espresso text-espresso-fg`.

### B3. Nút bị khoá (disabled) không được trông như lỗi

- Hiện nút disabled đang là xanh nhạt chữ trắng (khó đọc). Đổi style disabled chung của Button: nền `--color-disabled: #e6e2d3` (dark: `#2a3324`), chữ `--color-disabled-fg: #7a7463` (dark: `#8f9a84`), không opacity. Áp dụng một chỗ trong component Button, không sửa từng màn.
- Không thêm gradient, không thêm icon ổ khoá.

### B4. Màu riêng cho 3 môn và biểu đồ

- Token theo môn: `--color-sport-badminton: #3f7d20`, `--color-sport-basketball: #b85d19`, `--color-sport-volleyball: #9e6b1b`. Dark lần lượt: `#8bc34a`, `#d97724`, `#ca8a04`. Dùng cho chip/viền/icon môn ở trang chủ (khối các môn), lưới sân (tên môn dưới mã sân) và filter môn. **Không** đổi màu trạng thái ô sân.
- Báo cáo quản lý (S32), biểu đồ «Theo phương thức thanh toán»: 4 cột dùng 4 token `--color-chart-1..4` = `#1b4d20`, `#559e3e`, `#a66a38`, `#d4a359` (dark: `#6fa335`, `#9ccf5c`, `#c08a5a`, `#e0b877`).
- Heatmap «Khung giờ đông nhất»: 5 mức `--color-heat-0..4` = `#f4f2ea`, `#d9ebc4`, `#9ccf5c`, `#3f7d20`, `#b85d19` (0%, 1–30%, 31–60%, 61–85%, 86–100%). Dark: `#182114`, `#2b3d1f`, `#4f7a2c`, `#8bc34a`, `#d97724`. Thêm chú thích 5 mức nếu chưa có.

### B5. Trạng thái trống dễ thấy hơn

- Component `EmptyState` (`src/components/ui/index.tsx`): icon/hình đang gần như tàng hình trên nền kem. Đổi màu icon sang `--color-accent-text`, nền vòng tròn sau icon `--color-wood`. Không vẽ minh hoạ mới.

### B6. Hero trang chủ (S01)

- Lớp phủ ảnh hero: đổi thành gradient trái → phải: `linear-gradient(90deg, rgba(16,21,13,0.92) 0%, rgba(16,21,13,0.65) 45%, rgba(16,21,13,0.15) 100%)`. Trên điện thoại (<768px) giữ lớp phủ đều như cũ để chữ dễ đọc.
- Nút chính «Đặt sân» trên hero: nền `--color-volt`, chữ `--color-night`. Không thêm glow.

### Cố ý KHÔNG làm (ghi vào báo cáo là đã bỏ qua)

- Gradient hoặc inset highlight cho nút; glow `box-shadow` phát sáng.
- Banner đặt sân tự đổi ảnh theo môn + MorphSVG.
- Vẽ hoặc tạo bộ minh hoạ/ảnh mới. Chỉ dùng asset sẵn có trong repo (`public/media`, `illustrations.tsx`).

### B7. Kiểm tra Phần B

1. Kiểm tra tĩnh như A3.2, cộng `regression.mjs` 27/27.
2. Tương phản WCAG AA cho các cặp mới ở cả light và dark: `disabled-fg/disabled`, `espresso-fg/espresso`, `pass-fg/pass`, chữ trên `chart-*` và `heat-4` (nếu có chữ). Lập bảng tỉ lệ. Cặp nào dưới ngưỡng → chỉnh độ sáng, giữ cùng tông.

## Phần C — Sinh lại Screen Dictionary

1. Cập nhật `scripts/screen-dictionary.mjs` nếu Phần A làm thêm route mới (ví dụ trang điều khoản và dữ liệu cá nhân của `bed849c`). Không mang lại màn Vé ngày.
2. Chạy `BASE=http://127.0.0.1:8090 node scripts/screen-dictionary.mjs` → `docs/screen-dictionary/**` + `docs/Arena3-Screen-Dictionary.pdf`.
3. Mở nhanh vài trang: S01, S06, S07, S09, S16, S17, S27, S32. Ảnh banner, ảnh đầu thẻ và hình minh hoạ góc trang đã quay lại, tông xanh mạ + nâu, không còn mảng xanh dương.

## D. Báo cáo (ngắn) rồi DỪNG

- Bảng file xung đột: chọn gì, bỏ gì. Liệt kê riêng các file backend đã gộp tay và xác nhận từng bản sửa lỗi ở A1 còn nguyên (kèm `file:dòng`).
- Package mới (nếu có).
- Output nguyên văn `status-transitions` (A3.3) và `regression` (A3.4, B7.1).
- Bảng tương phản (B7.2).
- Mục nào ở Phần B đã làm hoặc chưa làm, kèm lý do.
- Tổng số màn và ảnh ở Phần C, cùng các lỗi giao diện còn thấy (mỗi lỗi một dòng kèm S-xx).
- Không commit. DỪNG.
