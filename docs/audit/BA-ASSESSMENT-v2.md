# Arena3: BA assessment, vòng 2 (chấm sâu)

Ngày: 2026-11-01 · Người chấm: Claude (BA độc lập) · Chuẩn: ảnh đặc tả gốc · Trạng thái code: commit `6b23876` "Bring back membership plans" trên `main`, cộng các sửa đổi chưa commit của chủ dự án (`bookings.ts`, EF-05e, landing, `coach.index.tsx`).

Vòng 1: `docs/audit/BA-ASSESSMENT.md`. Vòng này sâu hơn ở 3 điểm mà vòng 1 để ở Phụ lục A:

1. **Lần theo cả UI chứ không chỉ API.** Với mỗi gạch đầu dòng, kiểm tra có màn hình thật sự gọi endpoint đó không (grep `apiGet/apiPost/useRead` trong `src/routes`, `src/components`). Một chức năng có API mà không có nút bấm thì người dùng không làm được, nên chỉ đạt **Một phần**.
2. **Đọc hết guard còn bỏ ngỏ:** `enrollmentDelete`, `trainingCreate`, `ticketsList`, `subscriptionsCreate`, `trainingSuggest`, `homeworkCreate`, `reportsMembers`.
3. **Kiểm tra số tiền ở server** cho thanh toán gói và lớp (người dùng có tự đặt giá được không).

Thang giữ nguyên: **Đáp ứng đủ / Một phần / Không có / Không xác minh được**. Ở vòng này, "Đáp ứng đủ" yêu cầu: endpoint + guard + bảng DB + **màn hình gọi được**.

## Tóm tắt điều hành

| | Vòng 1 | Vòng 2 |
|---|---|---|
| Đáp ứng đủ | 20 | **27** / 32 |
| Một phần | 7 | **5** |
| Không có | 4 | **0** |
| Flow 1 | Một phần | **Đáp ứng đủ** |
| Flow 2 | Đáp ứng đủ | **Đáp ứng đủ**, trừ R6 thiếu UI |
| Flow 3 | Một phần | **Đáp ứng đủ** |

1. **Gói thành viên đã trở lại đầy đủ.** Đã có cả vòng đời: tạo gói, bán, thanh toán, kích hoạt, bảo lưu, gia hạn, tự hết hạn và nhắc hết hạn. Bốn mục "Không có" của vòng 1 (M5, U2, R3, R4) và phần nhắc hết hạn của U9 đều có code và màn hình. Gói **không** chặn vào cổng hay ghi danh lớp, đúng quyết định của chủ dự án.
2. **Phát hiện mới, quan trọng nhất: lễ tân không có nút đăng ký hoặc hủy lớp hộ thành viên (R6).** API cho phép: `H/classes.ts:325-327` nhận `user_id`, và `enrollmentDelete` (`H/classes.ts:575-592`) không chặn receptionist. Nhưng `desk.classes.tsx` chỉ đọc, `desk.member.$id.tsx` không có lệnh `enroll`, và `class-detail.tsx` chỉ có đổi HLV, sức chứa, giá, hủy lớp. Người chấm thao tác qua giao diện sẽ không làm được.
3. **Phát hiện mới: `flows.test.ts` không nằm trong `npm test`.** Script `test` trong `package.json:19` chạy `arena3.test.ts`, `tx.test.ts`, `ratelimit.test.ts` nhưng **bỏ sót** `flows.test.ts`. Các test MF-01…MF-07 (bằng chứng chính của Flow 1–3) vì vậy không bao giờ chạy trong CI hay khi chạy `npm test`.
4. **AI gợi ý bài tập (C8, Flow 5) vẫn chưa sửa.** `H/ops.ts:542-563` bỏ qua `goal` và `sport`, không đọc lịch sử, không gọi Gemini, nhưng vẫn gắn `source: "ai"`.
5. **Báo cáo số thành viên (M4) chưa theo khuyến nghị vòng 1.** `membersReportBody` (`H/reports.ts`) chỉ đếm `new_members` và `active_members` theo hoạt động. Chưa có "số người đang có gói còn hạn", dù gói đã trở lại.
6. **Số tiền được khóa ở server**, đúng cách: lớp phải trả đủ `enrollments.price_vnd` (`H/desk.ts:344-349`); gói phải trả đúng giá gói trừ khuyến mãi (`H/desk.ts:394-415`). Client không tự đặt giá được.
7. **Test chưa chạy được ở vòng này.** Test dùng PGLite trong bộ nhớ (`flows.test.ts:9-10`, `tx.test.ts:8-9`), không ghi vào DB thật. Tuy vậy lệnh chạy test bị bộ phân loại quyền của phiên chặn, nên kết quả pass/fail vẫn **không xác minh được**.

---

## 1. Bảng đối chiếu (chỉ ghi mục thay đổi so với vòng 1 hoặc có bằng chứng mới)

Chú thích: `H/` = `src/lib/arena3/handlers/`, `R/` = `src/routes/`, `C/` = `src/components/`, `FT` = `src/lib/arena3/flows.test.ts`.

### 1.1 Center Manager

| # | Yêu cầu | Vòng 1 | Vòng 2 | Bằng chứng mới |
|---|---|---|---|---|
| M1 | Quản lý thành viên, HLV, nhân viên | Đủ | **Đáp ứng đủ** | UI: `R/manager.members.tsx`, `R/manager.staff.tsx` gọi `/staff`. |
| M2 | Lớp, bộ môn, phòng tập (= sân), lịch | Đủ | **Đáp ứng đủ** | Chủ dự án xác nhận phòng tập = sân. |
| M3 | Phân công HLV | Đủ | **Đáp ứng đủ** | UI: `C/class-detail.tsx:357,383-385` lấy danh sách `/staff?role=coach` rồi gọi `POST /classes/:id/coach`. |
| M4 | Báo cáo số thành viên, đăng ký lớp, doanh thu | Đủ (có phản chứng) | **Một phần** | Doanh thu (`R/manager.index.tsx`) và hội viên (`C/report-panels.tsx`) có UI. Nhưng "số thành viên" chỉ là `new_members` + `active_members` theo booking/ghi danh (`H/reports.ts`, `membersReportBody`). Khi đã có gói, thiếu chỉ số "đang có gói còn hạn" là lệch nghĩa thông thường của "thành viên". Hạ xuống Một phần cho tới khi có chỉ số này. |
| M5 | Gói thành viên, học phí, thời hạn | **Không có** | **Đáp ứng đủ** | `H/plans.ts` (`plansCreate`, `plansPatch`, manager), UI `R/manager.plans.tsx` gọi `POST /plans`; thực tế trình duyệt hiện 8 gói (7 đang bán, 1 ẩn). |
| M6 | Phân quyền theo vai trò | Một phần | **Đáp ứng đủ** (theo quyết định) | Chủ dự án chọn 4 vai trò cố định. Gán vai trò ở `R/manager.staff.tsx`. Vẫn nên có bảng ma trận quyền chỉ đọc trong tài liệu. |
| M7 | Lịch sử thao tác | Đủ | **Đáp ứng đủ** | UI: `R/manager.audit.tsx:237` đọc `/audit` có phân trang. |

### 1.2 Coach

| # | Yêu cầu | Vòng 1 | Vòng 2 | Bằng chứng mới |
|---|---|---|---|---|
| C1 | Lịch dạy, danh sách học viên | Đủ | **Đáp ứng đủ** | `R/coach.attendance.tsx` gọi `/roster`. |
| C2 | Thông tin, mục tiêu học viên | Đủ | **Đáp ứng đủ** | `R/coach.student.$id.tsx`. |
| C3 | Kế hoạch tập | Đủ | **Đáp ứng đủ** | `C/coach-training.tsx` gọi `training-plans`; guard `coach, manager` + cờ `F4` (`H/training.ts:731-733`). |
| C4 | Kết quả sau buổi | Đủ | **Đáp ứng đủ** | `C/coach-training.tsx` gọi `/results`. |
| C5 | Đánh giá tiến độ, nhận xét | Đủ | **Đáp ứng đủ** | `R/coach.student.$id.tsx` gọi `/reviews`; gửi thông báo `review_added` cho học viên (`H/training.ts:272`). |
| C6 | Điểm danh | Đủ | **Đáp ứng đủ** | `R/coach.attendance.tsx`. |
| C7 | Gửi thông báo hoặc bài tập | Một phần | **Một phần** (sát ngưỡng) | Sửa nhận định vòng 1: HLV **có** gửi thông báo in-app kèm hành động, gồm `homework_assigned` (`H/training.ts:460`), `training_plan` (`:720`), `review_added` (`:272`). Vẫn thiếu thông báo **tự do** (HLV gõ nội dung gửi cả lớp). Chat thay được về chức năng nhưng không phải "thông báo". |
| C8 | AI gợi ý bài tập | Một phần | **Một phần** | Không đổi: `H/ops.ts:542-563` trả 1 trong 3 danh sách cố định theo `level`; `goal` và `sport` chỉ được chép lại vào payload; nhãn `source: "ai"` không đúng sự thật. |

### 1.3 Member

| # | Yêu cầu | Vòng 1 | Vòng 2 | Bằng chứng mới |
|---|---|---|---|---|
| U1 | Đăng ký, cập nhật thông tin | Đủ | **Đáp ứng đủ** | |
| U2 | Xem và đăng ký/gia hạn gói | **Không có** | **Đáp ứng đủ** | `R/app.plans.tsx` gọi `POST /subscriptions`; `subscriptionsCreate` kiểm tra `is_on_sale` (BR-16), gói bị bảo lưu (BR-14), rate-limit (`H/plans.ts:144+`). Đã xem trong trình duyệt. |
| U3 | Danh sách lớp, lịch | Đủ | **Đáp ứng đủ** | |
| U4 | Đăng ký/hủy lớp | Đủ, có test | **Đáp ứng đủ** | `R/app.classes.tsx` gọi `/enroll` và `enrollments/:id`. |
| U5 | Lịch cá nhân, thông tin HLV | Một phần | **Một phần** | Không đổi. |
| U6 | Lịch sử điểm danh, kết quả | Đủ | **Đáp ứng đủ** | `C/my-attendance.tsx` gọi `me/attendance`. |
| U7 | Kế hoạch tập, nhận xét HLV | Đủ | **Đáp ứng đủ** | `R/app.train.tsx` gọi `me/training`. |
| U8 | Hỏi AI | Đủ | **Đáp ứng đủ** | `R/app.assistant.tsx`; cờ `F6` bật từ `migrations/0008_ops.sql:2`. |
| U9 | Thông báo lịch, đổi lịch, hết hạn gói | Một phần | **Đáp ứng đủ** | Job `expiryReminders` ghi `sub_expiring` lúc còn 7, 3, 0 ngày (`jobs.ts`); trang chủ member hiện thẻ "Plans expiring soon" (`R/app.index.tsx`). |

### 1.4 Receptionist

| # | Yêu cầu | Vòng 1 | Vòng 2 | Bằng chứng mới |
|---|---|---|---|---|
| R1 | Tìm, xem thành viên | Đủ | **Đáp ứng đủ** | |
| R2 | Đăng ký thành viên tại quầy | Đủ | **Đáp ứng đủ** | Quy trình 3 bước tạo hội viên → chọn gói → thu tiền ở `R/desk.index.tsx`. |
| R3 | Đăng ký/gia hạn gói | **Không có** | **Đáp ứng đủ** | `R/desk.member.$id.tsx:640` gọi `POST /subscriptions` với `user_id`; bảo lưu/mở bảo lưu `:510,525`. |
| R4 | Kiểm tra trạng thái và thời hạn gói | **Không có** | **Đáp ứng đủ** | Trang hội viên ở quầy hiển thị gói, ngày hết hạn, trạng thái. Theo quyết định, cổng vẫn không dựa vào gói. |
| R5 | Điểm danh khi đến | Đủ, có test | **Đáp ứng đủ** | `R/desk.gate.tsx`. |
| R6 | Đăng ký lớp hoặc hủy lớp hộ | Một phần | **Một phần** (lý do mới) | API cho phép cả hai (`H/classes.ts:325-327`; `enrollmentDelete` `:575-592` chỉ chặn member khác người và coach khác lớp). **Không có màn hình nào** của lễ tân gọi `/enroll` hay `DELETE /enrollments/:id`: `R/desk.classes.tsx` không có lệnh ghi, `R/desk.member.$id.tsx` chỉ có các lệnh ở dòng 181-941 (reset mật khẩu, sửa hồ sơ, thanh toán, gói, booking). |
| R7 | Ghi nhận thanh toán, hóa đơn | Đủ (trừ gói) | **Đáp ứng đủ** | Gói đã thanh toán được; số tiền khóa ở server (`H/desk.ts:394-415`). Hóa đơn mở qua `openInvoice` (`R/desk.member.$id.tsx:30`, `R/account.tsx:1012`). |
| R8 | Tiếp nhận hỗ trợ | Đủ | **Đáp ứng đủ** | `ticketsList` guard `receptionist, manager` (`H/ops.ts:821-822`); UI `R/desk.index.tsx`. |

**Tổng hợp 32 gạch đầu dòng (M7 + C8 + U9 + R8):** Đáp ứng đủ 27 · Một phần 5 (M4, C7, C8, U5, R6) · Không có 0 · Không xác minh được 0.

---

## 2. Flow 1–3 (bắt buộc)

### Flow 1: User & membership management — **Đáp ứng đủ**

- **Đường đi:** đăng ký online hoặc tại quầy → chọn gói (`/app/plans` hoặc quầy) → tạo `subscription` trạng thái `pending` → thanh toán (quầy `POST /payments` `ref_type=subscription`, hoặc PayOS online) → kích hoạt, cộng giờ sân và số buổi → bảo lưu/mở bảo lưu (BR-14, BR-15) → nhắc hết hạn (7/3/0 ngày) → tự chuyển `expired` (`subscriptionStatus` trong `jobs.ts`) → gia hạn cùng gói thì nối tiếp ngày hết hạn (`H/desk.ts:166-178`).
- **Nhánh lỗi có trong code:** gói ngừng bán (BR-16), gói đang bảo lưu (BR-14), không cho nợ (BR-19), sai số tiền → 400 kèm `expected_vnd`, gán gói cho người không phải member → lỗi trường `user_id`.
- **Còn thiếu:** test tự động cho luồng gói. MF-06 hiện chỉ kiểm tra endpoint trả 200/401, chưa có test "mua → trả tiền → active → hết hạn".

### Flow 2: Class booking & schedule — **Đáp ứng đủ**, có một lỗ UI

- Như vòng 1 (MF-02, EF-02a/b/c, MF-05b, EF-05d).
- **Lỗ mới:** lễ tân không ghi danh hoặc hủy hộ được qua giao diện (R6).

### Flow 3: Payment & report — **Đáp ứng đủ**

- Thanh toán gói, lớp, sân; hoàn tiền hai người duyệt; hóa đơn PDF; báo cáo doanh thu và xuất file.
- **Điểm yếu còn lại:** báo cáo hội viên chưa có chỉ số theo gói (M4); không có test tự động cho báo cáo doanh thu và hoàn tiền trong FT.

## 2b. Flow 4–6 (tùy chọn)

| Flow | Mức | Bằng chứng |
|---|---|---|
| 4 Training & attendance | Đáp ứng đủ | Mọi màn hình HLV gọi đúng endpoint (mục 1.2); cờ `F4` bật (`0008_ops.sql:2`). |
| 5 AI workout recommendation | **Một phần** | `H/ops.ts:542-563`, không đổi từ vòng 1. |
| 6 AI assistant | Đáp ứng đủ | `R/app.assistant.tsx`, `gemini.ts`, rate-limit. |

## 3. Kiểm thử và khả năng chứng minh

| Phát hiện | Bằng chứng | Hậu quả | Đề xuất |
|---|---|---|---|
| `flows.test.ts` không có trong `npm test` | `package.json:19` | MF-01…MF-07 không chạy tự động; có thể đã hỏng mà không ai biết | Thêm `src/lib/arena3/flows.test.ts` vào lệnh `npx tsx --test …` |
| Chưa có test luồng gói | `FT` MF-06 chỉ kiểm tra 200/401 | Flow 1 thiếu bằng chứng tự động | Thêm MF-08: mua gói → thanh toán → active → bảo lưu → hết hạn |
| Không có test receptionist ghi danh/hủy hộ | FT | R6 không chứng minh được | Thêm case cùng lúc làm UI |
| Kết quả test hiện tại | lệnh chạy bị chặn trong phiên này | **Không xác minh được** | Chủ dự án chạy: `npx tsx --test src/lib/arena3/flows.test.ts` |

## 4. Phân quyền (bổ sung vòng 2)

- `enrollmentDelete` không gọi `requireRole`. Guard viết ngược: chặn member khác người, chặn coach khác lớp, còn lại cho qua. Hiện an toàn vì chỉ có 4 vai trò. Nếu sau này thêm vai trò thứ 5, vai trò đó sẽ hủy được mọi ghi danh. Nên đổi thành danh sách cho phép (`requireRole(user, ["member","coach","receptionist","manager"])`).
- `subscriptionsCreate`: member chỉ mua cho mình; lễ tân và manager mua hộ, và người nhận phải có role `member` (`H/plans.ts:150-160`). Đúng.
- `trainingSuggest`: `coach, manager` + `F5`. `homeworkCreate`, `trainingCreate`: `coach, manager` + `F4`. Manager làm thay coach được, khớp quyết định chủ dự án.
- `assistantChat` không có `requireRole`, chỉ yêu cầu đăng nhập và cờ `F6`. Mọi vai trò dùng được, rộng hơn ảnh (chỉ Member), không gây hại.

## 5. Rủi ro và đề xuất (ưu tiên)

| # | Việc | Mục | Công sức |
|---|---|---|---|
| 1 | Thêm nút "Ghi danh hộ" và "Hủy ghi danh" ở `desk.classes` hoặc `desk.member.$id` | R6, Flow 2 | S–M |
| 2 | Đưa `flows.test.ts` vào `npm test`, chạy và sửa nếu đỏ | Chứng minh Flow 1–3 | S |
| 3 | Thêm chỉ số "đang có gói còn hạn" vào báo cáo hội viên | M4 | S |
| 4 | Viết test luồng gói (MF-08) | Flow 1 | M |
| 5 | AI gợi ý: dùng `goal`, `sport`, lịch sử buổi tập, gọi Gemini với JSON schema; nhãn `source` ghi đúng (`ai` / `rules`) | C8, Flow 5 | M |
| 6 | Thông báo tự do HLV → lớp (ghi `outbox` template `coach_message`) | C7 | S–M |
| 7 | Đổi guard `enrollmentDelete` sang danh sách cho phép | Phân quyền | S |
| 8 | Cập nhật `docs/FLOW-1-COVERAGE.md`, `Arena3-Grading-Report.md` theo trạng thái mới (giờ "Plans live" lại đúng, nhưng cần dẫn chiếu commit `6b23876`) | Tài liệu | S |

## Phụ lục A. Giới hạn của vòng này

- Không chạy được test (bị chặn quyền). Pass/fail: **không xác minh được**.
- Kiểm tra UI bằng grep lời gọi API và hai lần mở trình duyệt (`/app/plans`, `/manager/plans` với dữ liệu seed trong bộ nhớ). Chưa bấm thử từng luồng end-to-end trong trình duyệt.
- Chưa đọc từng case của `tx.test.ts` (139) và `arena3.test.ts` (84).
- Các sửa đổi chưa commit của chủ dự án (`bookings.ts` chặn hủy booking đã bắt đầu, EF-05e) được coi là chưa ổn định, không tính điểm.
