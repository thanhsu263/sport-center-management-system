# AGENT-MANAGER-ADMIN-FIX: sửa các lỗi reviewer tìm thấy

Áp dụng cho phần việc chưa commit của `docs/AGENT-MANAGER-ADMIN.md`. Mọi ràng buộc cứng trong doc đó vẫn còn nguyên: chỉ test 127.0.0.1:8090; không đọc `.env*`; không migrate, deploy, build, db:push hay seed; không commit, push, stash, reset hay checkout; không sửa migration cũ (0001–0032). Một lỗi 500 luôn là bug. Không được sửa giá trị expected chỉ để test PASS.

## F1. `demo_fill_calendar()` trong 0033 (NGHIÊM TRỌNG, sửa trước)

`migrations/0033_manager_media_courts.sql` đang `CREATE OR REPLACE FUNCTION demo_fill_calendar()` với một thân hàm viết lại, lệch hẳn khỏi `migrations/0028_demo_fill.sql`:
- dùng các cột không có trong schema: total_vnd, deposit_vnd, updated_at, recorded_by;
- dùng payment status 'completed';
- insert thẳng vào occupancies thay vì gọi `occupancy_attach(...)`;
- chỉ bắt `exclusion_violation`.

Migration này sẽ chạy trên Neon dùng chung khi Vercel build từ main.

Cách sửa:
1. Thay toàn bộ thân hàm trong 0033 bằng bản sao **nguyên văn** thân hàm trong 0028: cùng chữ ký, cùng cột, cùng `occupancy_attach`, cùng mã 'PAY-', cùng `created_by`, cùng status 'posted', cùng enum pay_method, cùng `EXCEPTION WHEN OTHERS`, cùng giá.
2. Chỉ đổi đúng một chỗ: vòng lặp courts thêm `AND retired_at IS NULL`, tức là `WHERE status = 'ready' AND retired_at IS NULL`.
3. KHÔNG chép các câu lệnh đứng sau hàm trong 0028 (INSERT feature_flags, SELECT demo_fill_calendar()).
4. Chứng minh bằng:
   - `git diff --no-index` (hoặc `diff`) giữa phần thân hàm 0028 và 0033: chỉ được khác đúng dòng điều kiện courts;
   - khởi động lại safe server từ DB sạch (PGlite) và gọi hàm một lần nếu cờ DEMO_FILL bật; không được có lỗi.

## F2. Churn CRLF

`git diff --stat` báo khoảng 15k dòng, còn `git diff --ignore-cr-at-eol --stat` chỉ khoảng +1543/−355. Nghĩa là nhiều file bị đổi LF→CRLF.

Cách sửa:
- Mọi file đã sửa hoặc tạo mới phải dùng LF (giống repo). Dùng một script node nhỏ đổi `\r\n` → `\n` cho đúng các file trong `git diff --name-only` và các file mới của task này. Không dùng git checkout.
- Xong khi `git diff --stat` và `git diff --ignore-cr-at-eol --stat` cho cùng con số.

## F3. Thay đổi lạc đề trong desk.ts

`src/lib/arena3/handlers/desk.ts` có hai sửa đổi không thuộc task:
- `paymentsPending` thêm `capped: false`;
- `invoicesMine` tự clamp `limit > 100` trước khi gọi `pageParams`.

Hoàn tác cả hai về đúng bản HEAD, trừ khi chứng minh được có test nào trong `scripts/tests` đòi hỏi chúng. Nếu có, ghi tên test và lý do vào báo cáo.

## F4. Lọc sân đã retire

- `src/lib/arena3/handlers/desk.ts` ~1049 (bản đồ utilization theo ngày cho manager): loại sân đã retire, trừ khi sân đó có occupancy trong ngày. Thêm `where c.retired_at is null or o.id is not null` hoặc tương đương; giữ đúng logic `group by`.
- `src/lib/arena3/catalog.ts:76` và `reports.ts` capacity đã lọc rồi, không động vào.
- Báo cáo doanh thu và lịch sử vẫn phải giữ sân đã retire.
- Thêm 1 case vào `scripts/tests/agent/manager-admin.mjs`: retire một sân không có booking tương lai → sân đó không còn trong bản đồ desk court, catalog hay booking; restore → sân hiện lại.

## F5. Slot `brand.logo`

0033 seed `brand.logo` bằng `hall-courts.jpg` (một ảnh chụp, không phải logo).

Cách sửa: bỏ slot này khỏi seed và khỏi registry nếu UI không đọc nó. Nếu UI có đọc, để `enabled = false` và để UI dùng logo SVG hiện tại khi slot bị tắt. Không được dùng ảnh chụp làm logo.

## F6. PATCH courts khi đổi môn

Kiểm tra `PATCH /v1/manager/courts/:id`: khi đổi `sport` mà sân còn booking tương lai (`hold`, `confirmed`, `paid`), phải trả 409 với thông báo rõ ràng, không phải 200 hay 500. Nếu chưa có thì thêm, kèm 1 test.

## F7. Báo cáo phải đúng sự thật

Báo cáo trước liệt kê file và slot không tồn tại ("13 slots", "idx_courts_active"…). Lần này:
- Bảng slot phải sinh ra từ file 0033 thật (slot, default_path) và kiểm tra từng `default_path` có tồn tại trong `public/`.
- Chỉ nêu index nào thật sự có trong file.

## Cổng kiểm tra cuối (giữ nguyên Phase 5)

`npx --no-install tsc --noEmit`, eslint các file đã sửa, i18n-check, `npm test`, full agent suite (so sánh với baseline G-ADMIN: không có PASS→FAIL), regression 27/27, `manager-admin.mjs` all PASS, `grep -rn '"/media/' src` không còn hardcode, screenshot ở `test-output/manager-admin/`.

## Báo cáo

Mỗi mục F1–F7 ghi: đã làm gì, file:dòng, bằng chứng (lệnh và kết quả rút gọn). Kèm số liệu `git diff --ignore-cr-at-eol --stat` cuối cùng. KHÔNG commit, KHÔNG push.
