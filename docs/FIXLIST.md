# Arena3 — FIXLIST

Ngày lập: 2026-10-01. Phạm vi: **một trung tâm, một database**. Tài liệu này chỉ liệt kê việc cần sửa; không có thay đổi code hay schema nào đi kèm.

Nguồn: `Arena3-fix-list.md` (danh sách đã ghi nhận), `docs/SRS.md` v1.0, `docs/SDD.md` v1.0 (as-built, 2026-09-20), và đọc trực tiếp `src/routes`, `src/lib/arena3/handlers`, `src/components`.

## Cách đọc

- **Loại**: `BUG` hành vi sai so với màn hình/SRS đã có; `GAP` usecase chưa có; `OPS` vận hành, bảo mật, đúng giờ.
- **Pha**:
  - `P0` hỏng luồng đang có, làm trong đợt sửa UI.
  - `P1` thiếu usecase đã rõ rule, làm sau khi P0 xanh.
  - `P2` UX, không chặn luồng.
  - `CHỜ-PRODUCT` **cần rule tiền hoặc product chốt trước khi code**. Không viết schema, công thức hay màn hình khi chưa có quyết định.
  - `OPS-CUỐI` không làm trong đợt UI, chỉ sau khi P0 xanh.
- **Độ chắc của "Hiện trạng"** (ghi cuối ô):
  - `[code]` đã đối chiếu với code hiện tại và thấy nguyên nhân.
  - `[báo cáo]` lấy từ báo cáo, **chưa tái hiện bằng code**; cột "Cách kiểm" nói cách tái hiện trước khi sửa.
- Các dòng nguồn ghi `UX` (D-04, G-03…G-10) được xếp `GAP` vì bảng chỉ dùng BUG/GAP/OPS.
- Dòng có "xem B-xx" là bản nhìn từ actor khác của cùng lỗi. **Vẫn giữ riêng một dòng** để mỗi actor có tiêu chí nghiệm thu của mình; khi sửa thì sửa một chỗ, nghiệm thu từng dòng.
- Đường dẫn tính từ gốc repo. `shell.tsx` = `src/components/shell.tsx`; `H/` = `src/lib/arena3/handlers/`; `R/` = `src/routes/`.

## Không làm trong đợt này

- Multi-site, bỏ `center_settings.id = 1`.
- SSO, MFA, microservice, cache.
- Bài test và tài liệu/giáo án dạng file (C-03, C-04) khi chưa có rule.
- SMS/email production (M-07) trước khi P0 xong.
- Công thức nâng gói (M-01) và hủy gói (M-02) khi chưa có rule tiền.

## Cần product / rule tiền chốt trước khi code

| ID | Câu hỏi cần chốt |
|----|------------------|
| C-03 | Có bài test đánh giá không? Nếu có: thang điểm, ai chấm, member có thấy không. SRS chưa có. |
| C-04 | Có kho tài liệu dạy không? Lưu ở đâu, ai xem. SRS chưa có. |
| M-01 | Công thức nâng gói giữa kỳ: phần còn lại tính thế nào, chênh lệch, hiệu lực từ ngày nào, court hours/session đã dùng xử lý ra sao. |
| M-02 | Member tự hủy gói: hoàn hay không hoàn, hoàn bao nhiêu, gói đang freeze xử lý thế nào, quan hệ với BR-65 (rút gói ở phía trung tâm). |
| M-06 | Theo dõi tiến trình gồm những gì (buổi đã đi, streak, nhận xét HLV?). Phụ thuộc C-02. Không tự bịa bài test. |
| M-07 | Có làm email/SMS không, kênh nào, nhà cung cấp nào. SMS đã bị bỏ ở migration `0016_drop_sms.sql`. |

---

## 1. P0 — hỏng luồng đang có

| ID | Loại | Actor | Màn | Hiện trạng | Kỳ vọng | File nghi ngờ | Cách kiểm | Pha |
|----|------|-------|-----|------------|---------|---------------|-----------|-----|
| B-01 | BUG | Manager | Settings (Center details) | Lưu báo "Something went wrong on our side." Form gửi 9 khóa bằng `Number(...)`; ô trống hoặc không phải số thành `NaN`, JSON thành `null`, vi phạm NOT NULL. `settingsPatch` không validate; giới hạn cột `tax_code` VARCHAR(20), `legal_name` VARCHAR(190). `handleError` biến mọi lỗi DB thành 500 với code `VALIDATION`. Trang không có ô giờ mở cửa, timezone, tiền tệ; timezone/tiền tệ cũng không nằm trong whitelist. `[code]` | Lưu được tên, giờ mở cửa, timezone, tiền tệ. Lỗi server trả mã rule (`BR_VIOLATION` kèm `br`), không 500 mơ hồ. | `R/manager.settings.tsx`; `H/desk.ts` (`settingsPatch`, `settingsGet`); `src/lib/arena3/errors.ts` (`handleError`) | Mở Settings, xóa trống ô số rồi Save; nhập `tax_code` hơn 20 ký tự; nhập số vượt INT. Xem log server `console.error` để thấy lỗi Postgres thật. Kiểm cột nào có sẵn trong `center_settings` trước khi hứa timezone/tiền tệ (đổi schema nằm ngoài phạm vi). | P0 |
| B-02 | BUG | Front desk (và Manager) | Payments | Refund trên ngưỡng `refund_manager_vnd` thành `refund_pending`, chờ Manager. Hàng chờ duyệt nằm ở `/desk/payments`, nhưng menu Manager không có Payments và route nằm dưới `/desk`, nên Manager không có đường tới. `paymentsApproveRefund`/`paymentsRejectRefund` đổi trạng thái, không ghi audit, không gửi thông báo cho member. `[code]` | Hàng chờ refund trên màn Manager. Duyệt/từ chối trong một transaction, có audit (FR-D21–D23), member nhận thông báo. | `shell.tsx` (NAV manager); `R/desk.payments.tsx`; `H/desk.ts` (`paymentsRefund`, `paymentsApproveRefund`, `paymentsRejectRefund`); `src/lib/arena3/router.ts` | Đăng nhập Manager, tìm đường tới hàng chờ refund (hiện không có). Lễ tân tạo refund lớn hơn ngưỡng; sau khi duyệt kiểm bảng `audit_log` và `outbox`/`inbox` của member. | P0 |
| B-03 | BUG | Member | Book (lưới sân) | Lớp "cắn 30 phút" sang slot sau. Lưới dùng slot 60 phút; `createClass` mặc định `duration_min = 90` và form `manager.classes.tsx` không có ô thời lượng mà gửi cứng 90. `occAt` dùng phép kiểm overlap nên ô kế tiếp hiện "class". `[code]` | Slot kết thúc đúng giờ khai báo, không overlap occupancy. | `R/manager.classes.tsx`; `H/classes.ts` (`createClass`, `materializeClassSessions`); `src/components/court-grid.tsx` (`occAt`) | Tạo lớp 18:00 rồi mở Book ngày đó: ô 19:00 có bị đánh "class" không. Hỏi product: lớp 90 phút là cố ý hay lỗi form (đổi `duration_min` về bội của slot, hoặc cho lưới hiển thị nửa slot). | P0 |
| B-04 | BUG | Member | Schedule (`/app`) | Báo cáo: quick actions Volleyball, Badminton, All 3 Sports bấm không đi đâu. Code hiện tại của `app.index.tsx` chỉ có 4 quick action (Book a court, Classes, Plans, Ask AI); không có ô theo môn. `[báo cáo]` | Mỗi ô mở đúng môn hoặc lịch lọc đúng môn. | `R/app.index.tsx`; `src/components/media.tsx` (`PassCard`); `src/lib/arena3/labels.ts` | Tái hiện trên build đang chạy: tài khoản member có gói, bấm từng ô. Nhiều khả năng các nhãn môn là thẻ gói (`PassCard`, `live.slice(1)`) chứ không phải quick action; xác định đúng phần tử trước khi sửa, đừng thêm tile mới theo phỏng đoán. | P0 |
| B-05 | BUG | Member | Book | Báo "đặt sân đang bug", chưa tái hiện chi tiết. Điểm đáng nghi: `bookingsHold` chỉ đếm slot `confirmed/in_use` và thông báo cứng "2 slots"; `bookingsConfirm` chỉ cho member thanh toán `quota` hoặc `transfer`; mọi lỗi không phải `ApiError` thành 500 chung. `[báo cáo]` | Đặt, hold, confirm đi hết. Lỗi trả `CONFLICT_SLOT` hoặc mã hết quota (BR-17), không nuốt. | `R/app.book.tsx`; `H/bookings.ts` (`bookingsHold`, `bookingsConfirm`, `countSlotsToday`); `src/lib/arena3/errors.ts` | Chạy luồng hold → confirm bằng quota, bằng transfer, hết quota, hai tab cùng slot, giữ hold quá hạn (`HOLD_EXPIRED`). Ghi lại request/response từng bước rồi mới chốt nguyên nhân. | P0 |
| B-06 | BUG | Front desk | Payments (hóa đơn walk-in) | Form Courts nhập `guest_name`, `guest_phone` và lưu ở `court_bookings`. Hóa đơn chỉ có `buyer_name` (không có cột SĐT); `paymentsPending` join `users` theo `payments.user_id` nên walk-in không có tên/SĐT, danh sách biên lai hiện "Walk-in". `[code]` | Invoice/receipt lưu guest name + phone, in ra được. | `H/bookings.ts` (`walkIn`); `H/desk.ts` (`paymentsPending`, `paymentsCreate`); `src/lib/arena3/pdf.ts`; `R/desk.payments.tsx`; `R/desk.courts.tsx` | Đặt walk-in với tên và SĐT, mở hóa đơn và danh sách biên lai: có tên, có SĐT không. Có thể lấy SĐT từ `court_bookings.guest_phone` khi hiển thị mà không cần cột mới; nếu cần cột mới thì đó là đổi schema và phải xin phép riêng. | P0 |
| B-07 | BUG | Front desk | Courts | Ô booked/hold render thành `<div>` không bấm được; `desk.courts.tsx` chỉ xử lý ô trống và nút `convert`. `occupancyGet` chỉ trả `kind/ref`, không có khách hay số tiền. `[code]` | Click slot đã đặt: member hoặc guest, mã, giờ, tiền, trạng thái. | `src/components/court-grid.tsx` (`isBookable`, cell render); `R/desk.courts.tsx`; `H/bookings.ts` (`occupancyGet`, `bookingGet`) | Mở Courts, bấm ô đã đặt: không có gì xảy ra. Sau khi sửa kiểm member, guest, hold chuyển khoản, lớp. Lưu ý: không lộ thông tin khách cho role member. | P0 |
| B-08 | BUG | Manager | Classes | Danh sách lớp là thẻ không bấm được, không có route chi tiết. `[code]` | Mở được buổi: sân, HLV, sĩ số, danh sách học viên. | `R/manager.classes.tsx`; `H/classes.ts` (`classRoster` đã có, quyền coach/manager/receptionist) | Bấm vào một lớp: không có phản hồi. Dùng thử `GET` roster bằng tài khoản manager để chắc endpoint đủ dữ liệu. | P0 |
| B-09 | BUG | Coach | Teaching | Danh sách buổi chỉ hiện `hh:mm–hh:mm`, sân, sĩ số, level; không có ngày, không có mã lớp. `coachSchedule` lấy `start_at > now − 1 day`, tối đa 80 dòng. DB đã có `UNIQUE (class_id, start_at)` và `materializeClassSessions` dedupe theo cặp đó, nên "trùng" nhiều khả năng là nhiều buổi cùng lớp/level không phân biệt được. `[code]` cho thiếu ngày/mã; "trùng thật" là `[báo cáo]` | Mỗi session có ngày, giờ, sân, sĩ số. Không nhân đôi session. | `R/coach.tsx`; `H/classes.ts` (`coachSchedule`, `materializeClassSessions`); `src/lib/arena3/rrule.ts`; `migrations/0002_arena3.sql`, `0005_class_sessions.sql`, `0009_sunday_class.sql` | Truy vấn `class_sessions` nhóm theo `(class_id, start_at)` và theo `(court_id, start_at)` để tìm bản sao thật; so với danh sách coach thấy trên màn. Nếu không có bản sao thật thì lỗi chỉ là hiển thị. | P0 |
| B-10 | BUG | Coach | Teaching | `shell.tsx` chỉ hiện thanh menu khi `items.length > 1`; NAV của coach có đúng 1 mục nên không có menu. `[code]` | Cùng shell với role khác: lịch, điểm danh, profile, logout. | `src/components/shell.tsx` (NAV, `showNav`); `R/coach.tsx`; `R/account.tsx` | Đăng nhập coach: không thấy menu. Sau khi sửa kiểm cả mobile 390×844. | P0 |
| B-11 | BUG | Front desk + Manager | Member detail | `desk.member.$id.tsx` chỉ có xem, freeze/unfreeze, refund, check-in. Không có route staff sửa hồ sơ; `mePatch` chỉ cho chính chủ sửa tên/ghi chú sức khỏe. `[code]` | Sửa tên, SĐT, ngày sinh, guardian. Ghi audit. Không cho đổi SĐT sang số đã tồn tại. | `R/desk.member.$id.tsx`; `H/members.ts` (`memberGet`, `membersCreate`); `H/auth.ts` (`mePatch`); `src/lib/arena3/phone.ts`; `src/lib/arena3/router.ts` | Mở hồ sơ member bằng lễ tân và manager: không có nút sửa. Sau khi sửa: đổi SĐT trùng phải bị chặn; audit có bản ghi; số được chuẩn hóa qua `phone.ts`. | P0 |
| B-12 | BUG | Front desk | Gear | State ban đầu `form = { item_id: "", phone: "0901230101", qty: "1" }` nên SĐT mẫu dính sẵn. Ô số lượng là `<Input>` thường, không +/−, không chặn theo tồn. `[code]` | Placeholder, không value mẫu. Stepper số lượng, không vượt tồn kho. | `R/desk.gear.tsx`; `H/ops.ts` (`equipmentLoan`) | Mở Gear: ô phone đã có số. Nhập số lượng lớn hơn tồn rồi gửi. Kiểm server cũng từ chối, không chỉ UI. | P0 |
| B-13 | BUG | Member | Schedule (Notifications) | Danh sách thông báo là `inbox.slice(0, 8)`; chỉ template `payment_receipt` là nút (mở hóa đơn), các loại khác là thẻ thường. Không có route đánh dấu đã đọc. `[code]` | Bấm một dòng mở nội dung. Đánh dấu đã đọc. | `R/app.index.tsx`; `H/auth.ts` (`meGet`, `inbox` limit 30); `src/lib/arena3/notify.ts`; `src/lib/arena3/router.ts` | Tạo thông báo `transfer_requested`, `hold_expired`... rồi bấm. Kiểm `inbox` có cột/đường đánh dấu đọc chưa trước khi hứa; nếu thiếu cột thì đó là đổi schema. | P0 |
| B-14 | BUG | Member | Book | `STATE_CLASS`: hold là `bg-hold/20` viền nét đứt, booked là `bg-accent/30`; độ trong suốt thấp nên mờ trên nền tối. Legend đã có (khoảng dòng 241). `[code]` | Hai trạng thái phân biệt được trên nền tối, có legend. | `src/components/court-grid.tsx` (`STATE_CLASS`, legend); `src/styles.css` | Chụp màn Book ở desktop và 390×844, đo độ tương phản booked, hold, free, in_use. | P0 |
| B-15 | BUG | Landing | Trang chủ | `<Magnet radius={150} pull={0.28}>` bọc nút "Book court" (hai chỗ trong `index.tsx`, khoảng dòng 524 và 1348) làm nút dịch theo chuột. `[code]` | Hover không dịch chuyển hit target. | `R/index.tsx`; `src/components/fx.tsx` / `motion.tsx` (Magnet) | Rê chuột gần nút ở desktop: nút trôi. Sau khi sửa, kiểm thao tác bấm ở cả hai vị trí. | P0 |
| B-16 | BUG | Member | Schedule | Ô quota hiện court hours sai môn (gói bóng rổ court-hours lại hiện volleyball/badminton/all 3 sports). Phía server **không** sai: `memberDiscount` lọc `sport_scope = $2 or 'all'`. Phía hiển thị: `PassCard` chỉ lấy `live[0]` và in `sportLabel(sport_scope)` + "Court hours N left"; `live.slice(1)` cũng in `court_hours_left` cho mọi gói. Khớp "theo báo cáo", nhưng chưa tái hiện với dữ liệu thật. `[báo cáo]` + hiển thị `[code]` | Ô theo benefit thật của gói đang active. Gói court-hours không hiện session môn khác. | `R/app.index.tsx`; `src/components/media.tsx` (`PassCard`); `H/auth.ts` (`meGet` subs select); `src/lib/arena3/pricing.ts` (`memberDiscount`); `src/lib/arena3/labels.ts` | Tạo hai gói active khác môn (bóng rổ court-hours, cầu lông session) và kiểm từng thẻ: môn nào, quota nào. So `court_hours_left` / `session_left` với `sport_scope` của đúng gói đó. | P0 |
| B-17 | BUG | Front desk | Gear | `equipmentLoan` luôn yêu cầu SĐT VN hợp lệ, không có liên kết user, không tạo dòng payment. UI luôn gửi `{item_id, phone, qty}` (chỉ guest), không có bước tìm member. `[code]` | Member thuê bằng tài khoản đã tìm. Guest mới nhập SĐT. Trả đồ trừ đúng phiếu. | `R/desk.gear.tsx`; `H/ops.ts` (`equipmentLoan`, `equipmentReturn`); `H/members.ts` (`membersSearch`) | Thuê đồ cho member: hiện phải gõ SĐT tay và phiếu không gắn user. Kiểm trả đồ trừ đúng phiếu và tồn kho. Giá/phí thuê của member khác guest hay không là rule: hỏi product nếu SRS không nói. | P0 |

## 2. P0 — role và tài khoản nhân sự

Nguồn đặt các dòng này ở P0. Hệ thống hiện chỉ có role manager, coach, receptionist, member; `requireRole` gắn theo từng handler.

| ID | Loại | Actor | Màn | Hiện trạng | Kỳ vọng | File nghi ngờ | Cách kiểm | Pha |
|----|------|-------|-----|------------|---------|---------------|-----------|-----|
| R-01 | GAP | Admin (chưa có) / Manager | Quản trị nhân sự (chưa có) | Không có role `admin`; không có route/màn tạo, khóa, đổi role staff. `[code]` | Một role `admin` (hoặc manager được bật cờ) tạo, khóa, đổi role staff. Member tự đăng ký. Staff không tự đăng ký công khai. | `H/auth.ts`; `src/lib/arena3/session.ts`; `src/lib/arena3/router.ts`; `migrations/0002_arena3.sql` (kiểu role); `docs/SRS.md` (danh sách actor) | Tìm trong router mọi route tạo user: chỉ `register` (member) và `membersCreate`. Quyết định role `admin` mới hay cờ trên manager là việc của product; nếu cần đổi kiểu role trong DB thì đó là đổi schema, xin phép riêng. | P0 |
| R-02 | GAP | Người xin làm staff / Lễ tân / Admin | Onboard nhân sự (chưa có) | Không có luồng onboard. `register.tsx` chỉ cho member. `[code]` | Không có form public. Lễ tân ghi nhận, admin cấp tài khoản sau khi gặp trực tiếp. Ghi ai cấp, lúc nào. | `R/register.tsx`; `H/auth.ts`; `H/desk.ts` (`auditList` nơi ghi nhận) | Xác nhận `register` không tạo được staff. Kiểm audit có ghi người cấp và thời điểm sau khi làm. Không thêm form đăng ký công khai cho staff. | P0 |
| R-03 | GAP | Admin | Quản trị nhân sự (chưa có) | Không có danh sách staff, lọc role, khóa phiên, reset mật khẩu cho phía trung tâm. Chỉ có `mePassword` cho chính chủ. `[code]` | Danh sách staff, lọc role, khóa phiên, reset mật khẩu. | `H/auth.ts` (`mePassword`); `src/lib/arena3/session.ts`; `src/lib/arena3/router.ts` | Kiểm `session.ts` xem phiên lưu ở đâu để biết khóa phiên có làm được không. Phụ thuộc R-01. | P0 |
| R-04 | OPS | Mọi actor | Login / Register / Forgot | `login.tsx` có `DEMO_LOGINS_ON = import.meta.env.VITE_DEMO_LOGINS !== "off"` (mặc định bật) cùng hằng mật khẩu demo và nút tài khoản demo. `register.tsx` và `forgot.tsx` hiện "Demo build — the code is {otp}" khi API echo OTP; `mayEchoOtp()` là `OTP_ECHO=1` thì bật, `OTP_ECHO=0` thì tắt, còn lại bật khi `NODE_ENV !== "production"`. NFR-22 yêu cầu `VITE_DEMO_LOGINS=off`. `[code]` | `VITE_DEMO_LOGINS=off` ở production. OTP không render ra UI. | `R/login.tsx`; `R/register.tsx`; `R/forgot.tsx`; `H/auth.ts` (`mayEchoOtp`); `.env.example`; `README.md` | Build production và grep bundle tìm mật khẩu demo. Gọi `register`/`forgot` ở production và kiểm response không chứa `otp`. Đặt `OTP_ECHO=0` tường minh trên Vercel. Không in giá trị `.env.local`. | P0 |

## 3. Member

Đã có: đăng xuất, mua/gia hạn gói, ghi danh/rời lớp, đặt slot, xem gói, lớp và sân đã đặt, thông báo in-app, sửa profile, hỏi AI.

| ID | Loại | Actor | Màn | Hiện trạng | Kỳ vọng | File nghi ngờ | Cách kiểm | Pha |
|----|------|-------|-----|------------|---------|---------------|-----------|-----|
| M-01 | GAP | Member | Plans | `app.plans.tsx` chỉ có "Buy or renew". `activateSubscription` chỉ gia hạn gói active hoặc đổi pending → active. Không có đường nâng gói. `[code]` | Nâng gói giữa kỳ. **Cần rule:** phần còn lại, chênh lệch, hiệu lực. Không tự bịa công thức; hỏi product nếu SRS chưa có. | `R/app.plans.tsx`; `H/plans.ts` (`subscriptionsCreate`); `H/desk.ts` (`activateSubscription`); `docs/SRS.md` | Tìm trong SRS quy tắc nâng gói: nếu không có thì dừng ở câu hỏi product. | CHỜ-PRODUCT |
| M-02 | GAP | Member | Plans | Member không có thao tác hủy gói. BR-65 chỉ nói về việc trung tâm rút gói khỏi bán. Freeze/unfreeze nằm ở `ops.ts`. `[code]` | Màn hủy gói + rule hoàn tiền/không hoàn; xử lý gói đang freeze. | `R/app.plans.tsx`; `H/plans.ts`; `H/ops.ts` (freeze); `H/desk.ts` (`paymentsRefund`) | Đọc SRS về BR-65 và hoàn tiền. Rule tiền do product chốt, đừng tái sử dụng `paymentsRefund` theo phỏng đoán. | CHỜ-PRODUCT |
| M-03 | GAP | Member | Schedule / Book | Lịch hiện là danh sách và lưới theo giờ của một ngày; chưa có lịch tháng/tuần hiện ngày còn slot. `[code]` | Lịch trực quan theo ngày (tháng/tuần), ngày nào còn slot; không chỉ list. | `R/app.index.tsx`; `R/app.book.tsx`; `src/components/court-grid.tsx`; `H/bookings.ts` (`occupancyGet`) | Kiểm `occupancyGet` có trả được dữ liệu nhiều ngày một lần không (tránh gọi N lần); `book_ahead_days` giới hạn xa nhất. | P1 |
| M-04 | GAP | Member | Book (đặt rồi đổi) | Không có đổi slot sau khi đặt; chỉ hủy (`bookingsCancel`) rồi đặt lại. `[code]` | Reschedule trong cửa sổ hủy (BR-20: lớp 4 giờ). Giữ ràng buộc chống overlap, không tạo overlap. | `H/bookings.ts` (`bookingsCancel`, `bookingsHold`, `bookingsConfirm`); `src/lib/arena3/rules.ts`; `migrations/0002_arena3.sql` (trigger occupancy); `docs/SDD.md` §4.2 | Đổi slot khi hai người cùng tranh một slot; kiểm không để lại hai booking active; kiểm hoàn/quota khi đổi sang slot giá khác (rule tiền: hỏi product nếu SRS không nói). Occupancy hiện do trigger, không phải `EXCLUDE` (xem A-03). | P1 |
| M-05 | GAP | Member | Classes | `app.classes.tsx` chỉ có ghi danh/rời/waitlist. `sessionAttendanceGet/Post` chỉ cho coach/manager. `[code]` | Xem điểm danh của chính mình: Present / Late / Absent / Excused theo buổi. Không xem điểm danh người khác. | `R/app.classes.tsx`; `H/ops.ts` (`sessionAttendanceGet`); `src/lib/arena3/router.ts` | Kiểm endpoint mới chỉ trả dòng của `user.id`; thử gọi bằng id member khác phải bị từ chối. | P1 |
| M-06 | GAP | Member | Train (`app.train.tsx`) | Chưa có model tiến trình. Hiện có `trainingList/Create/Suggest` (kế hoạch tập), không phải tiến trình. `[code]` | Chỉ làm nếu product chốt: buổi đã đi, streak, nhận xét HLV. Không bịa bài test. Phụ thuộc M-05 và C-02. | `R/app.train.tsx`; `H/ops.ts` (`trainingList`, `trainingSuggest`) | Chờ product xác định chỉ số. Không viết schema trước. | CHỜ-PRODUCT |
| M-07 | OPS | Member | Thông báo | `outbox`/`inbox` có; transport email là stub, SMS đã bỏ (migration `0016`). In-app giữ nguyên. `[code]` | Email/SMS ở pha sau, không chặn bug P0. | `src/lib/arena3/notify.ts`; `src/lib/arena3/jobs.ts`; `migrations/0016_drop_sms.sql`; `.env.example` (`MAIL_*`) | Kiểm outbox có dòng treo không gửi. Chỉ làm sau P0 và sau khi product chọn kênh/nhà cung cấp. | CHỜ-PRODUCT |

## 4. Coach

Đã có: xem lớp, điểm danh 4 trạng thái, AI gợi ý giáo án theo Sport + Level + Focus, đăng xuất, sửa profile.

| ID | Loại | Actor | Màn | Hiện trạng | Kỳ vọng | File nghi ngờ | Cách kiểm | Pha |
|----|------|-------|-----|------------|---------|---------------|-----------|-----|
| C-01 | BUG | Coach | Teaching | Ngày dạy không hiện trên từng buổi (xem B-09). `[code]` | Mỗi buổi có ngày cụ thể. | `R/coach.tsx`; `H/classes.ts` (`coachSchedule`) | Như B-09: danh sách chỉ hiện giờ. | P0 |
| C-02 | GAP | Coach | Teaching (điểm danh) | Chỉ có trạng thái điểm danh, không có nhận xét theo học viên. `[code]` | Nhận xét buổi học cho từng học viên; nếu có thì member đọc được ở M-05. Nếu không làm thì ghi rõ là chưa làm, không bịa điểm số. | `R/coach.tsx`; `H/ops.ts` (`sessionAttendancePost`) | Kiểm bảng điểm danh có cột ghi chú không: nếu chưa có thì lưu nhận xét là đổi schema, xin phép riêng. | P1 |
| C-03 | GAP | Coach | Bài test đánh giá (chưa có) | SRS chưa có. `[code]` | Chờ product quyết; không code schema mới trong pha bug. | `docs/SRS.md` | Không có việc kiểm cho đến khi có quyết định. | CHỜ-PRODUCT |
| C-04 | GAP | Coach | Tài liệu dạy (chưa có) | Chưa có. `[code]` | Cùng cách xử lý C-03. Không làm file giáo án khi chưa có rule. | `docs/SRS.md` | Như C-03. | CHỜ-PRODUCT |
| C-05 | BUG | Coach | Menu | Thiếu menu bar (xem B-10). `[code]` | Cùng shell với role khác. | `src/components/shell.tsx`; `R/coach.tsx` | Như B-10. | P0 |
| C-06 | BUG | Coach | Teaching | Không có mã lớp và lịch theo ngày; nghi trùng session (xem B-09). `[code]` cho thiếu mã/ngày | Mã lớp + lịch theo ngày, hết trùng session. | `R/coach.tsx`; `H/classes.ts` (`coachSchedule`, `materializeClassSessions`) | Như B-09: thêm kiểm tra trùng `(court_id, start_at)` và so sánh với mã lớp. | P0 |

## 5. Front desk (lễ tân)

Đã có: đăng xuất, mở/đóng ca, tìm/xem/tạo member, xem sân trống, đặt sân tại quầy và thu tiền, mượn đồ.

| ID | Loại | Actor | Màn | Hiện trạng | Kỳ vọng | File nghi ngờ | Cách kiểm | Pha |
|----|------|-------|-----|------------|---------|---------------|-----------|-----|
| D-01 | BUG | Lễ tân | Payments (chờ thanh toán) | Hàng "Waiting for payment" có `takePayment` gửi `POST /payments` với `ref_type = subscription`, cho phép trả một phần (`paid_vnd`); `activateSubscription` đổi pending → active. Chưa thấy lỗi trong code; chưa rõ đã kích hoạt khi trả một phần hay chưa. `[báo cáo]` | Thu được và kích hoạt đúng gói. Không kích hoạt trước khi có payment. | `R/desk.payments.tsx`; `H/desk.ts` (`paymentsCreate`, `paymentsPending`, `activateSubscription`); `H/plans.ts` (`subscriptionsCreate`) | Tạo gói pending, thử (a) kích hoạt khi chưa trả, (b) trả một phần, (c) trả đủ, (d) bấm hai lần. Kiểm `subscriptions.status` và số dòng `payments` sau mỗi bước. | P0 |
| D-02 | BUG | Lễ tân (và Manager) | Payments | Refund chờ Manager (xem B-02). Nút "Back to the desk" luôn link `/desk` kể cả khi người xem là manager; `desk.payments.tsx` render `<Shell role={isManager ? "manager" : "receptionist"}>`. `[code]` | Nút về đúng quầy, không kẹt state. | `R/desk.payments.tsx`; `shell.tsx` | Vào `/desk/payments` bằng manager rồi bấm Back: đích có đúng không. Sau khi sửa B-02, kiểm Back theo từng role. | P0 |
| D-03 | BUG | Lễ tân | Payments (lịch sử hóa đơn) | Lịch sử hiện tên member hoặc "Walk-in", không có SĐT (xem B-06). `[code]` | Lịch sử hóa đơn hiện đúng walk-in. | `R/desk.payments.tsx`; `H/desk.ts` (`paymentsPending`); `H/bookings.ts` (`walkIn`) | Như B-06. | P0 |
| D-04 | GAP | Lễ tân | Account / Payments | Biên lai nằm trong `account.tsx` (tab Receipts) và cả `desk.payments.tsx`. UX: lễ tân phải vào setting. `[code]` | Đưa ra mục Payments hoặc lịch sử thu; lễ tân không phải vào settings. | `R/account.tsx`; `R/desk.payments.tsx`; `shell.tsx`; `docs/SRS.md` (FR-D13 biên lai) | Kiểm lễ tân tới được biên lai chỉ từ menu Payments. Giữ tab Receipts cho member nếu SRS yêu cầu. Nguồn ghi UX; bảng chỉ dùng BUG/GAP/OPS nên xếp `GAP` (thiếu lối vào). | P2 |
| D-05 | BUG | Lễ tân | Gear | Thuê đồ member vs guest (xem B-17, B-12). `[code]` | Member thuê bằng tài khoản; guest nhập SĐT; stepper; không vượt tồn. | `R/desk.gear.tsx`; `H/ops.ts` (`equipmentLoan`, `equipmentReturn`) | Như B-17 và B-12. | P0 |
| D-06 | BUG | Lễ tân | Member detail | Không sửa được profile học viên (xem B-11). `[code]` | Sửa tên, SĐT, ngày sinh, guardian, có audit. | `R/desk.member.$id.tsx`; `H/members.ts` | Như B-11. | P0 |
| D-07 | GAP | Lễ tân + Manager | Classes | `classRoster` đã có nhưng lễ tân không có màn lớp; manager chưa có chi tiết (B-08). `[code]` | Danh sách học viên trong một lớp kèm sĩ số; lễ tân và manager cùng xem. | `H/classes.ts` (`classRoster`); `R/manager.classes.tsx`; `R/desk.index.tsx`; `shell.tsx` | Kiểm quyền: `classRoster` cho coach (có kiểm sở hữu), manager, receptionist. Thêm lối vào màn lớp cho lễ tân (NAV receptionist chưa có). | P1 |

## 6. Manager

| ID | Loại | Actor | Màn | Hiện trạng | Kỳ vọng | File nghi ngờ | Cách kiểm | Pha |
|----|------|-------|-----|------------|---------|---------------|-----------|-----|
| G-01 | BUG | Manager | Settings | Lưu báo 500 (xem B-01). `[code]` | Lưu được; lỗi trả mã rule. | `R/manager.settings.tsx`; `H/desk.ts` (`settingsPatch`); `src/lib/arena3/errors.ts` | Như B-01. | P0 |
| G-02 | BUG | Manager | Classes | Không vào được chi tiết lớp (xem B-08). `[code]` | Mở chi tiết lớp. | `R/manager.classes.tsx`; `H/classes.ts` | Như B-08. | P0 |
| G-03 | GAP | Manager | Pricing | `manager.prices.tsx` là một danh sách phẳng (môn/ngày/giờ/peak/giá) lưu bằng PUT; VAT nằm ở `center_settings.vat_rate` chứ không ở màn này. `priceRulesPut` xóa hết rồi chèn lại. Nguồn xếp UX. `[code]` | Chia block: sân, giờ vàng, gói, VAT. | `R/manager.prices.tsx`; `H/desk.ts` (`priceRulesPut`); `R/manager.settings.tsx` (VAT) | Mở Pricing, đếm quy tắc để chọn cách nhóm. Giữ nguyên hợp đồng PUT. Kiểm các sửa chữa của `0014_price_rule_repair.sql` vẫn còn đúng. | P2 |
| G-04 | GAP | Manager | Plans | Đã có công tắc "Pause sales"/"Put on sale" và nhãn "On sale"/"Paused"; không có nút xóa (đúng với BR-65, không xóa cứng vì đã có subscription). Chữ chưa nói "ngừng bán", chưa có chi tiết; `plansPatch` dùng `coalesce` nên không đặt lại về null được. `[code]` | UI nói "ngừng bán"; không có nút delete chết im; không xóa cứng. | `R/manager.plans.tsx`; `H/plans.ts` (`plansPatch`, `plansList`); `migrations/0015_trial_plan_off_sale.sql`; `docs/SRS.md` (BR-65) | Thử bấm công tắc: gói đã có subscription vẫn dùng được cho người đang giữ. Kiểm member không mua được gói đã ngừng bán. | P2 |
| G-05 | GAP | Manager | Plans (chi tiết) | Chỉ có thẻ, không có trang chi tiết. `[code]` | Giá, hạn, quota theo môn, court hours hay session, môn áp dụng, đang bán hay đã rút. | `R/manager.plans.tsx`; `H/plans.ts` (`plansList`) | Đối chiếu trường của `membership_plans` với danh sách mong muốn; trường nào chưa có thì không bịa. | P2 |
| G-06 | GAP | Manager | Audit | `auditList` chỉ lọc `action`, trần 200; client có tìm văn bản. Không lọc actor/entity/ngày; không thu gọn. NFR-15. `[code]` | Lọc theo actor, action, entity, ngày. Mặc định gọn, có thu gọn. | `R/manager.audit.tsx`; `H/desk.ts` (`auditList`) | Đếm số dòng thật trong `audit_log`; kiểm các cột có sẵn để lọc (actor, entity, `created_at`). Chú ý B-02: duyệt/từ chối refund hiện chưa ghi audit. | P2 |
| G-07 | GAP | Manager | Reports | `reportsRevenue` trả `by_source` theo `ref_type`; màn có nhãn `sourceLabel`, CSV; không tách theo ca; thuê đồ không có dòng payment nên không vào doanh thu (xem B-17). `[code]` | Tách sân, lớp, gói, thuê đồ, hoàn tiền, theo ca. | `R/manager.index.tsx`; `H/desk.ts` (`reportsRevenue`) | So tổng `by_source` với tổng `payments` posted trừ refund trong cùng kỳ. Thuê đồ chỉ tách được nếu có dữ liệu tiền; kiểm trước khi hứa. | P2 |
| G-08 | GAP | Manager | Shell / header | Icon trợ lý (`AssistantMark`) chỉ cho role member; manager không có. Shell không có chuông thông báo; menu tài khoản chỉ có "Account settings" và "Sign out". `[code]` | Sửa icon AI; tách cụm thông báo khỏi menu tài khoản. | `shell.tsx` (`AssistantMark`, `AccountMenu`); `src/components/mark.tsx` | Xem header từng role. Làm rõ "icon AI sai" cụ thể là icon nào trước khi đổi. | P2 |
| G-09 | GAP | Manager (và member) | Audit, Notifications | Danh sách dài không có thu gọn hay xóa bớt (audit 200 dòng; thông báo `slice(0, 8)` rồi cắt). `[code]` | Nút xóa bớt/thu gọn trên list dài. "Xóa" nghĩa là ẩn ở UI; không xóa dữ liệu audit. | `R/manager.audit.tsx`; `R/app.index.tsx` | Kiểm không có thao tác nào xóa bản ghi `audit_log` (NFR-15). | P2 |
| G-10 | GAP | Manager | Dashboard / mọi màn | Manager mới vào không có empty state hay nhãn hành động rõ. Nguồn xếp UX. `[code]` | Empty state và nhãn hành động; không thêm tutorial dài. | `R/manager.index.tsx`; `R/manager.classes.tsx`; `R/manager.plans.tsx`; `R/manager.prices.tsx` | Dùng database trống/seed tối thiểu rồi đi qua từng màn manager, ghi lại chỗ không biết làm gì tiếp. `manager.classes.tsx` đang gán cứng `coach_id` và `court_id` seed; chú ý khi dữ liệu trống. | P2 |

## 7. Kiến trúc / vận hành (không làm trong đợt sửa UI)

Chỉ làm sau khi P0 xanh. Một site vẫn là phạm vi.

| ID | Loại | Actor | Màn | Hiện trạng | Kỳ vọng | File nghi ngờ | Cách kiểm | Pha |
|----|------|-------|-----|------------|---------|---------------|-----------|-----|
| A-01 | OPS | Hệ thống | Job nền | `startJobLoop` dùng `setInterval` 15 giây và `runDueJobs`, chỉ chạy khi instance còn ấm; trên serverless instance có thể ngủ (SDD §5). `[code]` | Tách cron/worker cho expire hold, no-show, subscription, notify. | `src/lib/arena3/jobs.ts`; `docs/SDD.md` §5 | Để instance nghỉ rồi kiểm hold hết hạn có được giải phóng đúng giờ không. | OPS-CUỐI |
| A-02 | OPS | Hệ thống | Rate limit | `ratelimit.ts` dùng `Map` trong tiến trình; comment tự nhận đếm theo instance (SDD §6). `[code]` | Đưa bộ đếm xuống Postgres, hoặc bỏ qua nếu chấp nhận một site. | `src/lib/arena3/ratelimit.ts`; `docs/SDD.md` §6 | Gọi login vượt ngưỡng qua nhiều instance và xem có bị chặn không. | OPS-CUỐI |
| A-03 | OPS | Hệ thống | Publish lớp / đặt sân | Overlap được chặn bằng trigger, không phải `EXCLUDE USING gist` (SDD §4.2). `booking_replace_hold` khóa dòng sân, còn publish lớp không khóa nên có thể đua với booking. `[code]` | Chuyển overlap sang `EXCLUDE USING gist` trên Neon. PGLite dev không được là lý do prod vẫn hở. | `H/classes.ts` (publish); `H/bookings.ts`; `migrations/0002_arena3.sql`; `src/lib/arena3/db.ts`; `docs/SDD.md` §4.2 | Hai transaction song song: publish lớp và giữ sân cùng khung giờ; kiểm có overlap lọt không. Đổi constraint là đổi schema nên cần xin phép riêng khi tới pha này. | OPS-CUỐI |
| A-04 | OPS | Hệ thống | Hoàn tiền, đóng ca, ghi danh, thuê đồ | Idempotency chỉ có cho payment và confirm booking (`idem` wrapper trong router). `[code]` | Idempotency cho hoàn tiền, đóng ca, ghi danh, thuê đồ. | `src/lib/arena3/router.ts`; `H/desk.ts`; `H/classes.ts`; `H/ops.ts` | Gửi hai lần cùng một request refund/đóng ca/enrol/loan: kiểm không có dòng kép. | OPS-CUỐI |
| A-05 | OPS | Dev | Môi trường local | `db.ts` dùng Neon khi có `DATABASE_URL`, nếu không thì PGLite. `.env.local` có `DATABASE_URL`, nên chạy dev local ghi vào database thật (SDD §10.1). `[code]` | Chặn local ghi prod. | `src/lib/arena3/db.ts`; `.env.local` (chỉ nhìn tên khóa, không in giá trị); `docs/SDD.md` §10.1 | Kiểm `npm run dev` ở máy local đang nối nhánh nào. Không in hay commit giá trị biến môi trường. | OPS-CUỐI |
| A-06 | OPS | Product / Dev | Thanh toán online | `payos.ts` và `H/online.ts` đã có; SRS và SDD không nhắc PayOS (grep không ra) và mô tả đối soát tay. `[code]` | Chốt một đường (PayOS hay đối soát tay) trước khi code webhook. | `src/lib/arena3/payos.ts`; `H/online.ts`; `src/components/pay-online.tsx`; `R/pay.return.tsx`; `docs/SRS.md`; `docs/SDD.md` | Đọc `online.ts` xem webhook đã có chưa. Quyết định của product, không phải của dev. | OPS-CUỐI |
| A-07 | OPS | Chủ dữ liệu / Manager | Dữ liệu cá nhân | Không có retention, không xuất/xóa dữ liệu cá nhân; guardian chỉ được ghi lúc đăng ký (liên quan B-11). `[code]` | Chính sách retention, xuất/xóa dữ liệu cá nhân, sửa guardian. | `H/members.ts`; `H/auth.ts`; `docs/SRS.md` (`minor_age`); `docs/SDD.md` §12 | Liệt kê bảng có dữ liệu cá nhân và kiểm có đường xóa/ẩn danh chưa; đối chiếu với hóa đơn/audit phải giữ. | OPS-CUỐI |
| A-08 | OPS | Dev | CI / test | Không có thư mục `.github`, không có CI. `npm test` dùng glob `'scripts/**/*.test.mjs'`; Git Bash trên Windows không expand glob (SDD §11). `[code]` | Có CI chạy build/typecheck/test; `npm test` chạy được trên Windows. | `package.json` (`test`); `src/lib/arena3/arena3.test.ts`; `docs/SDD.md` §11 | Chạy `npm test` trên Windows Git Bash và xem có bao nhiêu file thực sự được chạy. | OPS-CUỐI |
| A-09 | OPS | Dev / Product | Tài liệu | `README.md` (tiếng Việt) ghi mật khẩu demo và SĐT, không nhắc PayOS hay Neon; SRS/SDD ghi ngày 2026-09-20 và lệch với code (PayOS, migration trùng số 0014/0015). `[code]` | Một nguồn sự thật. | `README.md`; `docs/SRS.md`; `docs/SDD.md`; `.env.example`; `migrations/` | Đối chiếu từng mục README/SRS/SDD với code và sơ đồ. Chọn tài liệu nào là chuẩn trước khi sửa. | OPS-CUỐI |

---

## Phụ lục — trùng nhau giữa các dòng (giữ riêng, sửa chung)

| Dòng | Cùng nguyên nhân với |
|------|----------------------|
| C-01, C-06 | B-09 |
| C-05 | B-10 |
| D-02 | B-02 |
| D-03 | B-06 |
| D-05 | B-17, B-12 |
| D-06 | B-11 |
| G-01 | B-01 |
| G-02 | B-08 |
| B-04 | B-16 (cùng màn Schedule; chưa rõ có cùng phần tử hay không) |
| M-06 | M-05, C-02 |
| D-07 | B-08 |

## Mức độ chắc chắn tổng hợp

- **Đã thấy nguyên nhân trong code:** B-01, B-02, B-03, B-06, B-07, B-08, B-10, B-11, B-12, B-13, B-14, B-15, B-17 và các dòng R-, M-, G-, A- tương ứng.
- **Chưa tái hiện, cần chạy thử trước khi sửa:** B-04, B-05, B-09 (phần "trùng thật"), B-16, D-01.
- **Việc này không thay đổi code hay schema.** Các chỗ có thể cần đổi schema (B-06 nếu muốn cột SĐT, B-13 nếu thiếu cột đã đọc, C-02, R-01, A-03) đã được đánh dấu để xin phép riêng.

---

## Trạng thái xử lý

Cập nhật theo từng pha. Mỗi ID là **ĐÓNG**, **KHÔNG TÁI HIỆN** hoặc **DEFERRED** (kèm lý do). Kiểm bằng `npm run typecheck`, `node --experimental-strip-types --test src/lib/arena3/arena3.test.ts` và `node scripts/arena3-fixes-check.mjs` (chạy trên PGLite trong bộ nhớ).

### Pha 1 — sửa UI và luồng hỏng (P0)

| ID | Trạng thái | Ghi chú |
|----|------------|---------|
| B-01, G-01 | ĐÓNG | `validate.ts` kiểm từng khóa; ô sai trả 400 `VALIDATION` kèm `field`, form tô đúng ô. Số ngoài INT4, ô trống, giờ đóng ≤ giờ mở đều bị từ chối. |
| B-02, D-02 | ĐÓNG | Refund lớn vào hàng chờ; chỉ Manager duyệt/từ chối (`approve-refund`/`reject-refund`), ghi audit, báo member in-app. Nút "Back" đưa về đúng quầy theo role. |
| B-03 | ĐÓNG | Buổi lớp giữ sân theo cả slot 60 phút (`slotSpan`, cả khi tạo lớp lẫn `materializeClassSessions`); migration `0019` kéo dài các occupancy buổi còn tương lai. Trigger chống chồng giờ vẫn là chốt cuối. |
| B-06, D-03 | ĐÓNG | `invoices.buyer_phone` (schema được phép). Khách vãng lai hiện tên + SĐT trên biên lai, danh sách thu tiền và PDF. Thanh toán đặt sân giờ gắn đúng người mua (`bookingBuyer`). |
| B-07 | ĐÓNG | Bấm ô đã đặt/giữ/lớp/bảo trì trên lưới sân mở chi tiết: khách (member hoặc khách vãng lai, tên + SĐT), mã, giờ, tiền, trạng thái (`GET /occupancy/detail`, chỉ staff). |
| B-08, D-07, G-02 | ĐÓNG | Manager mở được từng lớp: lịch buổi, sân, HLV, sĩ số, danh sách học viên và waitlist (`GET /classes/:id`). Lễ tân có màn Classes cùng chi tiết (`desk.classes.tsx`). |
| B-09, C-01, C-06 | ĐÓNG (một phần KHÔNG TÁI HIỆN) | Mỗi buổi hiện ngày cụ thể và mã lớp `BAD-BEG-XXXX` (lớp cùng môn/trình độ phân biệt được). "Trùng thật" **không tái hiện**: `UNIQUE(class_id, start_at)` chặn, seed chỉ có lớp khác giờ/khác sân. |
| B-10, C-05 | ĐÓNG | Coach có menu như các role khác: Schedule, Attendance, Profile (`coach.tsx` thành layout). Lịch dạy gom theo ngày; bấm buổi mở điểm danh đúng buổi đó. |
| B-11, D-06 | ĐÓNG | Lễ tân/manager sửa tên, SĐT, ngày sinh, người giám hộ (`PATCH /members/:id`); SĐT trùng bị chặn bằng `BR-01` (422, `field: phone`), số được chuẩn hóa, người chưa đủ tuổi cần guardian (`BR-07`), có audit. |
| B-12 | ĐÓNG | Gear: không còn SĐT mẫu (placeholder), nút −/+ không vượt tồn; server cũng từ chối quá tồn (`BR-38`, trả số còn lại), thiếu/sai SĐT trả 400 `field: phone`. |
| B-17, D-05 | ĐÓNG | Thuê đồ theo tài khoản member (tìm trong ô) hoặc khách theo SĐT; danh sách đang thuê ghi tên member; trả đồ cộng lại đúng số lượng của phiếu, không trả hai lần được (409). Không đổi schema: phiếu mượn lưu SĐT của member. Phí thuê **chưa** tạo dòng payment (SRS không nói; xem G-07). |
| B-13 | ĐÓNG | `outbox.read_at` (schema được phép) + view `inbox` khai báo lại. Bấm thông báo mở nội dung và đánh dấu đã đọc; có "Mark all read" và chấm chưa đọc. |
| B-14 | ĐÓNG | Ô "đã đặt" và "giữ chỗ" khác màu/hatch, có chú giải. |
| B-15 | ĐÓNG | Bỏ hiệu ứng nam châm khỏi nút "Book a court" và "Create an account" trên landing: vùng bấm không còn trôi theo con trỏ. |
| B-04 | ĐÓNG | Không có quick action theo môn (chỉ 4 ô). Phần tử đúng là các thẻ gói phụ trên Schedule trông như bấm được nhưng không đi đâu; nay mỗi thẻ mở màn Book hoặc Classes đã lọc đúng môn (`?sport=`). |
| B-16 | ĐÓNG | Server đúng (`memberDiscount` lọc môn). Thẻ gói chỉ hiện quyền lợi gói thật sự có (court hours, session, % giảm); gói session không còn "0 court hours". |
| B-05 | KHÔNG TÁI HIỆN | Chạy hold → confirm bằng transfer, hai member cùng slot (`CONFLICT_SLOT` 409), cash bị từ chối (403), confirm lần hai (409): đều trả mã rõ ràng, không có 500. Chỉ sửa câu BR-32 để dùng đúng `max_slots_per_day` thay vì cứng "2". |
| D-01 | Chuyển sang Pha 2 | Xem bảng Pha 2. |

### Pha 2 — nhân sự, tiền, báo cáo, audit (P1/P2)

Kiểm bằng `node scripts/arena3-phase2-check.mjs` (44 kiểm tra, PGLite trong bộ nhớ). Không thêm migration nào trong pha này.

| ID | Trạng thái | Ghi chú |
|----|------------|---------|
| R-01, R-02, R-03 | ĐÓNG | Không có role admin: Manager cấp tài khoản lễ tân/HLV (`POST /staff`), khóa/mở khóa, đổi role giữa receptionist và coach, reset mật khẩu (mật khẩu tạm, bắt buộc đổi khi đăng nhập lần đầu), thu hồi phiên (`/staff/:id/...`). Màn Manager → Staff. Mọi thao tác ghi audit gồm người cấp và thời điểm. Không có form đăng ký công khai cho staff; `register` vẫn chỉ tạo member; không tự khóa/hạ role chính mình. |
| R-04 | ĐÓNG | Production không có đăng nhập demo trừ khi đặt tường minh `VITE_DEMO_LOGINS=on`; OTP chỉ echo ra UI ở dev (`OTP_ECHO` / `NODE_ENV`), `.env.example` ghi rõ. Không thêm mật khẩu demo mới. |
| D-01 | ĐÓNG (đã tái hiện trước khi sửa) | Gói `pending` kích hoạt được mà chưa thu tiền. Nay `paymentsCreate` kiểm số tiền đúng giá gói, chỉ nhận cho gói `pending`, và chỉ khi có payment posted gói mới `active`; gói frozen/active bị từ chối bằng mã 409. Link thanh toán online chỉ cho gói pending. |
| D-04 | ĐÓNG | Biên lai đã truy cập được từ danh sách thu tiền; bổ sung tìm theo tên/SĐT/mã, và tab Receipts cho member ở Account. |
| G-03 | ĐÓNG | Pricing chia block: giá sân theo môn/ngày/giờ (nhãn Peak/Off-peak, quy tắc riêng một sân ghi rõ sân), gói đang bán (link sang Plans), VAT (đọc từ Settings). Hợp đồng `PUT /price-rules` giữ nguyên; lỗi tô đúng dòng (`index`). |
| G-04 | ĐÓNG | Không có xóa cứng. Nút "Stop selling" / "Sell again", nhãn "Not for sale", ghi chú BR-65; audit `withdraw_plan_from_sale` / `put_plan_on_sale`. |
| G-05 | ĐÓNG | Chi tiết gói (`GET /plans/:id`): giá, hạn, court hours/session, % giảm, môn áp dụng, trạng thái bán, số người đang giữ (active/pending/frozen/từng mua). Chỉ hiện trường thật sự có. |
| G-06, G-09 | ĐÓNG | Audit lọc theo actor, action, entity, khoảng ngày; mặc định gọn, "Show more"; "Hide" chỉ ẩn ở UI, không có thao tác xóa audit. Thông báo member có "Show all/fewer", "Hide read ones". |
| G-07 | ĐÓNG một phần / DEFERRED phần còn lại | Doanh thu tách sân / gói, hoàn tiền (trừ riêng) và theo ca thu (`by_shift`). **Lớp học và thuê đồ không có dòng payment** nên không có số để tách: UI ghi chú rõ, không bịa. Cần quyết định product để tạo dòng thu cho lớp/gear. |
| G-08 | ĐÓNG (chuông) / KHÔNG TÁI HIỆN (icon) | Member có chuông thông báo riêng (chấm số chưa đọc, trang `/app/notifications`), tách khỏi menu tài khoản. "Icon AI sai": `AssistantMark` giống nhau ở header, Quick actions và trang Assistant, không tìm ra chỗ sai; chờ chỉ rõ icon nào. |
| G-10 | ĐÓNG | Empty state có bước tiếp theo ở Prices, Plans, Classes (Classes cũng lấy HLV/sân từ dữ liệu thật thay vì gán cứng, báo thiếu tài nguyên). Không có tutorial. |
| Timezone / currency (B-01) | DEFERRED | Ghi `timezone`/`currency` ở Settings vẫn bị từ chối có chủ đích (đụng id = 1/đa vùng); chưa có yêu cầu SRS để mở. |

### Pha 3 — tính năng member trong rule hiện có (M-03, M-04, M-05)

Kiểm bằng `node scripts/arena3-phase3-check.mjs` (32 kiểm tra, PGLite trong bộ nhớ). Không thêm migration, không đụng công thức tiền.

| ID | Trạng thái | Ghi chú |
|----|------------|---------|
| M-03 | ĐÓNG | `GET /availability?from&days&sport` trả số slot còn trống của từng ngày trong **một** lần đọc (tối đa 62 ngày, `days`/`sport` sai trả 400 kèm `field`), tính từ cùng nguồn với lưới sân nên một hold làm ngày đó giảm đúng 1. Màn Book có dải tuần hiện "N free" và chế độ Month (lưới tháng, thứ Hai đầu tuần). Ngày quá khứ hoặc xa hơn `book_ahead_days` hiện mờ, không bấm được (mặc định 7 ngày nên phần lớn tháng chưa mở đặt). |
| M-04 | ĐÓNG | `POST /bookings/:id/reschedule` (chỉ member chủ booking). Chỉ đổi booking `confirmed`, **ngoài** cửa sổ hủy `cancel_court_hours` của Settings (trong cửa sổ trả 409 `CONFLICT_STATE` kèm `window_hours`). Cùng môn, sân phải `ready` (BR-35), trong `book_ahead_days`, không ở quá khứ (BR-66), giữ giới hạn slot/ngày (BR-32) và xác nhận chồng giờ (BR-39C). Việc đổi occupancy (`court_id`, `start_at`, `end_at`) và `court_bookings` nằm **cùng một transaction**; trigger chống chồng giờ vẫn là chốt cuối: tranh slot trả 409 `CONFLICT_SLOT` và booking giữ nguyên chỗ cũ (đã kiểm). **Khác giá bị từ chối** (409, kèm `paid_vnd` và `new_price_vnd`, gợi ý hủy rồi đặt lại) vì SRS không có công thức chênh lệch; booking dùng quota gói thì không có chênh lệch tiền. Có thông báo `booking_rescheduled` và audit. UI: danh sách "Your upcoming courts" với nút "Change time", banner đang đổi, lưới sân nhận lần bấm kế tiếp. |
| M-05 | ĐÓNG (đường có dữ liệu chỉ kiểm cấu trúc) | `GET /me/attendance` chỉ trả dòng của chính `user.id` (staff nhận 403, member không có lớp thấy rỗng), đủ 4 trạng thái hiện có Present / Late / Absent / Excused kèm tổng; buổi chưa điểm danh hiện "Not marked yet". Hiển thị ở cuối màn Classes ("My attendance"). Không thể tạo buổi quá khứ trên dev để thử dữ liệu thật nên phần có dòng chỉ được kiểm bằng hình dạng phản hồi. Nhận xét theo học viên (C-02) **không** làm. |

### Pha 4A — vòng đời lớp học và danh sách member (theo SRS v1.4)

Kiểm bằng `node scripts/arena3-phase4-check.mjs` (65–67 kiểm tra, chạy **một lần** trên server PGLite mới; đặt `DATABASE_URL=` rỗng vì dev server đọc `.env.local` trỏ tới DB thật). Migration `0020_phase4_sessions.sql`: `sessions.original_start_at`, `sessions.change_reason`, `classes.cancel_reason`.

| ID | Trạng thái | Ghi chú |
|----|------------|---------|
| Hủy buổi (BR-26) | ĐÓNG | `POST /sessions/:id/cancel`, chỉ manager, bắt buộc `reason`. Nhả sân + lịch HLV, cộng +1 buổi cho gói tính theo buổi (đúng một lần, hủy lại trả 409), báo từng học viên, audit `cancel_session`. |
| Dời buổi (BR-21, BR-28) | ĐÓNG | `POST /sessions/:id/reschedule`. Trùng sân/HLV trả 409 `CONFLICT_SLOT` và buổi giữ nguyên chỗ; dưới 12 giờ phải có lý do (422 `BR-28`). Giữ nguyên thời lượng; `original_start_at` để bộ sinh buổi không tạo lại giờ cũ. |
| Đổi HLV (BR-23, BR-27) | ĐÓNG | `POST /classes/:id/coach`: HLV phải dạy môn đó, không trùng lịch; chuyển các buổi sắp tới, báo HLV cũ/mới và học viên, audit `change_coach`. |
| Sửa / đóng / hủy lớp (BR-22, BR-67) | ĐÓNG | `PATCH /classes/:id`: sức chứa (không thấp hơn số đã ghi danh), level, `open`/`closed`/`cancelled`. Tăng sức chứa mời người trong waitlist. Hủy lớp: hoàn +1 mỗi học viên một lần, hủy mọi buổi sắp tới, hết hạn lời mời waitlist. |
| FR-MEM-04 | ĐÓNG | `GET /directory/members` (manager): tìm theo tên/SĐT/mã, lọc theo trạng thái tài khoản, môn, tình trạng gói (active/expiring/expired/none), phân trang, kèm số lớp. Màn `/manager/members` (mục Members trong menu), dòng mở hồ sơ member. |

UI: modal lớp ở Manager có nút Move/Cancel trên từng buổi sắp tới, và mục "Manage this class" (đổi HLV, sửa sức chứa, hủy lớp). Thông báo member có nội dung riêng cho từng loại thay đổi.

### Pha 4B — báo cáo (FR-PAY-06, FR-PAY-07, FR-CRT-09)

Kiểm bằng `node scripts/arena3-phase4b-check.mjs` (59 kiểm tra, PGLite trong bộ nhớ). Không thêm migration. Thêm thư viện `fflate` (nén zip cho xlsx).

| ID | Trạng thái | Ghi chú |
|----|------------|---------|
| Xuất Excel / PDF | ĐÓNG | `GET /reports/{revenue,capacity,members}/export?format=xlsx\|pdf` (chỉ manager; `format` sai trả 400 `field: format`, loại báo cáo lạ trả 404). Xuất đúng bộ lọc đang xem, bộ lọc ghi ở đầu mỗi sheet/trang. Ô tiền là ô số (không phải chữ). PDF dùng font Roboto nhúng nên đủ tiếng Việt. Tải qua fetch có token (link thường không mang token). |
| So sánh kỳ trước | ĐÓNG | `GET /reports/revenue` trả thêm `prev` (cùng độ dài, cùng bộ lọc method) thay vì client gọi hai lần; Reports hiện xu hướng và file xuất có cột kỳ trước. |
| Lọc phương thức thanh toán | ĐÓNG | `method` = cash/transfer/card/gateway/quota, kiểm `from <= to`, sai trả 400 có `field`. |
| Heatmap công suất sân (FR-CRT-09) | ĐÓNG | `GET /reports/capacity`: % giờ đã bán theo sân × giờ mở cửa (booking + buổi lớp; hold và bảo trì không tính), theo môn có tách giờ cao điểm / thấp điểm (từ `price_rules.is_peak`), doanh thu sân tách khỏi học phí lớp. Tối đa 93 ngày. |
| Báo cáo member và lớp (FR-PAY-06) | ĐÓNG | `GET /reports/members`: member mới, gói đang chạy, sắp hết hạn chưa gia hạn, tỉ lệ gia hạn, xu hướng 12 tháng, từng lớp với sĩ số/waitlist/% đầy. % điểm danh ẩn khi chưa có dữ liệu điểm danh (BR-62), không in 0%. |

Giới hạn đã biết: tỉ lệ gia hạn coi gói mới bắt đầu trong vòng 30 ngày sau khi gói cũ hết là gia hạn (SRS không định nghĩa ngưỡng). Học phí lớp hiện bằng 0 trong doanh thu vì lớp dùng quota gói, không có dòng payment (xem G-07).

### Pha 4C — module huấn luyện F4 (BR-52…BR-62)

Kiểm bằng `node scripts/arena3-phase4c-check.mjs` (115 kiểm tra, chạy **một lần** trên server PGLite mới, `DATABASE_URL=` rỗng). Migration `0021_phase4c_training.sql` (cần `npm run db:migrate` trên Neon, cùng với `0020`). Luật thuần (khóa điểm danh, chuỗi vắng, chỉ số, bài tập) nằm ở `rules.ts` và có unit test.

| ID | Trạng thái | Ghi chú |
|----|------------|---------|
| Khóa điểm danh (BR-53) | ĐÓNG | `GET/PUT /sessions/:id/attendance`. Khóa sau 2 giờ kể từ `end_at` hoặc khi buổi đã `done`. Sau khóa chỉ manager sửa, bắt buộc `reason` (≥ 3 ký tự), có audit; coach nhận 422 `BR-53`. Phần khóa theo thời gian chỉ kiểm bằng unit test vì toàn bộ buổi seed nằm ở tương lai. |
| Kết quả buổi tập (BR-55, BR-56) | ĐÓNG | `GET/PUT /sessions/:id/results`: % hoàn thành giáo án, chỉ số theo môn (smash, ném phạt, giao bóng), ghi chú. Cho phép sửa với mọi buổi chưa hủy; không có luật "đã bắt đầu" trong SRS nên không bịa thêm. |
| Giáo án (BR-59, BR-60) | ĐÓNG | `POST/PATCH /training-plans`, khối giáo án theo giai đoạn, xuất bản/ẩn. `POST /classes/:id/plans/duplicate-week` sao chép tuần trước, bản sao ở trạng thái **nháp** để coach xem lại trước khi học viên thấy. |
| Bài tập về nhà (BR-61) | ĐÓNG | `POST/GET /homework`; học viên tick từng mục (`PUT /me/homework/:id`), hoàn thành khi đủ mục. |
| Chuỗi vắng (BR-58) | ĐÓNG | 3 buổi vắng liên tiếp báo `absent_streak` cho coach và manager. Có phép (Excused) **cắt** chuỗi; BR-58 chỉ cảnh báo, không bao giờ tự hủy ghi danh. Trước đây staff không có chỗ xem thông báo này, nên thêm trang `/alerts` và chuông cho mọi role. |
| Cổng vào (BR-54) | ĐÓNG | `POST /desk/gate-checkin` (SĐT hoặc mã member), `GET /desk/gate-checkins` (hôm nay). Idempotent trong 5 phút; chỉ ghi "đã vào cổng", **không** điền điểm danh buổi lớp, vì tick của coach mới là chuẩn cho Present/Late (BR-57). |
| Hồ sơ học viên | ĐÓNG | `GET /students/:id/profile`, `PUT /students/:id/level`, `POST /students/:id/reviews` (không sửa được sau khi lưu, học viên được báo), ghi chú của coach **chỉ staff** thấy. |
| Tiến độ của member | ĐÓNG | `GET /me/training`, `PUT /me/training-goal`; tab "Progress" thay màn Train cũ. |
| Cờ F4 tắt (BR-62) | ĐÓNG | `requireFlag` trả **403** `br: "BR-62"` (trước đây 422); UI ẩn các khối F4 khi cờ tắt. |

UI: Attendance của coach có khóa/lý do sửa, kết quả buổi, giáo án và bài tập; tên học viên mở `/coach/student/$id`; desk có tab Gate; member có tab Progress.

Việc cần làm ngoài code: chạy `npm run db:migrate` để `0020` và `0021` lên Neon; dọn dữ liệu thử còn sót trên Neon (lớp "Lifecycle …", "Directory Bare …").

### Chưa làm có chủ đích

- **CHỜ-PRODUCT:** C-03, C-04, M-01, M-02, M-06, M-07 — chờ product chốt, không viết code/schema.
- **OPS-CUỐI:** A-01…A-09 — việc vận hành cuối đợt, không phải code.
- **Không được làm:** C-02 (cột nhận xét buổi học là đổi schema ngoài danh sách cho phép).
