# Cơ sở dữ liệu Arena3: kể lại từ đầu đến cuối

> Tài liệu này mô tả database của Arena3 đúng như nó đang chạy sau khi áp dụng đủ **57 file migration** (đánh số 0002–0056) (cập nhật 18/11/2026). Viết bằng văn xuôi để đưa vào NotebookLM tổng hợp thành video: mỗi phần trả lời một câu hỏi, có ví dụ, và đi theo luồng nghiệp vụ thật của một trung tâm thể thao.
>
> Số dòng ghi trong ngoặc là **dữ liệu demo (seed)**, không phải số liệu kinh doanh thật. Tên người, số điện thoại và số tiền trong seed chỉ để chạy thử.

---

## 1. Bức tranh tổng thể trong một phút

Arena3 là phần mềm quản lý một trung tâm thể thao có nhiều môn (cầu lông, pickleball, tennis, bóng bàn…). Bốn vai trò dùng chung một database:

- **Quản lý (manager):** cấu hình trung tâm, giá, gói hội viên, khuyến mãi, báo cáo, duyệt hoàn tiền.
- **Lễ tân (receptionist):** mở ca thu ngân, nhận tiền mặt, check-in, xử lý đặt sân tại quầy.
- **Huấn luyện viên (coach):** dạy lớp, điểm danh, viết giáo án, đánh giá tiến bộ học viên.
- **Hội viên (member):** đặt sân, mua gói, đăng ký lớp, thanh toán online, nhắn tin với trung tâm.

Sau khi chạy hết migration, database có:

| Thành phần | Số lượng |
| --- | --- |
| Bảng | 61 |
| View | 1 (`inbox`) |
| Hàm SQL | 16 |
| Trigger | 3 |
| Kiểu enum | 16 |
| Migration | 57 file (0002–0056) |

Có thể hình dung database như **sáu khu** nối với nhau qua bảng `users`:

1. **Con người và đăng nhập:** ai được vào hệ thống, với vai trò gì.
2. **Sân và lịch sân:** sân nào trống giờ nào, ai đang giữ, ai đã đặt.
3. **Lớp học:** lớp, buổi học, người ghi danh, hàng chờ.
4. **Gói hội viên:** gói theo tháng, quyền lợi giờ sân, gia hạn.
5. **Tiền:** ca thu ngân, thanh toán, hóa đơn, khuyến mãi.
6. **Vận hành và huấn luyện:** check-in, thông báo, chat, giáo án, thiết bị, bảo trì, nhật ký kiểm toán.

Ý tưởng xuyên suốt: **database tự bảo vệ những quy tắc không bao giờ được sai** (hai người không thể giữ cùng một sân cùng giờ, lớp không thể vượt sĩ số, một người chỉ có một gói đang chạy), còn những quy tắc kinh doanh linh hoạt hơn (hoàn bao nhiêu phần trăm, ai được duyệt) nằm trong code xử lý và bảng cấu hình.

---

## 2. Vài khái niệm cần biết trước

- **Bảng (table):** giống một trang tính; mỗi dòng là một bản ghi, mỗi cột là một thuộc tính.
- **Khóa chính (primary key, PK):** cột định danh duy nhất của dòng. Hầu hết bảng dùng `id` kiểu UUID, một chuỗi ngẫu nhiên khó đoán.
- **Khóa ngoại (foreign key, FK):** cột trỏ sang dòng ở bảng khác, ví dụ `court_bookings.court_id` trỏ tới `courts.id`. Database từ chối nếu trỏ tới dòng không tồn tại.
- **Ràng buộc (constraint):**
  - `NOT NULL`: bắt buộc có giá trị.
  - `UNIQUE`: không được trùng.
  - `CHECK`: điều kiện phải đúng, ví dụ giá không âm.
- **Unique index một phần (partial unique index):** chỉ cấm trùng trong một nhóm dòng thỏa điều kiện. Ví dụ "mỗi người chỉ có **một** booking đang ở trạng thái `hold`", còn booking đã xong thì bao nhiêu cũng được.
- **Enum:** kiểu dữ liệu chỉ nhận một danh sách giá trị cố định, như trạng thái booking.
- **Transaction:** nhóm thao tác hoặc thành công hết, hoặc hủy hết.
- **Khóa hàng (`FOR UPDATE`):** khi một giao dịch đang sửa một dòng, giao dịch khác muốn sửa cùng dòng phải xếp hàng chờ.
- **Trigger:** đoạn xử lý tự chạy mỗi khi có thêm/sửa/xóa dòng.

Tiền luôn lưu bằng **số nguyên đồng Việt Nam** (cột tên kết thúc bằng `_vnd`), không dùng số thực, để tránh sai số làm tròn. Thời điểm lưu kiểu `timestamptz` (có múi giờ); múi giờ của trung tâm là `Asia/Ho_Chi_Minh`.

---

## 3. Database chạy ở đâu

Arena3 dùng **PostgreSQL** ở hai dạng:

- **Khi phát triển trên máy (dev):** dùng **PGlite**, một bản PostgreSQL chạy ngay trong tiến trình Node, không cần cài server riêng.
  - Dữ liệu lưu trong thư mục `.pglite`, nên tắt mở lại vẫn còn.
  - Đặt `PGLITE_DATA_DIR=memory` thì database nằm hoàn toàn trong bộ nhớ: mỗi lần khởi động là một bản seed mới tinh. Cách này dùng khi chạy kiểm thử toàn bộ API.
- **Khi triển khai thật:** khi có biến `DATABASE_URL` và đang ở môi trường deploy (`VERCEL` hoặc `NODE_ENV=production`), ứng dụng dùng `pg.Pool` kết nối tới PostgreSQL thật (Neon).

Code nghiệp vụ không cần biết đang chạy dạng nào: cả hai đều đi qua cùng một lớp truy vấn trong `src/server/db.ts`.

Vì PGlite không có extension `btree_gist`, Arena3 **không** dùng exclusion constraint để chống trùng lịch. Thay vào đó là trigger kiểm tra khoảng thời gian (phần 11), chạy được ở cả hai môi trường.

---

## 4. Migration: database được xây dần như thế nào

**Migration** là các file SQL trong thư mục `migrations/`, mỗi file là một bước thay đổi schema hoặc dữ liệu.

- Chúng chạy theo **thứ tự tên file** (`0002_…`, `0003_…`, …). Có vài số bị dùng hai lần (ví dụ hai file `0014_…`, hai file `0015_…`); khi đó thứ tự theo tên đầy đủ.
- Bảng `_migrations` ghi lại file nào đã chạy, nên mỗi file chỉ chạy **một lần**.
- Mỗi file chạy trong **một transaction riêng**: lỗi giữa chừng thì cả file bị hủy, database không ở trạng thái nửa vời.
- Trên máy dev, migration tự chạy khi server khởi động. Khi build để deploy, lệnh `npm run db:migrate` (`scripts/migrate.mjs`) chạy chúng trên database thật.
- Thư mục con `migrations/auth/` **không** được áp dụng.

Điều quan trọng khi đọc migration: **file đầu cho biết bảng ra đời ra sao, file sau mới cho biết luật hiện tại.** Ví dụ gói hội viên từng có cột phạm vi môn `sport_scope`; migration 0056 đã xóa cột này vì gói giờ áp dụng cho mọi môn. Bản đồ đầy đủ ở phần 15.

---

## 5. Khu con người và đăng nhập

### 5.1. `users`: mọi người dùng (59 dòng demo)

Một bảng chung cho cả bốn vai trò; cột `role` phân biệt manager, coach, receptionist, member.

| Nhóm cột | Cột | Ghi chú |
| --- | --- | --- |
| Định danh | `id`, `member_code` | `member_code` là mã hội viên dễ đọc, duy nhất, do hàm `next_member_code()` cấp |
| Họ tên | `full_name`, `name_normalized` | Bản bỏ dấu, chữ thường, để tìm kiếm nhanh (có index riêng) |
| Liên lạc | `phone`, `email` | `phone` bắt buộc và duy nhất; `email` duy nhất nếu có |
| Vai trò, trạng thái | `role`, `status` | `status`: `active`, `locked` (khóa tạm), `disabled` (vô hiệu) |
| Mật khẩu | `password_hash`, `must_change_password` | Chỉ lưu bản băm, không bao giờ lưu mật khẩu gốc |
| Chống dò mật khẩu | `failed_logins`, `locked_until` | Sai nhiều lần thì khóa tạm đến thời điểm `locked_until` |
| Thông tin cá nhân | `date_of_birth`, `guardian_name`, `guardian_phone`, `national_id`, `health_notes` | Người dưới tuổi `minor_age` (16) cần người giám hộ |
| Đồng ý dữ liệu | `pii_consent_at` | Thời điểm người dùng đồng ý cho lưu dữ liệu cá nhân |
| Google | `google_sub`, `google_email` | Liên kết đăng nhập Google; `google_sub` duy nhất khi có |
| Thời gian | `created_at` | |

**Luật về tài khoản quản lý:** quản lý có thể cấp và thu hồi tài khoản quản lý khác, nhưng hệ thống luôn giữ **ít nhất một** quản lý còn hoạt động.

### 5.2. Phiên đăng nhập và mã OTP

- **`sessions_auth`:** mỗi lần đăng nhập tạo một phiên.
  - Cột: `user_id`, `token_hash` (băm của token, duy nhất), `expires_at`, `created_at`, `revoked_at`.
  - Đăng xuất hoặc đổi mật khẩu thì ghi `revoked_at`, token cũ hết hiệu lực ngay.
- **`otp_challenges`:** mã một lần cho đăng ký và quên mật khẩu.
  - Cột: `phone`, `purpose`, `otp_hash`, `payload`, `expires_at`, `attempts`.
  - Mã chỉ lưu dạng băm. Đếm số lần nhập sai để chặn đoán mò.
  - Trang đăng ký và đặt lại mật khẩu **không còn hiện mã OTP trên màn hình**. Có thêm captcha, ô bẫy bot (honeypot) và thời gian chờ trước khi gửi lại mã.
- **`user_avatars`:** ảnh đại diện lưu thẳng trong database.
  - Cột: `user_id` (khóa chính, xóa user thì xóa ảnh), `bytes`, `mime`, `width`, `height`, `version`, `updated_at`.
  - Chỉ nhận JPEG, PNG, WebP; cạnh ảnh từ 64 đến 4096 điểm ảnh.

### 5.3. Môn thể thao và huấn luyện viên

- **`sports` (4 môn):** danh mục môn có thể thêm/bớt mà không sửa code.
  - `code` là khóa chính, chữ thường, ví dụ `badminton`.
  - Tên hai ngôn ngữ: `name_en`, `name_vi`.
  - `court_prefix`: hai chữ in hoa, duy nhất, dùng đặt mã sân.
  - Hiển thị: `color_key`, `glyph_key`, `sort_order`.
  - Luật chơi: `max_players` (mặc định 4), `slot_duration_min` (mặc định 60 phút).
  - Vòng đời: `enabled`, `retired_at`; có thêm `is_scope_all`.
- **`coach_sports` (5 dòng):** huấn luyện viên dạy được môn nào. Khóa chính là cặp (`user_id`, `sport`). Không xóa được user khi còn dòng ở đây.
- **`coach_certifications`:** bằng cấp của huấn luyện viên.
- **`coach_rates` (5 dòng):** đơn giá trả huấn luyện viên. Mặc định 150.000 đ mỗi buổi cộng 10.000 đ mỗi học viên.
- **`coach_payouts`:** bảng lương theo kỳ.
  - Mỗi huấn luyện viên chỉ có một dòng cho mỗi kỳ.
  - Trạng thái `closed` (đã chốt) hoặc `paid` (đã trả).

---

## 6. Khu sân và lịch sân

Đây là trái tim của hệ thống: làm sao để **không bao giờ có hai hoạt động cùng chiếm một sân cùng lúc**.

### 6.1. `courts`: các sân (17 sân demo)

- Cột: `court_code` (duy nhất, ví dụ `BD01`), `display_name`, `sport` (khóa ngoại sang `sports`), `status`, `sort_order`, `retired_at`.
- Trạng thái sân:
  - `ready`: sẵn sàng.
  - `maintenance`: đang bảo trì.
  - `closed`: đóng.

### 6.2. `occupancies`: sổ chiếm chỗ chung (1.256 dòng demo)

Thay vì để booking, buổi học, bảo trì mỗi thứ tự kiểm tra trùng giờ với nhau, Arena3 dồn mọi thứ chiếm sân vào **một sổ duy nhất**. Mỗi dòng nói: "sân X bị chiếm từ `start_at` đến `end_at` bởi việc Y".

| Cột | Ý nghĩa |
| --- | --- |
| `court_id` | Sân bị chiếm |
| `start_at`, `end_at` | Khoảng thời gian; luôn có `end_at > start_at` |
| `kind` | Loại chiếm chỗ: `hold` (đang giữ tạm), `booking` (đặt sân đã chốt), `session` (buổi học), `maintenance` (bảo trì). Giá trị `convert` chỉ còn vì lịch sử |
| `ref_id` | Trỏ tới dòng gốc (booking, buổi học…) |
| `reason` | Lý do, dùng cho bảo trì |

Ba lớp bảo vệ:

1. **Trigger `occupancies_no_overlap`:** từ chối dòng mới nếu giao với dòng khác trên cùng sân (phần 11). Khoảng thời gian tính kiểu "lấy đầu, bỏ cuối", nên 18:00–19:00 và 19:00–20:00 kề nhau vẫn hợp lệ.
2. **Unique (`kind`, `ref_id`, `court_id`):** một việc không thể chiếm cùng sân hai lần.
3. **Index (`court_id`, `start_at`):** tra lịch một ngày của một sân rất nhanh.

Tương tự, **`coach_occupancies` (61 dòng)** là sổ lịch của huấn luyện viên.

- Cột: `coach_id`, `session_id`, `start_at`, `end_at`.
- Có trigger riêng chặn một huấn luyện viên dạy hai buổi trùng giờ.

### 6.3. `court_bookings`: đặt sân (1.486 dòng demo)

| Nhóm | Cột |
| --- | --- |
| Mã | `code` (duy nhất, mã chứng từ dễ đọc) |
| Ai đặt | `user_id` cho hội viên, hoặc `guest_name` + `guest_phone` cho khách vãng lai. Check `booking_guest` bắt buộc có một trong hai |
| Sân và giờ | `court_id`, `start_at`, `end_at` |
| Trạng thái | `status`, `hold_until` (hạn giữ chỗ), `channel` (đặt online hay tại quầy) |
| Liên kết sổ chiếm chỗ | `occupancy_id` (duy nhất). Check `booking_occ_sync` giữ cho trạng thái và occupancy luôn khớp |
| Giá | `price_vnd`, `discount_pct`, `vat_rate`, `quota_hours` (số giờ trừ từ gói hội viên) |
| Khuyến mãi | `promo_id`, `promo_discount_vnd` |
| Cọc và đã trả | `deposit_vnd`, `paid_vnd` |
| Hủy | `cancel_refund_pct`, `cancel_fee_vnd` |
| Chuyển khoản | `transfer_requested_at`: khách báo đã chuyển khoản, chờ lễ tân đối soát |
| Đặt định kỳ | `series_id` trỏ tới `booking_series` |

**Vòng đời một booking** (enum `booking_status`):

```
hold ──(thanh toán/xác nhận)──► confirmed ──(check-in)──► in_use ──► completed
  │                                │
  └──(hết hạn/hủy)──► cancelled    ├──(hủy)──► cancelled
                                   └──(không đến)──► no_show
```

Hai unique index một phần đảm bảo **mỗi hội viên và mỗi số điện thoại khách chỉ giữ một sân `hold` tại một thời điểm**: `one_hold_per_user` và `one_hold_per_guest_phone`.

Các index khác phục vụ tra cứu:

- Theo người và ngày: (`user_id`, `start_at`).
- Theo sân và ngày: (`court_id`, `start_at`).
- Theo ngày: `start_at`.
- Theo chuỗi định kỳ: `series_id`.
- Booking đang chờ đối soát chuyển khoản: `bookings_awaiting_transfer_idx`.

### 6.4. `booking_series`: đặt sân cố định hằng tuần

Khách muốn chơi "tối thứ Tư 19:00 suốt 8 tuần" thì tạo một chuỗi.

- Cột chính:
  - `weekday`: 0–6.
  - `start_local`: giờ bắt đầu theo giờ địa phương.
  - `weeks`: số tuần.
  - `starts_on`: ngày bắt đầu.
  - `discount_pct`: mức giảm.
  - `status`: `active` hoặc `cancelled`.
- Mỗi tuần sinh một dòng `court_bookings` có `series_id` trỏ về chuỗi.
- Số tuần tối thiểu, tối đa và mức giảm mặc định nằm trong `center_settings`: 4–12 tuần, giảm 10%.

### 6.5. `price_rules`: bảng giá sân (20 dòng demo)

- Giá thay đổi theo:
  - Môn (`sport`), hoặc riêng từng sân (`court_id`).
  - Loại ngày (`day_kind`): `weekday`, `weekend`, `holiday`.
  - Khung giờ: `start_local` đến `end_local`.
- `price_vnd` phải lớn hơn 0 và không quá 5.000.000 đ.
- `is_peak` đánh dấu giờ cao điểm, ảnh hưởng tới việc có bắt cọc hay không.
- Hai cột `start_min`, `end_min` được database **tự tính** từ giờ, để so sánh khung giờ cho nhanh.

---

## 7. Khu lớp học

### 7.1. `classes`: lớp (13 lớp demo)

| Nhóm | Cột |
| --- | --- |
| Môn, trình độ | `sport`, `level` |
| Người dạy | `coach_id`, `assistant_id` (trợ giảng) |
| Sân | `court_id` |
| Sĩ số | `capacity` (> 0), `enrolled_count`, `min_enrolled` (≥ 1). Check `enrolled_cap`: số đã ghi danh không vượt sức chứa |
| Lịch | `rrule` (luật lặp lịch, ví dụ "thứ Hai và thứ Năm"), `duration_min` (mặc định 60), `start_on`, `end_on` |
| Trạng thái | `status`: `draft` → `open` → `closed`, hoặc `cancelled`; `cancel_reason` |
| Giá | `price_vnd` (≥ 0) |
| Giới thiệu | `description`, `syllabus` (tối đa 2.000 ký tự), `who_for`, `bring` (tối đa 300 ký tự) |

**Luật sĩ số tối thiểu:** khi lớp sắp mở mà chưa đủ `min_enrolled`, quản lý nhận thông báo để quyết định giữ hay hủy lớp.

### 7.2. `sessions`: từng buổi học (113 buổi demo)

- Mỗi lớp sinh ra nhiều buổi.
- Cột: `class_id`, `court_id`, `start_at`, `end_at`, `status` (`scheduled`, `done`, `cancelled`), `occupancy_id`.
- Không có hai buổi cùng lớp cùng giờ bắt đầu.
- Khi dời buổi, `original_start_at` giữ giờ gốc và `change_reason` ghi lý do. Nhờ vậy vẫn biết buổi này vốn là buổi nào.
- Mỗi buổi chiếm sân qua `occupancies` (kind `session`) và chiếm lịch huấn luyện viên qua `coach_occupancies`.

**Luật khi trung tâm hủy buổi:** học viên được hoàn **phần tiền của đúng một buổi** đó.

### 7.3. `enrollments`: ghi danh (148 dòng demo)

- Một dòng cho mỗi cặp (lớp, học viên); cặp này duy nhất.
- Trạng thái (`enroll_status`):
  - `hold`: đang giữ ghế, chờ trả tiền; hết hạn ở `hold_until` (mặc định 15 phút, cấu hình `class_hold_minutes`).
  - `confirmed`: đã trả tiền, chính thức trong lớp.
  - `waitlisted`: lớp đầy, đang xếp hàng; vị trí ở `waitlist_pos`.
  - `cancelled`: đã hủy.
- Check `waitlist_pos_chk`: chỉ dòng `waitlisted` mới có số thứ tự hàng chờ. Unique index `enrollments_waitlist_pos` đảm bảo không có hai người cùng vị trí trong một lớp.
- Cột tiền:
  - `price_vnd`: giá chốt lúc ghi danh.
  - `promo_id`, `promo_discount_vnd`: khuyến mãi.
  - `transfer_requested_at`: khách báo đã chuyển khoản.
  - `extension_vnd`, `extension_to`: tiền và ngày gia hạn gói hội viên kèm theo lớp (phần 8.3).
- `prepaid_sessions` còn lại từ giai đoạn tính tiền theo buổi trước đây.

**Luật giới hạn:** mỗi hội viên giữ hoặc học tối đa `max_active_classes` lớp cùng lúc (mặc định 3).

**Luật học phí:** học phí lớp **không hoàn** khi học viên tự bỏ; chỉ hoàn phần buổi mà trung tâm hủy.

### 7.4. Hàng chờ và lời mời

- **`waitlist_offers`:** khi có người rời lớp, người đứng đầu hàng chờ nhận một lời mời.
  - Cột: `enrollment_id`, `expires_at` (mặc định 2 giờ, cấu hình `waitlist_offer_hours`), `status`.
  - Trạng thái: `pending`, `accepted`, `expired`, `skipped`.
  - Hết hạn mà không nhận thì chuyển sang người kế tiếp.
- Sau mỗi thay đổi, hàm `waitlist_compact()` đánh lại số thứ tự hàng chờ thành 1, 2, 3… liền mạch.

### 7.5. Tính buổi và chứng nhận

- **`session_charges`:** ghi buổi nào đã trừ vào gói của học viên nào. Khóa chính (`session_id`, `user_id`) chống trừ hai lần.
- **`class_certificates`:** chứng nhận hoàn thành lớp.
  - Mỗi enrollment có tối đa một chứng nhận.
  - Cột: `code` (duy nhất, 6–24 ký tự), `attended` (số buổi đã đến), `sessions` (tổng số buổi), `issued_at`.
  - **Luật:** chỉ cấp khi lớp **đã kết thúc**.

---

## 8. Khu gói hội viên

### 8.1. `membership_plans`: các gói bán ra (12 gói demo)

- Cột:
  - `name`, `price_vnd` (≥ 0), `is_on_sale` (đang bán hay không).
  - Thời hạn: `duration_months` (1–120 tháng), kèm `duration_days`.
  - Quyền lợi: `session_quota` (số buổi), `court_hours` (số giờ sân miễn phí, mặc định 0), `court_discount_pct` (giảm giá sân 0–100%), `carry_over_hours` (giờ dư được chuyển sang kỳ sau).
- **Gói áp dụng cho mọi môn.** Cột phạm vi môn `sport_scope` đã bị xóa ở migration 0056.

### 8.2. `subscriptions`: gói mà một người đã mua (51 dòng demo)

- Cột:
  - `user_id`, `plan_id`, `start_on`, `end_on`.
  - `status`: `pending` (chờ thanh toán), `active`, `frozen` (tạm dừng), `expired`.
  - Quyền lợi còn lại: `court_hours_left`, `session_left`.
  - `frozen_days`: số ngày đã bảo lưu. Tối đa 30 ngày mỗi năm, cấu hình `freeze_max_days_year`.
  - `price_vnd`: **giá chốt lúc mua**; đổi giá gói sau đó không ảnh hưởng người đã mua.
  - `promo_id`, `promo_discount_vnd`.
- **Mỗi người chỉ một gói đang chạy:**
  - Unique index `one_live_sub_per_user` cho trạng thái `active` hoặc `frozen`.
  - `one_pending_sub_per_user` cho gói đang chờ thanh toán.

### 8.3. `membership_extensions`: gia hạn gói theo lớp

- Khi một lớp kéo dài quá ngày hết hạn gói, hội viên có thể trả thêm để gói kéo dài tới hết lớp.
- Cột: `subscription_id`, `enrollment_id`, `from_on`, `to_on`, `amount_vnd`, `status` (`active` hoặc `refunded`).
- Mỗi enrollment chỉ có một gia hạn đang hiệu lực (`one_active_extension_per_enrollment`).

Cấu hình liên quan trong `center_settings`:

- `member_court_fee_vnd`: phí sân của hội viên, mặc định 30.000 đ.
- `member_day_rate_vnd`: giá quy đổi một ngày gói, mặc định 16.667 đ, dùng để tính tiền gia hạn.

---

## 9. Khu tiền

### 9.1. `cashier_shifts`: ca thu ngân (3 dòng demo)

- Lễ tân mở ca trước khi nhận tiền mặt.
- Cột: `receptionist_id`, `opened_at`, `closed_at`, `cash_declared_vnd` (tiền mặt kê khai lúc đóng ca).
- Mỗi lễ tân chỉ có một ca đang mở (`one_open_shift`).
- **Luật:** quản lý có thể đóng ca thay lễ tân. Ca mở quá lâu, hoặc tiền kê khai lệch với tiền hệ thống ghi nhận, sẽ bị gắn cờ cảnh báo.

### 9.2. `payments`: mọi khoản thu và hoàn (1.523 dòng demo)

| Nhóm | Cột |
| --- | --- |
| Mã, người | `code`, `user_id`, `created_by`, `shift_id` (ca thu ngân nếu thu tại quầy) |
| Cách trả | `method`: `cash`, `transfer`, `card`, `gateway` (cổng online), `quota` (trừ quyền lợi gói) |
| Số tiền | `amount_vnd`, `vat_rate`, `discount_vnd`, `promo_id` |
| Trả cho cái gì | `ref_type` + `ref_id`: trỏ tới booking, enrollment, subscription… |
| Trạng thái | `status` |
| Cổng thanh toán | `capture_mode` (`manual` hoặc `auto`), `provider`, `provider_order_code` (duy nhất), `provider_txn_id`, `provider_status`, `paid_at` |
| Thời gian | `created_at` |

Trạng thái thanh toán (`pay_status`):

- `pending`: đã tạo đơn, chờ cổng thanh toán xác nhận.
- `posted`: tiền đã vào sổ.
- `failed`: cổng báo thất bại.
- `expired`: quá hạn không trả.
- `refund_pending`: khoản hoàn đang chờ duyệt.
- `refund_rejected`: khoản hoàn bị từ chối.

Khoản hoàn tiền là một dòng `payments` mang **số tiền âm**. Check `refund_amount_chk` giữ dấu số tiền khớp với trạng thái hoàn.

Cặp (`provider`, `provider_txn_id`) duy nhất, nên cùng một giao dịch từ cổng không thể được ghi nhận hai lần.

**Luật hoàn tiền hiện tại:**

- **Mọi khoản hoàn đều tạo ở trạng thái chờ (`refund_pending`)** và trả bằng tiền mặt sau khi được duyệt.
- Khoản hoàn lớn hơn `refund_manager_vnd` (mặc định 1.000.000 đ) phải do quản lý duyệt.
- Hội viên tự hủy đặt sân **không còn được hoàn tiền**.

### 9.3. Hóa đơn

- **`invoices` (49 dòng):** mỗi payment có tối đa một hóa đơn.
  - Người mua: `buyer_name`, `buyer_tax_code`, `buyer_address`, `buyer_phone`.
  - Người bán, sao lại từ cấu hình lúc xuất: `seller_legal_name`, `seller_tax_code`, `seller_address`.
  - Ký hiệu: `form_no`, `serial_no`.
  - Tiền: `subtotal_vnd`, `vat_rate`, `vat_vnd`, `total_vnd`.
  - Thời gian: `issued_at`, `exported_at`.
- **`invoice_lines` (49 dòng):** các dòng hàng.
  - Cột: `description`, `qty`, `unit`, `unit_vnd`, `amount_vnd`.

### 9.4. Khuyến mãi

- **`promotions` (4 dòng):**
  - Mã `code` không phân biệt hoa thường (unique trên `upper(code)`).
  - `kind`: `percent` (giảm phần trăm) hoặc `amount` (giảm số tiền); `value` > 0.
  - Giới hạn: `max_discount_vnd`, `min_order_vnd`, `starts_at`, `ends_at`, `max_uses`, `max_per_member`.
  - Phạm vi: `applies_to` (mặc định gói và sân), có thể bó theo `sport` hoặc `plan_id`; `stackable` cho biết được cộng dồn hay không.
  - `status`: `active` hoặc `paused`.
- **`promotion_redemptions`:** mỗi lần dùng mã.
  - Cột: `promo_id`, `user_id`, `payment_id` (duy nhất), `discount_vnd`.
  - `status`: `applied`, hoặc `restored` khi payment bị hoàn và lượt dùng được trả lại; thời điểm trả ghi ở `restored_at`.

### 9.5. Điểm thưởng

- **`loyalty_adjustments`:** cộng/trừ điểm thủ công.
  - Lý do: `redeem` (đổi điểm), `bonus` (thưởng), `correction` (sửa sai).
  - Số điểm khác 0.
- Tỷ lệ tích và đổi nằm trong `center_settings`:
  - `loyalty_earn_vnd`: chi 10.000 đ được 1 điểm.
  - `loyalty_redeem_vnd`: 1 điểm đổi 100 đ.
- **Luật:**
  - Việc đổi điểm được khóa hàng để không tiêu cùng một số điểm hai lần.
  - Mã sinh ra từ đổi điểm gắn với đúng hội viên đó.
  - Mã chưa dùng bị vô hiệu khi khoản thanh toán liên quan bị hoàn.

### 9.6. Bộ đếm mã chứng từ

- **`code_counters`:** khóa chính (`kind`, `yyyy`), cột `n`. Hàm `next_doc_code()` tăng bộ đếm để cấp mã booking, payment, hóa đơn theo năm.
- **`provider_sequences`:** mốc số đơn gửi sang cổng thanh toán, để không bao giờ dùng lại một số đơn cũ.

---

## 10. Khu vận hành, giao tiếp và huấn luyện

### 10.1. `center_settings`: một dòng cấu hình cả trung tâm

Bảng chỉ có đúng một dòng (check `id = 1`). Mọi con số kinh doanh có thể chỉnh mà không sửa code đều nằm ở đây.

| Nhóm | Cột (giá trị mặc định) |
| --- | --- |
| Chung | `timezone` (Asia/Ho_Chi_Minh), `currency` (VND), `open_time` 06:00, `close_time` 22:00 |
| Đặt sân | `slot_minutes` 60, `hold_minutes` 5, `book_ahead_days` 7, `max_slots_per_day` 2 |
| Hủy | `cancel_court_hours` 2, `cancel_class_hours` 4, `cancel_tiers` (bậc hoàn theo số giờ báo trước, bắt đầu bằng "trước 24 giờ hoàn 100%") |
| Check-in | `noshow_grace_minutes` 10, `checkin_before_minutes` 15, `self_checkin_enabled` **true**, `gate_dedup_minutes` 120 |
| Tiền | `vat_rate` 0, `round_vnd` 1.000, `refund_manager_vnd` 1.000.000, `transfer_hold_minutes` 120 |
| Cọc | `deposit_pct` 30, `deposit_peak_only` true (chỉ bắt cọc giờ cao điểm) |
| Đặt định kỳ | `series_min_weeks` 4, `series_max_weeks` 12, `series_discount_pct` 10 |
| Lớp | `class_hold_minutes` 15, `waitlist_offer_hours` 2, `max_active_classes` 3 |
| Gói | `freeze_max_days_year` 30, `member_court_fee_vnd` 30.000, `member_day_rate_vnd` 16.667 |
| Điểm thưởng | `loyalty_earn_vnd` 10.000, `loyalty_redeem_vnd` 100 |
| Chăm sóc | `at_risk_idle_days` 14 (bao lâu không đến thì coi là có nguy cơ rời bỏ), `minor_age` 16 |
| Pháp lý | `tax_code`, `legal_name`, `address` (in lên hóa đơn) |
| Giao diện | `ui_config` (cấu hình menu) |

Từ migration 0055, **tự check-in mặc định bật**.

### 10.2. Check-in và điểm danh

- **`attendance` (845 dòng):** một bảng cho hai loại (`att_kind`):
  - `session`: điểm danh buổi học. Mỗi học viên chỉ một dòng mỗi buổi.
  - `gate`: quẹt vào cổng trung tâm. Các lần quẹt trong vòng `gate_dedup_minutes` được gộp lại.
- Cột: `user_id`, `session_id`, `result`, `at`, `method`, `flagged`, `reason`, `checked_by`.
- Kết quả (`att_result`): `present`, `late`, `absent`, `excused`.
- **`checkin_tokens`:** mã QR check-in dùng một lần. Khóa chính là `jti` (định danh token); `used_at` ghi lúc đã dùng để không quét lại được.

### 10.3. Thông báo, tin nhắn, gọi video

- **`outbox` (650 dòng):** hàng đợi thông báo.
  - Cột: `channel`, `template`, `user_id`, `payload`.
  - `dedupe_key` duy nhất, chống gửi trùng.
  - Trạng thái gửi và đọc: `sent_at`, `attempts`, `read_at`.
- **View `inbox`:** cách nhìn `outbox` dưới dạng hộp thư của từng người dùng.
- **`conversations`:** mỗi cặp (hội viên, nhân viên) có một cuộc trò chuyện (unique `member_id`, `staff_id`).
- **`messages`:** tin nhắn tối đa 2.000 ký tự; có index để đếm tin chưa đọc nhanh.
- **`rtc_peers`, `rtc_signals`:** tín hiệu kết nối cho gọi video trực tiếp giữa hai trình duyệt.

### 10.4. Kiểm toán và an toàn

- **`audit_logs` (67 dòng):** mọi thao tác nhạy cảm.
  - Cột: `at`, `actor_id` (ai làm), `action`, `entity`, `entity_id`.
  - Ảnh chụp dữ liệu trước và sau: `before`, `after`.
  - Id tăng dần kiểu `bigserial`.
- **`feature_flags` (4 dòng):** bật/tắt tính năng theo `key`. Ví dụ cờ `F5` tắt thì huấn luyện viên gọi gợi ý giáo án sẽ bị từ chối (403).
- **`idempotency_keys`:** client gửi kèm một khóa cho mỗi thao tác ghi; gửi lại cùng khóa thì nhận lại kết quả cũ thay vì làm hai lần. Unique (`user_id`, `key`).

### 10.5. Huấn luyện

- **`training_plans`:** giáo án.
  - `scope`: cho cả lớp (`class_id`) hoặc một học viên (`user_id`); có thể gắn một buổi cụ thể (`session_id`).
  - Nội dung: `title`, `payload`, `published`.
  - Nguồn (`source`): mặc định `coach`, hoặc do AI gợi ý.
  - Phiên bản: `version`, `parent_id`.
  - `is_template`: lưu làm mẫu dùng lại. Huấn luyện viên lưu được **mọi** giáo án thành mẫu; trình độ không hợp lệ thì lấy trình độ hợp lệ gần nhất thay vì từ chối.
  - Giáo án không chia theo môn.
  - Gợi ý AI đọc danh sách học viên của lớp và soạn nháp cho **mọi buổi sắp tới**.
- **`training_plan_versions`:** lịch sử các bản sửa.
- **`session_results` (267 dòng):** kết quả từng học viên ở từng buổi.
- **`progress_reviews` (10 dòng):** đánh giá định kỳ.
  - Chu kỳ 2 hoặc 4 tuần.
  - Chấm kỹ thuật (`technique`), thể lực (`fitness`), thái độ (`attitude`) từ 1 đến 5.
  - **Chỉ được thêm, không được sửa hay xóa** (trigger `progress_reviews_no_change`).
- **`training_profiles` (51 dòng):** mục tiêu của học viên: `weight` (cân nặng), `technique`, `compete` (thi đấu), `fun` (vui).
- **`member_levels` (51 dòng):** trình độ hiện tại.
- **`coach_notes` (17 dòng):** ghi chú của huấn luyện viên.
- **`homework` (3 dòng):** bài tập về nhà, giao cho **hoặc** cả lớp **hoặc** một người, không cả hai.
- **`homework_recipients` (28 dòng):** ai nhận bài tập nào.

### 10.6. Thiết bị, sự cố, bảo trì

- **`equipment_items` (4), `equipment_loans` (8):** cho mượn vợt, bóng.
  - Trạng thái mượn (`loan_status`): `out` (đang mượn), `returned`, `lost`.
- **`tickets` (6):** phản ánh của khách.
- **`contact_log` (5):** lịch sử chăm sóc khách.
- **`work_orders` (3):** phiếu bảo trì.
  - `priority`: `low`, `normal`, `urgent`.
  - `status`: `open`, `in_progress`, `done`, `cancelled`.
  - `blocks_court`: có khóa sân hay không.
  - **Luật:** trước khi đưa sân vào bảo trì, hệ thống kiểm tra booking và buổi học đang có trên khung giờ đó.

### 10.7. Hình ảnh website

- **`site_assets` (42):** ảnh và video từng vị trí trên trang chủ, có bản mặc định, chữ thay thế hai ngôn ngữ và số phiên bản.
- **`site_asset_history`:** các bản cũ khi bị thay.
- **`media_library` (173):** thư viện ảnh có thể gắn thẻ; index GIN trên cột `tags` để lọc theo thẻ nhanh.

Bảng vé ngày `day_passes` từng tồn tại nhưng đã bị xóa ở migration 0029. Dữ liệu lịch sử có thể còn `ref_type='day_pass'`, nhưng không còn bảng đó.

---

## 11. Hàm SQL và trigger

**Hàm SQL** là đoạn xử lý đặt tên trong database, được code gọi chủ động. **Trigger** tự chạy khi dữ liệu thay đổi.

### 11.1. Ba trigger

| Trigger | Hàm | Việc làm |
| --- | --- | --- |
| `occupancies_no_overlap` | `occupancies_prevent_overlap()` | Trước khi thêm/sửa occupancy, từ chối nếu giao với dòng khác cùng sân. Báo lỗi `CONFLICT_SLOT` |
| `coach_occupancies_no_overlap` | `coach_occupancies_prevent_overlap()` | Chặn lịch huấn luyện viên chồng nhau |
| `progress_reviews_no_change` | `progress_reviews_append_only()` | Từ chối sửa/xóa đánh giá đã ghi |

Phần lõi của trigger chống trùng sân:

```sql
SELECT 1 FROM occupancies o
WHERE o.court_id = NEW.court_id
  AND o.id IS DISTINCT FROM NEW.id
  AND tstzrange(o.start_at, o.end_at, '[)') && tstzrange(NEW.start_at, NEW.end_at, '[)')
```

Đọc thành lời: "tìm một dòng khác trên cùng sân mà khoảng thời gian giao với khoảng mới". `[)` nghĩa là lấy điểm đầu, bỏ điểm cuối; `&&` là phép "có giao nhau".

### 11.2. Mười ba hàm được gọi chủ động

| Hàm | Việc làm |
| --- | --- |
| `occupancy_attach(court, start, end, kind, ref, reason)` | Thêm một dòng chiếm chỗ, trả id; chuẩn hóa lỗi khi trùng |
| `occupancy_confirm_hold(id)` | Đổi chỗ đang giữ (`hold`) thành đặt chính thức (`booking`) |
| `occupancy_release_booking(booking, terminal)` | Khóa booking, chuyển sang trạng thái kết thúc, rồi trả sân |
| `occupancy_release_session(session, terminal)` | Tương tự cho buổi học; trả cả lịch huấn luyện viên |
| `booking_replace_hold(user, phone, court, start, end, booking)` | Khóa sân, bỏ chỗ giữ cũ của người đó, giữ chỗ mới |
| `enrollment_hold(class, user, minutes, price)` | Khóa lớp, giữ ghế nếu còn chỗ, ghi giá và hạn giữ |
| `enrollment_confirm(class, user)` | Khóa lớp, kiểm tra sức chứa, chốt ghi danh, dọn hàng chờ |
| `enrollment_waitlist(class, user)` | Khóa lớp, xếp người vào cuối hàng chờ |
| `waitlist_compact(class)` | Đánh lại số thứ tự hàng chờ |
| `next_member_code()` | Cấp mã hội viên mới |
| `next_doc_code(kind)` | Cấp mã chứng từ theo năm |
| `normalize_phone(p)` | Chuẩn hóa số điện thoại về dạng +84 |
| `demo_fill_calendar()` | Bổ sung lịch demo cho có dữ liệu (chỉ chạy khi cờ demo bật) |

**Mẹo hàng chờ hai bước:** `waitlist_compact()` đổi số thứ tự sang **số âm** trước rồi mới đổi lại thành số dương. Nếu dồn trực tiếp vị trí 3 về 2 trong khi một dòng khác vẫn đang giữ số 2, unique index sẽ báo trùng giữa chừng. Đi vòng qua số âm thì không bao giờ đụng nhau.

---

## 12. Chống tranh chấp: khi hai người bấm cùng lúc

Transaction thôi chưa đủ. Nếu hai người cùng "đọc thấy còn chỗ rồi ghi", cả hai có thể cùng thành công. Arena3 kết hợp **transaction, khóa hàng, trigger và unique** thành nhiều lớp.

### 12.1. Hai người giữ cùng một sân

Trong `booking_replace_hold()`:

1. Giao dịch A khóa dòng `courts` của sân (`FOR UPDATE`).
2. Giao dịch B cũng muốn sân đó, phải **xếp hàng chờ**.
3. A bỏ chỗ giữ cũ nếu có, thêm occupancy mới, ghi booking, commit.
4. B được chạy tiếp. Trigger chống trùng thấy occupancy của A nên từ chối B. B nhận lỗi "khung giờ đã có người giữ".

Unique index `one_hold_per_user` là lớp bảo vệ thêm: một người mở hai tab giữ hai sân khác nhau cùng lúc cũng chỉ giữ được một.

### 12.2. Hai người tranh ghế cuối của lớp

1. `enrollment_hold()` khóa dòng `classes`.
2. Nó chỉ tăng `enrolled_count` khi còn chỗ và lớp đang `open`.
3. Người thứ hai phải chờ, đọc lại sĩ số đã tăng, và nhận lỗi `CLASS_FULL`.

Code xử lý đặt một **điểm lưu (`SAVEPOINT sp_enroll`)** trước khi gọi hàm. Nếu lớp đầy, nó quay về điểm lưu rồi xếp người đó vào hàng chờ. Không có điểm lưu thì transaction đã lỗi sẽ không chạy tiếp được.

Check `enrolled_cap` là lưới an toàn cuối cùng: dù code có sai, số ghi danh cũng không thể vượt sức chứa.

### 12.3. Cổng thanh toán báo về hai lần

Sau khi khách trả online, có **hai đường** báo kết quả:

- Trình duyệt hỏi lại trạng thái (verify).
- Cổng thanh toán gọi webhook về server.

Cả hai khóa cùng dòng payment rồi vào chung một hàm chốt tiền. Hàm này thấy payment đã `posted` thì dừng ngay. Thêm vào đó là unique trên mã đơn, mã giao dịch và hóa đơn, nên tiền không bao giờ được ghi nhận hai lần.

---

## 13. Kể chuyện: một ngày dữ liệu đi qua những bảng nào

### 13.1. Hội viên đặt sân online

1. Chọn sân BD01 lúc 19:00. Gọi `booking_replace_hold()`: thêm một dòng `occupancies` kind `hold` và một dòng `court_bookings` status `hold`, hạn giữ 5 phút.
2. Hệ thống tra `price_rules` để tính giá.
   - Có gói hội viên thì trừ `court_hours_left` trong `subscriptions` và ghi `quota_hours`.
   - Có mã khuyến mãi thì ghi `promo_id`.
   - Giờ cao điểm thì tính tiền cọc 30%.
3. Khách trả online: tạo `payments` status `pending`, `method = gateway`, có `provider_order_code`.
4. Cổng báo thành công:
   - Payment chuyển `posted`, ghi `paid_at`.
   - Booking chuyển `confirmed`; `occupancy_confirm_hold()` đổi occupancy sang kind `booking`.
   - Tạo `invoices` và `invoice_lines`, nếu có mã thì thêm `promotion_redemptions`.
   - Một dòng `outbox` báo cho khách.
5. Đến sân, quét QR: `checkin_tokens` đánh dấu đã dùng, thêm `attendance` kind `gate`, booking chuyển `in_use`, chơi xong chuyển `completed`.
6. Nếu không đến sau `noshow_grace_minutes`, booking chuyển `no_show` và sân được trả.

### 13.2. Khách vãng lai đặt tại quầy, trả tiền mặt

1. Lễ tân đã mở ca trong `cashier_shifts`.
2. Booking ghi `guest_name`, `guest_phone` thay vì `user_id`.
3. Payment `method = cash` có `shift_id` của ca đó.
4. Cuối ca, lễ tân kê khai `cash_declared_vnd`. Lệch với tổng tiền mặt trong ca thì ca bị gắn cờ.

### 13.3. Đăng ký lớp và hàng chờ

1. Lớp còn chỗ: `enrollment_hold()` tạo enrollment `hold`, tăng `enrolled_count`, hạn 15 phút.
2. Trả tiền xong: enrollment thành `confirmed`, có payment với `ref_type` trỏ tới enrollment.
3. Nếu lớp kéo dài quá ngày hết gói, có thể mua thêm một dòng `membership_extensions`.
4. Lớp đầy: enrollment `waitlisted` với `waitlist_pos` là cuối hàng.
5. Có người rút: người đầu hàng nhận `waitlist_offers` hạn 2 giờ. Nhận thì thành `hold`; bỏ qua thì offer `expired` và mời người kế tiếp; `waitlist_compact()` đánh lại thứ tự.
6. Mỗi buổi học, huấn luyện viên điểm danh vào `attendance` kind `session` và ghi `session_results`.
7. Lớp kết thúc thì cấp `class_certificates`.

### 13.4. Hủy và hoàn tiền

- Trung tâm hủy một buổi: buổi chuyển `cancelled`, `occupancy_release_session()` trả sân và lịch huấn luyện viên. Mỗi học viên có một payment hoàn **âm** bằng giá một buổi, ở trạng thái `refund_pending`.
- Quản lý duyệt: trả tiền mặt. Khoản trên 1.000.000 đ bắt buộc quản lý duyệt. Từ chối thì chuyển `refund_rejected`.
- Payment có mã khuyến mãi bị hoàn: lượt dùng chuyển `restored`; mã đổi điểm chưa dùng bị vô hiệu.
- Mọi bước đều để lại dấu vết trong `audit_logs`.

### 13.5. Mua gói hội viên

1. Tạo `subscriptions` status `pending` (chỉ một gói chờ mỗi người), giá chốt vào `price_vnd`.
2. Trả tiền: subscription chuyển `active`, có `start_on`/`end_on` và quyền lợi `court_hours_left`, `session_left`.
3. Bảo lưu: chuyển `frozen`, cộng `frozen_days`, tối đa 30 ngày mỗi năm.
4. Hết hạn: chuyển `expired`, khi đó mới mua được gói mới.

---

## 14. Index: tìm nhanh và chặn trùng

Index giống mục lục của sách. Unique index còn có thêm vai trò **chặn trùng**. Partial index chỉ đánh mục lục cho một nhóm dòng.

| Mục đích | Index |
| --- | --- |
| Tìm người theo tên | `users_name_norm_idx` trên `name_normalized` |
| Đăng nhập Google | Unique `users_google_sub` khi có `google_sub` |
| Lịch sân trong ngày | `occupancies_day_idx` (`court_id`, `start_at`) |
| Một chỗ giữ mỗi người | `one_hold_per_user`, `one_hold_per_guest_phone` |
| Booking theo người, ngày, sân, chuỗi | (`user_id`, `start_at`), `start_at`, (`court_id`, `start_at`), `series_id` |
| Chờ đối soát chuyển khoản | `bookings_awaiting_transfer_idx` |
| Lịch huấn luyện viên | (`coach_id`, `start_at`) trên `coach_occupancies` |
| Hàng chờ | Unique `enrollments_waitlist_pos`; `enrollments_hold_until_idx` để dọn ghế hết hạn |
| Một ca mở mỗi lễ tân | `one_open_shift` |
| Gói hội viên | `one_live_sub_per_user`, `one_pending_sub_per_user`, `one_active_extension_per_enrollment` |
| Báo cáo tiền | `payments` theo `created_at`, `user_id`, (`ref_type`, `ref_id`) |
| Cổng thanh toán | Unique `provider_order_code`; unique (`provider`, `provider_txn_id`) |
| Thông báo | `outbox` (`user_id`, `sent_at` giảm dần) |
| Nhật ký | `audit_logs` theo `at` giảm dần |
| Check-in cổng | `attendance` (`user_id`, `at`) cho kind `gate`; unique buổi/người cho kind `session` |
| Mã khuyến mãi | Unique `upper(code)` |
| Tin nhắn | Theo cuộc trò chuyện và thời gian; index riêng cho tin chưa đọc |
| Thư viện ảnh | GIN trên `tags` |

Khóa chính và unique constraint cũng tự tạo index tương ứng.

---

## 15. Bản đồ 57 migration

| Migration | Vai trò |
| --- | --- |
| `0002_arena3.sql` | Schema nền: enum, bảng nghiệp vụ, trigger chống trùng, hàm giữ/trả chỗ, hàm cấp mã |
| `0003_seed.sql` | Dữ liệu ban đầu |
| `0004_fix_codes.sql` | Sửa hàm cấp mã hội viên và chứng từ |
| `0005_class_sessions.sql` | Sinh buổi học cho lớp seed |
| `0006_seed_demo.sql`, `0007_nam_booking.sql` | Dữ liệu demo, lượt đặt mẫu |
| `0008_ops.sql` | Hàm ghi danh và hàng chờ, unique điểm danh, cờ tính năng, thiết bị |
| `0009_sunday_class.sql`, `0010_english_seed.sql` | Lớp và nội dung seed |
| `0011_scale_centre.sql` | Index cho lịch, tiền, user, audit; mở rộng dữ liệu demo |
| `0012_transfer_reconcile.sql` | Chờ đối soát chuyển khoản |
| `0013_ticket_replies.sql` | Phản hồi ticket |
| `0014_invoice_legal.sql` | Thông tin pháp lý trên hóa đơn |
| `0014_price_rule_repair.sql` | Sửa ma trận giá, giới hạn giá |
| `0015_payment_capture.sql` | Trạng thái chờ/thất bại/hết hạn, cột cổng thanh toán |
| `0015_trial_plan_off_sale.sql` | Ngừng bán gói dùng thử |
| `0016_drop_sms.sql`, `0017_demo_court.sql` | Bỏ kênh SMS; sân demo |
| `0018_provider_sequences.sql` | Mốc số đơn cổng thanh toán |
| `0019_fixlist_phase1.sql` | `read_at` và view `inbox`; số điện thoại trên hóa đơn |
| `0020_phase4_sessions.sql` | Giữ giờ gốc khi dời buổi |
| `0021_phase4c_training.sql` | Giáo án, kết quả, đánh giá chỉ-thêm, hồ sơ, bài tập |
| `0022_srs_v141.sql` | Bỏ công nợ/ghép sân; thêm check-in, khuyến mãi, chăm sóc khách, phiên bản giáo án |
| `0023_seed_activity.sql` | Hoạt động demo |
| `0024_deposit_series_ops.sql` | Cọc và bậc hoàn, đặt định kỳ, điểm thưởng, lương HLV, bảo trì |
| `0025_fill_calendar.sql`, `0026_fix_payment_codes.sql` | Lịch demo; sửa mã payment demo |
| `0027_class_hours.sql` | Lớp 90 phút đổi thành 60 phút |
| `0028_demo_fill.sql` | Hàm bổ sung lịch demo |
| `0029_drop_day_passes.sql` | Xóa vé ngày |
| `0030_idempotency_member_code.sql` | Khóa chống gửi lặp; sửa cấp mã hội viên |
| `0031_session_revoke.sql`, `0032_subscription_price_lock.sql` | Thu hồi phiên đăng nhập; chốt giá gói khi mua |
| `0033_manager_media_courts.sql` | Ảnh website và vòng đời sân |
| `0034_sports.sql` | Danh mục môn động thay cho enum cứng |
| `0035_media_library.sql` – `0037_staff_person_names.sql` | Thư viện ảnh, ảnh HLV, tên nhân viên seed |
| `0038_chat.sql` | Trò chuyện và gọi video |
| `0039_rename_center.sql` – `0041_rename_center_short.sql` | Đổi tên trung tâm; bảng ảnh đại diện |
| `0042_waitlist_order.sql` | Hàm dọn hàng chờ |
| `0043_session_charges.sql` | Trừ buổi theo gói |
| `0044_enroll_hold_status.sql`, `0045_sell_classes.sql` | Trạng thái giữ ghế, giá lớp, `enrollment_hold()` |
| `0046_min_size_and_certificates.sql` | Sĩ số tối thiểu, bằng cấp HLV, chứng nhận hoàn thành |
| `0047_ui_config.sql` – `0049_nav_plans.sql` | Cấu hình menu, giá lớp seed |
| `0050_class_description.sql` | Mô tả, giáo trình, hướng dẫn chuẩn bị |
| `0051_single_membership.sql` | Gói theo tháng, một gói mỗi người, gia hạn theo lớp |
| `0052_waitlist_compact_two_step.sql` | Dọn hàng chờ hai bước |
| `0053_google_link.sql` | Liên kết Google |
| `0054_max_active_classes.sql` | Giới hạn số lớp đang học |
| `0055_self_checkin_on.sql` | Bật tự check-in mặc định |
| `0056_drop_sport_scope.sql` | Bỏ phạm vi môn của gói: gói áp dụng mọi môn |

---

## 16. Tóm tắt để nhớ

1. **Một sổ chiếm chỗ (`occupancies`)** cho mọi thứ dùng sân, có trigger chặn trùng giờ. Đây là lý do không bao giờ có hai người cùng giữ một sân.
2. **Khóa hàng trước khi ghi:** khóa sân khi giữ sân, khóa lớp khi giữ ghế, khóa payment khi chốt tiền.
3. **Unique một phần** biến luật kinh doanh thành luật database:
   - Một chỗ giữ mỗi người.
   - Một gói đang chạy mỗi người.
   - Một ca mở mỗi lễ tân.
4. **Tiền là số nguyên đồng; hoàn tiền là dòng âm**, luôn qua bước chờ duyệt.
5. **Mọi con số kinh doanh nằm trong `center_settings`**, chỉnh được mà không sửa code.
6. **Lịch sử không bị xóa:**
   - Giá chốt lúc mua.
   - Giờ gốc khi dời buổi.
   - Đánh giá chỉ được thêm.
   - Mọi thao tác nhạy cảm vào `audit_logs`.
7. **57 file migration** (đánh số 0002–0056) kể lại lịch sử: đọc file sau để biết luật hiện tại.
