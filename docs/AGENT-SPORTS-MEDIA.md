# AGENT-SPORTS-MEDIA: heatmap dễ đọc, môn thể thao do manager quản lý, kho ảnh hơn 100 tấm

Bạn là agent thực thi. Đọc hết file này trước khi sửa bất kỳ dòng nào. Làm theo thứ tự các phase. Mỗi phase có cổng kiểm tra riêng: chưa qua cổng thì không sang phase sau.

## Ràng buộc cứng (giữ nguyên từ các doc AGENT-* trước)

- Chỉ test trên safe server 127.0.0.1:8090 (PGlite, fake clock). Không chạm Neon, payOS hay SMTP thật.
- Không mở, in, copy hay grep `.env`, `.env.local`, `.env.*`. Không in biến môi trường bí mật.
- Không chạy: check-integrations, deploy, migrate, db:push, db:seed, neon, `npm run build`, db:migrate. Không dùng Neon MCP.
- Không `npm install`. Dùng `npx --no-install`. Task này không cần package mới; resize ảnh bằng tham số CDN (Phase 3).
- Không git commit, push, stash, reset hay checkout.
- Không sửa migration cũ (0001–0033), không sửa `attachments/`, `graft/`, `.agents/`, `agent/`. Mọi thay đổi schema nằm trong migration MỚI: `0034_sports.sql`, `0035_media_library.sql`.
- **Bài học từ lần trước (F1):** không bao giờ `CREATE OR REPLACE` một function đã có, trừ khi chép NGUYÊN VĂN thân hàm hiện tại và chỉ sửa đúng dòng cần sửa. Phải chứng minh bằng `diff`.
- Migration 0034/0035 sẽ tự chạy trên Neon dùng chung khi Vercel build từ main. Chúng phải idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `UPDATE ... WHERE` có điều kiện bảo vệ). Không `DROP TABLE`, `DROP COLUMN` hay `DROP TYPE`. Không xoá dữ liệu.
- Một lỗi 500 luôn là bug. Không được sửa giá trị expected chỉ để test PASS.
- Theo `CLAUDE.md`: GSAP chỉ ở landing/moments; dùng `motion` trong app; hiệu ứng phải tôn trọng reduced motion; không hiệu ứng nào đè lên ô lưới sân.
- Tiếng Anh là ngôn ngữ chính. Mọi chuỗi mới có bản tiếng Việt trong `src/lib/i18n/vi.*.ts`, và `i18n-check` phải báo 0 missing.

## Phase 0. Baseline

1. Khởi động safe server. Chạy full agent suite, regression và `manager-admin`. Lưu kết quả vào `test-output/bugfix/G-SPORTS/baseline/`.
2. Kiểm kê, lưu vào `test-output/bugfix/G-SPORTS/inventory.txt`:
   - `grep -rn "sport_kind" migrations src`: mọi bảng, cột, function, view đang dùng enum.
   - `grep -rn "badminton\|basketball\|volleyball" src --include=*.ts --include=*.tsx --include=*.css`: mọi chỗ đang cố định môn (khoảng 45 file).
   - Các hằng số theo môn trong `src/lib/arena3/rules.ts`, `labels.ts`, `media.ts`, `components/moments/sport-glyph.tsx`, `styles.css` (`--color-sport-*`), `handlers/courts.ts:61` (prefix CL/BR/BC).
   - Bảng giá theo môn (tìm nơi `manager.prices.tsx` đọc và ghi).
   - Trên safe DB, chạy `select pg_get_viewdef(...)` / `pg_depend` để liệt kê view, index, constraint (kể cả exclusion constraint) phụ thuộc vào các cột `sport`.

## Phase 1. Bảng "Busiest hours" dễ đọc

Vấn đề hiện tại (`src/components/report-panels.tsx` khoảng dòng 189–250):
- Ô chỉ có số trần (0, 6, 100), không có `%`, người xem không biết đó là gì.
- Xem 1 ngày thì mọi ô chỉ là 0 hoặc 100, rất rối.
- Thang màu nhảy từ xanh sang cam ở mức 86–100%, chú thích khó hiểu.
- Không gom theo môn.
- Sân test `DEMO-01` lọt vào bảng.

Yêu cầu:
1. **Tiêu đề và mô tả rõ nghĩa:**
   - `"When courts are busy"`, kèm khoảng ngày đang xem.
   - Hint khi xem nhiều ngày: `"Each square shows how often that court was booked at that hour, {from} – {to}."`
   - Hint khi xem 1 ngày: `"Booked or free, hour by hour."`
2. **Chế độ 1 ngày:** chỉ có 2 trạng thái Booked/Free. Ô booked tô đậm, không in số. Chú thích chỉ có 2 mục.
3. **Chế độ nhiều ngày:**
   - Thang màu một tông (nâu nhạt → nâu đậm, dùng token mới `--color-heat-0..5`, có cả bản dark). Các mốc: 0, 1–10, 11–25, 26–50, 51–75, 76–100%.
   - Bỏ số trong ô.
   - Tooltip và `aria-label` của mỗi ô: `"CL-03 · 17:00 · booked 12 of 30 days (40%)"`. Backend phải trả thêm `days_booked` và `days_total` cho từng ô; nếu chưa có thì thêm vào handler.
4. **Gom theo môn:** mỗi môn một hàng tiêu đề (tên môn lấy từ DB, sau Phase 2) với chấm màu của môn.
5. **Tóm tắt ở trên cùng:** một dải cột nhỏ theo giờ (tỉ lệ của tất cả sân) và dòng chữ `"Busiest: 19:00 (82%), 17:00, 18:00"`, nêu 3 giờ đông nhất. Hàng "All courts" ở cuối bảng in số kèm `%`.
6. Ẩn sân đã retire, trừ khi sân đó có booking trong khoảng đang xem.
7. Ô vẫn là phần tử tĩnh (không hiệu ứng). Hover/focus chỉ đổi viền. Bảng cuộn ngang được trên mobile, cột tên sân dính bên trái.
8. Test agent: sân do test tạo ra (như `DEMO-01`) phải được retire trong bước dọn dẹp của `manager-admin.mjs`.

Cổng Phase 1: tsc 0 lỗi; chụp `test-output/sports-media/heatmap-day.png`, `heatmap-range.png`, `heatmap-mobile.png` (cả light và dark).

## Phase 2. Môn thể thao do manager quản lý (thêm, sửa, xoá)

### 2.1 Schema (`migrations/0034_sports.sql`)

```
CREATE TABLE IF NOT EXISTS sports (
  code          TEXT PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_-]{1,23}$'),
  name_en       VARCHAR(40) NOT NULL,
  name_vi       VARCHAR(40) NOT NULL,
  court_prefix  CHAR(2) UNIQUE CHECK (court_prefix ~ '^[A-Z]{2}$'),
  color_key     TEXT NOT NULL DEFAULT 'leaf',
  glyph_key     TEXT NOT NULL DEFAULT 'generic',
  is_scope_all  BOOLEAN NOT NULL DEFAULT false,
  sort_order    INT NOT NULL DEFAULT 100,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  retired_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- Thêm các cột cho mọi hằng số theo môn tìm thấy ở Phase 0 (ví dụ số người tối đa, độ dài slot…). Seed đúng giá trị đang dùng.
- Seed bằng `ON CONFLICT (code) DO NOTHING`:
  - `badminton` (CL, sort 10)
  - `basketball` (BR, sort 20)
  - `volleyball` (BC, sort 30)
  - `all` (court_prefix NULL, `is_scope_all = true`, sort 0)
- Chuyển MỌI cột `sport sport_kind` sang `TEXT` bằng `ALTER COLUMN sport TYPE TEXT USING sport::text`, rồi thêm FK `REFERENCES sports(code)`.
  - Nếu một view, index hay constraint chặn lệnh ALTER, phải xử lý đúng cái đó: tạo lại y nguyên sau khi ALTER, có diff chứng minh.
  - Viết sao cho chạy lại lần 2 không lỗi: kiểm tra `information_schema.columns.data_type` trước khi ALTER, dùng khối `DO $$ ... $$`.
- KHÔNG drop type `sport_kind`, vì các migration seed cũ vẫn ép kiểu `'x'::sport_kind` khi dựng DB mới.
- Function nào có tham số hoặc biến kiểu `sport_kind`: chép nguyên văn, chỉ đổi kiểu, kèm diff.
- Chỉ cho phép `all` ở các cột phạm vi (gói tập, khuyến mãi…). Cột `courts.sport` và `classes.sport` phải chặn `all` bằng trigger hoặc kiểm tra trong handler.

### 2.2 API

- `GET /v1/sports` (công khai): các môn `enabled` và chưa retire, sắp theo `sort_order`. Mỗi môn kèm URL ảnh slot `sport.<code>`.
- `GET /v1/manager/sports`: tất cả các môn, kèm số sân đang hoạt động, booking tương lai, lớp tương lai và gói tập đang hiệu lực.
- `POST /v1/manager/sports` (chỉ manager):
  - Body: code, name_en, name_vi, court_prefix, color_key, glyph_key và **giá ban đầu** (theo đúng cấu trúc bảng giá hiện có).
  - Trong cùng transaction: tạo các dòng giá và slot `site_assets` `sport.<code>`, ảnh mặc định lấy từ kho (Phase 3) hoặc `sport.all`.
  - Trả 409 nếu trùng code hoặc trùng prefix.
- `PATCH /v1/manager/sports/:code`:
  - Sửa được tên, màu, glyph, thứ tự, bật/tắt.
  - `code` không được sửa.
  - Đổi `court_prefix` chỉ khi môn chưa có sân nào; nếu có thì trả 409.
- `POST /v1/manager/sports/:code/retire`:
  - Trả 409 kèm danh sách lý do nếu còn sân đang hoạt động, booking tương lai, lớp tương lai hoặc gói tập đang hiệu lực.
  - Không retire được `all`, và không retire được môn cuối cùng còn hoạt động.
  - Có route `restore` tương ứng.
- `DELETE /v1/manager/sports/:code`: chỉ xoá hẳn khi môn chưa từng được tham chiếu ở bất kỳ đâu. Nếu đã có lịch sử, trả 409 với thông báo `"This sport has history. Retire it instead."`
- Mọi thao tác ghi đều ghi audit log như các handler manager khác. Có rate limit như các route manager khác.
- `handlers/courts.ts`: prefix lấy từ `sports.court_prefix`, bỏ hẳn biểu thức ba ngôi CL/BR/BC.
- Validate ở mọi nơi nhận `sport`: kiểm tra với bảng `sports` (đang hoạt động), không dùng danh sách cố định. Môn không hợp lệ trả 422.

### 2.3 Giao diện

- Trang mới `/manager/sports`, thêm vào menu manager (desktop và mobile) và lối tắt trên dashboard.
  - Danh sách thẻ môn hiện: ảnh, tên EN/VI, prefix, số sân, trạng thái.
  - Các thao tác: thêm, sửa, bật/tắt, retire/restore, xoá.
  - Form thêm có bước nhập giá.
  - Chọn màu từ bảng màu cố định (6–8 key như `leaf`, `clay`, `sky`, `plum`, `sun`, `slate`…; mỗi key có token light/dark đạt tương phản AA với chữ trắng hoặc đen). Không cho nhập hex tự do.
  - Chọn glyph: 3 glyph hiện có cộng `generic`.
  - Chọn ảnh từ kho (Phase 3).
- Hook `useSports()` (cache, tự làm mới khi manager sửa) thay cho MỌI danh sách môn cố định: landing (courts, facilities, pricing, schedule, hero, coaches), đặt sân, lớp học, desk courts, các trang manager (courts, classes, plans, prices, promos, members, staff), báo cáo, trợ lý.
- Tên môn lấy từ DB (`name_en`/`name_vi` theo ngôn ngữ). Màu dùng `var(--color-sport-<color_key>)`. `sport-glyph.tsx` dùng `generic` cho môn mới.
- Landing tự hiện môn mới với ảnh `sport.<code>`. Môn bị tắt hoặc retire tự biến mất.

### 2.4 Cổng Phase 2

- `grep -rnE "'(badminton|basketball|volleyball)'|\"(badminton|basketball|volleyball)\"" src` chỉ còn được xuất hiện trong: file test, fixture demo, và danh sách glyph SVG (key glyph). Mọi chỗ khác là lỗi. Ghi output vào báo cáo.
- Thêm môn `pickleball` qua API → tạo được sân `PB-01` → đặt được sân đó → môn hiện trên landing và heatmap → retire bị chặn (409) khi còn booking → huỷ booking, retire sân, retire môn → môn biến mất khỏi landing.
- Thêm một môn rồi xoá ngay → xoá hẳn được. Xoá môn có lịch sử → 409.

## Phase 3. Kho ảnh: hơn 100 tấm, thay ảnh coach, làm đẹp ảnh hiện có

### 3.1 Nguồn ảnh được phép (chỉ những nguồn này)

| Nguồn | Cách lấy | Giấy phép chấp nhận |
|---|---|---|
| Openverse API `https://api.openverse.org/v1/images/?q=...&license=cc0,pdm,by&size=large` | không cần key | CC0, Public Domain Mark, CC BY |
| Unsplash (`images.unsplash.com`, trang `unsplash.com/photos/<id>`) | tìm qua Agent Reach (Exa/Jina) hoặc trang search công khai | Unsplash License |
| Pexels (`images.pexels.com`, trang `pexels.com/photo/<id>`) | tìm qua Agent Reach | Pexels License |
| Wikimedia Commons (`upload.wikimedia.org`) | Openverse hoặc API commons | CC0, PD, CC BY, CC BY-SA |

Cấm:
- Google Images, Pinterest, Facebook, báo chí.
- Ảnh có watermark (Shutterstock, Getty, Adobe Stock, iStock, Dreamstime).
- Giấy phép NC hoặc ND.
- Ảnh có logo thương hiệu nổi bật, chữ in đè, hoặc trẻ em nhìn rõ mặt.
- **Ảnh vận động viên hay người nổi tiếng có thật** (không được để người thật trông như coach của trung tâm). Ảnh coach chỉ lấy từ Unsplash/Pexels, nơi người mẫu đã ký giấy đồng ý.
- Không đăng nhập, không nhập cookie hay token, không tạo tài khoản ở bất kỳ trang nào. Không cần key thì mới dùng.

Tải bằng `fetch` trong một script node đặt ở `scripts/media/fetch-library.mjs`, chỉ từ các host trong bảng trên.
- Kiểm tra magic bytes (JPEG/PNG/WebP), bỏ file khác loại.
- Resize bằng tham số CDN:
  - Unsplash: `?w=1920&q=78&fm=jpg&fit=max`
  - Pexels: `?auto=compress&cs=tinysrgb&w=1920`
  - Commons: URL thumb `/1920px-`
  - Ảnh chân dung: rộng 900.
- Mỗi file ≤ 450 KB; cả kho ≤ 45 MB.

### 3.2 Nội dung kho (tối thiểu 110 ảnh, đặt ở `public/media/library/<category>/<slug>.jpg`)

| Category | Số lượng tối thiểu | Ghi chú |
|---|---|---|
| badminton | 12 | trong nhà, hành động, cận vợt và cầu, sân trống |
| basketball | 12 | trong nhà, hành động, rổ, bóng |
| volleyball | 12 | trong nhà, hành động, lưới |
| other-sports | 16 | pickleball, tennis, futsal, bóng bàn (4 mỗi môn), để manager có sẵn ảnh khi thêm môn |
| facility | 16 | quầy lễ tân, sảnh, phòng thay đồ, khu ngồi chờ, căng tin, bãi xe, mặt tiền, toàn cảnh sân trong nhà |
| coach | 14 | chân dung huấn luyện viên (người châu Á ưu tiên), trang phục thể thao, nền sân; dọc 4:5 |
| class | 12 | lớp nhóm người lớn, khởi động, giáo án, bảng chiến thuật |
| equipment | 8 | vợt, cầu, bóng, giày, lưới |
| event | 8 | giải đấu, khán đài, trao giải, đội hình |

Mọi ảnh phải nằm ngang 16:9 (hoặc cắt được an toàn về 16:9), trừ `coach` dùng 4:5. Ưu tiên tông ấm, trong nhà, ánh sáng sân, hợp theme xanh lúa và nâu. Agent phải TỰ XEM từng ảnh (đa phương thức) và loại ảnh mờ, nghiêng, quá tối, có chữ hoặc logo.

### 3.3 Ghi nguồn

- `public/media/library/CREDITS.md`: mỗi ảnh một dòng gồm file, tác giả, URL trang gốc, giấy phép, ngày tải.
- Bảng `media_library` (trong `0035_media_library.sql`):

```
CREATE TABLE IF NOT EXISTS media_library (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL DEFAULT 'image',
  category    TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  width       INT, height INT,
  alt_en      TEXT NOT NULL, alt_vi TEXT NOT NULL,
  credit      TEXT, source_url TEXT, license TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Seed toàn bộ ảnh của kho bằng `ON CONFLICT (id) DO NOTHING`, sinh tự động từ manifest `scripts/media/library.json` bằng script (không viết tay). Đưa luôn 33 ảnh cũ trong `public/media/` vào bảng (category `legacy`, license `project`). Ảnh CC BY và CC BY-SA phải có `credit`, và tên tác giả hiện trong tooltip hoặc chú thích nhỏ khi ảnh được dùng trên trang công khai.

### 3.4 Ảnh coach

- Đọc seed để biết tên, giới tính và môn của từng coach (các slot `coach.<user_id>` trong 0033).
- Chọn cho mỗi coach một chân dung khớp giới tính, trông khớp môn, khung 4:5, nhìn thẳng, ánh sáng tốt.
- Cập nhật slot trong 0035:
  `UPDATE site_assets SET src_path = <mới>, default_path = <mới> WHERE slot = 'coach.<id>' AND bytes IS NULL AND src_path = <đường dẫn cũ>`
  Điều kiện này để không đè lên ảnh manager đã upload.
- Coach mới do manager tạo dùng ảnh `coach` generic từ kho cho tới khi manager chọn hoặc upload ảnh.

### 3.5 Làm đẹp các slot hiện có

- Duyệt 31 slot hiện có. Với mỗi slot, chọn ảnh tốt nhất trong kho: đúng ngữ cảnh, đúng tỉ lệ, đủ nét ở 1920px. Đổi bằng `UPDATE ... WHERE bytes IS NULL AND src_path = <cũ>` như trên.
- Ghi bảng trước/sau vào báo cáo: slot, ảnh cũ, ảnh mới, lý do.
- Thêm slot còn thiếu (nếu UI có chỗ cần ảnh mà chưa có slot), ví dụ:
  - ảnh thẻ gói tập (`plan.<id>` hoặc `plans.default`);
  - ảnh loại lớp (`class.default`);
  - ảnh nền trạng thái rỗng (`empty.default`);
  - một dải gallery 8 ảnh trên landing (`landing.gallery.1..8`).
- Mỗi slot mới phải có chỗ hiển thị thật trong UI. Không tạo slot "để đó".

### 3.6 Chọn ảnh từ kho trong `/manager/media`

- Mỗi slot có thêm nút "Choose from library", mở một lưới ảnh lọc được theo category và tag, có ô tìm kiếm, lazy-load.
- Chọn xong gọi `PATCH /v1/manager/site-assets/:slot` với `library_id`. Server chỉ chấp nhận `path` có trong `media_library` (không nhận đường dẫn tự do). Ghi `site_asset_history` như upload.
- Ảnh manager upload được tự thêm vào `media_library` (category `uploaded`) để dùng lại cho slot khác.
- Có trang con hoặc tab "Library" để xem toàn bộ kho kèm credit.

### Cổng Phase 3

- Số dòng `media_library` (trừ legacy) ≥ 110; mọi `path` tồn tại trong `public/`; mọi dòng có `license` thuộc danh sách cho phép.
- `du -sh public/media/library` ≤ 45 MB.
- Ảnh contact sheet `test-output/sports-media/library-contact-sheet.png`: trang `/manager/media` tab Library cuộn qua toàn bộ, chụp nhiều tấm nếu cần.
- `grep -rn '"/media/' src` vẫn rỗng.

## Phase 4. Test

Tạo `scripts/tests/agent/sports-media.mjs` (dùng cùng harness với `manager-admin.mjs`). Tối thiểu:

- **SP-01..SP-20:**
  - CRUD môn;
  - 409 khi trùng code hoặc trùng prefix;
  - 409 khi retire mà còn sân, booking, lớp hoặc gói tập;
  - không retire được `all` và môn cuối cùng;
  - xoá hẳn môn chưa có lịch sử, 409 với môn có lịch sử;
  - đổi prefix khi đã có sân → 409;
  - môn mới tạo được sân, đặt được sân và có giá;
  - môn không hợp lệ → 422 ở booking, class, plan và promo;
  - non-manager → 403.
- **ML-01..ML-12:**
  - danh sách kho;
  - chọn ảnh từ kho cho slot;
  - path ngoài kho → 422;
  - upload xong tự vào kho;
  - history ghi đúng;
  - URL công khai của slot đổi theo.
- **HM-01..HM-06:**
  - endpoint heatmap trả `days_booked` và `days_total`;
  - xem 1 ngày thì mỗi ô là booked hoặc free;
  - sân đã retire bị ẩn khi không có booking.
- Mỗi test tạo dữ liệu thì phải tự dọn: retire sân/môn test, huỷ booking test.

## Phase 5. Cổng cuối

1. `npx --no-install tsc --noEmit`: 0 lỗi.
2. `npm run lint`: 0 errors.
3. `node scripts/i18n-check.mjs`: 0 missing.
4. `npm test`: tất cả pass. Test unit nào đang cố định 3 môn thì sửa sang đọc từ bảng sports, nhưng không đổi expected một cách gian lận.
5. Full agent suite so với baseline G-SPORTS: 0 case PASS→FAIL/WARN.
6. Regression 27/27. `manager-admin` và `sports-media` đều PASS 100%.
7. Dựng safe DB mới từ đầu (toàn bộ migration 0001→0035) không lỗi. Chạy lại 0034 và 0035 lần hai trên DB đó cũng không lỗi (chứng minh idempotent).
8. Chụp vào `test-output/sports-media/`, desktop và mobile, light và dark:
   - landing (có môn mới `pickleball` đang bật);
   - `/manager/sports`;
   - `/manager/media` (slot và library);
   - trang đặt sân với môn mới;
   - heatmap;
   - 5 thẻ coach.
9. Chạy `node scripts/tests/agent/run-suite.mjs` một lần cuối trên DB sạch, đảm bảo `pickleball` test đã được dọn (không còn hiện trên landing).

## Phase 6. Báo cáo

Viết bằng tiếng Việt, mỗi mục kèm file:dòng và bằng chứng thật (lệnh + output rút gọn):

1. Phase 1: ảnh heatmap trước/sau, mô tả thay đổi.
2. Phase 2: danh sách cột đã chuyển từ enum sang text; view, index hoặc function phải tạo lại (kèm diff); output grep ở cổng 2.4.
3. Phase 3: tổng số ảnh theo category; dung lượng; bảng slot trước/sau; bảng coach (tên, ảnh mới, nguồn, giấy phép).
4. Bảng giấy phép: đếm số ảnh theo từng loại giấy phép.
5. Kết quả các cổng Phase 5 (số liệu thật).
6. `git status --short` và `git diff --ignore-cr-at-eol --stat`. Danh sách file mới cần commit (để reviewer biết add file nào).
7. Cảnh báo deploy: 0034 chuyển kiểu cột trên Neon. Ước lượng thời gian khoá bảng (bảng nào lớn nhất trên safe DB, bao nhiêu dòng).

KHÔNG commit, KHÔNG push. DỪNG sau khi báo cáo.
