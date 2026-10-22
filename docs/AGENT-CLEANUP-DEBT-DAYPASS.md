> **2026-10-15: chủ dự án quyết xoá hẳn, xem AGENT-BUGFIX mục 8**

# Nhiệm vụ: gỡ Công nợ + Vé ngày (Day pass), thống nhất toàn hệ thống, dọn bàn giao QA

Tài liệu này dành cho agent thực thi. Làm **đúng thứ tự** từ mục 0 đến mục 12. Được chạy lệnh thoải mái, không
cần tiết kiệm. Mọi con số trong báo cáo phải đọc từ file, log hoặc output của lệnh, không viết theo trí nhớ.
Ghi tiến độ liên tục vào `test-output/cleanup/PROGRESS.md`, mỗi bước một dòng: thời gian, bước, kết quả, file
bị đổi.

---

## 0. Luật cứng của nhiệm vụ này

Luật ở mục 1 của `docs/AGENT-TEST-INSTRUCTIONS.md` vẫn giữ nguyên, **trừ một ngoại lệ**: nhiệm vụ này **được
phép sửa** `src/`, `migrations/` (chỉ thêm file mới), `docs/`, `scripts/`. Các luật sau vẫn bắt buộc:

1. Chỉ test trên server an toàn 127.0.0.1:8090 (`node scripts/tests/start-safe-server.mjs`).
2. **Không** mở, in, copy hay grep `.env`, `.env.local`, `.env.*`. Không in biến môi trường bí mật.
3. **Không** đụng Neon thật, payOS thật, SMTP thật. **Không** chạy `migrate`, `db:push`, `db:seed`, `deploy`,
   `check-integrations`, `check:integrations`, `neon`. **Không** dùng công cụ MCP Neon.
4. **Không** sửa migration cũ (`migrations/00xx_*.sql` đã có). Chỉ được **thêm** file migration mới, theo
   chính sách ở mục 3.4.
5. **Không** `npm install`. Dùng `npx --no-install`.
6. **Không** commit, push, tạo branch, reset, stash. Mọi thay đổi chỉ nằm trong working tree để người duyệt.
   Ngoại lệ duy nhất vẫn là `git restore docs/interactive-tests-report.json`.
7. **Không** sửa `attachments/` (tài liệu gốc), `graft/` (index tự sinh), `.agents/`, `agent/`, `node_modules/`.
8. Sơ đồ: **chỉ** draw.io XML theo `CLAUDE.md`. **Cấm Mermaid** dưới mọi hình thức, kể cả trong Markdown
   báo cáo. Khi sửa `.drawio`: không comment XML, mọi vertex có `vertex="1"` và `mxGeometry`, mọi edge có
   `edge="1"` và `mxGeometry`, id duy nhất, source/target trỏ tới vertex có thật, không chồng chéo.
9. Không đổi expected value của test chỉ để có PASS. Status 500 luôn là bug.
10. Ngôn ngữ nhãn trong sơ đồ và SRS: tiếng Anh học thuật (chuẩn SE FPT University). Báo cáo QA: tiếng Việt.

---

## 1. Quyết định nghiệp vụ (đã chốt, không bàn lại)

### 1.1 Công nợ: **không tồn tại** trong hệ thống

- Không có trần nợ (`debt_limit_vnd`), không có view nợ gói (`v_subscription_debt`), không có "member đang nợ
  thì không đặt sân".
- Gói tập trả **một lần, đủ tiền** (BR-19). Đơn gói chưa trả là **"đơn chờ thanh toán"** (pending order),
  **không phải nợ**.
- **Đặt cọc booking + thu phần còn lại (collect-balance) vẫn giữ.** Đây là tính năng đặt cọc, không phải công
  nợ. Chỉ đổi **cách gọi**: "số còn phải thu" / "balance due", không gọi là "nợ".
- **BR-44** trong code nghĩa là: **"Chỉ được thu tiền tại quầy khi lễ tân đang mở ca thu ngân"**
  (`extras.ts:40`, `desk.ts:256`, `bookings.ts:938`, `bookings.ts:1130`). Code là chuẩn. Mọi tài liệu ghi BR-44
  là "debt limit" đều **sai** và phải sửa.

### 1.2 Vé ngày (Day pass): **gỡ khỏi sản phẩm**

- **Gỡ toàn bộ đường ghi**: bán, dùng, huỷ vé ngày; màn hình quầy; mục menu; cấu hình giá; API.
- **Giữ đường đọc lịch sử**: dữ liệu cũ (payment `ref_type = 'day_pass'`, audit `sell_day_pass` /
  `use_day_pass` / `void_day_pass`) vẫn phải **hiển thị được** và **vẫn được tính** trong báo cáo doanh thu,
  sổ ca, hoá đơn cũ. Lý do: tiền đã thu thật thì không được biến mất khỏi sổ.
- **Không xoá bảng `day_passes`**, không xoá giá trị enum, không xoá cột `day_pass_vnd` trong DB ở nhiệm vụ này
  (xem mục 3.4). Code chỉ thôi đọc/ghi phần đã gỡ.

---

## 2. Kiểm kê trước khi sửa (bắt buộc, chưa sửa gì)

Tạo `test-output/cleanup/INVENTORY.md`. Chạy grep **không phân biệt hoa thường** trên toàn repo, loại trừ
`node_modules/`, `test-output/`, `.output/`, `dist/`, `attachments/`, `graft/`, `.agents/`, `agent/`:

| Nhóm | Mẫu grep |
|---|---|
| Vé ngày | `day.?pass`, `daypass`, `day_passes`, `vé ngày`, `DP-0`, `dayPass` |
| Công nợ | `debt`, `công nợ`, `cong no`, `owed`, `còn nợ`, `khoản nợ`, `debt_limit`, `v_subscription_debt`, `FR-B08` |
| BR-44 | `BR-44` |

Với **mỗi** dòng trúng, ghi một hàng: `file:dòng | trích ngắn | phân loại | hành động dự kiến`.

Phân loại dùng đúng một trong các nhãn sau:

- `WRITE-PATH`: code bán/dùng/huỷ vé ngày, cấu hình giá vé ngày → **xoá**.
- `UI-ENTRY`: menu, nút, liên kết, ô cài đặt dẫn tới vé ngày → **xoá**.
- `HISTORY-READ`: nhãn audit, nhãn `ref_type`, báo cáo, sổ ca, hoá đơn đọc dữ liệu cũ → **giữ**, thêm comment
  một dòng giải thích vì sao giữ.
- `DEBT-WORDING`: chữ "nợ / owed / debt" mô tả đơn chờ thanh toán hoặc phần còn phải thu → **đổi chữ**.
- `DEBT-STALE-DOC`: tài liệu còn mô tả công nợ → **sửa tài liệu**.
- `BR44-WRONG`: tài liệu gọi BR-44 là debt limit → **sửa thành quy tắc mở ca**.
- `OLD-MIGRATION`: nằm trong migration cũ → **không sửa**, chỉ ghi nhận.
- `GENERATED`: file sinh tự động (báo cáo chấm điểm, `graft/`, PDF/HTML xuất ra) → ghi nhận, sinh lại nếu có
  script, không sửa tay.
- `FALSE-POSITIVE`: trúng chữ nhưng không liên quan → bỏ qua, ghi lý do.

Cuối INVENTORY.md: bảng đếm theo nhãn. **Phải liệt kê ít nhất** các điểm đã biết sau. Thiếu điểm nào là
kiểm kê chưa xong.

- `src/lib/arena3/router.ts:338–351`: 4 route `/day-passes`.
- `src/lib/arena3/handlers/extras.ts:369–484`: `dayPassSell`, `dayPassList`, `dayPassUse`, `dayPassVoid`.
- `src/lib/arena3/handlers/extras.ts:501`: `ref_type in ('booking','subscription','day_pass')` → HISTORY-READ.
- `src/routes/desk.day-passes.tsx`: cả màn hình.
- `src/routes/desk.index.tsx:228`, `src/routes/manager.index.tsx:222`, `src/components/shell.tsx:85–87,117`:
  lối vào UI.
- `src/routes/manager.settings.tsx:46,223,227`, `src/lib/arena3/validate.ts:54,89`,
  `src/lib/arena3/helpers.ts:43,57`, `src/lib/arena3/handlers/desk.ts:1019`: giá vé ngày.
- `src/routes/manager.audit.tsx:113,123,124,144`, `src/lib/arena3/labels.ts:227`: HISTORY-READ.
- `src/lib/i18n/vi.ops.ts`, `src/lib/i18n/vi.srv.ts`: chuỗi dịch.
- `src/routes/desk.payments.tsx:206,352–355,587`, `src/lib/i18n/vi.desk.ts:294,322`: DEBT-WORDING.
- `src/lib/arena3/handlers/desk.ts:297,611`: comment nhắc "debt". Đọc kỹ rồi quyết định.
- `docs/SRS.md:163` (FR-B08), `:357` (FR-G03 "debt"), `:372` (FR-G18 "debt"), `:544` (BR-44 sai nghĩa).
- `docs/SDD.md:216` (subscription-debt view).
- `docs/SRS-feature-checklist.md:86,96,204`, `docs/FIXLIST.md:48,241`, `docs/HANDOFF-SRS-v2.3.md`.
- `docs/diagrams/srs/06-uc-desk-sales.drawio`, `20-cd-booking-payment.drawio`, `23-cd-operations.drawio`,
  `26-sf-receptionist.drawio`, `28-sf-manager.drawio`, `33-erd-logical-3-payments.drawio`.
- Script sinh tài liệu và sơ đồ: `scripts/build-srs-iii.py`, `scripts/srs_pipeline/doc-nb.txt`,
  `scripts/srs_pipeline/br_map.py`, `scripts/srs_diagrams/{usecase,classes,screens,erd_logical}.py`,
  `scripts/srs_diagrams/erd_logical_layout.json`.
- Test: `scripts/tests/agent/{01-authz-matrix,09-extras,12-jobs-races,13-misc,14a-deep-input,14b-deep-money,14e-deep-races,14f-role-matrix,audit-expects,regression}.mjs`,
  `scripts/tests/test-desk-flows.mjs`, `scripts/arena3-srs141-check.mjs`, `scripts/auto-grade.mjs`,
  `src/lib/arena3/arena3.test.ts` (nếu có chữ trúng).
- Tài liệu tiếng Việt: `docs/Arena3-So-tay-Kiem-thu-va-Nghiem-thu-Chi-tiet.md`,
  `docs/Arena3-Phan-cong-va-Kich-ban-Nghiem-thu.md`, `docs/Arena3-Phan-cong-5-nguoi-Chi-tiet.md`,
  `docs/Arena3-Evidence-And-UI-Grade.md`, `docs/Arena3-Scope-Benchmark.md`.
- Tài liệu QA: `docs/AGENT-TEST-INSTRUCTIONS.md:678,680`, `docs/AGENT-TEST-SUITES.md:99,117–125`,
  `docs/AGENT-TEST-ROUND2.md:76`.

Grep thêm cờ tính năng: `src/lib/arena3/flags.ts` có cờ cho vé ngày không. Nếu có, gỡ cờ đó và ghi vào
INVENTORY.

**Chụp mốc trước khi sửa** vào `test-output/cleanup/BASELINE.md`:

- `git status --short` và `git diff --stat`. Cây làm việc đã có file chưa commit, **không được làm mất**.
- Số route: GET/POST/PATCH/PUT/DELETE và tổng (đã biết: 161 route, 91 route ghi). Đọc lại từ `router.ts`.
- `npx --no-install tsc --noEmit`: số lỗi trước khi sửa. Có lỗi sẵn thì ghi lại để không đổ cho nhiệm vụ này.
- `npx --no-install eslint src`: số lỗi và cảnh báo.
- Unit test nếu repo có (`npx --no-install vitest run`): số pass/fail.

---

## 3. Gỡ Vé ngày khỏi code

Sửa theo đúng thứ tự dưới đây. Sau **mỗi** mục con, chạy `npx --no-install tsc --noEmit`. Lỗi tăng so với
BASELINE thì sửa ngay rồi mới đi tiếp.

### 3.1 API

1. `router.ts`: xoá 4 khối route `day-passes` (GET list, POST sell, POST `:id/use`, POST `:id/void`) và comment
   `// Day passes.`. Sau khi xoá, `/v1/day-passes*` phải rơi xuống nhánh "không có route" như mọi đường dẫn lạ.
   Đọc cuối `router.ts` để biết nhánh đó trả gì (404 code nào) và ghi vào báo cáo.
2. `handlers/extras.ts`: xoá `dayPassSell`, `dayPassList`, `dayPassUse`, `dayPassVoid` và tiêu đề
   `/* ── Day pass ── */`. Sửa comment đầu file (dòng ~23) để không còn liệt kê "day passes".
3. Import nào thành thừa sau khi xoá (`ictDateString`, helper sinh mã…) thì gỡ, **chỉ khi** không còn chỗ nào dùng.
4. **Giữ** `ref_type in ('booking','subscription','day_pass')` ở `extras.ts:501`. Thêm comment một dòng, ví dụ:
   `// 'day_pass' stays: day passes are no longer sold, but cash already taken for them still belongs to the shift.`
   Grep thêm mọi truy vấn báo cáo hoặc sổ ca có lọc `ref_type`. Chỗ nào **liệt kê tường minh** các `ref_type` mà
   bỏ sót `day_pass` thì **không** tự thêm vào; chỉ ghi vào `NEEDS-HUMAN`.

### 3.2 Cấu hình giá

1. `validate.ts:54,89`: bỏ `day_pass_vnd` khỏi schema settings và bảng nhãn.
2. `helpers.ts:43,57`: bỏ khỏi kiểu settings và câu `select` đọc settings.
3. `handlers/desk.ts:1019`: bỏ khỏi câu `select`/`update` settings.
4. `manager.settings.tsx:46,223,227`: bỏ khỏi danh sách field, bỏ ô "Day pass price". Đổi tiêu đề nhóm
   "Fixed weekly bookings, points and day pass" thành "Fixed weekly bookings and points", và sửa khoá dịch tương
   ứng ở `vi.ops.ts:204`.
5. **Hành vi phải xác định rõ:** sau khi gỡ, `PATCH /v1/settings` có gửi `day_pass_vnd` thì server **từ chối
   422** (field lạ) hay **lặng lẽ bỏ qua**? Đọc `validate.ts` để biết schema là strict hay passthrough. Ghi kết
   luận kèm `file:dòng` vào báo cáo. **Không** đổi độ strict của schema chỉ để test dễ.

### 3.3 Giao diện

1. Xoá file `src/routes/desk.day-passes.tsx`.
2. Xoá lối vào ở `desk.index.tsx:228`, `manager.index.tsx:222`, `shell.tsx:87` và `shell.tsx:117`. Sửa comment
   `shell.tsx:85` cho đúng (không còn nhắc bán vé ngày).
3. Icon `Ticket` (và import khác) thành thừa thì gỡ import. Không gỡ nếu còn chỗ khác dùng.
4. `src/routeTree.gen.ts` là file **tự sinh**. Không sửa tay. Sinh lại bằng đúng cơ chế của dự án: đọc
   `package.json` và cấu hình TanStack Router để biết lệnh (thường build hoặc dev sẽ tự sinh). Sau khi sinh
   lại, `grep -i day-passes src/routeTree.gen.ts` phải ra 0 dòng.
5. i18n `vi.ops.ts` và `vi.srv.ts`: xoá các khoá **chỉ** màn hình vé ngày dùng: "Day passes", "Day pass {code}
   sold", "Day pass price (đ)", "A day pass cannot be for a past day.", và các khoá khác trong khối
   `// ── day passes`. **Giữ** "Day pass", "Sell day pass", "Use day pass", "Void day pass", "day pass", vì nhãn
   lịch sử ở `manager.audit.tsx` và `labels.ts` vẫn dùng. Sửa comment `vi.ops.ts:2`, `vi.ops.ts:66` và
   `vi.srv.ts:311`.
6. Trước khi xoá một khoá dịch, grep khoá đó trên `src/`. Còn chỗ dùng thì giữ.
7. Mở `/desk/day-passes` bằng trình duyệt hoặc fetch HTML trên server an toàn: phải ra trang 404 hoặc not-found
   của app, **không** trắng trang, **không** lỗi console. Ghi lại bằng chứng.

### 3.4 Cơ sở dữ liệu: chính sách

- **Không** thêm migration xoá bảng `day_passes`, cột `day_pass_vnd`, hay giá trị `day_pass` của `ref_type`.
  Dữ liệu thật trên production có thể đang trỏ tới chúng.
- Nếu `v_subscription_debt` **vẫn còn** sau toàn bộ chuỗi migration hiện có thì được thêm **một** migration
  mới, đánh số tiếp theo. Kiểm chuỗi bằng cách đọc theo thứ tự: tạo ở `0002`, có thể đổi ở `0011`/`0012`, có
  thể đã xoá ở `0022`. Điều kiện thêm: **không** còn code, view hay hàm nào tham chiếu tới view đó (grep
  chứng minh). Nội dung chỉ một câu `DROP VIEW IF EXISTS v_subscription_debt;` kèm comment đầu file theo house
  style (xem header các migration khác). Nếu `0022` đã xoá rồi thì **không** thêm gì, chỉ ghi `file:dòng`
  chứng minh.
- Server an toàn tự áp migration khi khởi động. Khởi động lại và xác nhận không lỗi.
- Ghi vào `NEEDS-HUMAN`: "Có xoá hẳn bảng `day_passes` / cột `day_pass_vnd` trên production không, và khi nào".

### 3.5 Unit test và script phụ

- `src/lib/arena3/arena3.test.ts` và `scripts/tests/test-desk-flows.mjs`: test nào bán, dùng hoặc huỷ vé ngày
  thì **xoá**. Test nào khẳng định "settings không có debt" thì **giữ**.
- `scripts/arena3-srs141-check.mjs:81` khẳng định settings không có `debt_limit`. Giữ nguyên, đây là bằng
  chứng công nợ đã gỡ.
- `scripts/auto-grade.mjs`: nếu chấm điểm có tiêu chí vé ngày thì sửa sang "đã gỡ theo quyết định phạm vi". Không
  xoá mất tiêu chí khác.

---

## 4. Dọn Công nợ (code đã gỡ, giờ dọn chữ và tài liệu)

### 4.1 Code: chỉ đổi chữ, không đổi logic

1. `desk.payments.tsx:206`: đổi tên biến `owed` thành `toCollect` (hoặc `dueTotal`).
2. `desk.payments.tsx:352–355`: đổi chuỗi `"{n} waiting · {amount} owed"` thành `"{n} waiting · {amount} to
   collect"`. Comment dòng 352 cũng đổi chữ "owed" tương ứng.
3. `desk.payments.tsx:587`: đổi `"Nothing owed"` thành `"Nothing to collect"`.
4. `vi.desk.ts:294`: `"{n} waiting · {amount} to collect": "{n} đang chờ · cần thu {amount}"`.
   `vi.desk.ts:322`: `"Nothing to collect": "Không có khoản chờ thu"`. Xoá khoá cũ.
5. `handlers/desk.ts:297` ("No debt and no deposit (BR-19)…"): đây là câu khẳng định chính sách, **giữ**,
   nhưng sửa cho rõ: "No credit and no deposit (BR-19)…" hoặc giữ nguyên nếu đọc kỹ thấy đúng nghĩa. Ghi lựa
   chọn vào báo cáo.
6. `handlers/desk.ts:611` ("rather than the debt view"): view đó không còn, sửa comment cho đúng hiện trạng.
7. Grep lại `debt|owed|công nợ|còn nợ` trên `src/`. Kết quả còn lại phải là **0**, hoặc từng dòng được giải
   thích là FALSE-POSITIVE.
8. Nếu `GET /v1/directory/members` hoặc `GET /v1/members/:id` còn trả một trường kiểu nợ (`debt_vnd`,
   `owed_vnd`…): **không** xoá trường API (có thể phá client). Ghi vào `NEEDS-HUMAN` kèm `file:dòng` và giá trị
   mẫu. Nếu không có trường như vậy, ghi "không có" kèm lệnh grep đã chạy.

### 4.2 Tài liệu SRS và SDD

1. `docs/SRS.md`:
   - **Xoá** FR-B08 (dòng 163). Không đánh lại số các FR khác. Để lại một dòng
     `| FR-B08 | *(Removed in v2.4 — no debt in the system; see BR-19.)* | — |` để mã truy vết không bị
     "nhảy" một cách khó hiểu.
   - FR-G03 (dòng 357): bỏ "debt and"; viết "cancellation windows, refund limits, VAT and rounding". Đối chiếu
     với các trường thật của `PATCH /v1/settings` trong `validate.ts` sau khi gỡ `day_pass_vnd`. Danh sách
     trong FR-G03 phải khớp code.
   - FR-G18 (dòng 372): bỏ "debt". Viết theo đúng các cột mà `GET /v1/directory/members` trả thật.
   - BR-44 (dòng 544): sửa thành **"Money may be taken at the desk only within the receptionist's open cashier
     shift."**, khớp `scripts/srs_pipeline/doc-nb.txt:1468` và message `"Open a till shift before taking
     payment."`.
   - Mọi UC, FR, ma trận truy vết, glossary nhắc vé ngày / day pass / UC-23: xoá UC-23 khỏi danh sách, để dòng
     `*(Removed in v2.4.)*` ở vị trí cũ, cập nhật ma trận truy vết FR↔UC↔BR↔TC để không còn tham chiếu treo.
   - Thêm mục **Revision history**: dòng `v2.4 | 2026-10-14 | Removed day pass (UC-23) and residual debt wording;
     corrected BR-44 to the open-shift rule.`
2. `docs/SDD.md:216`: bỏ "the subscription-debt view". Grep toàn SDD tìm day pass hoặc endpoint
   `/day-passes`, xoá khỏi danh sách API, ERD mô tả bằng chữ, bảng module. Bảng `day_passes` trong phần mô tả DB:
   giữ, ghi chú "legacy, read-only, no longer written".
3. `docs/SRS-feature-checklist.md`:
   - Dòng 86: sửa nội dung cho đúng BR-44 (đã đúng nghĩa mở ca thì giữ).
   - Dòng 96 (UC-23): đổi thành `~~UC-23 Bán và dùng vé ngày~~: đã gỡ khỏi phạm vi (v2.4)`.
   - Dòng 204: bỏ "vé ngày 60.000đ".
4. `docs/FIXLIST.md:48,241`: dòng 241 "kèm nợ": sửa theo kết quả mục 4.1.8. Dòng 48: đọc toàn dòng, sửa phần
   nhắc debt hoặc day pass.
5. `docs/HANDOFF-SRS-v2.3.md`: **không** sửa nội dung lịch sử. Thêm ở đầu file một khung ghi chú:
   "Superseded in part by v2.4: day pass removed, BR-44 = open shift."
6. Tài liệu tiếng Việt (Sổ tay kiểm thử, Phân công, Phân công 5 người, Evidence-And-UI-Grade): xoá kịch bản,
   ca kiểm thử, nhiệm vụ phân công về vé ngày và công nợ. Chỗ nào có bảng tổng số ca thì **đếm lại** cho khớp.
   Nếu một người trong bảng phân công chỉ phụ trách vé ngày, ghi vào `NEEDS-HUMAN`; **không** tự phân lại.
7. `docs/Arena3-Scope-Benchmark.md`: là tài liệu so sánh phạm vi, **không xoá** dòng day pass. Đổi trạng thái
   thành "Removed by scope decision (v2.4)".
8. `docs/Arena3-Grading-Report.md` và `docs/grading-report.json`: là kết quả chấm sinh ra. Nếu có script sinh
   (`scripts/auto-grade.mjs`) thì sinh lại **sau** mục 8. Nếu không sinh lại được thì để nguyên và ghi
   `GENERATED, not regenerated` vào báo cáo.

### 4.3 Script sinh SRS và sơ đồ

Sửa **nguồn** để lần sinh sau không đưa vé ngày hay công nợ quay lại:

- `scripts/build-srs-iii.py:407`: bỏ câu "BR-44 debt over debt_limit_vnd blocks a new booking." `:694`: sửa
  BR-44 thành quy tắc mở ca. Grep cả file tìm day pass hoặc UC-23.
- `scripts/srs_pipeline/doc-nb.txt`: BR-44 ở dòng 1468 đã đúng. Grep day pass, UC-23, `/day-passes`, xoá đúng
  khối UC và các tham chiếu chéo. Danh sách UC ở dòng 1468 còn UC-23 thì bỏ.
- `scripts/srs_pipeline/br_map.py`: đọc, đảm bảo không ánh xạ BR-44 về nghĩa nợ.
- `scripts/srs_diagrams/usecase.py`, `classes.py`, `screens.py`, `erd_logical.py`, `erd_logical_layout.json`:
  bỏ use case, màn hình, lớp DayPass. **ERD giữ bảng `day_passes`**, gắn nhãn `legacy`, vì bảng vẫn tồn tại
  trong DB.
- **Không** chạy pipeline xuất PDF hay DOCX. Chỉ sửa nguồn. Script sinh `.drawio` chạy được offline thì được
  chạy, nhưng phải kiểm `git diff --stat docs/diagrams/`: chỉ các file sơ đồ dự kiến được đổi. Đổi lan sang
  sơ đồ khác thì `git restore` **riêng** các file lan đó (ngoại lệ git được phép duy nhất trong nhiệm vụ này,
  và chỉ cho file `.drawio` do chính bạn vừa sinh ra), rồi sửa tay.

### 4.4 Sơ đồ draw.io

Với từng file `06-uc-desk-sales`, `20-cd-booking-payment`, `23-cd-operations`, `26-sf-receptionist`,
`28-sf-manager`, `33-erd-logical-3-payments`:

1. Tìm vertex có nhãn liên quan vé ngày hoặc công nợ.
2. Xoá vertex đó **và mọi edge** có `source` hoặc `target` là id của vertex đó.
3. Xếp lại các vertex còn lại nếu để lại lỗ lớn. Không được tạo chồng chéo.
4. ERD (`33-erd-logical-3-payments`): giữ entity `day_passes`, thêm `«legacy»` vào tên, không xoá quan hệ với
   `payments`.
5. Sau khi sửa, kiểm từng file bằng một script Node nhỏ (đặt ở `scripts/tests/agent/check-drawio.mjs`) đọc XML
   và báo:
   - id trùng
   - edge có source/target không tồn tại
   - cell thiếu `mxGeometry`
   - cell vừa không có `vertex="1"` vừa không có `edge="1"` (trừ id `0` và `1`)
   - có chuỗi `<!--`
   - có chữ `mermaid`
   - hai vertex cùng parent có hình chữ nhật giao nhau
   
   Kết quả phải là 0 lỗi cho **mọi** file trong `docs/diagrams/`, không chỉ 6 file vừa sửa. File cũ có lỗi
   sẵn thì ghi riêng, không sửa trong nhiệm vụ này.

---

## 5. Cập nhật tài liệu QA và bộ test

### 5.1 Tài liệu QA

- `docs/AGENT-TEST-INSTRUCTIONS.md:678`: bỏ `DP-` (vé ngày) khỏi danh sách tiền tố. `:680`: bỏ "day pass".
  Thêm tiền tố mới `RMV-` (kiểm việc gỡ tính năng).
- `docs/AGENT-TEST-SUITES.md`:
  - Đổi tiêu đề Suite 09 thành "Thiết bị, điểm thưởng, hoa hồng, work order".
  - Xoá mục 09.2 `DP-` và **không** đánh lại số các mục 09.x khác; để lại dòng
    `### 09.2 (Đã gỡ: vé ngày, v2.4)`.
  - Thêm **Suite 15** theo mục 5.3 bên dưới.
- `docs/AGENT-TEST-ROUND2.md:76`: bỏ "bán vé ngày" khỏi luồng tiền.
- Mọi chỗ trong ba file trên nhắc "161 route" hoặc "91 route ghi" thì cập nhật theo số đếm lại ở mục 7.

### 5.2 Script test

Trong `scripts/tests/agent/`:

| File | Việc |
|---|---|
| `09-extras.mjs` | Xoá mọi case `DP-*` và helper chỉ phục vụ vé ngày |
| `01-authz-matrix.mjs` | Bỏ các route `/day-passes*` khỏi ma trận quyền |
| `12-jobs-races.mjs` | Bỏ bước bán vé ngày trong race/luồng tiền. Nếu một race **chỉ** chạy trên vé ngày, xoá case và ghi id vào báo cáo |
| `13-misc.mjs` | Bỏ phần liên quan |
| `14a-deep-input.mjs` | Bỏ 4 route vé ngày khỏi danh sách route sinh tự động hoặc khai báo tay |
| `14b-deep-money.mjs` | Bỏ bước bán vé ngày trong chuỗi bất biến tiền. Bất biến tổng tiền phải tính lại, **không** sửa expected bằng tay |
| `14e-deep-races.mjs` | Như 12 |
| `14f-role-matrix.mjs` | Bỏ route vé ngày khỏi ma trận |
| `audit-expects.mjs` | Bỏ kỳ vọng audit `sell_day_pass`/`use_day_pass`/`void_day_pass` cho **luồng mới**. Kỳ vọng hiển thị nhãn lịch sử thì giữ |
| `regression.mjs` | Finding nào chỉ về vé ngày → trạng thái `OBSOLETE` (xem mục 6), không chạy nữa |
| `generate-round4-routes.mjs` | Chạy lại để sinh `ROUTES.md` mới |

Mỗi case bị xoá phải ghi vào `test-output/cleanup/REMOVED-CASES.md`: `id | file | lý do (feature removed /
debt removed)`. **Cấm** xoá case không thuộc hai tính năng trên.

### 5.3 Suite 15 mới: `15-removed-features.mjs`, tiền tố `RMV-`

| id | Hành động | Kỳ vọng |
|---|---|---|
| RMV-01 | `GET /v1/day-passes?date=<hôm nay>` bằng token lễ tân | Giống mọi route không tồn tại (đọc nhánh cuối router để biết status/code chính xác); **không** 200, **không** 500 |
| RMV-02 | `POST /v1/day-passes` body hợp lệ cũ, token lễ tân, có mở ca | Như RMV-01. Sau đó số payment trong ca **không đổi** |
| RMV-03 | `POST /v1/day-passes/<uuid>/use` | Như RMV-01 |
| RMV-04 | `POST /v1/day-passes/<uuid>/void` | Như RMV-01 |
| RMV-05 | RMV-01..04 với token manager và member | Như RMV-01 (không lộ khác biệt theo vai) |
| RMV-06 | `GET /v1/settings` (manager) | Không có key `day_pass_vnd`, không có key nào chứa `debt` |
| RMV-07 | `PATCH /v1/settings` `{ "day_pass_vnd": 70000 }` | Đúng hành vi đã xác định ở mục 3.2.5 (422 hoặc bỏ qua); `GET` lại không có key |
| RMV-08 | `PATCH /v1/settings` `{ "debt_limit_vnd": 1 }` | Cùng hành vi như RMV-07 |
| RMV-09 | Lễ tân **không** mở ca, thu tiền mặt một booking | 422 `BR-44`, message mở ca |
| RMV-10 | Member có đơn gói pending chưa trả vẫn đặt sân được (không có chặn nợ) | 2xx, hoặc bị chặn bởi **luật khác** có BR rõ; **không** được có lý do "nợ" |
| RMV-11 | `GET /v1/audit` có lọc hoặc trang chứa audit `sell_day_pass` cũ (tạo bằng cách insert trực tiếp vào DB PGLite **của server an toàn** nếu có helper, nếu không thì BLOCKED có lý do) | Trả về bình thường, nhãn hiển thị được, không 500 |
| RMV-12 | Báo cáo doanh thu / đóng ca khi có payment `ref_type='day_pass'` cũ (cách tạo như RMV-11) | Tiền đó **vẫn** được tính; tổng khớp |
| RMV-13 | Tải HTML `/desk/day-passes` | Trang not-found của app, status như route lạ khác |
| RMV-14 | Tải HTML `/desk` và `/manager`, tìm chuỗi `day-passes` | 0 lần |
| RMV-15 | `GET /v1/directory/members` (manager) | Không trường nào tên chứa `debt`/`owed`; nếu có → FAIL, liên kết NEEDS-HUMAN mục 4.1.8 |

RMV-11 và RMV-12: **không** sửa `src/` để tạo dữ liệu. Chỉ dùng cơ chế seed hoặc SQL sẵn có của server an
toàn. Không có cơ chế thì đánh `blocked` kèm lý do, đừng giả PASS.

Đăng ký Suite 15 vào `run-suite.mjs` và `run-all-clean.mjs`.

---

## 6. Cập nhật findings F-01..F-28

Đọc `test-output/final/BUGS-FINAL.md`. Với mỗi finding:

- Chỉ về vé ngày (ví dụ input sai ở `/day-passes` trong F-27/F-28, FK ở `day_passes`, race bán vé): tách phần
  vé ngày ra. Nếu finding **chỉ** còn vé ngày → trạng thái `OBSOLETE (feature removed v2.4)`. **Không** ghi
  "fixed".
- Finding có nhiều route, trong đó có route vé ngày: giữ finding, bỏ route vé ngày khỏi danh sách repro và
  regression ids, **đếm lại** số case.
- Finding về công nợ: tương tự, `OBSOLETE`.
- Ghi bảng trước/sau vào `test-output/cleanup/FINDINGS-DELTA.md`: `F-xx | trước | sau | lý do | file:dòng`.

---

## 7. Dọn bàn giao QA (6 điểm còn tồn từ lần duyệt trước)

1. **Mermaid**: xoá **mọi** khối ```` ```mermaid ```` và mọi sơ đồ dạng Mermaid trong `test-output/` (đặc biệt
   `final/BUGS-FINAL.md`, `final/HANDOFF.md`). Thay bằng bảng Markdown: `nhóm | finding | nguyên nhân gốc |
   file:dòng`. Cần sơ đồ thì tạo `.drawio` trong `docs/diagrams/qa/` theo CLAUDE.md và kiểm bằng
   `check-drawio.mjs`. Cuối cùng grep `mermaid` trên `test-output/` và `docs/`: phải ra 0.
2. **14f hàng 4–6** (HLV nhận 404 ở `/bookings/:id*`): kiểm id trong ma trận là thật hay giả. Id giả hoặc 404
   do không tìm thấy → gán F-10, không phải F-03. Regression ids của F-03 phải là các case HLV thao tác
   **thành công** trên booking người khác (BK-83/86/89). Sửa `regression.mjs`, chạy
   `node scripts/tests/agent/regression.mjs F-03`: phải `STILL_FAIL`.
3. **14f hàng 13–16** (`coach_other` nhận 404 ở `/sessions/:id/*`): trích handler. Handler cố ý lọc theo HLV
   sở hữu rồi trả 404 để che sự tồn tại → chuyển sang `NEEDS-HUMAN`, bỏ khỏi F-10. Không cố ý → giữ F-10.
4. **Severity**:
   - F-11 → **MEDIUM**. Lý do: đổi mật khẩu không thu hồi được phiên đã lộ.
   - Top 5 phải có F-03 (HIGH) thay cho cặp MEDIUM F-27/28.
   - Ghi vào bảng đổi severity.
5. **Fix group**: chỉ giữ là "nhóm" những finding **cùng nguyên nhân gốc và sửa ở cùng một chỗ**: G-1 (withTx),
   G-2 (FK 23503), G-3 (thứ tự auth), G-5 (mã member), và F-27+F-28 nếu cùng nằm ở `helpers.ts`. Tách G-4, G-6
   phần còn lại và G-7 thành từng bug lẻ, mỗi bug một `file:dòng` gốc.
6. **Test chập chờn**: sửa BK-98, BK-99, BK-124, TIME-06-peak-price, SS-19, SS-22 để dùng **ngày cố định ở
   tương lai** (`freeSlotAnyDay`, hoặc ngày tương lai cố định đúng thứ cần), sân riêng nếu cần, không phụ thuộc
   giờ chạy hay thứ tự case.
   - Chạy riêng từng suite bị ảnh hưởng **3 lần liên tiếp**. Verdict phải giống nhau cả 3 lần.
   - Giải thích BLOCKED 8 → 7 (đếm ra lẽ ra 6).
   - Giải thích unique 2,991 → 2,992: id nào mới xuất hiện.

---

## 8. Kiểm chứng toàn bộ

Chạy theo thứ tự, ghi output tóm tắt vào `test-output/cleanup/VERIFY.md`:

1. `npx --no-install tsc --noEmit`: số lỗi **không lớn hơn** BASELINE.
2. `npx --no-install eslint src`: số lỗi không lớn hơn BASELINE.
3. Unit test (nếu có): không có test mới fail. Test fail vì đã xoá tính năng phải được **xoá** ở mục 3.5, không
   để fail.
4. Build production local (lệnh `build` trong `package.json`; **không** deploy): build thành công.
5. Khởi động server an toàn: migrate in-memory không lỗi, không cảnh báo mới.
6. Đếm lại route từ `router.ts`. Kỳ vọng: **157 route** (GET 67, POST 71, PATCH 12, PUT 5, DELETE 2) và **88
   route ghi**. Số khác thì giải thích bằng `file:dòng`, **không** sửa cho khớp.
7. `node scripts/tests/agent/check-drawio.mjs`: 0 lỗi mới.
8. Grep cuối, loại trừ như mục 2. Mọi dòng còn lại phải có nhãn `HISTORY-READ`, `OLD-MIGRATION`, `GENERATED`
   hoặc `FALSE-POSITIVE` trong INVENTORY. Dòng nào không có nhãn → quay lại sửa.
   - `day.?pass|daypass|vé ngày|/day-passes`
   - `debt|công nợ|còn nợ|owed|debt_limit|v_subscription_debt`
   - `mermaid`
9. Chạy sạch toàn bộ: `run-all-clean.mjs` (gồm Suite 15). Sau đó chạy `reconcile.mjs` và `regression.mjs` (mọi
   finding).
10. So với lần chạy sạch trước (2,992 case: 2,875 PASS / 89 FAIL / 21 WARN / 7 BLOCKED). Lập bảng:
    `trước | xoá (REMOVED-CASES) | thêm (RMV-) | kỳ vọng sau | thực tế sau`. Từng cột phải cộng khớp. Lệch thì
    liệt kê id gây lệch.
11. FAIL mới xuất hiện ở suite không liên quan → **dừng lại**, điều tra xem có phải do việc gỡ code gây hồi quy
    không. Ghi `file:dòng` nguyên nhân. Hồi quy do mình gây ra thì sửa trong `src/`, chạy lại từ bước 1.

---

## 9. Kiểm giao diện

Dùng trình duyệt trên server an toàn. Đăng nhập bằng tài khoản seed (đọc từ file seed hoặc fixture của dự án,
không dùng thông tin thật).

1. Lễ tân: trang `/desk` và menu không còn "Vé ngày". Chụp màn hình.
2. Manager: `/manager/settings` không còn ô giá vé ngày, nhóm đổi tên đúng. Chụp màn hình.
3. Lễ tân: `/desk/payments` hiển thị "cần thu …", không còn chữ "nợ". Chụp màn hình cả tiếng Việt và tiếng Anh.
4. Manager: `/manager/audit` vẫn hiển thị được dòng audit vé ngày cũ, nếu tạo được dữ liệu ở RMV-11.
5. `/desk/day-passes`: trang not-found. Console không lỗi.

Lưu ảnh vào `test-output/cleanup/screens/`.

---

## 10. Không được làm

- Không tự gỡ tính năng **đặt cọc**, **collect-balance**, **series**, **điểm thưởng**. Chúng không thuộc
  phạm vi.
- Không đổi nghĩa BR khác ngoài BR-44.
- Không đánh lại số FR, UC, BR, TC. Mục bị gỡ để lại dòng "Removed in v2.4".
- Không sửa expected value của test không liên quan để làm cho tổng đẹp.
- Không dùng Mermaid.

---

## 11. Sản phẩm đầu ra

Trong `test-output/cleanup/`:

| File | Nội dung |
|---|---|
| `PROGRESS.md` | Nhật ký từng bước |
| `INVENTORY.md` | Kiểm kê có nhãn, bảng đếm |
| `BASELINE.md` | Mốc trước khi sửa |
| `CHANGES.md` | Danh sách **mọi** file bị đổi/thêm/xoá, mỗi file 1 dòng lý do, kèm `git diff --stat` cuối |
| `REMOVED-CASES.md` | Case test đã xoá |
| `FINDINGS-DELTA.md` | Findings trước/sau |
| `VERIFY.md` | Kết quả mục 8 |
| `NEEDS-HUMAN.md` | Câu hỏi cần người quyết (DB production, trường API nợ, phân công, ref_type liệt kê thiếu, coach_other 404…) |
| `screens/` | Ảnh mục 9 |

Cập nhật `test-output/final/BUGS-FINAL.md` và `test-output/final/HANDOFF.md` theo số mới (HANDOFF tối đa 1
trang, không Mermaid).

---

## 12. Báo cáo cuối (dán lại cho người duyệt)

Trả lời ngắn, đúng khung sau, số liệu đọc từ file:

1. Số file đổi / thêm / xoá (từ `CHANGES.md`).
2. Route: trước → sau, route ghi: trước → sau.
3. Grep cuối: số dòng còn lại theo nhãn.
4. tsc / eslint / unit / build: trước → sau.
5. `check-drawio`: số file kiểm, số lỗi.
6. Chạy sạch: bảng ở mục 8.10.
7. Suite 15: PASS/FAIL/BLOCKED từng id.
8. Findings: danh sách đổi trạng thái (OBSOLETE, đổi severity, đổi nhóm).
9. 6 điểm dọn ở mục 7: từng điểm xong hay chưa, bằng chứng.
10. Test chập chờn: kết quả 3 lần chạy.
11. `NEEDS-HUMAN`: liệt kê.
12. Hồi quy phát hiện trong lúc gỡ (nếu có) và cách đã sửa.

---

## 13. Vòng sửa sau duyệt (R2)

Phần gỡ code đã đạt: `docs/SRS.md` (FR-B08, BR-44, revision v2.4) đúng; `src/` không còn route ghi vé ngày;
tổng chạy sạch cộng khớp (2,991 − 64 + 15 = 2,942; 2,827 + 86 + 21 + 8 = 2,942). Các điểm dưới đây **chưa
đạt**. Làm theo thứ tự, luật mục 0 giữ nguyên. Ghi tiến độ tiếp vào `test-output/cleanup/PROGRESS.md` dưới
tiêu đề `## R2`.

### 13.1 Nhãn grep không khớp code thật

Báo cáo ghi HISTORY-READ tại `extras.ts:440,501` và `desk.ts:287,342`. Grep thật trên `src/` (loại
`routeTree.gen.ts`) ra **15 dòng** ở chỗ khác:

| Vị trí | Nội dung |
|---|---|
| `vi.ops.ts:198,211,213,214,217` | nhãn dịch lịch sử |
| `labels.ts:227` | nhãn `ref_type` |
| `manager.audit.tsx:113,123,124,144` | nhãn audit lịch sử |
| `desk.ts:1004,1025,1050` | `delete row.day_pass_vnd` |
| `extras.ts:383,384` | sổ ca giữ `day_pass` |

Việc cần làm:

1. Chạy lại grep. Gán nhãn cho **đúng** từng `file:dòng` thật trong `INVENTORY.md`.
2. Viết lại `check-inventory-labels.mjs`: nó phải đọc output grep thật rồi so với INVENTORY. Không được đếm theo
   danh sách viết tay.
3. Nhãn `DOCS-LEGACY` và `TESTS-RMV` không có trong mục 2. Được giữ, nhưng phải thêm định nghĩa vào đầu
   `INVENTORY.md`.
4. `desk.ts:1004,1025,1050` lặp ba lần cùng một việc. Gom thành **một** helper nhỏ trong `desk.ts`, ví dụ
   `publicSettings(row)`, kèm comment một dòng: cột legacy còn trong DB, không trả ra API. Sau đó chạy lại
   RMV-06/07/08.
5. Báo lại số dòng theo nhãn **từ output script**.

### 13.2 Mâu thuẫn findings

14a giảm từ 36 FAIL xuống 34 FAIL sau khi xoá 20 case vé ngày. Như vậy 2 FAIL đã nằm trên route vé ngày, và
chúng thuộc F-27/F-28 (hoặc finding khác). Trong khi đó báo cáo ghi "không finding nào đổi".

1. Liệt kê 2 id case đó, kèm finding mà chúng thuộc về.
2. Cập nhật `FINDINGS-DELTA.md` và `BUGS-FINAL.md`: bỏ route vé ngày khỏi repro, đếm lại số case của
   finding (ví dụ F-28 từ 21 xuống 20).
3. Bỏ hai id đó khỏi `regression.mjs`.
4. Làm tương tự cho 14f (bớt 21 case nhưng FAIL vẫn là 17) và 01-authz (bớt 18 case). Chứng minh bằng danh
   sách id trong `REMOVED-CASES.md` rằng **không** case FAIL nào bị xoá ở hai suite này.

### 13.3 Fix group (mục 7.5 chưa làm)

Báo cáo giữ nguyên 7 nhóm, rồi còn nhét thêm F-11 vào G-7. Làm đúng yêu cầu:

1. Chỉ giữ là nhóm khi các finding **cùng nguyên nhân gốc và sửa ở cùng một chỗ**. Cụ thể là G-1 (withTx),
   G-2 (FK 23503), G-3 (thứ tự auth), G-5 (mã member), và F-27+F-28 nếu cả hai nằm ở `helpers.ts`.
2. Tách G-4, phần còn lại của G-6, và G-7 thành **từng bug lẻ**. Mỗi bug có một `file:dòng` gốc riêng.
3. Viết lại mô tả F-03 trong Top 5 cho đúng bản chất: "HLV huỷ/sửa được booking của người khác" (BK-83/86/89).
   Không dùng câu chung chung "đặt sân vượt quyền".

### 13.4 Test chập chờn (mục 7.6 chưa làm đủ)

Báo cáo mới chạy 14c, 08, 12. Chưa có BK-98, BK-99, BK-124, SS-19, SS-22.

1. Tìm suite chứa từng id. Sửa các case đó để dùng ngày cố định ở tương lai và sân riêng.
2. Chạy **riêng** từng suite đó 3 lần liên tiếp. Ghi bảng `id | lần 1 | lần 2 | lần 3`.
3. JOB-04 và RACE-04 đã bị đổi fixture. Ghi `git diff` của hai case đó vào `test-output/cleanup/FIXTURE-DIFF.md`
   và chứng minh **expected không đổi**, chỉ cách tạo dữ liệu đổi. INV-04 (chuyển sang gear_loan) cũng vậy:
   bất biến tiền vẫn phải kiểm cùng một tính chất.
4. Giải thích BLOCKED từ 7 lên 8: id nào mới bị BLOCKED, ở lần chạy nào.
5. Giải thích baseline 2,991 so với lần chạy sạch trước là 2,992: id nào thiếu.

### 13.5 Unit test 59 → 114

Nhiệm vụ này không viết thêm unit test, vậy mà số tăng gần gấp đôi.

1. Ghi đúng lệnh đã chạy ở BASELINE và ở VERIFY.
2. Nếu khác lệnh (ví dụ baseline chỉ chạy một thư mục), chạy lại baseline bằng `git stash`? **Không được**
   (cấm git mutation). Thay vào đó, liệt kê file test mà lệnh sau tìm thấy nhưng lệnh trước không thấy, và nói
   rõ con số nào là thật.
3. Có file test mới do chính agent tạo thì liệt kê.

### 13.6 Bằng chứng RMV-11 / RMV-12

1. Ghi rõ cách tạo audit `sell_day_pass` cũ và payment `ref_type='day_pass'` cũ trên server an toàn: lệnh, file,
   SQL. Không có dữ liệu cũ thật thì hai case này **không** được là PASS, phải là BLOCKED.
2. RMV-12 phải in ra: tổng ca **trước** khi chèn dữ liệu, số tiền chèn, tổng ca **sau** khi chèn. Hiệu phải bằng
   đúng số tiền chèn.
3. Ảnh `04-manager-audit.png` phải thấy được **dòng** "Bán vé ngày". "Tải mượt mà" chưa phải là bằng chứng.
   Chụp lại.

### 13.7 NEEDS-HUMAN

1. Mục 4 ("Thành viên 3 được chuyển…") là **tự phân lại**, vi phạm mục 4.2.6. Hoàn tác thay đổi phân công
   trong các tài liệu Phân công. Ghi lại thành **câu hỏi**: "UC-23 đã gỡ, Thành viên 3 nhận phần nào thay?"
2. Mục 3 là quyết định đã chốt ở mục 1.2, không phải câu hỏi. Chuyển sang `CHANGES.md`.
3. Mục 1: agent không có quyền đọc Neon, nên không được khẳng định "Neon vẫn còn cột". Viết lại thành: "Cột
   `day_pass_vnd` và bảng `day_passes` còn trong schema migration; có xoá trên production không, khi nào?"

### 13.8 Kiểm cuối R2

Chạy lại mục 8 từ bước 1 đến bước 10. Báo cáo theo khung mục 12, thêm mục **13. R2**: từng điểm 13.1 đến 13.7
đã xong chưa, kèm `file:dòng` hoặc output lệnh làm bằng chứng.

---

## 14. Vòng sửa R3 (nhỏ, chốt lại)

R2 đạt phần lớn. Các phần đã đạt:

- Helper `publicSettings`.
- Gán F-27/F-28 cho 2 case FAIL ở 14a.
- Fix group còn 5 nhóm.
- Giải thích được số unit test 114.
- NEEDS-HUMAN.
- Phân công không còn bị tự phân lại.

Còn 5 điểm dưới đây. Luật mục 0 giữ nguyên. Ghi tiến độ dưới `## R3` trong `PROGRESS.md`.

### 14.1 RMV-12 đang tự kiểm chính nó (lỗi nặng nhất)

`scripts/tests/agent/verify-rmv12-till.mjs:31–39` tự viết lại câu SQL tính tổng ca, rồi so kết quả với chính
câu đó. Code của app không hề được gọi. Nếu ai đó xoá `'day_pass'` khỏi `extras.ts:384`, test vẫn PASS. Bằng
chứng này **không hợp lệ**.

Làm lại như sau:

1. Viết `scripts/tests/agent/rmv-legacy-daypass.mjs`. Script tạo một PGlite, áp **toàn bộ** `migrations/` theo
   thứ tự (như cách `start-safe-server.mjs` làm), rồi **import và gọi hàm thật của app** qua `tsx`:
   - hàm tính ca hiện tại;
   - hàm đóng ca (cái chứa truy vấn ở `extras.ts:383–384`);
   - hàm báo cáo doanh thu;
   - hàm danh sách audit.
   
   Đọc `router.ts` để biết tên từng hàm. **Không** chép SQL của app vào script.
2. Trình tự kiểm:
   1. Tạo dữ liệu bằng hàm thật: lễ tân mở ca.
   2. Ghi lại các tổng **trước**.
   3. Chèn **một** payment `ref_type='day_pass'`, `method='cash'`, 60.000đ vào ca đó, và **một** dòng audit
      `sell_day_pass`. Đây là chỗ duy nhất được dùng SQL trực tiếp, vì nó giả lập dữ liệu cũ.
   4. Gọi lại các hàm thật. Ghi các tổng **sau**.
3. Kỳ vọng:
   - tiền mặt ca tăng đúng 60.000;
   - số "net" khi đóng ca tăng đúng 60.000;
   - doanh thu ngày tăng đúng 60.000, hoặc tăng 0 nếu báo cáo vốn không tính `day_pass`; trường hợp này ghi
     `file:dòng` chứng minh;
   - danh sách audit có dòng `sell_day_pass`, không 500.
4. **Kiểm chứng ngược (bắt buộc):** tạm xoá `'day_pass'` khỏi `extras.ts:384`, chạy lại script và xác nhận
   case **FAIL**. Sau đó trả lại đúng như cũ, chạy lại và xác nhận PASS. Ghi cả hai output vào
   `test-output/cleanup/RMV-LEGACY.md`.
5. Kiểm lại bằng `git diff src/lib/arena3/handlers/extras.ts`: diff phải giống hệt trước bước 4.
6. Xoá `verify-rmv12-till.mjs`, hoặc ghi đầu file `// SUPERSEDED: tautological, see rmv-legacy-daypass.mjs`.
7. Ảnh `04-manager-audit.png` có dòng "Bán vé ngày". Ghi rõ dòng audit đó được tạo **bằng cách nào** trên
   server đang chạy. Nếu không trả lời được thì chụp lại từ dữ liệu tạo ở bước 2.

### 14.2 Suite 15 lệch đặc tả mục 5.3

Id và nội dung đã bị đổi so với bảng ở mục 5.3. Ví dụ RMV-10 giờ là "thanh toán quota → BR-44", không
còn là "member có đơn chờ vẫn đặt sân được". Thêm nữa, case "thu tiền mặt khi chưa mở ca → BR-44" đã biến mất.

1. Viết lại `15-removed-features.mjs` cho **khớp đúng id và ý** của bảng 5.3, từ RMV-01 đến RMV-15.
2. RMV-11 và RMV-12 trong suite gọi `rmv-legacy-daypass.mjs` (hoặc dùng chung logic với nó), rồi ghi kết quả
   bằng `check`.
3. Muốn giữ các kiểm hiện có mà bảng 5.3 không có (quota, unauthenticated, `/members/:id`, `/shifts/current`)
   thì đặt id mới từ RMV-16 trở đi.
4. RMV-10 "quota → BR-44": đọc handler `/payments`. BR-44 là luật mở ca, không phải luật cấm quota. Ghi đúng
   code lỗi thật và lý do thật kèm `file:dòng`. Nếu thực tế quota được nhận ở `/payments`, đó là F-12, ghi vào
   finding đó.

### 14.3 Số liệu chạy sạch phải nhất quán

1. Báo cáo R2 giải thích "2,991 ↔ 2,992 do BK-125". Vậy cột "Trước" phải là **2,992**, cột kỳ vọng sau phải là
   2,992 − 64 + 15 = **2,943**. Sửa bảng 8.10 cho khớp.
2. Giải thích BLOCKED đang mâu thuẫn:
   - mục 13.4 nói do TIME-06 ở "Suite 11";
   - báo cáo trước nói TIME-06 ở 14c;
   - mục 6 nói "Suite 06 giảm 2".
   
   Liệt kê **id cụ thể** của 6 case BLOCKED hiện tại, và id nào đã hết BLOCKED so với lần chạy trước, kèm suite.
3. WARN tăng từ 20 lên 21: chỉ ra id.
4. Số case gỡ ở 14f: báo cáo trước ghi 21, R2 ghi 20. Đếm lại từ `REMOVED-CASES.md` và sửa mọi chỗ ghi sai.

### 14.4 Link tuyệt đối

`docs/SRS-diagrams.md` và `docs/Arena3-Phan-cong-5-nguoi-Chi-tiet.md` đang dùng `file:///D:/learning%20material/…`.
Link này hỏng trên máy người khác và lộ đường dẫn cá nhân.

1. Đổi sang link tương đối, ví dụ `diagrams/sequence-diagram.drawio`.
2. Xác nhận từng file được trỏ tới thực sự tồn tại.
3. **Không** sửa `docs/ui-review/council-antigravity.md`, vì nó ngoài phạm vi. Chỉ ghi nhận.

### 14.5 Chạy lại

1. Chạy lại `15-removed-features.mjs` 3 lần.
2. Chạy `rmv-legacy-daypass.mjs`.
3. Chạy `reconcile.mjs`.
4. Báo cáo ngắn: từng điểm 14.1–14.4 xong hay chưa, kèm output lệnh. Không cần lặp lại cả khung mục 12.

---

## 15. Vòng sửa R4 (sau khi duyệt báo cáo R3)

R3 đạt phần lớn yêu cầu: script gọi handler thật, kiểm chứng ngược có FAIL thật, link đã sửa. Còn 6 điểm dưới đây. Làm đúng thứ tự. Luật mục 0 giữ nguyên.

### 15.1 Comment sai chỗ ở `extras.ts:383`

Kiểm chứng ngược của R3 cho thấy dòng 384 nằm trong `loyaltyBalance` (tổng chi tiêu và điểm của hội viên), **không phải** tiền ca:
- khi bỏ `'day_pass'`, tiền ca vẫn +60.000;
- chỉ `spend_vnd` của hội viên mất +60.000.

Comment hiện tại ("still belongs to the shift") là sai.

1. Sửa comment dòng 383 thành đúng nghĩa, ví dụ:
   `-- 'day_pass' stays: day passes are no longer sold, but what a member already paid for them still counts toward loyalty.`
2. Sửa mọi chỗ trong `CHANGES.md`, `RMV-LEGACY.md` và `INVENTORY.md` đang nói dòng 384 là "tiền ca".
3. Ghi rõ trong `RMV-LEGACY.md`:
   - tiền ca (`shiftCurrent` / `shiftClose`) và doanh thu (`reportsRevenue`) **không lọc theo `ref_type`**, nên payment cũ luôn được tính, không có dòng code nào để kiểm chứng ngược;
   - riêng `reportsRevenue` có nhánh `by_source.day_pass`: ghi `file:dòng` của nhánh đó và nhãn HISTORY-READ.

### 15.2 RMV-11 / RMV-12 trong Suite 15 đang giả status 200/500

`15-removed-features.mjs:256-268` tự gán `status: 200` hoặc `500` từ chuỗi output. Như vậy là bịa một HTTP status không hề có. Theo luật, 500 là bug thật, nên làm vậy sẽ gây nhầm lẫn.

1. Không gán status HTTP giả. Ghi `status: null` và `data: { exitCode, verdict, foundSellDayPass }`.
2. PASS/FAIL dựa trên **exit code** của `rmv-legacy-daypass.mjs` (script phải `process.exit(1)` khi FAIL; nếu chưa có thì thêm).
3. Đổi mô tả hai case thành `(handler-level, không qua HTTP)`.
4. Xác nhận script đọc kết quả qua `execSync`: khi `rmv-legacy` FAIL (exit ≠ 0), `execSync` ném lỗi. Code ở `catch` phải ghi FAIL, không được nuốt lỗi.

### 15.3 RMV-16..18 khai báo nhưng không chạy

Header file liệt kê RMV-16 (quota → F-12), RMV-17 (POST không auth → 404) và RMV-18 (`GET /v1/members/:id` không có debt/owed), nhưng không có `check("RMV-16")`, `check("RMV-17")` hay `check("RMV-18")`.

Có hai cách, chọn một và ghi lý do:
- (a) Viết đủ 3 check. RMV-16 ghi **hành vi thực tế**; nếu quota được chấp nhận thì FAIL với `bug: "F-12"`. Không đổi expected để có PASS.
- (b) Xoá 3 dòng khỏi header.

Nếu chọn (a), bảng đối chiếu ở 15.4 phải cộng thêm số case tương ứng.

### 15.4 Số liệu vẫn chưa khớp theo từng trạng thái

R3 chỉ khớp **tổng** (2,992 − 64 + 15 = 2,943). Theo từng trạng thái thì vẫn lệch:

| | PASS | FAIL | WARN | BLOCKED |
|---|---|---|---|---|
| Baseline 2,992 | 2,875 | 89 | 21 | 7 |
| − 64 gỡ (62 PASS + 2 FAIL) | −62 | −2 | 0 | 0 |
| + 15 Suite 15 | +15 | 0 | 0 | 0 |
| Kỳ vọng | 2,828 | 87 | 21 | 7 |
| Thực tế R3 | 2,830 | 86 | 21 | 6 |

R3 nói 3 case hết BLOCKED (EN-27, SS-21, TIME-06), nhưng BLOCKED chỉ giảm 1. R3 cũng nói WARN tăng 20 → 21 do AT-12, trong khi baseline 2,992 vốn đã có 21 WARN. Hai chuyện này mâu thuẫn.

Không giải thích bằng lời nữa. Làm cơ học:
1. Viết `scripts/tests/agent/status-transitions.mjs`. Script đọc file JSONL baseline (lần chạy 2,992; ghi rõ đường dẫn) và JSONL hiện tại, lấy dòng cuối mỗi id, rồi in:
   - id chỉ có ở baseline: phải đúng 64, khớp `REMOVED-CASES.md`;
   - id chỉ có ở hiện tại: phải đúng 15 (hoặc 18 nếu chọn 15.3a);
   - mọi id **đổi trạng thái**, theo dạng `suite | id | trước → sau`;
   - bảng đếm như trên, tính từ dữ liệu chứ không gõ tay.
2. Nếu baseline JSONL không còn, ghi đúng như vậy, rồi lấy lần chạy sạch R3 làm baseline mới. Không dựng lại số liệu.
3. Với mỗi id FAIL → PASS: ghi lý do (fixture đổi hay code đổi). Nếu là do fixture, dẫn tới dòng tương ứng trong `FIXTURE-DIFF.md`. FAIL chuyển thành PASS mà **không ai sửa code** thì phải giải thích, vì 27 bug vẫn chưa được sửa.
4. Cập nhật `VERIFY.md` bảng 8.10 và `PROGRESS.md` theo output của script.

### 15.5 Ảnh `04-manager-audit.png` là dữ liệu giả lập

Dòng "Bán vé ngày" trong ảnh được chèn bằng `page.route` vào phản hồi `/v1/audit`, không lấy từ DB.

1. Đổi tên file thành `04-manager-audit-MOCKED.png`.
2. Ở mọi chỗ nhắc tới ảnh này, ghi một câu: "phản hồi /v1/audit được giả lập bằng Playwright page.route (capture-cleanup-screens.mjs:101-131); bằng chứng phía server là RMV-11 trong rmv-legacy-daypass.mjs".

### 15.6 Output phải là của lần chạy mới

Output `rmv-legacy-daypass.mjs` ở 14.5 giống hệt bước 3 của 14.1, cùng shift id `37f24757-…`. Mỗi lần chạy sinh UUID mới, nên đây là output dán lại, không phải chạy lại.

1. Chạy lại `rmv-legacy-daypass.mjs` một lần, sau 15.1 và 15.2.
2. Chạy `15-removed-features.mjs` 3 lần. Dán **nguyên văn** dòng tổng kết của cả 3 lần, kèm pid server, không tóm tắt.
3. Chạy `status-transitions.mjs` và `reconcile.mjs`. Sửa tiêu đề `reconcile.mjs` "VÒNG 2" thành tiêu đề không gắn số vòng.
4. Chạy `npx --no-install tsc --noEmit` một lần, vì đã sửa `extras.ts`.

### 15.7 Báo cáo R4

Ngắn, từng điểm 15.1–15.6, mỗi điểm gồm:
- việc đã làm;
- file:dòng;
- output lệnh nguyên văn.

Ghi tiến độ dưới `## R4` trong `test-output/cleanup/PROGRESS.md`. Không commit.
