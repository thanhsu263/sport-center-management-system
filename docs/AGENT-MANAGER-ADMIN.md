# AGENT-MANAGER-ADMIN: Quản lý quản lý được ảnh của trung tâm, số sân và nhân viên

Đọc hết file này trước khi viết dòng code nào. Làm tuần tự **Phần 0 → 1 → 2 → 3 → 4 → 5**. Chưa đạt cổng kiểm tra cuối mỗi phần thì không sang phần sau. Xong thì báo cáo theo **Phần 6** rồi DỪNG.

## Mục tiêu (định nghĩa "xong")

1. **Ảnh trung tâm không còn hard-code.** Mọi ảnh hoặc video đang hiện trên web (landing, đăng nhập, đăng ký, banner trang trong, ảnh môn, ảnh HLV, logo) đều lấy từ **cơ sở dữ liệu**. Quản lý thay, xem trước, hoàn tác và tắt được từng ảnh tại trang mới **`/manager/media`**, không cần sửa code hay deploy lại.
2. **Quản lý quản lý được số sân.** Tại **`/manager/courts`**: thêm sân, đổi mã hoặc môn, đổi trạng thái (sẵn sàng, bảo trì, đóng) và cho sân **ngừng sử dụng**. Lưới đặt sân, sơ đồ sân của lễ tân, báo cáo, bảng giá và landing tự cập nhật theo số sân thật. Không còn con số sân viết cứng ở đâu.
3. **Quản lý tạo được nhân viên.** Chức năng đã có (`POST /v1/staff`, nút «Thêm nhân viên» ở `/manager/staff`). Việc của bạn là **kiểm tra chạy đúng đầu cuối**, sửa nếu hỏng, và làm cho dễ tìm (xem Phần 3). HLV mới tạo xong phải gắn được ảnh (nối với mục 1).

## Bối cảnh code (đã khảo sát, đừng khảo sát lại từ đầu)

| Việc | Hiện trạng |
| --- | --- |
| Ảnh | `src/lib/arena3/media.ts`: object `media` gồm 32 đường dẫn `/media/*.jpg/mp4` viết cứng, cộng hàm `sportPhoto()`. Re-export qua `src/components/media.tsx` (`Cover`, `PhotoBanner`, `HeroVideo`, `PassCard`, `MediaCaption`). Được dùng trong `components/landing/{hero,courts,facilities,pricing,closing,plans,coaches}.tsx`, `routes/{login,register,app.book,app.classes,app.plans,app.train,coach.index,desk.gate,manager.index,manager.plans}.tsx`, `lib/arena3/coaches.ts` (ảnh 4 HLV theo tên). File thật nằm ở `public/media/`. |
| Sân | Bảng `courts(id, court_code VARCHAR(8) UNIQUE, sport sport_kind, status court_status)`, trong đó `convertible` và `pair_court_id` đã bị xoá ở 0022. Mã sân theo môn: `CL-xx` cầu lông, `BR-xx` bóng rổ, `BC-xx` bóng chuyền. API: `GET /v1/courts` (`bookH.courtsList`, `bookings.ts:~411`) và `PATCH /v1/courts/:id` (chỉ đổi status, `bookings.ts:426`). UI đổi trạng thái đang nằm trong `manager.settings.tsx:~286`. Có **khoá ngoại** từ `occupancies`, `bookings`, `classes`, giá… tới `courts(id)`, nên **cấm xoá cứng**. |
| Cài đặt | Bảng 1 dòng `center_settings` (`legal_name`, `address`, giờ mở cửa…). `GET/PATCH /v1/settings` nằm trong `deskH`. |
| Nhân viên | `handlers/staff.ts`: `staffCreate` (receptionist/coach, mật khẩu tạm, `must_change_password`, HLV bắt buộc chọn môn), `staffPatch`, `staffResetPassword`, `staffRevokeSessions`. UI: `routes/manager.staff.tsx`. Menu: `components/shell.tsx:121`. |
| Migration mới nhất | `0032_subscription_price_lock.sql`. Việc này cần **0033**. |

## Ràng buộc cứng

- Chỉ test trên **127.0.0.1:8090** (safe server + PGlite + fake clock). Không Neon, payOS, SMTP thật. Không `npm run build`, deploy, `db:migrate`, `db:push`, `db:seed`, không dùng Neon MCP. Không đọc, in hay copy `.env`, `.env.local`, `.env.*`.
- Git chỉ được `status` và `diff`. **KHÔNG** `commit`, `push`, `stash`, `reset`, `checkout`.
- Migration: **chỉ thêm file mới** `migrations/0033_manager_media_courts.sql`. **CẤM** sửa migration cũ. Migration phải **idempotent** (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) và chạy được nhiều lần. Không `ALTER TYPE … ADD VALUE` (lỗi trong transaction). Muốn biết safe server áp migration thế nào thì đọc script khởi động safe server và `scripts/migrate.mjs`, **không** chạy migrate vào DB thật.
- Không sửa `agent/`, `.agents/`, `graft/`, `attachments/`, `eslint.config.mjs`. Không `npm install` package mới. Không có thư viện thì tự viết (resize ảnh bằng `<canvas>` trên trình duyệt).
- Không đổi expected value của test cũ để có PASS. Lỗi 500 luôn là bug.
- Giữ nguyên toàn bộ bản sửa lỗi QA (27 finding) và theme xanh mạ + nâu. Không hex rải rác: màu đi qua token trong `src/styles.css`.
- Mọi chuỗi giao diện mới phải có **cả EN và VI** (`src/lib/i18n/**`), `node scripts/i18n-check.mjs` PASS. Không dùng em-dash (—) trong chuỗi hiển thị.
- Mọi API ghi dữ liệu mới: `requireRole(user, ["manager"])` + `audit(...)` + chạy trong transaction như các handler khác.

## Phần 0: Mốc chuẩn

1. `git status`: ghi lại các file đang dở (nếu có) để không lẫn.
2. Chạy sạch toàn bộ suite dưới fake clock như vòng trước, rồi `node scripts/tests/agent/regression.mjs`. Ghi lại con số mốc (kỳ vọng 2,940 / 0 / 0 / 6 và 27/27). Lưu vào `test-output/bugfix/G-ADMIN/baseline/`.
3. Lệnh grep sau để lập danh sách "điểm hard-code" phải xử lý ở Phần 1 và 2. Dán kết quả vào báo cáo:
   ```
   grep -rn "media\.\w\+\|sportPhoto\|/media/" src --include=*.ts --include=*.tsx
   grep -rniE "\b(16|sixteen|mười sáu)\b.{0,20}(court|sân)|(court|sân).{0,20}\b16\b|CL-0[0-9]|BR-0[0-9]|BC-0[0-9]" src --include=*.ts --include=*.tsx
   ```

## Phần 1: Ảnh trung tâm do quản lý điều khiển

### 1.1 Dữ liệu (trong migration 0033)

```sql
CREATE TABLE IF NOT EXISTS site_assets (
  slot        VARCHAR(64) PRIMARY KEY,
  kind        VARCHAR(8)  NOT NULL CHECK (kind IN ('image','video')),
  src_path    TEXT,
  mime        VARCHAR(32),
  bytes       BYTEA,
  width       INT,
  height      INT,
  alt_en      TEXT NOT NULL DEFAULT '',
  alt_vi      TEXT NOT NULL DEFAULT '',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  version     INT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id),
  CONSTRAINT one_source CHECK (src_path IS NOT NULL OR bytes IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS site_asset_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot       VARCHAR(64) NOT NULL REFERENCES site_assets(slot),
  src_path   TEXT, mime VARCHAR(32), bytes BYTEA, width INT, height INT,
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by UUID REFERENCES users(id)
);
```

- **Seed** mỗi slot trỏ về file có sẵn trong `public/media/` (`src_path = '/media/hall.jpg'`…, `ON CONFLICT (slot) DO NOTHING`). Như vậy **đường dẫn mặc định nằm trong DB**, không nằm trong code.
- Tên slot dạng chấm, theo nơi dùng: `landing.hero.image`, `landing.hero.video`, `landing.courts.badminton`, `landing.facilities.reception`, `landing.closing`, `auth.login.image`, `auth.login.video`, `auth.register.image`, `banner.book`, `banner.classes`, `banner.train`, `banner.coach`, `banner.gate`, `banner.manager`, `sport.badminton`, `sport.basketball`, `sport.volleyball`, `sport.all`, `brand.logo`… Một ảnh đang dùng ở nhiều nơi khác ý nghĩa thì **tách slot** để quản lý thay riêng được. Danh sách đầy đủ lập từ grep ở Phần 0.3.
- **Ảnh HLV:** slot `coach.<user_id>` gắn với tài khoản HLV thật (seed cho 4 HLV demo theo `user_id` trong seed). `coaches.ts` không được map ảnh theo tên nữa.

### 1.2 Code: chỉ giữ "sổ đăng ký slot", không giữ đường dẫn

- Viết lại `src/lib/arena3/media.ts` thành **registry**: `slot`, `kind`, nhãn EN/VI, "dùng ở đâu", tỉ lệ khuyến nghị (16:9, 4:5, 1:1). **Không còn chuỗi `/media/...` nào trong `src/`**. Cổng kiểm tra là `grep -rn "/media/" src` → rỗng.
- `GET /v1/site-assets` (**công khai**, không cần đăng nhập): trả `{ items: [{ slot, kind, url, alt_en, alt_vi, enabled, width, height }] }`. `url`:
  - ảnh upload → `/v1/site-assets/<slot>/file?v=<version>`;
  - ảnh mặc định → `src_path`.
  - Cache: `Cache-Control: public, max-age=60, stale-while-revalidate=600`.
- `GET /v1/site-assets/:slot/file`: trả `bytes` với `Content-Type` = mime đã kiểm tra, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable` (URL có `?v=` nên an toàn), `ETag`. Slot không có bytes → 302 về `src_path`. Slot không tồn tại → 404 (không phải 500).
- Client: `SiteAssetsProvider` + hook `useAsset(slot)` → `{ url, alt, enabled }`. Nạp **một lần** ở `src/routes/__root.tsx`, theo đúng cách repo đang nạp dữ liệu phía server, để SSR có ảnh ngay và không bị nháy. Nạp lỗi thì component vẫn render: khung nền `bg-wood` + chữ, **không** vỡ trang, **không** quay về đường dẫn viết cứng.
- `Cover`, `PhotoBanner`, `HeroVideo`, `PassCard` nhận `slot` thay cho `src`. `enabled = false` thì: banner ẩn hẳn và bố cục co lại gọn; ảnh thẻ dùng khung nền token; video thì dùng ảnh poster của slot ảnh cùng nhóm.
- `sportPhoto(sport)` → `useAsset("sport." + sport)`.
- `alt` lấy theo ngôn ngữ đang chọn. Rỗng thì `alt=""` + `aria-hidden` cho ảnh trang trí.

### 1.3 API quản lý (manager)

| Method | Route | Việc |
| --- | --- | --- |
| `GET` | `/v1/manager/site-assets` | Như bản công khai, cộng `updated_at`, `updated_by` (tên), số bản trong lịch sử, `default_path` |
| `PUT` | `/v1/manager/site-assets/:slot` | Upload ảnh mới. Body JSON `{ data_base64, mime, alt_en?, alt_vi? }`. Bản cũ chép vào `site_asset_history`, `version + 1`. |
| `PATCH` | `/v1/manager/site-assets/:slot` | Sửa `alt_en`, `alt_vi`, `enabled`, hoặc chọn lại một file có sẵn trong thư viện `public/media` (`src_path` phải thuộc **danh sách trắng** tạo từ thư mục đó, chặn `..` và URL ngoài) |
| `POST` | `/v1/manager/site-assets/:slot/revert` | Quay lại bản gần nhất trong lịch sử, hoặc về mặc định (`{ to: "default" }`) |
| `GET` | `/v1/manager/site-assets/library` | Danh sách file có sẵn trong `public/media` để chọn lại |

**Bảo mật upload (bắt buộc, có test cho từng dòng):**
- Chỉ `image/jpeg`, `image/png`, `image/webp`. **Cấm SVG, GIF, HTML.** Kiểm tra **magic bytes** (`FF D8 FF`, `89 50 4E 47`, `RIFF....WEBP`), **không tin** `mime` client gửi. Sai → 422 `err.field`.
- Tối đa **2 MB sau giải mã** (giới hạn body của Vercel là 4.5 MB, base64 phình khoảng 33%). Quá → 413/422 rõ ràng, không 500.
- Đọc width/height từ header ảnh. Cạnh dài quá 4000 px hoặc dưới 400 px → 422.
- Slot phải có trong registry **và** `kind = 'image'`. Video slot chỉ được bật/tắt hoặc chọn lại file thư viện.
- Áp rate limit có sẵn (`ratelimit.ts`) cho PUT. Ghi `audit(..., "replace_asset", "site_asset", slot, {from_version, to_version, size})`.

### 1.4 Trang `/manager/media`

- Thêm menu nhóm **Hệ thống** cạnh «Cài đặt» trong `shell.tsx`: nhãn «Hình ảnh» / «Media».
- Lưới thẻ chia nhóm theo registry: **Trang chủ · Đăng nhập & đăng ký · Banner trang trong · Ảnh môn · Huấn luyện viên · Thương hiệu**. Mỗi thẻ có:
  - ảnh hiện tại đúng tỉ lệ;
  - tên slot dễ hiểu và "Dùng ở: …";
  - kích thước, thời điểm sửa, người sửa;
  - các nút **Thay ảnh**, **Chọn từ thư viện**, **Sửa mô tả**, **Bật/Tắt**, **Hoàn tác**, **Về mặc định**.
- **Thay ảnh** gồm:
  - chọn file → resize trên trình duyệt bằng `<canvas>` về cạnh dài ≤ 2400 px, xuất WebP chất lượng 0.85;
  - **xem trước trong khung đúng tỉ lệ của nơi dùng**, có vùng an toàn cho chữ đè lên;
  - bấm Lưu mới upload, trong lúc upload hiện tiến trình;
  - lỗi từ server hiện đúng tại thẻ đó.
- Hoàn tác và Về mặc định phải **hỏi xác nhận**.
- Trống, đang tải, lỗi mạng: dùng `EmptyState` và component có sẵn, theo theme hiện tại.

**Cổng kiểm tra Phần 1:** `grep -rn "/media/" src` rỗng. Thay ảnh `landing.hero.image` ở `/manager/media` → mở `/` (tab ẩn danh) thấy ảnh mới, không cần build lại. Tắt `banner.classes` → `/app/classes` không còn banner, bố cục không thủng. Upload file `.svg` đổi đuôi thành `.png` → bị từ chối.

## Phần 2: Quản lý số sân

### 2.1 Dữ liệu (migration 0033)

```sql
ALTER TABLE courts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE courts ADD COLUMN IF NOT EXISTS display_name VARCHAR(40);
ALTER TABLE courts ADD COLUMN IF NOT EXISTS sort_order INT;
```

- "Ngừng sử dụng" = `retired_at IS NOT NULL`. **Không bao giờ xoá dòng** trong `courts` (khoá ngoại, hoá đơn và lịch sử cũ vẫn phải hiện đúng mã sân).

### 2.2 API

| Method | Route | Việc |
| --- | --- | --- |
| `GET` | `/v1/courts` | **Giữ shape cũ** (`items[]` gồm `id`, `court_code`, `sport`, `status`), chỉ thêm field mới. Mặc định **loại** sân đã ngừng. |
| `GET` | `/v1/manager/courts` | Tất cả sân, kể cả sân đã ngừng, kèm: số lượt đặt sắp tới, lớp đang gắn, có giá riêng không |
| `POST` | `/v1/manager/courts` | Tạo sân: `{ sport, court_code?, display_name?, status? }`. Bỏ trống `court_code` thì tự sinh `CL-`/`BR-`/`BC-` + số kế tiếp **lấy từ DB** (2 chữ số, lấp chỗ trống không, không trùng sân đã ngừng). Mã tự nhập: regex `^[A-Z]{2}-\d{2,3}$`, tối đa 8 ký tự, trùng → `BR-01` 409. |
| `PATCH` | `/v1/courts/:id` | Mở rộng bản hiện có: ngoài `status` còn nhận `court_code`, `display_name`, `sort_order`, `sport`. **Đổi môn bị chặn** (409 + số lượt bị ảnh hưởng) nếu còn occupancy/booking/lớp **trong tương lai**. Giữ nguyên hành vi cũ khi chỉ gửi `status` (test cũ phải PASS). |
| `POST` | `/v1/manager/courts/:id/retire` | Ngừng sử dụng. **Chặn** nếu còn lượt đặt, lớp hoặc bảo trì trong tương lai: trả 409 kèm danh sách. Chỉ khi có `{ force: true, reason }` mới huỷ các lượt đặt tương lai **qua đúng luồng huỷ hoặc hoàn tiền đang có**. Không tự viết SQL huỷ riêng. Không có luồng an toàn thì **không làm force**, ghi vào báo cáo. |
| `POST` | `/v1/manager/courts/:id/restore` | Bỏ ngừng, `status = 'ready'` |

- Không cho ngừng hoặc đóng **sân cuối cùng** của một môn đang có gói tập hay lớp còn hiệu lực: 409 + giải thích.
- Mọi thao tác đều `audit` (`create_court`, `patch_court`, `retire_court`, `restore_court`).

### 2.3 Mọi nơi đọc sân phải theo DB

Rà và sửa **mọi** câu `from courts` trong `src/lib/arena3/**` (dùng `grep -rn "from courts" src/lib`):
- Đặt sân, giữ chỗ, lưới, "Giờ còn trống", sơ đồ lễ tân, walk-in, series, lớp, bảo trì: **loại** sân đã ngừng. `bookingsHold` từ chối sân đã ngừng (`BR-06`).
- Báo cáo, hoá đơn, lịch sử: **vẫn hiện** mã sân đã ngừng cho dữ liệu cũ.
- Job tự lấp dữ liệu demo theo giờ (commit "Refill the demo court map…"): bỏ qua sân đã ngừng và sân mới thì vẫn chạy được.
- Sắp xếp theo `sort_order NULLS LAST, court_code`.
- Landing và trang giới thiệu: số sân, số sân theo môn **tính từ** `GET /v1/courts`. Mọi con số và mã sân viết cứng tìm được ở grep Phần 0.3 phải bỏ. Riêng `coaches.ts` (`"Courts CL-01 · CL-05"`) thì lấy từ lớp thật của HLV, hoặc bỏ dòng đó.
- `CourtGrid` phải chạy đẹp với 1 sân, 30 sân, và môn có 0 sân (ẩn tab môn đó). Không đè hiệu ứng lên ô lưới (CLAUDE.md).

### 2.4 Trang `/manager/courts`

- Menu nhóm **Vận hành**: «Sân» / «Courts». Chuyển phần đổi trạng thái sân trong `manager.settings.tsx` sang đây. Bên Cài đặt chỉ để lại link «Quản lý sân →».
- Bảng hoặc lưới thẻ theo môn, tổng «n sân · x sẵn sàng · y bảo trì · z đã ngừng», lọc theo môn và trạng thái, hiện cả sân đã ngừng (mờ, nhãn «Đã ngừng»).
- Nút **Thêm sân** mở dialog: chọn môn, xem trước mã tự sinh (sửa được), tên hiển thị.
- Hành động trên từng sân: Sửa, Đổi trạng thái, Ngừng sử dụng hoặc Khôi phục. Khi bị chặn (409) thì hiện **danh sách lượt bị ảnh hưởng** và hướng dẫn, không chỉ báo lỗi chung.
- Phân trang theo chuẩn C1 nếu có hơn 25 sân.

**Cổng kiểm tra Phần 2:** thêm sân cầu lông mới → mã tự sinh đúng (ví dụ `CL-13`) → thấy ngay trên `/app/book`, `/desk/courts`, landing (số sân +1). Ngừng một sân không có lượt tương lai → biến mất khỏi lưới, nhưng hoá đơn cũ vẫn hiện mã đó. Ngừng sân còn lượt đặt → 409 + danh sách. Test cũ của `PATCH /v1/courts/:id` vẫn PASS.

## Phần 3: Tạo nhân viên (kiểm tra và hoàn thiện)

1. Trên safe server, đăng nhập quản lý → `/manager/staff` → «Thêm nhân viên»: tạo 1 lễ tân và 1 HLV (chọn môn). Kiểm tra:
   - mật khẩu tạm hiện **một lần** và có nút sao chép;
   - đăng nhập bằng tài khoản mới bị buộc đổi mật khẩu;
   - trùng số điện thoại → `BR-01` hiện đúng tại ô;
   - HLV không chọn môn → lỗi tại ô;
   - danh sách và phân trang cập nhật.
2. Sửa mọi lỗi tìm được (code, không phải test).
3. Dễ tìm hơn:
   - mục «Nhân viên» trong `shell.tsx` phải hiện trong menu điện thoại (mục «Thêm»), vì hiện đang `dock: false`, hãy kiểm tra nó có trong «Thêm» không;
   - trên `/manager` (bảng điều khiển) thêm lối tắt «Thêm nhân viên»;
   - nếu trung tâm **chưa có lễ tân hoặc chưa có HLV nào đang hoạt động**, hiện thẻ nhắc «Chưa có lễ tân, thêm ngay» dẫn tới dialog tạo.
4. Dialog tạo hoặc sửa HLV: thêm ô **Ảnh đại diện**, dùng chung luồng upload của Phần 1 với slot `coach.<user_id>`. Slot được tạo khi tạo HLV và chỉ có sau khi đã có `user_id`. Trang HLV trên landing và trang lớp học lấy ảnh từ slot này. HLV chưa có ảnh thì hiện chữ cái đầu tên trên nền token, không dùng ảnh người khác.
5. **Không** mở quyền tạo tài khoản `manager` qua UI. `MANAGED_ROLES` giữ nguyên.

**Cổng kiểm tra Phần 3:** tạo HLV mới có ảnh → ảnh hiện ở landing (mục HLV) và trong dialog lớp học. Tài khoản lễ tân mới đăng nhập được sau khi đổi mật khẩu.

## Phần 4: Test (bắt buộc, đặt trong file test **mới**)

Tạo `scripts/tests/agent/manager-admin.mjs` (hoặc theo cấu trúc suite hiện có), chạy trên 8090. Tối thiểu các case sau:

- **Assets:**
  - public list không cần auth;
  - lễ tân, HLV, hội viên gọi API manager → 403;
  - upload JPEG/PNG/WebP hợp lệ → 200 và version tăng;
  - SVG đổi tên, HTML, GIF, magic bytes sai → 422;
  - quá 2 MB → 413/422;
  - slot lạ → 404;
  - slot video + PUT → 422;
  - `src_path` có `..` hoặc `https://` → 422;
  - revert về bản trước và về mặc định;
  - `enabled = false` phản ánh ở public list;
  - file endpoint trả đúng `Content-Type` + `nosniff`;
  - có audit.
- **Courts:**
  - tạo tự sinh mã;
  - mã trùng → 409;
  - mã sai định dạng → 422;
  - không phải manager → 403;
  - đổi môn khi còn lượt tương lai → 409;
  - retire bị chặn hoặc thành công;
  - sân đã ngừng không giữ chỗ được (`BR-06`);
  - `GET /v1/courts` loại sân đã ngừng;
  - restore;
  - không ngừng được sân cuối của môn đang có gói;
  - `PATCH` chỉ `status` vẫn y như cũ.
- **Staff:** happy path lễ tân và HLV, trùng, HLV thiếu môn, không phải manager → 403.
- Thêm vào `scripts/tests/agent/regression.mjs` **không được**. Chỉ chạy nó để xác nhận 27/27.

## Phần 5: Cổng cuối

1. `npx --no-install tsc --noEmit`, `npx --no-install eslint .`, `node scripts/i18n-check.mjs`, `npm test`: tất cả PASS.
2. Chạy sạch toàn bộ suite dưới fake clock, rồi `node scripts/tests/agent/status-transitions.mjs test-output/bugfix/G-ADMIN/baseline test-output/results`: **0 case PASS→FAIL/WARN**. Tổng PASS ≥ mốc. Case mới cộng thêm thì ghi rõ.
3. `node scripts/tests/agent/regression.mjs`: **27/27 FIXED**.
4. `node scripts/tests/agent/manager-admin.mjs`: tất cả PASS.
5. `grep -rn "/media/" src` → rỗng. Grep số sân hoặc mã sân của Phần 0.3 → chỉ còn trong test, seed hoặc migration.
6. Chụp màn hình (desktop 1440 + điện thoại 390, light, VI) vào `test-output/manager-admin/`:
   - `/manager/media`, dialog thay ảnh có xem trước;
   - `/manager/courts`, dialog thêm sân, hộp thoại bị chặn khi ngừng sân;
   - `/manager/staff` + dialog thêm HLV có ảnh;
   - landing trước và sau khi thay ảnh hero;
   - `/app/book` sau khi thêm sân.

   Mỗi màn: không lỗi console, không request 4xx/5xx ngoài ý muốn, không chuỗi tiếng Anh lọt vào chế độ VI.
7. Cập nhật `scripts/screen-dictionary.mjs`: thêm `/manager/media` và `/manager/courts` (chỉ đọc, không bấm nút ghi). **Không** chạy lại cả bộ, chỉ ghi chú cần sinh lại.

## Phần 6: Báo cáo (ngắn) rồi DỪNG

- `git diff --stat` + danh sách file mới. Nội dung tóm tắt `0033_manager_media_courts.sql`.
- Bảng slot: slot → nơi dùng → file mặc định.
- Bảng API mới: method, route, quyền.
- Kết quả nguyên văn của 5.2, 5.3, 5.4. Output grep 5.5.
- Danh sách ảnh 5.6.
- Những gì **không làm được** hoặc cố ý không làm (ví dụ retire force nếu không có luồng huỷ an toàn), kèm lý do.
- **Cảnh báo deploy cho người dùng:** migration 0033 sẽ chạy vào Neon dùng chung ở lần build Vercel tiếp theo. Ghi rõ dung lượng ước tính của bảng `site_assets`.
- Không commit. DỪNG.
