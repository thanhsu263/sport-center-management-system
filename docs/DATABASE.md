# Cơ sở dữ liệu Arena3 — từ bảng và khóa tới khóa hàng khi đặt chỗ

Tài liệu dành cho sinh viên mới học web, đối chiếu với `migrations/*.sql` và mã truy cập dữ liệu ngày 10/11/2026. Nội dung mô tả schema sau chuỗi migration hiện có, không phải ảnh chụp dữ liệu của một database đang triển khai. Không thể kết luận một DB thật đã chạy đủ migration chỉ từ việc file SQL tồn tại.

Các trích đoạn là code ngắn từ repo; đường dẫn `file:dòng` tính từ gốc dự án. Khi migration sau sửa migration trước, phần dưới ghi rõ thay đổi. Đọc cùng [KIEN-TRUC.md](KIEN-TRUC.md) để nối bảng với request và handler.

## Mục lục

1. [Bảng, kiểu dữ liệu, khóa và quan hệ](#1-khai-niem)
2. [PGlite khi phát triển, Postgres/Neon khi triển khai](#2-backend)
3. [Migration được áp dụng thế nào?](#3-migration)
4. [Người dùng, xác thực và môn thể thao](#4-users)
5. [Gói hội viên và đăng ký gói](#5-membership)
6. [Sân, khoảng chiếm sân, lượt đặt và giá](#6-san)
7. [Lớp, buổi học, đăng ký và hàng chờ](#7-lop)
8. [Thu tiền, hóa đơn và khuyến mãi](#8-tien)
9. [Cấu hình, thông báo, hội thoại và audit](#9-van-hanh)
10. [Các nhóm bảng bổ trợ](#10-bo-tro)
11. [Hàm SQL, trigger và view](#11-ham)
12. [Transaction và khóa hàng chống đặt trùng](#12-khoa)
13. [Index: tăng tốc và bảo vệ tính duy nhất](#13-index)
14. [Bản đồ migrations để tra cứu](#14-lich-su)

<a id="1-khai-niem"></a>
## 1. Bảng, kiểu dữ liệu, khóa và quan hệ

**Bảng là gì?** Một bảng lưu các hàng cùng cấu trúc. Mỗi hàng là một bản ghi; mỗi cột là một thuộc tính. Ví dụ một hàng trong `courts` là một sân, có `id`, `court_code`, `sport`, `status`.

**Schema là gì?** Là cấu trúc database: bảng, cột, kiểu, khóa, ràng buộc, index, hàm và view. Schema khác dữ liệu: tạo bảng sân là thay đổi schema; thêm sân CL-01 là thêm dữ liệu.

| Khái niệm | Cách hiểu | Ví dụ thật |
| --- | --- | --- |
| `PRIMARY KEY` — khóa chính | Nhận diện duy nhất một hàng, không được null | `users.id`, `migrations/0002_arena3.sql:52` |
| `FOREIGN KEY` / `REFERENCES` — khóa ngoại | Giá trị phải trỏ tới hàng tồn tại của bảng được tham chiếu | `subscriptions.plan_id` → `membership_plans.id`, cùng file `:96` |
| Khóa ghép | Nhiều cột cùng nhận diện một hàng | `coach_sports(user_id, sport)`, cùng file `:77` |
| `UNIQUE` | Không cho lặp giá trị hoặc bộ giá trị | `enrollments(class_id, user_id)`, cùng file `:242` |
| `NOT NULL` | Bắt buộc có giá trị | `users.full_name`, cùng file `:54` |
| `CHECK` | Điều kiện mỗi hàng phải thỏa | `classes.capacity > 0`, cùng file `:206` |
| `DEFAULT` | Giá trị dùng khi câu INSERT không cung cấp cột đó | UUID từ `gen_random_uuid()`, cùng file `:52` |
| `NULL` | Chưa có/không áp dụng; không đồng nghĩa số 0 hay chuỗi rỗng | Booking khách vãng lai có thể không có `user_id` |
| `ON DELETE CASCADE` | Xóa hàng cha thì xóa hàng con liên quan | Messages theo conversation, `migrations/0038_chat.sql:16` |

**Quan hệ một-nhiều:** một user có thể có nhiều booking; mỗi booking tham chiếu tối đa một user. **Nhiều-nhiều:** người dùng và lớp nối qua `enrollments`; một người có nhiều lớp, một lớp có nhiều người.

**Ví dụ — `migrations/0002_arena3.sql:236`:**

```sql
CREATE TABLE IF NOT EXISTS enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id),
  user_id UUID NOT NULL REFERENCES users(id),
  status enroll_status NOT NULL,
  waitlist_pos INT,
  UNIQUE (class_id, user_id),
```

`UNIQUE (class_id, user_id)` áp dụng cả hàng đã hủy. Vì vậy các hàm đăng ký có nhánh tái sử dụng hàng cũ, không cứ mỗi lần đăng ký lại là thêm một hàng mới.

### Một số kiểu gặp trong repo

| Kiểu | Dùng để làm gì? |
| --- | --- |
| `UUID` | ID như user, lớp, payment |
| `INT`, `SMALLINT`, `BIGINT`, `BIGSERIAL` | Số nguyên; audit và tín hiệu RTC dùng ID tự tăng |
| `VARCHAR(n)`, `TEXT` | Chuỗi có hoặc không có giới hạn độ dài ở kiểu |
| `DATE`, `TIME` | Ngày hoặc giờ riêng, như ngày hết gói và giờ mở cửa |
| `TIMESTAMPTZ` | Thời điểm có xử lý múi giờ, như `start_at`, `expires_at` |
| `NUMERIC` | Số thập phân chính xác, như VAT hoặc số giờ còn lại lịch sử |
| `JSONB` | Dữ liệu có cấu trúc linh hoạt: payload, audit trước/sau, cấu hình menu |
| `TEXT[]` | Mảng chuỗi: tag ảnh, phạm vi áp dụng promotion |
| `BYTEA` | Dữ liệu nhị phân: ảnh avatar hoặc media upload |
| Enum | Bộ nhãn hợp lệ, như `booking_status`, `enroll_status` |

Driver chuẩn hóa `bigint` thành number, `date` thành chuỗi ngày và interval thành text để hai backend trả dữ liệu tương thích (`src/server/data/db.ts:54`, `:89`, `:133`). `numeric` vẫn có thể là chuỗi trong JavaScript; không nên coi mọi cột số SQL đều trả JS number. `bigint` vượt giới hạn số nguyên an toàn của JS cần xử lý riêng, như comment trong file đã nêu.

<a id="2-backend"></a>
## 2. PGlite khi phát triển, Postgres/Neon khi triển khai

**Là gì?** PostgreSQL là hệ quản trị database. Neon là dịch vụ Postgres bên ngoài. PGlite đưa Postgres chạy qua WebAssembly, giúp dự án có database nhúng khi phát triển.

**Điều kiện thật trong code — `src/server/data/db.ts:18`:**

```ts
const isDeploy = typeof process !== "undefined" && (Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production");
export const dbSource: DbSource = databaseUrl && isDeploy ? "neon" : "pglite";
```

| Trường hợp | Backend theo biểu thức hiện tại |
| --- | --- |
| Dev thông thường | PGlite, kể cả có `DATABASE_URL` nhưng chưa thỏa `isDeploy` |
| Có URL không rỗng và có `VERCEL` hoặc `NODE_ENV=production` | Nhánh `neon`, dùng `pg.Pool` |
| Không có URL hợp lệ | PGlite theo biểu thức chọn backend; không nên suy chỉ từ chữ “production” rằng chắc chắn đã dùng Neon |

Đoạn code thực thi chính xác hơn comment rút gọn “có DATABASE_URL thì dùng Neon”. URL toàn khoảng trắng được coi là không đặt (`db.ts:7`). Nhánh có tên `neon` dùng driver `pg`, không gọi Neon HTTP SQL API (`:89`).

PGlite mặc định lưu ở `.pglite`; `PGLITE_DATA_DIR` đổi thư mục, giá trị `memory` chọn chế độ bộ nhớ và mất dữ liệu khi DB bị đóng (`db.ts:127`). Kết nối được chia sẻ qua promise trên `globalThis` để tránh HMR mở nhiều instance hoặc chạy migration đua nhau (`:46`).

**Truy vấn có tham số là gì?** SQL giữ cấu trúc riêng, giá trị người dùng truyền qua mảng tham số; không ghép thẳng input vào câu SQL.

**Ví dụ — `src/server/controllers/session.ts:113`:**

```ts
       from sessions_auth s
       join users u on u.id = s.user_id
      where s.token_hash = $1`,
    [sha256(token)],
```

`getSql()` trả giao diện có tagged template và `.query(text, params)` (`src/server/data/db.ts:30`, `:74`, `:230`). DB module chặn việc khởi tạo trong trình duyệt (`:213`); client phải gọi API thay vì import kết nối DB để đọc bảng.

<a id="3-migration"></a>
## 3. Migration được áp dụng thế nào?

**Migration là gì?** Là bước thay đổi schema hoặc dữ liệu được lưu bằng file SQL có thứ tự. Ví dụ thêm cột `revoked_at` vào session là một migration. **Seed** là dữ liệu ban đầu/demo; repo có nhiều file seed xen giữa các thay đổi schema.

### 3.1. PGlite tự áp dụng lúc khởi tạo

`createPgliteSql()` trong `src/server/data/db.ts:133` thực hiện:

1. Mở PGlite và chờ sẵn sàng.
2. Tạo `_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())` nếu chưa có (`:150`).
3. Lấy SQL ở `/migrations/*.sql` bằng `import.meta.glob` với `?raw`; khi chạy ngoài bundler thì có nhánh đọc file bằng Node (`:166`).
4. Đọc tên migration đã chạy; gọi `pendingMigrations()` để chọn phần còn thiếu.
5. Với **mỗi file**, chạy SQL và ghi tên vào `_migrations` trong cùng một transaction (`:189`). Nếu file lỗi, không ghi dấu đã chạy thành công cho file đó.
6. Tuần tự hóa các lượt migration qua promise chain trên `globalThis`, tránh hai request áp dụng cùng lúc (`:199`).

**Ví dụ — `src/server/data/db.ts:189`:**

```ts
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
```

### 3.2. Postgres bên ngoài dùng script migration

`createNeonSql()` tạo pool truy vấn, không tự chạy các file migration. `scripts/migrate.mjs:30` đọc thư mục, kết nối bằng `pg`, tạo cùng bảng `_migrations`, chạy `BEGIN` → SQL file → ghi tên → `COMMIT`; lỗi thì `ROLLBACK`. Script `build` gọi `db:migrate` sau Vite build (`package.json:11`). Không có `DATABASE_URL` thì script bỏ qua.

**Thứ tự dựa vào gì?** `scripts/migration-plan.mjs:42` sắp theo **tên file đầy đủ** bằng `localeCompare`, ghi nhận theo basename. Vì vậy hai file cùng tiền tố `0014` hay `0015` vẫn là hai migration khác nhau. `_migrations` không lưu checksum nội dung; sửa file đã ghi tên không khiến nó tự chạy lại.

Hai bộ áp dụng đều chỉ đọc `migrations/*.sql`, không đi xuống `migrations/auth/` (`db.ts:169`, `scripts/migration-plan.mjs:13`). Schema auth tùy chọn bên dưới thư mục đó không tự trở thành schema nghiệp vụ `/v1`.

**Vì sao tách `0044` và `0045`?** `0044_enroll_hold_status.sql:2` thêm nhãn enum `hold`; file tiếp theo mới dùng nó trong hàm SQL. Tương tự `0015_payment_capture.sql:17` giải thích không dùng nhãn enum mới trong chính transaction vừa thêm nhãn.

<a id="4-users"></a>
## 4. Người dùng, xác thực và môn thể thao

### 4.1. `users`: tài khoản nghiệp vụ

**Tạo ở:** `migrations/0002_arena3.sql:51`.

| Nhóm cột | Cột quan trọng | Khóa/ràng buộc |
| --- | --- | --- |
| Định danh | `id`, `member_code` | UUID PK; `member_code` unique, có thể null |
| Liên hệ | `full_name`, `name_normalized`, `phone`, `email` | Tên/phone bắt buộc; phone unique; email unique nhưng có thể null |
| Quyền/trạng thái | `role`, `status` | Enum vai trò `manager`, `coach`, `receptionist`, `member`; trạng thái `active`, `locked`, `disabled` |
| Đăng nhập | `password_hash`, `must_change_password`, `failed_logins`, `locked_until` | Hash bắt buộc; bộ đếm và mốc khóa phục vụ kiểm tra đăng nhập |
| Hồ sơ | `date_of_birth`, `guardian_name`, `guardian_phone`, `national_id`, `pii_consent_at`, `health_notes`, `created_at` | Phần lớn hồ sơ có thể null; không nên tự suy tất cả đều đã được người dùng cung cấp |
| Google | `google_sub`, `google_email` | Thêm ở `migrations/0053_google_link.sql:4`; unique partial index cho subject khác null |

`UNIQUE(email)` của schema này không tự làm email không phân biệt hoa/thường. Handler đăng nhập có `lower(email) = lower($1)` (`src/server/controllers/session.ts:59`); đó là xử lý truy vấn, khác một unique index trên `lower(email)`.

### 4.2. Session, OTP và avatar

| Bảng | Cột/quan hệ quan trọng | Nguồn |
| --- | --- | --- |
| `sessions_auth` | `id` PK, `user_id` FK → users, `token_hash` unique, `expires_at`, `created_at` | Tạo `migrations/0002_arena3.sql:425`; thêm `revoked_at` ở `0031_session_revoke.sql:2` |
| `otp_challenges` | `id` PK, `phone`, `purpose`, `otp_hash`, `payload JSONB`, `expires_at`, `attempts` | `migrations/0002_arena3.sql:433`; `phone` không phải FK sang users |
| `user_avatars` | `user_id` vừa PK vừa FK → users, xóa cascade; `bytes`, `mime`, `width`, `height`, `version`, `updated_at` | `migrations/0040_user_avatars.sql:2`; MIME chỉ JPEG/PNG/WebP, hai chiều từ 64 tới 4096 |

`sessions_auth` là phiên đăng nhập; **`sessions` ở mục lớp là buổi học**, hai bảng không cùng chức năng. DB chỉ lưu hash token Arena3; việc kiểm tra hết hạn/thu hồi diễn ra trong `src/server/controllers/session.ts:87`.

### 4.3. `sports` và `coach_sports`

Ban đầu môn thể thao là enum `sport_kind`. `migrations/0034_sports.sql:4` tạo `sports`: `code TEXT` PK có regex, `name_en`, `name_vi`, `court_prefix` unique có regex hai chữ in hoa, `color_key`, `glyph_key`, `is_scope_all`, `max_players`, `slot_duration_min`, `sort_order`, `enabled`, `retired_at`, các mốc tạo/sửa.

Migration này chuyển 10 cột môn sang `TEXT` có FK tới `sports(code)`: `courts.sport`, `membership_plans.sport_scope`, `subscriptions.sport_scope`, `classes.sport`, `price_rules.sport`, `equipment_items.sport`, `promotions.sport`, `member_levels.sport`, `progress_reviews.sport`, `coach_sports.sport`. Không nên đọc riêng `0002` rồi kết luận chỉ có thể thêm môn bằng sửa enum.

`coach_sports` tạo ở `migrations/0002_arena3.sql:74`, PK ghép `(user_id, sport)`; `user_id` FK tới users với `ON DELETE RESTRICT`. Kiểm tra vai trò có thực sự là coach thuộc tầng ứng dụng, không phải một `CHECK(role='coach')` trên bảng nối này.

<a id="5-membership"></a>
## 5. Gói hội viên và đăng ký gói

**Hai bảng khác nhau thế nào?** `membership_plans` là loại sản phẩm được bán; `subscriptions` là lần một hội viên đăng ký gói đó với ngày bắt đầu/kết thúc cụ thể.

| Bảng | Cột quan trọng | Khóa/ràng buộc và migration |
| --- | --- | --- |
| `membership_plans` | `id`, `name`, `sport_scope`, `duration_days`, `session_quota`, `court_hours`, `court_discount_pct`, `price_vnd`, `is_on_sale`, `carry_over_hours` | `id` PK; scope FK sang sports sau `0034`; discount 0–100, giá ≥ 0. Tạo `migrations/0002_arena3.sql:80` |
| Bổ sung plan | `duration_months` | Nullable, check 1–120; `migrations/0051_single_membership.sql:6` |
| `subscriptions` | `id`, `user_id`, `plan_id`, `sport_scope`, `start_on`, `end_on`, `status`, `court_hours_left`, `session_left`, `frozen_days` | PK UUID; FK tới users/plans; tạo `migrations/0002_arena3.sql:93` |
| Bổ sung subscription | `promo_id`, `promo_discount_vnd`, `price_vnd` | Promo FK thêm ở `migrations/0022_srs_v141.sql:94`; giá khóa lúc đặt thêm ở `0032_subscription_price_lock.sql:2` |
| `membership_extensions` | `id`, `subscription_id`, `enrollment_id`, `from_on`, `to_on`, `amount_vnd`, `status`, `created_at` | Hai FK tới subscriptions/enrollments; giá ≥ 0; `to_on >= from_on`; status `active`/`refunded`; tạo `migrations/0051_single_membership.sql:14` |

**Thay đổi lớn ở `0051`:** ngừng bán gói cũ, tạo gói theo tháng, chuyển phần quyền lợi còn lại của gói cũ thành ngày hội viên. Các cột quota vẫn còn để giữ lịch sử, không có nghĩa luồng giữ sân hiện tại tiếp tục trừ giờ gói (`migrations/0051_single_membership.sql:1`, `src/server/controllers/handlers/bookings.ts:635`).

Hai unique index ban đầu theo `(user_id, sport_scope)` bị bỏ. Hiện tại:

**Ví dụ — `migrations/0051_single_membership.sql:94`:**

```sql
create unique index if not exists one_live_sub_per_user on subscriptions (user_id)
  where status in ('active','frozen');
create unique index if not exists one_pending_sub_per_user on subscriptions (user_id)
  where status = 'pending';
```

Đây là **unique index có điều kiện**: mỗi user tối đa một gói active/frozen và một gói pending, nhưng vẫn có nhiều gói expired để giữ lịch sử. Nó không cấm một user đồng thời có một active và một pending.

`membership_extensions` có unique index chỉ cho một extension `active` trên mỗi enrollment (`0051:25`). Bảng này ghi lịch sử gia hạn gắn với lớp; việc tồn tại bảng không có nghĩa người chưa đủ hạn membership tự động được đăng ký lớp. Handler hiện gọi `assertMembershipOutlastsClass()`, yêu cầu ngày hết gói **lớn hơn** ngày hết lớp (`src/server/services/membership.ts:30`, `:97`).

View `v_subscription_debt` ban đầu ở `0002:315` đã bị bỏ bởi `migrations/0022_srs_v141.sql:8`. Không trình bày nó như view công nợ hiện còn dùng.

<a id="6-san"></a>
## 6. Sân, khoảng chiếm sân, lượt đặt và giá

### 6.1. `courts` và `occupancies`

**Khác nhau thế nào?** Sân là tài nguyên; occupancy là một khoảng thời gian tài nguyên đó bị chiếm. Cả lớp học, hold, booking và bảo trì đều có thể chiếm sân. Chỉ đọc `court_bookings` sẽ bỏ sót khoảng sân dùng cho lớp.

| Bảng | Cột quan trọng | Khóa/ràng buộc |
| --- | --- | --- |
| `courts` | `id`, `court_code`, `sport`, `status` | PK UUID, code unique; status `ready`/`maintenance`/`closed`; tạo `migrations/0002_arena3.sql:110` |
| Bổ sung courts | `retired_at`, `display_name`, `sort_order` | `migrations/0033_manager_media_courts.sql:33`; sport FK và check khác `all` ở `0034_sports.sql:32` |
| `occupancies` | `id`, `court_id`, `start_at`, `end_at`, `kind`, `ref_id`, `reason` | PK UUID; court FK; check `end_at > start_at`; unique `(kind, ref_id, court_id)`; tạo `migrations/0002_arena3.sql:120` |
| `coach_occupancies` | `id`, `coach_id`, `session_id`, `start_at`, `end_at` | PK; user FK; check thời gian; FK session được kiểm cuối transaction do `DEFERRABLE INITIALLY DEFERRED`; tạo `migrations/0002_arena3.sql:157`, FK ở `:231` |

`occupancies.ref_id` là ID đối tượng theo `kind`, **không phải một khóa ngoại chung trỏ tới mọi bảng**. Bảng booking/session lại giữ `occupancy_id` có FK cụ thể để liên kết.

Cột ghép sân `courts.convertible`, `pair_court_id`, `occupancies.convert_group_id` và hai hàm convert đã bị xóa trong `migrations/0022_srs_v141.sql:17`. Nhãn enum `convert` cũ vẫn còn; giữ nhãn không đồng nghĩa tính năng ghép sân vẫn hoạt động.

### 6.2. `court_bookings` — tên bảng thật của lượt đặt

Đường dẫn API dùng `/bookings`, nhưng bảng SQL là **`court_bookings`**, không có bảng nghiệp vụ tên đơn giản `bookings` trong schema này.

**Tạo ở:** `migrations/0002_arena3.sql:258`.

| Nhóm | Cột và quan hệ |
| --- | --- |
| Định danh/đối tượng | `id` PK, `code` unique; `court_id` FK → courts; `user_id` FK nullable → users; `guest_name`, `guest_phone` cho khách |
| Thời gian/trạng thái | `start_at`, `end_at`, `status`, `channel`, `hold_until`, `occupancy_id` unique FK → occupancies |
| Giá ban đầu | `price_vnd`, `discount_pct`, `vat_rate`, `quota_hours` |
| Chờ đối soát | `transfer_requested_at`, thêm ở `migrations/0012_transfer_reconcile.sql:19` |
| Khuyến mãi | `promo_id` FK, `promo_discount_vnd`, thêm ở `migrations/0022_srs_v141.sql:92` |
| Đặt định kỳ/tiền thu | `series_id` FK → booking_series, `deposit_vnd`, `paid_vnd`, `cancel_refund_pct`, `cancel_fee_vnd`, thêm ở `migrations/0024_deposit_series_ops.sql:48` |

**Ràng buộc quan trọng:**

- `booking_guest`: phải có user hoặc có đủ tên và phone khách. Điều kiện này không cấm một hàng có cả user lẫn thông tin khách (`0002:275`).
- `booking_occ_sync`: `hold`, `confirmed`, `in_use` phải có `occupancy_id`; `completed`, `cancelled`, `no_show` phải không có (`0002:276`).
- `one_hold_per_user`, `one_hold_per_guest_phone`: mỗi người/phone khách chỉ có một booking hold tại một thời điểm xét theo trạng thái (`0002:281`). Đây không phải giới hạn tất cả booking trong ngày.

Các cột deposit/quota vẫn hiện diện. Luồng tạo hold hiện tại đặt deposit bằng 0, thu đủ giá và tính phí hội viên theo ngày chơi (`src/server/controllers/handlers/bookings.ts:635`). Không suy chính sách hiện tại chỉ từ tên cột cũ.

### 6.3. Giá sân và chuỗi đặt cố định

`price_rules` tạo ở `migrations/0002_arena3.sql:185`: PK `id`; `sport` bắt buộc và trở thành FK sang sports sau `0034`; `court_id` là FK nullable sang courts. Day kind chỉ `weekday`, `weekend`, `holiday`; các cột còn lại gồm `start_local`, `end_local`, `price_vnd`, `is_peak`. `start_min`, `end_min` là cột generated từ giờ. Check `end_local > start_local`.

Migration `0014_price_rule_repair.sql:38` siết thêm giá **> 0 và ≤ 5.000.000**, ngoài check ≥ 0 ban đầu. Vì vậy giá 0 của lớp có thể hợp lệ nhưng giá 0 của một price rule sân không hợp lệ theo schema này.

`booking_series` tạo ở `migrations/0024_deposit_series_ops.sql:30`: `id` PK, `code` unique, user/court/created_by là FK, `guest_name`, `guest_phone`, `weekday` check 0–6, `start_local`, `weeks > 0`, `starts_on`, `discount_pct`, status `active`/`cancelled`, `created_at`. Các lượt của chuỗi trỏ về qua `court_bookings.series_id`; chuỗi không thay thế việc kiểm occupancy cho từng lượt.

<a id="7-lop"></a>
## 7. Lớp, buổi học, đăng ký và hàng chờ

### 7.1. `classes`: lớp có lịch lặp

**Tạo ở:** `migrations/0002_arena3.sql:199`.

| Nhóm | Cột, khóa và ràng buộc |
| --- | --- |
| Định danh/bộ môn | `id` PK; `sport` FK sang sports và check khác `all` sau `0034_sports.sql:111` |
| Người dạy/sân | `coach_id` bắt buộc, `assistant_id` tùy chọn → users; `court_id` → courts |
| Sức chứa | `capacity > 0`, `enrolled_count` mặc định 0; check `0 <= enrolled_count <= capacity` |
| Lịch | `rrule`, `duration_min`, `start_on`, `end_on`; `duration_min` default được đổi 90 → 60 ở `migrations/0027_class_hours.sql:17` |
| Trạng thái | `draft`, `open`, `closed`, `cancelled`; `cancel_reason` thêm ở `migrations/0020_phase4_sessions.sql:9` |
| Bán lớp | `price_vnd` nullable và check ≥ 0, thêm ở `migrations/0045_sell_classes.sql:3`; null nghĩa chưa có giá bán theo handler |
| Quy mô tối thiểu | `min_enrolled` nullable, check ≥ 1, thêm ở `migrations/0046_min_size_and_certificates.sql:4` |
| Nội dung giới thiệu | `description`, `syllabus` tối đa 2.000 ký tự; `who_for`, `bring` tối đa 300; thêm ở `migrations/0050_class_description.sql:5` |

`enrolled_count` là số đếm được code/hàm SQL duy trì, **không phải generated column tự đếm enrollments**. Ghế `hold` cũng được tính vào số này bởi `enrollment_hold()`. Không có trigger tổng quát trong các migration tự sửa count sau mọi câu UPDATE enrollment tùy ý.

Giới hạn 200 người trong handler (`src/server/controllers/handlers/classes.ts:16`, `:42`) khác check SQL ban đầu chỉ yêu cầu `capacity > 0` và count trong khoảng. Tương tự `min_enrolled` là cảnh báo quy mô theo comment migration, không tự hủy lớp khi chưa đủ người.

### 7.2. `sessions`: từng buổi cụ thể

**Tạo ở:** `migrations/0002_arena3.sql:216`.

- `id` PK; `class_id` FK → classes; `court_id` FK → courts.
- `start_at`, `end_at`, status `scheduled`/`done`/`cancelled`.
- `occupancy_id` unique FK → occupancies. Check `session_occ_sync` yêu cầu scheduled có occupancy, done/cancelled không có.
- Unique `(class_id, start_at)` tránh sinh hai buổi cùng lớp, cùng giờ bắt đầu.
- `original_start_at`, `change_reason` thêm ở `migrations/0020_phase4_sessions.sql:7`; index một phần trên `(class_id, original_start_at)` hỗ trợ tra buổi đã dời. Giữ mốc cũ giúp generator nhận ra lịch gốc đã được xử lý.

Buổi học trỏ tới lớp; enrollment trỏ tới lớp; attendance/session_results mới nối người học với từng buổi. Không có nghĩa mọi enrollment được sao chép thành một hàng cho mỗi session.

### 7.3. `enrollments`: giữ ghế, xác nhận, chờ hoặc hủy

**Tạo ở:** `migrations/0002_arena3.sql:236`.

| Cột/nhóm | Ý nghĩa và nguồn bổ sung |
| --- | --- |
| `id`, `class_id`, `user_id` | PK UUID; hai FK; unique `(class_id, user_id)` |
| `status`, `waitlist_pos` | Enum ban đầu confirmed/waitlisted/cancelled; nhãn `hold` thêm ở `migrations/0044_enroll_hold_status.sql:2` |
| `prepaid_sessions` | Default 0; thêm để giữ cơ chế buổi trả trước cũ ở `migrations/0043_session_charges.sql:11` |
| `hold_until`, `price_vnd`, `transfer_requested_at` | Thêm ở `migrations/0045_sell_classes.sql:4`; giữ hạn ghế và giá chốt lúc đặt |
| `extension_vnd`, `extension_to` | Thêm ở `migrations/0051_single_membership.sql:11`; extension_vnd ≥ 0 |
| `promo_id`, `promo_discount_vnd` | Promo FK và giảm giá chốt; thêm ở `migrations/0051_single_membership.sql:105` |

Check `waitlist_pos_chk` yêu cầu hàng `waitlisted` có vị trí, trạng thái khác có vị trí null. Unique partial index `(class_id, waitlist_pos)` khi vị trí khác null tránh hai người cùng vị trí trong một lớp (`0002:243`). Check không yêu cầu vị trí luôn dương; điều đó cho phép bản sửa `0052` tạm dùng số âm trong lúc đánh lại hàng.

`enrollments.price_vnd` được khai báo nullable mà không có check giá trực tiếp ở `0045`; check ≥ 0 trên `classes.price_vnd` không tự lan sang cột enrollment. Handler chịu trách nhiệm tạo báo giá phù hợp.

### 7.4. `waitlist_offers`: lời mời nhận ghế

Tạo ở `migrations/0002_arena3.sql:251`: `id` PK, `enrollment_id` FK, `expires_at`, status `pending`/`accepted`/`expired`/`skipped`.

Không có unique constraint `enrollment_id` trong bảng này; một enrollment có thể có lịch sử nhiều offer. Code phải lọc offer đang pending và còn hạn (`src/server/controllers/handlers/ops.ts:213`). Nhận offer của lớp có phí tạo ghế `hold`, không xác nhận ngay (`:186`).

### 7.5. Hai bảng liên quan lịch sử học

| Bảng | Cột/khóa đáng chú ý | Tạo ở |
| --- | --- | --- |
| `session_charges` | PK ghép `(session_id, user_id)`; FK tới sessions/users; subscription FK nullable; `charged`, `at` | `migrations/0043_session_charges.sql:2` |
| `class_certificates` | `id` PK; `enrollment_id` unique FK, xóa cascade; `code` unique dài 6–24; `attended >= 0`, `sessions >= 1`, `issued_at` | `migrations/0046_min_size_and_certificates.sql:20` |

Không nhầm bảng charge cũ với cơ chế thu học phí lớp hiện tại. Repo có test xác nhận điểm danh hiện không trừ buổi gói hay ghi charge mới (`src/server/controllers/tx.test.ts:4213`).

<a id="8-tien"></a>
## 8. Thu tiền, hóa đơn và khuyến mãi

### 8.1. `cashier_shifts` và `payments`

`cashier_shifts` tạo ở `migrations/0002_arena3.sql:286`: `id` PK; `receptionist_id` FK users; `opened_at`, `closed_at`, `cash_declared_vnd`. Unique index theo receptionist khi `closed_at IS NULL` chỉ cho một ca đang mở trên mỗi lễ tân.

`payments` tạo ở `migrations/0002_arena3.sql:296`:

| Nhóm | Cột và quan hệ |
| --- | --- |
| Định danh/người liên quan | `id` PK, `code` unique; `user_id`, `created_by` FK users; `shift_id` FK cashier_shifts, đều có thể null theo khai báo |
| Nội dung tiền | `method`, `amount_vnd`, `vat_rate`, `status`, `created_at` |
| Đối tượng được trả | `ref_type`, `ref_id`; hai cột bắt buộc, quan hệ do ứng dụng diễn giải |
| Cổng thanh toán | `capture_mode`, `provider`, `provider_order_code`, `provider_txn_id`, `provider_status`, `paid_at`, thêm ở `migrations/0015_payment_capture.sql:46` |
| Khuyến mãi | `promo_id` FK promotions, `discount_vnd`, thêm ở `migrations/0022_srs_v141.sql:88` |

**Quan hệ đa hình là gì?** Với `ref_type='booking'`, `ref_id` được hiểu là ID court booking; với `subscription` hoặc `enrollment`, nó trỏ theo nghiệp vụ khác. `payments.ref_id` **không được khai báo FK tới đồng thời các bảng này**. Handler cần kiểm tra đối tượng có thật và đúng chủ.

`pay_method` còn nhãn `quota` lịch sử. `pay_status` ban đầu có `posted`, `refund_pending`, `refund_rejected`; `0015` thêm `pending`, `expired`, `failed`. Check `capture_mode IN ('manual','auto')` phân biệt người xác nhận với cổng xác nhận, không đồng nhất capture mode với phương thức cash/card/transfer.

**Số tiền âm dùng khi nào?** Check hiện tại từ `migrations/0015_payment_capture.sql:38`:

```sql
  CASE
    WHEN status::text IN ('refund_pending', 'refund_rejected') THEN amount_vnd < 0
    WHEN status::text = 'posted' THEN true
    ELSE amount_vnd >= 0
  END
```

Payment hoàn tiền được duyệt có thể là `posted` với số tiền âm. Không được mô tả `posted` luôn dương hoặc mọi hàng payment đều là doanh thu đã nhận.

Unique partial index `payments_provider_order_code_idx` chặn mã đơn trùng; `payments_provider_txn_idx` chặn trùng `(provider, provider_txn_id)` khi transaction ID không null (`0015:64`, `:74`). Các cột gateway nullable; nhánh gateway phải ghi provider/transaction ID đúng, không suy mọi payment đều có mã ngân hàng.

### 8.2. `invoices` và `invoice_lines`

| Bảng | Cột/khóa quan trọng | Nguồn |
| --- | --- | --- |
| `invoices` | `id` PK, `code` unique; `payment_id` bắt buộc và unique FK payments; `buyer_name`, `buyer_tax_code`, `issued_at` | `migrations/0002_arena3.sql:323` |
| Thông tin pháp lý/số tiền | `form_no`, `serial_no`, `buyer_address`, `seller_legal_name`, `seller_tax_code`, `seller_address`, `subtotal_vnd`, `vat_rate`, `vat_vnd`, `total_vnd` | `migrations/0014_invoice_legal.sql:13` |
| Thông tin khách/xuất | `buyer_phone`; `exported_at` | `migrations/0019_fixlist_phase1.sql:37`; `0024_deposit_series_ops.sql:151` |
| `invoice_lines` | `id` PK, `invoice_id` FK; `description`, `qty`, `unit_vnd`, `amount_vnd`; thêm `unit` | `migrations/0002_arena3.sql:332`; `0014_invoice_legal.sql:26` |

Một payment có tối đa một invoice theo unique FK; một invoice có nhiều dòng. Schema không bắt buộc mọi payment đều có invoice và không dùng CHECK để tự chứng minh tổng tất cả invoice_lines bằng invoice.total. `issueInvoice()` chịu trách nhiệm dựng chứng từ (`src/server/controllers/helpers.ts:237`).

Thông tin bên bán được chép vào invoice lúc lập để thay đổi tên/địa chỉ trung tâm sau này không làm đổi chứng từ cũ; phần backfill ở `migrations/0014_invoice_legal.sql:84` thể hiện ý định đó. Schema không có trigger cấm sửa invoice hay tự biến nó thành hóa đơn điện tử đã ký số.

### 8.3. Promotions và lượt dùng

Tạo bởi `migrations/0022_srs_v141.sql:51`:

| Bảng | Cột quan trọng và ràng buộc |
| --- | --- |
| `promotions` | `id` PK; `code`, `name`, `kind` percent/amount; `value > 0`, phần trăm ≤ 100; `max_discount_vnd`, `min_order_vnd`, `starts_at`, `ends_at`, `max_uses`, `max_per_member`, `applies_to TEXT[]`, `sport`, `plan_id`, `stackable`, status active/paused, người tạo và các mốc thời gian |
| `promotion_redemptions` | `id` PK; promo/user/payment FK; `payment_id` unique; `discount_vnd >= 0`; status applied/restored; `created_at`, `restored_at` |

Check `promo_window` yêu cầu hạn kết thúc lớn hơn bắt đầu nếu có; giới hạn số lượt phải dương nếu được đặt. Unique index trên `upper(code)` làm mã giảm giá duy nhất không phân biệt hoa/thường (`0022:74`), khác unique email dạng nguyên bản.

Giá giảm có thể được chốt trên booking/subscription/enrollment trước; redemption được ghi khi tiền được post theo code, không chỉ vì người dùng vừa gõ thử mã (`src/server/services/promos.ts`, `src/server/controllers/handlers/classes.ts:574`). `applies_to` là mảng text; không có CHECK trong đoạn tạo bảng buộc mảng chỉ chứa một danh sách nhãn cố định.

### 8.4. Bộ đếm nội bộ và mã đơn nhà cung cấp

`code_counters(kind, yyyy, n)` có PK ghép `(kind, yyyy)` (`migrations/0002_arena3.sql:406`). Hàm cấp mã dùng `INSERT ... ON CONFLICT DO UPDATE` để tăng số theo phạm vi; mã chứng từ hiện lấy ngày Việt Nam qua `next_doc_code()` trong `migrations/0004_fix_codes.sql:12`. `next_member_code()` được sửa tiếp ở `0030_idempotency_member_code.sql:16` để bỏ qua mã đã tồn tại và không cắt số lớn hơn 9.999.

`provider_sequences` tạo ở `migrations/0018_provider_sequences.sql:38`: `provider` PK, `last_order_code BIGINT`, `updated_at`, `note`. Nó giữ mốc mã đơn lớn nhất của nhà cung cấp; `nextOrderCode()` ở `src/server/controllers/helpers.ts:163` dùng đồng hồ cùng mốc này. Mã payOS không còn đơn giản là bỏ dấu gạch khỏi mã PAY như comment cũ trong `0015`.

Migration `0018` nêu cần giữ mốc đã cấp khi chuyển DB vì payOS còn nhớ các mã bên ngoài DB. Đây là trạng thái cần đối chiếu khi chuyển dữ liệu, không phải cứ tạo DB rỗng là nhà cung cấp quên đơn cũ.

<a id="9-van-hanh"></a>
## 9. Cấu hình, thông báo, hội thoại và audit

### 9.1. `center_settings`: một hàng cấu hình chung

Tạo ở `migrations/0002_arena3.sql:21`. `id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)` cho phép tối đa một hàng; câu INSERT seed tạo hàng 1. Check không tự ngăn việc xóa hàng đó.

| Nhóm cấu hình | Cột tiêu biểu | Tạo/sửa ở |
| --- | --- | --- |
| Địa phương/giờ | `timezone`, `currency`, `open_time`, `close_time`, `slot_minutes` | `migrations/0002_arena3.sql:23` |
| Đặt/hủy/check-in | `hold_minutes`, `book_ahead_days`, `max_slots_per_day`, `cancel_court_hours`, `cancel_class_hours`, `noshow_grace_minutes`, `checkin_before_minutes` | Cùng file `:28` |
| Tiền/pháp lý | `refund_manager_vnd`, `vat_rate`, `round_vnd`, `tax_code`, `legal_name`, `address` | Cùng file `:36` |
| Membership/hàng chờ | `freeze_max_days_year`, `minor_age`, `waitlist_offer_hours` | Cùng file `:37` |
| Đối soát | `transfer_hold_minutes` default 120 | `migrations/0012_transfer_reconcile.sql:24` |
| Điểm danh/chăm sóc | `self_checkin_enabled`, `gate_dedup_minutes`, `at_risk_idle_days` | `migrations/0022_srs_v141.sql:29` |
| Đặt chuỗi/hoàn/tích điểm | `deposit_pct`, `deposit_peak_only`, `cancel_tiers JSONB`, `series_min_weeks`, `series_max_weeks`, `series_discount_pct`, `loyalty_earn_vnd`, `loyalty_redeem_vnd` | `migrations/0024_deposit_series_ops.sql:10`; deposit_pct check 0–100 ở `:24` |
| Ghế lớp | `class_hold_minutes` default 15, check 1–240 | `migrations/0045_sell_classes.sql:7` |
| Menu/danh sách | `ui_config JSONB` default `{}` | `migrations/0047_ui_config.sql:6`; `0049_nav_plans.sql` sửa menu đã lưu |
| Membership hiện tại | `member_court_fee_vnd` default 30.000 và ≥ 0; `member_day_rate_vnd` default 16.667 và > 0 | `migrations/0051_single_membership.sql:8` |
| Giới hạn lớp | `max_active_classes` default 3, check 1–50 | `migrations/0054_max_active_classes.sql:2` |

`debt_limit_vnd`, `deposit_pct_activates` bị xóa ở `0022_srs_v141.sql:8`; `day_pass_vnd` được thêm ở `0024` rồi xóa ở `0029_drop_day_passes.sql:7`. Cột deposit được giữ từ giai đoạn khác không chứng minh luồng đặt sân hiện tại đang thu cọc.

Default trong migration là giá trị khởi tạo, không phải giá trị mà quản lý không thể thay đổi. Nhiều kiểm tra cấu hình còn nằm trong handler, không phải tất cả cột INT đều có check SQL về khoảng hợp lệ.

### 9.2. Notifications: `outbox` và view `inbox`

Trong schema này không có bảng riêng tên `notifications`. Endpoint thông báo đọc qua cơ chế outbox/inbox.

`outbox` tạo ở `migrations/0002_arena3.sql:443`: `id` PK, `channel`, `template`, `user_id` FK nullable, `payload JSONB`, `dedupe_key` unique, `sent_at`, `attempts`, `created_at`. `read_at` thêm ở `migrations/0019_fixlist_phase1.sql:45`.

**Ví dụ — `migrations/0019_fixlist_phase1.sql:48`:**

```sql
CREATE OR REPLACE VIEW inbox AS
  SELECT * FROM outbox WHERE sent_at IS NOT NULL AND channel = 'inapp';
```

**View là gì?** Là câu SELECT được đặt tên để truy vấn như một bảng. `inbox` không lưu một bản sao thông báo tách khỏi outbox. Migration phải khai báo lại view khi thêm `read_at`, vì `SELECT *` trong view đã chốt danh sách cột lúc tạo.

`notifyFlush()` chọn hàng chưa gửi và còn dưới 5 lần thử (`src/server/data/jobs.ts:117`); `enqueue()` dùng dedupe key (`src/server/controllers/helpers.ts:181`). Migration `0016_drop_sms.sql:14` đánh dấu các hàng SMS cũ và bỏ flag SMS; không coi schema có chuỗi channel là bằng chứng hệ thống gửi SMS thật.

### 9.3. Hội thoại, tin nhắn và tín hiệu RTC

Tạo ở `migrations/0038_chat.sql`:

| Bảng | Cột/khóa/ràng buộc |
| --- | --- |
| `conversations` (`:3`) | UUID PK; `member_id`, `staff_id` FK users và xóa cascade; unique cặp member/staff; `created_at` |
| `messages` (`:14`) | UUID PK **không có default sinh UUID trong SQL**; `conversation_id` FK cascade, `sender_id` FK users cascade; `body` bắt buộc, độ dài ≤ 2.000; `created_at`, `read_at` |
| `rtc_peers` (`:26`) | PK ghép `(room, peer_id)`; `name`, `last_seen` |
| `rtc_signals` (`:34`) | BIGSERIAL PK; `room`, `from_peer`, `to_peer`, `kind`, `payload JSONB`, `created_at` |

Tên `member_id`/`staff_id` không tự tạo CHECK vai trò trong SQL. Kiểm tra người được chat và quyền xem conversation thuộc `src/server/controllers/handlers/chat.ts`. `messages.body` check độ dài tối đa không tự cấm chuỗi trắng; phần input cần được handler kiểm tra.

RTC lưu tín hiệu kết nối theo room/peer, không có FK từ các chuỗi peer sang users trong migration này. Không nên mô tả bảng tín hiệu là bảng lưu nội dung video.

### 9.4. Audit, feature flags và chống gửi lặp

| Bảng | Nội dung và ràng buộc | Nguồn |
| --- | --- | --- |
| `audit_logs` | `id BIGSERIAL` PK, `at`, `actor_id`, `action`, `entity`, `entity_id`, `before`, `after JSONB` | `migrations/0002_arena3.sql:388`; `actor_id`/`entity_id` không có FK ở khai báo này |
| `feature_flags` | `key VARCHAR(16)` PK, `enabled` | `migrations/0002_arena3.sql:399`; những migration sau cập nhật các flag |
| `idempotency_keys` | Key request, user, method/path, request hash, response code/body, thời gian tạo/hết hạn | Tạo `migrations/0002_arena3.sql:413`; sửa ở `0030_idempotency_member_code.sql:5` |

Ở `0030`, PK đơn `key` bị bỏ, `user_id` được đặt NOT NULL/default UUID toàn số 0, tạo unique `(user_id, key)`; `response_code`/`response_body` cho phép null để biểu diễn đang xử lý. `user_id` ở bảng này không có FK user. Không áp quy tắc “mọi cột tên user_id đều là FK”.

`audit()` ghi log trước/sau bằng code (`src/server/controllers/helpers.ts:105`). Các migration không tạo trigger audit tự động cho mọi bảng, cũng không cấm sửa/xóa audit bằng một append-only trigger. Điều này khác `progress_reviews`, có trigger bảo vệ riêng ở mục 11.

<a id="10-bo-tro"></a>
## 10. Các nhóm bảng bổ trợ

### 10.1. Điểm danh, giáo án và theo dõi tiến bộ

| Bảng | Cột/quan hệ và check đáng chú ý | Migration |
| --- | --- | --- |
| `attendance` | `id` PK; `kind`, user FK, session FK nullable; `result`, `at`; bổ sung `method`, `flagged`, `reason`, `checked_by` FK | Tạo `0002_arena3.sql:361`; unique session/user khi kind=session ở `0008_ops.sql:13`; bổ sung `0022_srs_v141.sql:33` |
| `checkin_tokens` | `jti UUID` PK, user FK, `used_at`; lưu token QR đã dùng | `0022_srs_v141.sql:41` |
| `training_plans` | PK; `scope`, class/user FK nullable, `source`, `published`, `payload JSONB`; thêm session/created_by FK, title, created_at; thêm version/is_template/parent_id tự tham chiếu | `0002_arena3.sql:370`; `0021_phase4c_training.sql:6`; `0022_srs_v141.sql:116` |
| `training_plan_versions` | PK; plan FK cascade, version, title, payload, edited_by FK, created_at; unique `(plan_id, version)` | `0022_srs_v141.sql:121` |
| `session_results` | PK; session/user FK; plan_pct 0–100, metrics JSONB, note, recorded_by FK; unique `(session_id,user_id)` | `0021_phase4c_training.sql:13` |
| `progress_reviews` | PK; user/coach FK, sport FK sau `0034`; period_weeks 2 hoặc 4; technique/fitness/attitude mỗi giá trị 1–5; comment, created_at | `0021_phase4c_training.sql:27` |
| `training_profiles` | user_id vừa PK vừa FK; goal weight/technique/compete/fun, updated_at | `0021_phase4c_training.sql:50` |
| `member_levels` | PK ghép user/sport; level beginner/intermediate/advanced; assessed_by FK, updated_at | `0021_phase4c_training.sql:56`; sport đổi ở `0034` |
| `coach_notes` | PK; user/coach FK, body, created_at | `0021_phase4c_training.sql:66` |
| `homework` | PK; coach FK; class hoặc user FK; title/body/checklist/due_on; check XOR buộc đúng một đích class/user | `0021_phase4c_training.sql:76` |
| `homework_recipients` | PK ghép homework/user; homework FK cascade; user FK; done_items JSONB, completed_at | `0021_phase4c_training.sql:89` |
| `coach_certifications` | PK; coach FK cascade, name dài 1–120, issuer ≤120, issued_on/expires_on; check hạn không trước ngày cấp khi có cả hai; created_by FK | `0046_min_size_and_certificates.sql:7` |

Tên migration trong bảng trên đều thuộc thư mục `migrations/`. Các cột JSONB không tự có schema TypeScript bên trong; validation payload nằm ở handler/service. Mặc dù có comment “scope”, `training_plans` ban đầu không có check XOR đích như `homework`.

### 10.2. Thiết bị, hỗ trợ, chăm sóc và vận hành

| Bảng | Nội dung và quan hệ | Migration tạo/sửa |
| --- | --- | --- |
| `equipment_items` | UUID PK, `sku` unique, name, sport FK nullable sau `0034`, stock, rent_vnd | `migrations/0002_arena3.sql:341` |
| `equipment_loans` | PK; item FK, booking FK nullable, phone, qty, status out/returned/lost, due_at/returned_at | `migrations/0002_arena3.sql:350` |
| `tickets` | PK; user FK nullable; body, status, created_at; thêm reply/replied_at/replied_by FK | `migrations/0002_arena3.sql:380`; `0013_ticket_replies.sql:17` |
| `contact_log` | PK; user FK; reason/channel/outcome/note; created_by FK, created_at | `migrations/0022_srs_v141.sql:100` |
| `loyalty_adjustments` | PK; user FK; points khác 0; reason redeem/bonus/correction; note; promo/created_by FK; created_at | `migrations/0024_deposit_series_ops.sql:87` |
| `coach_rates` | coach_id vừa PK vừa FK; per_session_vnd/per_student_vnd ≥0; updated_at | `migrations/0024_deposit_series_ops.sql:102` |
| `coach_payouts` | PK; coach FK, period CHAR(7), sessions, students, amount_vnd, status closed/paid, closed_by FK, closed_at/paid_at; unique `(coach_id,period)` | `migrations/0024_deposit_series_ops.sql:112` |
| `work_orders` | PK, code unique, court FK nullable, title/description, priority low/normal/urgent, status open/in_progress/done/cancelled, blocks_court, assignee, cost_vnd ≥0, resolution, reported_by FK, các mốc thời gian | `migrations/0024_deposit_series_ops.sql:130` |

Không tự thêm check “stock luôn không âm” hay “qty luôn dương” vào mô tả schema nếu câu CREATE TABLE không có. Handler có thể kiểm tra những điều đó; đây là hai lớp bảo vệ khác nhau.

`day_passes` từng được tạo ở `0024_deposit_series_ops.sql:66` nhưng bị xóa ở `migrations/0029_drop_day_passes.sql:6`. Dữ liệu payment/audit lịch sử có thể vẫn mang `ref_type='day_pass'`; không có nghĩa bảng vé ngày còn tồn tại.

### 10.3. Media của website

| Bảng | Cấu trúc chính | Migration |
| --- | --- | --- |
| `site_assets` | `slot` PK, kind image/video; src_path/default_path, mime/bytes, width/height, alt_en/alt_vi, enabled/version, updated_at/updated_by FK | `migrations/0033_manager_media_courts.sql:4` |
| `site_asset_history` | UUID PK, slot FK site_assets, đường dẫn/bytes/MIME/kích thước cũ, replaced_at/replaced_by FK | Cùng file `:21` |
| `media_library` | text id PK, path unique, kind/category/tags, width/height, alt_en/alt_vi, credit/source_url/license, created_at | `migrations/0035_media_library.sql:4` |

Ảnh upload có thể lưu `BYTEA`; thư viện có thể chỉ lưu đường dẫn và metadata. Không nên suy dự án bắt buộc dùng S3 chỉ vì có ảnh và video.

<a id="11-ham"></a>
## 11. Hàm SQL, trigger và view

**Hàm SQL là gì?** Là đoạn xử lý được đặt tên trong database, có thể nhận tham số và được gọi bằng SELECT. **Trigger** tự gọi hàm khi một sự kiện trên bảng xảy ra, như trước INSERT/UPDATE. Hàm được gọi chủ động và trigger tự chạy là hai cơ chế khác nhau.

| Hàm/cơ chế | Tác dụng | Migration hiện liên quan |
| --- | --- | --- |
| `occupancies_prevent_overlap()` + trigger `occupancies_no_overlap` | Trước INSERT/UPDATE occupancy, từ chối khoảng giao nhau trên cùng sân, báo `CONFLICT_SLOT`, SQLSTATE `23P01` | `migrations/0002_arena3.sql:138`, `:153` |
| `coach_occupancies_prevent_overlap()` + trigger | Từ chối lịch coach chồng nhau | Cùng file `:166`, `:181` |
| `occupancy_attach()` | Thêm occupancy, trả UUID, chuẩn hóa lỗi conflict | Cùng file `:458` |
| `occupancy_confirm_hold()` | Đổi kind hold thành booking; sai kind/không còn hold báo lỗi | Cùng file `:472` |
| `occupancy_release_booking()` | Khóa booking, chuyển terminal/null occupancy_id trước khi xóa occupancy | Cùng file `:480` |
| `occupancy_release_session()` | Tương tự cho session; xóa cả coach occupancy | Cùng file `:494` |
| `booking_replace_hold()` | Khóa sân; giải phóng hold cũ của user/phone; gắn occupancy hold mới | Cùng file `:534` |
| `normalize_phone()` | Chuẩn hóa các tiền tố điện thoại về +84 theo các nhánh SQL | Cùng file `:554` |
| `next_doc_code()` | Tăng bộ đếm và tạo mã chứng từ theo ngày | Tạo `0002`; sửa `migrations/0004_fix_codes.sql:12` |
| `next_member_code()` | Cấp mã hội viên, tránh đụng mã đã có và tránh cắt số thứ tự lớn | Tạo `0002`, sửa `0004`, bản sau ở `migrations/0030_idempotency_member_code.sql:16` |
| `enrollment_confirm()` | Khóa lớp, kiểm sức chứa, tái sử dụng/ghi enrollment và dọn hàng chờ | Tạo `0002`, sửa `0008`, bản sau ở `migrations/0042_waitlist_order.sql:16` |
| `enrollment_waitlist()` | Khóa lớp, tính vị trí cuối, tái sử dụng hoặc thêm hàng chờ | Tạo `0008`, sửa `0042`, bản sau ở `migrations/0045_sell_classes.sql:43` |
| `enrollment_hold()` | Khóa lớp, tăng sĩ số có điều kiện, ghi giá và hạn hold | `migrations/0045_sell_classes.sql:12` |
| `waitlist_compact()` | Đánh lại vị trí hàng chờ 1..n | Tạo `0042`, thay bằng hai bước ở `migrations/0052_waitlist_compact_two_step.sql:6` |
| `progress_reviews_append_only()` + trigger | Từ chối UPDATE/DELETE review đã ghi | `migrations/0021_phase4c_training.sql:41` |
| `demo_fill_calendar()` | Bổ sung dữ liệu demo theo lịch, được kiểm soát bằng feature flag | `migrations/0028_demo_fill.sql`; job gọi ở `src/server/data/jobs.ts:275` |

Các hàm convert và view công nợ đã bị xóa ở `0022`; chúng không thuộc danh sách chức năng hiện còn sau khi áp dụng đầy đủ migrations. `inbox` là view hiện còn, được tạo ở `0002:455` và khai báo lại ở `0019:48`.

### Ví dụ: trigger kiểm tra khoảng thời gian

**`migrations/0002_arena3.sql:142`:**

```sql
    SELECT 1 FROM occupancies o
    WHERE o.court_id = NEW.court_id
      AND o.id IS DISTINCT FROM NEW.id
      AND tstzrange(o.start_at, o.end_at, '[)') && tstzrange(NEW.start_at, NEW.end_at, '[)')
```

`[)` có nghĩa lấy đầu khoảng, không lấy cuối. Vì vậy 18:00–19:00 và 19:00–20:00 được phép kề nhau. `&&` là toán tử giao nhau của range. Trigger tự chạy cho mỗi hàng; đây không phải một exclusion constraint dùng `btree_gist` — đầu file `0002:1` nêu chủ đích tương thích PGlite.

### Ví dụ: dọn hàng chờ hai bước

`migrations/0052_waitlist_compact_two_step.sql:9` cập nhật vị trí mới sang số âm trước; tới `:18` mới đổi dấu về số dương. Nếu dồn trực tiếp 3 → 2 khi một hàng khác vẫn giữ 2, unique index có thể từ chối giữa chừng. Hai bước tránh đụng các vị trí dương đang tồn tại. Đây là bản thay thế hàm trong `0042`, không phải trigger tự chạy sau mọi thay đổi hàng chờ.

<a id="12-khoa"></a>
## 12. Transaction và khóa hàng chống đặt trùng

**Transaction là gì?** Là nhóm câu SQL được commit cùng nhau hoặc rollback khi thất bại. **Khóa hàng** khiến transaction khác muốn sửa/khóa cùng hàng phải chờ. Transaction đơn thuần không tự biến mọi lần “đọc chỗ trống rồi ghi” thành an toàn khi nhiều request chạy đồng thời.

`withTx()` ở `src/server/controllers/tx.ts:64` dùng PGlite transaction hoặc một connection `pg` với BEGIN/COMMIT/ROLLBACK. Các khóa `FOR UPDATE` có ý nghĩa khi được giữ trong transaction của toàn thao tác.

### 12.1. Hai người giữ cùng sân

**Ví dụ — `migrations/0002_arena3.sql:540`:**

```sql
  PERFORM 1 FROM courts WHERE id = p_court FOR UPDATE;
  SELECT id INTO v_old FROM court_bookings
  WHERE status = 'hold'
```

Trong luồng `bookingsHold()` → `booking_replace_hold()`:

1. Transaction A khóa hàng `courts` của sân muốn giữ.
2. Transaction B cùng giữ sân đó phải chờ khóa ở cùng hàm.
3. A giải phóng hold cũ nếu có, gắn occupancy, ghi court booking rồi commit.
4. B tiếp tục; occupancy vừa commit của A được kiểm tra bởi trigger overlap. Nếu giờ giao nhau, B nhận conflict, rollback thao tác.

`booking_replace_hold()` khóa cả hold cũ trước khi hủy (`0002:541`). Unique index một hold/người là lớp bảo vệ khác, đặc biệt khi nhiều request của cùng người muốn giữ các sân khác nhau.

**Vì sao không chỉ dựa vào trigger?** Trigger ở đây dùng `IF EXISTS` để đọc occupancy; nó không tự lấy khóa sân trong thân hàm trigger. Hai thao tác ghi đồng thời nếu bỏ qua cách khóa thống nhất có thể cùng chưa thấy hàng chưa commit của nhau. Vì vậy mô tả đúng là **transaction + khóa tài nguyên ở luồng ghi + trigger kiểm tra range + unique/check**, không phải “chỉ trigger là đủ cho mọi kiểu ghi SQL”.

### 12.2. Hai người lấy ghế cuối của lớp

**Ví dụ — `migrations/0045_sell_classes.sql:16`:**

```sql
  perform 1 from classes where id = p_class for update;
```

Sau khóa, `enrollment_hold()` tăng count chỉ khi `enrolled_count < capacity AND status='open'`. Request sau phải chờ, đọc count đã thay đổi rồi nhận `CLASS_FULL` nếu hết ghế. Check `enrolled_cap` giữ count không vượt capacity; unique enrollment chặn một người có hai hàng cùng lớp.

Handler đặt `SAVEPOINT sp_enroll` trước lời gọi. Khi SQL báo full, handler `ROLLBACK TO SAVEPOINT` rồi ghi hàng chờ (`src/server/controllers/handlers/classes.ts:432`, `:471`). Nếu chỉ bắt lỗi JS rồi query tiếp, transaction PostgreSQL đang ở trạng thái lỗi sẽ không tiếp tục như bình thường.

Khi nhận lời mời, code khóa offer, rồi lớp, rồi enrollment và kiểm tra lại người sở hữu/sức chứa (`src/server/controllers/handlers/ops.ts:154`). Khi xác nhận học phí, `settleEnrollment()` khóa lớp rồi enrollment (`src/server/controllers/handlers/classes.ts:587`). Việc giữ thứ tự khóa nhất quán ở các phần dùng chung giúp hạn chế xung đột; tài liệu không khẳng định toàn repo không thể deadlock.

### 12.3. Poll và webhook thanh toán tới cùng lúc

`onlineVerify()` khóa payment theo ID (`src/server/controllers/handlers/online.ts:350`); webhook khóa theo provider order code (`:423`). Hai đường cùng vào `settleOnline()`, có nhánh trả ngay khi đã `posted` (`:77`). Unique mã provider và unique invoice/payment bổ sung bảo vệ. Người dùng mở return URL không thay thế các bước xác minh này.

**Giới hạn của test:** `tx.test.ts` dùng một PGlite riêng với migrations thật (`src/server/controllers/tx.test.ts:114`). Test rollback/giữ dữ liệu nằm ở `:130`; test hàng chờ ở `:1276`. Những test này hữu ích cho nghiệp vụ và constraint, nhưng không tự chứng minh mọi interleaving trên Postgres nhiều connection đều đã được kiểm thử.

<a id="13-index"></a>
## 13. Index: tăng tốc và bảo vệ tính duy nhất

**Index là gì?** Là cấu trúc hỗ trợ tìm/lọc/sắp xếp dữ liệu nhanh hơn. Unique index còn từ chối trùng. Partial index chỉ chứa hàng thỏa điều kiện WHERE; expression index đánh chỉ mục theo biểu thức, như `upper(code)`. Việc có index không có nghĩa mọi truy vấn chắc chắn dùng index đó; điều này còn tùy câu SQL và kế hoạch thực thi.

| Nhóm index | Cột/điều kiện và tác dụng | Nguồn |
| --- | --- | --- |
| Tìm tên user | `users_name_norm_idx(name_normalized)` | `migrations/0002_arena3.sql:72` |
| Tra lịch sân | `occupancies_day_idx(court_id,start_at)`; unique kind/ref/court | Cùng file `:135` |
| Hold duy nhất | user hoặc guest_phone khi status=hold | Cùng file `:281` |
| Vị trí hàng chờ | class/waitlist_pos khi khác null, unique | Cùng file `:248` |
| Ca đang mở | receptionist khi closed_at null, unique | Cùng file `:293` |
| Booking theo người/ngày/sân | user/start; start; court/start | `migrations/0011_scale_centre.sql:22` |
| Gói và hàng chờ | subscriptions(user_id), enrollments(user_id), offers(enrollment_id) | Cùng file `:27` |
| Lịch học/coach | sessions(start_at), sessions(court_id,start_at), coach_occupancies(coach_id,start_at) | Cùng file `:36` |
| Báo cáo tiền | payments(created_at), payments(user_id), payments(ref_type,ref_id) | Cùng file `:41` |
| Thông báo/audit | outbox(user_id,sent_at DESC), audit_logs(at DESC) | Cùng file `:46` |
| Chờ chuyển khoản sân | transfer_requested_at khi hold và khác null | `migrations/0012_transfer_reconcile.sql:29` |
| Tickets | user_id/created_at DESC | `migrations/0013_ticket_replies.sql:24` |
| Gateway | unique provider_order_code; unique provider/txn_id khi txn_id khác null | `migrations/0015_payment_capture.sql:64` |
| Buổi đã đổi giờ | class/original_start khi khác null | `migrations/0020_phase4_sessions.sql:11` |
| Huấn luyện | plan theo session; results/reviews/notes theo user và ngày; homework_recipients theo user | `migrations/0021_phase4c_training.sql:10`, `:24`, `:39`, `:73`, `:96` |
| Check-in/promo | attendance gate theo user/at; token used_at; promo upper(code) unique; redemption promo/user; contact_log user/ngày; plan template partial | `migrations/0022_srs_v141.sql:37`, `:46`, `:74`, `:86`, `:110`, `:119` |
| Chuỗi/vận hành | booking_series(user_id), booking(series_id) khác null, loyalty(user_id), work_orders(status,created_at DESC) | `migrations/0024_deposit_series_ops.sql:46`, `:55`, `:97`, `:146` |
| Thư viện media | category và GIN(tags) cho mảng tag | `migrations/0035_media_library.sql:20` |
| Hội thoại/tin nhắn | conversation theo member/staff; messages theo conversation/created_at; unread partial; RTC theo room/to_peer/id và created_at | `migrations/0038_chat.sql:11`, `:23`, `:44` |
| Ghế giữ hết hạn | hold_until khi status=hold | `migrations/0045_sell_classes.sql:10` |
| Bằng cấp coach | coach_id | `migrations/0046_min_size_and_certificates.sql:17` |
| Membership hiện tại | user unique cho active/frozen; user unique cho pending; một extension active/enrollment; extension theo subscription | `migrations/0051_single_membership.sql:25`, `:94` |
| Google | google_sub unique khi khác null | `migrations/0053_google_link.sql:6` |

PK và UNIQUE constraint cũng tạo index bảo vệ tương ứng; bảng trên tập trung các index đặt tên trong migrations. Không nên cộng lại hai index gói theo scope đã bị `0051` xóa. Index vé ngày tạo trong `0024` cũng không còn sau khi bảng bị `0029` xóa.

<a id="14-lich-su"></a>
## 14. Bản đồ migrations để tra cứu

**Tại sao cần mục này?** Schema hiện tại là kết quả nhiều file chạy nối tiếp. Đọc file đầu biết bảng ra đời ra sao; đọc các file sửa mới biết quy tắc hiện tại. Bảng sau giúp chọn đúng nơi mở, không coi số tiền/tên người trong seed là dữ liệu kinh doanh thật.

Tất cả file trong bảng thuộc `migrations/`; đường dẫn có thể mở từ tên file.

| Migration | Vai trò trong chuỗi |
| --- | --- |
| `0002_arena3.sql` | Schema nền: enum, bảng nghiệp vụ, occupancy trigger, hàm cấp mã/giữ và giải phóng chỗ |
| `0003_seed.sql` | Dữ liệu ban đầu |
| `0004_fix_codes.sql` | Sửa hàm cấp mã member/chứng từ |
| `0005_class_sessions.sql` | Sinh buổi học cho lớp seed |
| `0006_seed_demo.sql`, `0007_nam_booking.sql` | Bổ sung dữ liệu demo/lượt đặt mẫu |
| `0008_ops.sql` | Hàm enroll/waitlist, unique điểm danh session/user, flag và thiết bị seed |
| `0009_sunday_class.sql`, `0010_english_seed.sql` | Dữ liệu lớp và nội dung seed |
| `0011_scale_centre.sql` | Bổ sung index phục vụ lịch, thu tiền, user, audit; mở rộng dữ liệu demo |
| `0012_transfer_reconcile.sql` | Trạng thái chờ đối soát sân bằng timestamp, cấu hình hạn và index |
| `0013_ticket_replies.sql` | Phản hồi ticket và index tra theo user |
| `0014_invoice_legal.sql` | Bổ sung thông tin hóa đơn, đơn vị dòng hàng và backfill |
| `0014_price_rule_repair.sql` | Sửa ma trận giá và check giới hạn giá |
| `0015_payment_capture.sql` | Trạng thái chờ/thất bại/hết hạn, capture mode, cột provider và unique gateway |
| `0015_trial_plan_off_sale.sql` | Ngừng bán gói trial trong seed |
| `0016_drop_sms.sql`, `0017_demo_court.sql` | Bỏ kênh SMS trong vận hành; dữ liệu sân demo |
| `0018_provider_sequences.sql` | Mốc cấp mã đơn nhà cung cấp |
| `0019_fixlist_phase1.sql` | Điều chỉnh occupancy lớp; buyer_phone invoice; read_at và view inbox |
| `0020_phase4_sessions.sql` | Giữ lịch gốc khi dời buổi, lý do đổi/hủy |
| `0021_phase4c_training.sql` | Giáo án gắn buổi, kết quả, review append-only, hồ sơ, homework |
| `0022_srs_v141.sql` | Bỏ công nợ/ghép sân; thêm check-in, promo, chăm sóc, phiên bản giáo án |
| `0023_seed_activity.sql` | Dữ liệu hoạt động demo |
| `0024_deposit_series_ops.sql` | Cấu hình cọc/hoàn, chuỗi sân, loyalty, payout, bảo trì; từng tạo vé ngày |
| `0025_fill_calendar.sql`, `0026_fix_payment_codes.sql` | Bổ sung lịch demo; sửa mã payment demo |
| `0027_class_hours.sql` | Đổi lớp 90 phút sang 60 phút, đổi default và điều chỉnh lịch liên quan |
| `0028_demo_fill.sql` | Hàm bổ sung lịch demo theo thời gian/flag |
| `0029_drop_day_passes.sql` | Xóa bảng vé ngày và cột giá vé ngày |
| `0030_idempotency_member_code.sql` | Unique key theo user; sửa cấp mã hội viên |
| `0031_session_revoke.sql`, `0032_subscription_price_lock.sql` | Thu hồi phiên; chốt giá subscription |
| `0033_manager_media_courts.sql` | Asset/history và metadata vòng đời sân |
| `0034_sports.sql` | Danh mục môn động, chuyển 10 cột enum sang text/FK |
| `0035_media_library.sql`, `0036_coach_avatars.sql`, `0037_staff_person_names.sql` | Thư viện media; cập nhật ảnh và tên staff seed |
| `0038_chat.sql` | Conversation/message và tín hiệu RTC |
| `0039_rename_center.sql`, `0040_user_avatars.sql`, `0041_rename_center_short.sql` | Đổi tên trung tâm trong dữ liệu; bảng avatar riêng |
| `0042_waitlist_order.sql` | Hàm compact và cập nhật các hàm enroll/waitlist |
| `0043_session_charges.sql` | Lưu charge buổi và prepaid_sessions của giai đoạn cũ |
| `0044_enroll_hold_status.sql`, `0045_sell_classes.sql` | Nhãn hold, giá lớp/ghế, hạn giữ, enrollment_hold và sửa waitlist |
| `0046_min_size_and_certificates.sql` | Sĩ số tối thiểu, bằng cấp coach, chứng nhận hoàn thành lớp |
| `0047_ui_config.sql`, `0048_seed_class_prices.sql`, `0049_nav_plans.sql` | Cấu hình menu, giá lớp seed và bổ sung menu gói |
| `0050_class_description.sql` | Mô tả, giáo trình và hướng dẫn chuẩn bị cho lớp |
| `0051_single_membership.sql` | Gói theo tháng, chuyển quyền lợi cũ sang ngày; unique gói theo user; extensions và promo enrollment |
| `0052_waitlist_compact_two_step.sql` | Thay hàm compact bằng cập nhật hai bước để tránh unique conflict |
| `0053_google_link.sql` | Subject/email Google, unique subject |
| `0054_max_active_classes.sql` | Cấu hình giới hạn lớp hold/confirmed |

Để đọc một tình huống cụ thể, có thể đi theo quan hệ: user → court_booking → occupancy cho đặt sân; user → enrollment → class → session cho lớp; payment → invoice → invoice_lines cho chứng từ. Với mỗi bước, đối chiếu cả khóa/constraint trong migration và handler đang ghi bảng đó để biết điều kiện nào database tự bảo vệ, điều kiện nào do code nghiệp vụ kiểm tra.
