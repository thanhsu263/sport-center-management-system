# AGENT-UI-MERGE — Đưa bản redesign giao diện (nhánh `arena3-ui-ux`) vào `working`

Đọc hết file này trước khi làm. Chỉ sửa FRONTEND. Làm tuần tự từ mục 1 đến mục 6, xong thì báo cáo theo mục 6 rồi DỪNG.

## 0. Bối cảnh

- File `Arena3-Screen-Dictionary.pdf` (45 màn, thay đổi C1–C11) chụp nhánh `origin/arena3-ui-ux` (commit `f6b8332`, 12/10/2026). Quy tắc thiết kế nằm ở `docs/UI-REDESIGN.md` trên nhánh đó.
- Nhánh này **chỉ sửa giao diện**: không động tới handlers, migration hay API. Nó tách ra trước đợt bugfix nên `working` đã khác nhiều.
- Mục tiêu: lấy C1–C10 cùng toàn bộ redesign (token màu, bo góc, font Be Vietnam Pro, lưới sân, menu «Thêm», landing/đăng nhập/đăng ký) vào `working`, giữ nguyên **100%** backend và kết quả kiểm thử hiện có.
- **Không làm C11** («Bản thử: đặt sân theo giờ trước»). Nó đang chờ duyệt và chưa có code.
- **Không đưa lại Vé ngày (day pass).** `working` đã bỏ hẳn tính năng này (migration 0029). Màn S21 trong PDF coi như không còn.

## 1. Ràng buộc cứng

- Chỉ được sửa: `src/routes/**`, `src/components/**`, `src/styles.css`, `src/lib/i18n.tsx`, `src/lib/i18n/**`, `src/lib/gsap.ts`, `src/lib/arena3/labels.ts`, `src/lib/arena3/coaches.ts`, `src/routeTree.gen.ts`, `package.json`, `package-lock.json`, `docs/UI-REDESIGN.md`, `scripts/i18n-check.mjs`, `scripts/screen-dictionary.mjs`.
- Với `src/lib/arena3/pdf.ts`: chỉ nhận thay đổi về trình bày (font, màu, bố cục). Nếu diff đổi số tiền, VAT, số hoá đơn hay dữ liệu → bỏ, ghi vào báo cáo.
- **CẤM** sửa: `src/lib/arena3/handlers/**`, `router.ts`, `session.ts`, `helpers.ts`, `tx.ts`, `validate.ts`, `jobs.ts`, `payos.ts`, `migrations/**`, `scripts/tests/**`, `.env*`. Nếu merge làm thay đổi bất kỳ file nào trong danh sách này → lấy lại bản của `working` cho file đó (`git checkout HEAD -- <file>` được phép **chỉ** cho các file cấm này, trong lúc merge).
- Git chỉ được dùng: `git fetch`, `git merge --no-commit --no-ff origin/arena3-ui-ux`, `git merge --abort` (khi rối quá), `git add`, `git rm` (cho file bị xoá ở mục 2), `git status`, `git diff`. **KHÔNG** `commit`, `push`, `stash`, `reset`. Người dùng sẽ tự commit.
- Được chạy `npm install` **một lần** sau khi merge xong `package-lock.json`, để có `@fontsource/be-vietnam-pro`. Không thêm package nào khác.
- Chỉ test trên 127.0.0.1:8090 (safe server + fake clock như các vòng trước). Không Neon/payOS/SMTP thật, không build/deploy/db:migrate.
- Tiết kiệm: không chụp lại toàn bộ 45 màn. Chụp đúng các màn ở mục 4.

## 2. Merge

```
git fetch origin
git merge --no-commit --no-ff origin/arena3-ui-ux
```

Sẽ có 10 file xung đột. Cách xử lý:

| File | Cách xử lý |
| --- | --- |
| `src/routes/desk.day-passes.tsx` | Giữ đã xoá (`git rm`). |
| `src/components/calm-toggle.tsx` | `working` đã xoá ở commit `2321386`. Giữ đã xoá, trừ khi file nào của nhánh còn import nó. Nếu còn import → bỏ import đó và phần dùng nó, không khôi phục file. |
| `src/components/shell.tsx` | Lấy bố cục và menu của nhánh (nhóm Kinh doanh / Vận hành / Hệ thống, tối đa 5 mục dưới điện thoại). **Bỏ mọi mục `/desk/day-passes`** («Day passes» / «Vé ngày»). Giữ mọi thay đổi chức năng của `working`, ví dụ link trang đã bị xoá phải mất. |
| `src/routes/desk.index.tsx` | Lấy khối «Ngay lúc này» (C9) và bố cục mới. Bỏ lối tắt Vé ngày. Giữ nguyên mọi lời gọi API và logic của `working`. |
| `src/routes/desk.payments.tsx`, `desk.gear.tsx` | Lấy giao diện của nhánh, giữ logic, validate và lời gọi API của `working`. Bỏ mọi tham chiếu `day_pass`. |
| `src/components/class-detail.tsx` | Lấy giao diện của nhánh (C5: «Cần gói …», «dùng 1 trong n buổi»), giữ logic của `working`. |
| `src/routes/index.tsx` | Lấy landing mới của nhánh. |
| `src/lib/i18n/vi.desk.ts`, `vi.srv.ts` | Gộp cả hai: giữ mọi khoá của `working` (nhất là chuỗi lỗi server mới từ đợt bugfix trong `vi.srv.ts`), thêm khoá mới của nhánh. Bỏ khoá liên quan Day pass nếu không còn chỗ dùng. |

Quy tắc chung khi xung đột: **nhánh thắng về giao diện** (className, bố cục, câu chữ hiển thị, icon), **`working` thắng về hành vi** (gọi API, tên field gửi đi, validate, xử lý lỗi, route tồn tại hay không).

Sau khi giải hết xung đột:
- `grep -rn "day-passes\|day_pass\|Day pass\|Vé ngày" src` chỉ được còn ở chỗ đọc dữ liệu cũ (nếu có) như `labels.ts` cho nhãn thanh toán lịch sử. Mọi chỗ khác → bỏ.
- Sinh lại `src/routeTree.gen.ts` theo cách repo đang làm (route `/desk/day-passes` không được xuất hiện).
- `git diff HEAD --stat -- src/lib/arena3/handlers src/lib/arena3/router.ts src/lib/arena3/session.ts src/lib/arena3/helpers.ts src/lib/arena3/tx.ts src/lib/arena3/validate.ts migrations scripts/tests` phải **rỗng**. Dán output vào báo cáo.

## 3. Kiểm tra tĩnh

1. `npm install` (một lần, xem mục 1).
2. `npx --no-install tsc --noEmit`, `npx --no-install eslint .`, `node scripts/i18n-check.mjs`, `npm test`: tất cả PASS.
3. Theo `docs/UI-REDESIGN.md`: `grep` thử trong các file đã merge xem còn hard-code màu (`bg-white`, `#hex`, `rgba(`) hay em-dash (—) trong chuỗi hiển thị không. Chỉ sửa những chỗ do merge sinh ra, không đi dọn cả repo.

## 4. Kiểm tra trên trình duyệt (safe server 127.0.0.1:8090)

Chụp màn hình máy tính (1440px) và điện thoại (390px) cho đúng các màn sau, lưu vào `test-output/ui-merge/`:

- S01 trang chủ, S02 đăng nhập, S03 tạo tài khoản (C6: ngày sinh để trống, ô đồng ý không tick sẵn, có link Điều khoản và Dữ liệu cá nhân), S05 điều khoản.
- S07 đặt sân: lưới sân, ô trống nổi bật, dải «Giờ còn trống» trên điện thoại (C8), thẻ «Đang giữ sân cho bạn» có vòng đếm ngược (C10), ngày đủ lượt ghi «Bạn đã đủ n lượt» (C4), mã VietQR khi chọn chuyển khoản (C2).
- S08 lớp học (C5), S17 quầy lễ tân có khối «Ngay lúc này» (C9), S19 sơ đồ sân, S20 thanh toán với phân trang 10/25/50/100 (C1), S45 cài đặt trung tâm (C7: đổi giờ mở cửa thì lưới đổi theo).
- Menu «Thêm» của quản lý (3 nhóm) và của lễ tân: **không có mục Vé ngày**.
- Bật dark mode (prefers-color-scheme) cho S07 và S17: chữ đọc được, không có ô trắng chói.

Với mỗi màn: không có lỗi console, không có request 4xx/5xx bất thường, không có chuỗi tiếng Anh lọt ra ở chế độ VI.

## 5. Chạy lại bộ kiểm thử (không được tụt)

1. Chạy sạch toàn bộ suite dưới fake clock như Vòng 9.
2. `node scripts/tests/agent/status-transitions.mjs test-output/bugfix/G-9/results test-output/results`. Kỳ vọng vẫn **2,940 PASS / 0 FAIL / 0 WARN / 6 BLOCKED**, không có PASS→FAIL/WARN.
3. `regression.mjs`: 27/27 FIXED.
4. Nếu có case UI/E2E tụt chỉ vì selector hoặc câu chữ đổi theo redesign: được sửa **selector trong test UI** (không phải expected nghiệp vụ). Ghi từng chỗ vào `test-output/bugfix/FIXTURE-DIFF.md` mục «UI merge». Đây là ngoại lệ duy nhất cho `scripts/tests/**`, và chỉ cho selector/text locator.
5. Lưu kết quả sang `test-output/bugfix/G-UI/results/`.

## 6. Báo cáo (ngắn) rồi DỪNG

- Bảng 10 file xung đột: đã chọn gì, bỏ gì.
- Output `git diff HEAD --stat` của nhóm file cấm (phải rỗng).
- Output nguyên văn `status-transitions` và `regression`.
- Danh sách ảnh trong `test-output/ui-merge/` và các lỗi giao diện còn thấy (nếu có), mỗi lỗi một dòng kèm màn S-xx.
- Những gì của nhánh đã cố ý không lấy (Vé ngày, calm-toggle, phần pdf.ts nếu có…).
- Không commit. DỪNG.
