# Báo cáo đơn giản hóa code Arena3

Ngày thực hiện: 09/11/2026.

Đã refactor 16 file nguồn, thêm 3 test hồi quy trong `scripts/refactor-simplify.test.mjs`. Không commit, push hoặc đổi nhánh.

Đã đọc `AGENTS.md`, `CLAUDE.md`. `PRODUCT.md`, `DESIGN.md` và `AGENTS.project.md` không có trong checkout.

## Thống kê theo thư mục

Số dòng tính trên toàn bộ file `.ts` và `.tsx` trong từng thư mục, kể cả dòng trống, không tính đoạn rỗng sau ký tự xuống dòng cuối file. Đây là tổng dòng của thư mục, không chỉ các file đã sửa.

| Thư mục | Trước | Sau | Chênh lệch | Hàm tách | Code chết đã xóa |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/server/services` | 2.264 | 2.225 | -39 | 1 | 0 |
| `src/server/controllers/handlers` | 13.748 | 13.757 | +9 | 2 | 0 |
| `src/server/data` | 1.095 | 1.097 | +2 | 0 | 0 |
| `src/shared` | 1.737 | 1.784 | +47 | 0 | 0 |
| `src/client/lib` | 6.143 | 6.148 | +5 | 1 | 0 |
| `src/client/components` | 16.487 | 16.485 | -2 | 0 | 0 |
| `src/routes` | 20.572 | 20.575 | +3 | 0 | 0 |
| **Tổng** | **62.046** | **62.071** | **+25** | **4** | **0** |

Không xóa hàm/export với giả định là code chết. Phần giảm ở services chủ yếu do chuyển kiểu sang shared, không phải xóa chức năng. Việc tách hàm làm tổng số dòng tăng nhẹ.

## Những thay đổi đã làm

- Services: tách `parseWeeklyRule`; đổi các tên tạm thành `start`, `weekday`, `sessions`, `priceRule`, `listPrice`, `discountPct`, `roundingStep`.
- Handlers: tách `generateCourtCode` khỏi việc tạo sân; dùng `describeCourtBlocker` chung cho hai trường `affected` và `blockers`. Vẫn tạo hai mảng riêng như trước, giữ thứ tự và quy tắc ưu tiên mã booking trước tên lớp.
- Data: đặt tên rõ hơn cho biến tính tên cột Excel; đặt hằng `COLUMN_WIDTH_SAMPLE_SIZE` và dùng lại mẫu dòng khi đo độ rộng cột.
- Shared: chuyển nguyên cấu trúc của `CatalogPlan`, `CatalogClass`, `CatalogPrice`, `CatalogCourt`, `CatalogSlot` từ services sang `src/shared/arena3/contracts.ts`. Cập nhật import ở services và toàn bộ 8 file landing liên quan; shared không thêm import.
- Client lib: tách `closingHour` để thay biểu thức điều kiện lồng; giữ nguyên cách làm tròn giờ và fallback; đặt tên rõ hơn cho biến trong `hourOf`, `hoursOf`.
- Components: tái sử dụng bộ định dạng giờ trong effect của `useVenueHour`. Các file component khác chỉ đổi đường dẫn `import type`.
- Routes: đếm giờ trống theo môn từ `schedFreeList` có sẵn bằng `Map`, giữ nguyên JSX.

Đã tìm nơi dùng tên/export và namespace bằng tìm kiếm toàn `src` và `scripts` trước khi sửa. Không đổi tên export công khai. Không thêm comment trong code; comment hiện hữu được giữ nguyên.

## Tối ưu hiệu năng và tính tương đương

| Thay đổi | Công việc được giảm | Vì sao kết quả không đổi |
| --- | --- | --- |
| Lịch tuần | Chỉ định dạng `startTime` và đổi phút sang mili giây một lần mỗi lần gọi, thay vì mỗi ngày/phiên | Quy tắc ngày, khoảng `[from, until)`, giờ mặc định và thứ tự phiên giữ nguyên; 198 ca đối chiếu bằng nhau, kể cả lỗi đầu vào |
| Độ rộng cột Excel | Chỉ `slice(0, 200)` một lần mỗi sheet, thay vì mỗi cột | Cùng 200 dòng đầu, cùng công thức độ rộng; toàn bộ XML trong 30 workbook đối chiếu bằng nhau |
| Đồng hồ landing | Tạo `Intl.DateTimeFormat` một lần mỗi lần effect được mount, thay vì mỗi lần đọc giờ | Cùng locale, múi giờ, tùy chọn, lần đọc ngay khi mount và chu kỳ 60 giây |
| Giờ trống theo môn | Một lượt đếm trên danh sách có sẵn; mỗi lần hỏi số giờ của một môn chỉ tra Map, không quét lại lịch và occupancies | `freeHours` xét từng sân độc lập. Đếm theo môn trên toàn bộ danh sách bằng đếm danh sách sân đã lọc; 12 lịch đối chiếu bằng nhau, kể cả môn không tồn tại và tên `__proto__`. Thứ tự danh sách giờ trống không đổi |

Không thay đổi query SQL, số lần gọi DB, transaction hoặc chính sách cache. Không áp dụng thay đổi N+1/gộp query khi chưa có bằng chứng bảo toàn thứ tự, thời điểm đọc và kết quả nghiệp vụ.

## Kiểm tra sau từng lô

Thứ tự thực hiện: services → handlers → data → shared → client/lib → client/components → routes. Các import kiểu phụ thuộc được cập nhật cùng lô shared để tránh trạng thái lỗi type giữa chừng.

| Lô | `npx tsc --noEmit` | `npm test` |
| --- | --- | --- |
| Services | PASS | 139 test pass; dừng ở khởi động tsx |
| Handlers | PASS | 139 test pass; dừng ở khởi động tsx |
| Data | PASS | 139 test pass; dừng ở khởi động tsx |
| Shared và import kiểu | PASS | 139 test pass; dừng ở khởi động tsx |
| Client lib | PASS | 139 test pass; dừng ở khởi động tsx |
| Client components | PASS | 139 test pass; dừng ở khởi động tsx |
| Routes | PASS | 139 test pass; dừng ở khởi động tsx |

Trên PowerShell, dùng `npx.cmd`/`npm.cmd` vì execution policy chặn các wrapper `.ps1`. npm cache được chuyển vào `.cache/npm` cho các lần chạy test vì cache mặc định không có quyền ghi. Không sửa package hoặc lockfile.

## Kết quả cuối

- `npx.cmd tsc --noEmit`: **PASS**.
- `npm.cmd run build`: **PASS**, gồm client, SSR và output Vercel. Chạy với `DATABASE_URL` không được đặt trong tiến trình build để bước `db:migrate` bỏ qua, không áp dụng migration lên DB.
- `npm.cmd test`: **chưa pass toàn lệnh**. Nhóm Node có **139/139 pass**, rồi tsx lỗi `ERR_SYSTEM_ERROR: uv_os_get_passwd returned ENOMEM`. Lỗi này cũng có trước khi refactor. Nhóm scripts qua glob trong npm test báo 0 test trên Windows.
- Chạy trực tiếp nhóm scripts lần cuối: **180/200 pass, 20 fail**, gồm 3 test hồi quy mới. Các lỗi liên quan tài nguyên `.grok/skills/og` bị thiếu, quyền tạo symlink, và test mẫu kỳ vọng auth/branding khác cấu hình hiện tại. Không thay đổi các file cấu hình hoặc code branding để làm test xanh. Log: `.cache/refactor/scripts-final-test.log`.
- Chạy ba file test vốn dùng tsx bằng Node với bộ phân giải đường dẫn tạm và hỗ trợ transform TypeScript: **158/158 pass**, bao gồm integration PGlite, transaction, rate limit và P2P. Lệnh: `node --experimental-transform-types --loader ./.cache/refactor/resolve.mjs --test src/server/controllers/tx.test.ts src/server/controllers/ratelimit.test.ts src/client/lib/multiplayer/p2p.test.ts`. Không sửa test gốc hoặc dependency. Log: `.cache/refactor/native-integration-test.log`.
- `node --test scripts/refactor-simplify.test.mjs`: **3/3 pass**. Kiểm tra biên lịch tuần, giờ đóng cửa/fallback, sinh mã sân và mô tả blocker.
- Đối chiếu bản HEAD với bản sửa bằng `.cache/refactor/equivalence.mjs`: **PASS**. Gồm **198** ca lịch tuần, **1.800** cấu hình giờ hoạt động, XML của **30** workbook và **12** lịch đếm giờ trống.
- Kiểm tra AST trên **16 file nguồn đã sửa**: JSX, chuỗi SQL và comment không đổi, sau khi chuẩn hóa CRLF/LF. Không có diff ở `styles.css`, hai file dịch bị cấm, migrations, seed, route tree hoặc package/lockfile.
- `git diff --check`: **PASS**.
- `browser-smoke`: **không chạy được kiểm tra hình ảnh**. Script từ chối đường dẫn Windows vì chỉ cho phép `/workspace`: `screenshot path must be under /workspace`. Chưa xác minh ảnh dev/production bằng browser; kiểm tra AST không thay thế phép so sánh pixel.
- MCP graph bị chặn bởi chính sách công cụ. CLI graft không khởi động được do thiếu native build `tree-sitter-kotlin`; thử rebuild bị chặn vì không tìm được Python. Đã dùng thẻ graph có sẵn và tìm kiếm dự phòng. `graft build` cuối lượt cũng lỗi cùng nguyên nhân; graph chưa được refresh.

Log kiểm tra từng lô và kiểm tra tương đương được giữ tại `.cache/refactor/` trong workspace; đây là thư mục cache, không phải file cần commit.

## Những chỗ cân nhắc nhưng không sửa

- Không tách/reformat JSX hoặc component có animation; không sửa `fx.tsx`, `gl.tsx`, `motion.tsx`, GSAP, CSS, className, style, aria hoặc nội dung hiển thị.
- Không đổi cách lọc/sắp xếp catalog, truy vấn chọn lớp đại diện, quy tắc giá/discount hoặc cách xử lý số không hợp lệ.
- Không gộp query, chạy song song thêm các thao tác DB hoặc sửa lịch chạy jobs: có thể thay thời điểm quan sát dữ liệu và thứ tự side effect.
- Không sửa logic auth, phân quyền, rate limit, đặt sân, gói tập hoặc response để phù hợp các test mẫu đang lỗi.
- Không thay dữ liệu seed, migration, cấu hình auth/branding hoặc cấu hình package để xử lý lỗi môi trường.
- Không xóa export dựa riêng vào graph: graph có thể thiếu cách dùng JSX hoặc namespace, và lượt này không có ứng viên đủ bằng chứng để xóa.

## Lượt 3

Ngày thực hiện: 09/11/2026. Thay đổi thực tế **32 tệp nguồn**, gồm 23 tệp hiện hữu và 9 tệp mới; thêm 3 test hồi quy vào tệp test của lượt trước. Giữ nguyên thay đổi đang có khi bắt đầu lượt, không commit, push hoặc đổi nhánh. `PRODUCT.md`, `DESIGN.md`, `AGENTS.project.md` vẫn không có trong checkout.

### Thống kê

Mốc trước là nội dung trên đĩa khi bắt đầu lượt 3, không phải HEAD. Đếm toàn bộ `.ts`/`.tsx` của từng thư mục, kể cả dòng trống; không tính đoạn rỗng sau newline cuối. Hàng helpers tính riêng một tệp, không chồng với hàng handlers. “Hàm tách” là tên hàm cấp module mới; các hàm chỉ chuyển vị trí không được tính thêm.

| Thư mục/tệp | Trước | Sau | Chênh lệch | Hàm tách | Code chết đã xóa |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/server/services` | 2.225 | 2.329 | +104 | 3 | 0 |
| `src/server/controllers/handlers` | 13.757 | 13.757 | 0 | 37 | 1 nhánh không thể tới; 1 hằng; 1 tham số; 2 import không dùng |
| `src/server/controllers/helpers.ts` | 521 | 530 | +9 | 1 | 0 |
| `src/server/data` | 1.097 | 1.097 | 0 | 0 | 0 |
| `src/shared` | 1.784 | 1.784 | 0 | 0 | 0 |
| `src/client/lib` | 6.148 | 8.426 | +2.278 | 8 | 1 binding `res` bỏ trong quá trình chuyển logic; giữ lời gọi API |
| `src/client/components` | 16.485 | 16.485 | 0 | 0 | 0 |
| `src/routes` | 20.575 | 18.465 | -2.110 | 0 | 1 binding `first`; 18 import không dùng |
| **Tổng** | **62.592** | **62.873** | **+281** | **49** | **2 binding, 1 hằng, 1 tham số, 1 nhánh, 20 import** |

Tổng dòng tăng 281 do chữ ký helper, kiểu đặt tên và hợp đồng trả dữ liệu từ hook sang JSX. Đây là tách trách nhiệm và giảm độ dài hàm; không tuyên bố giảm tổng kích thước code. Các kiểu catalog đã chuyển sang shared ở lượt trước, không chuyển lần nữa.

### Những phần đã tách

| Hàm | Dòng trước | Dòng sau |
| --- | ---: | ---: |
| `paymentsCreate` | 225 | 45 |
| `onlineCreate` | 233 | 57 |
| `settleOnline` | 140 | 37 |
| `courtsPatch` | 165 | 17 |
| `staffPatch` | 72 | 17 |
| `capacityBody` | 153 | 39 |
| `reportDoc` | 214 | 21 |
| `membersReportBody` | 90 | 64 |
| `trainingPatch` | 73 | 38 |

- Thanh toán tại quầy: tách tìm ca thu ngân, kiểm tra booking/lớp/gói, tính promo, ghi nhận nghiệp vụ và xuất hóa đơn. Giữ thứ tự khóa payment → class → enrollment, thứ tự query, các nhánh renewal và thông báo lỗi.
- Thanh toán online: tách kiểm tra từng đối tượng, đọc link đang chờ, tạo payment pending, yêu cầu link và xử lý từng loại settlement. Giữ 2 lần thử, xử lý mã payOS `231`, cập nhật payment thất bại, thời hạn link và quy tắc tái dùng link.
- Sân: tách status-only khỏi metadata, kiểm tra chuyển môn và ghi metadata. Không hợp nhất hai nhánh có quy tắc khác nhau.
- Nhân sự: tách cập nhật status/role, dùng chung `ensureCoachAsset`; vẫn giữ vị trí thu hồi session và ghi audit.
- Báo cáo: tách từng loại tài liệu, truy vấn dữ liệu công suất/lớp và chuyển tổng hợp Map sang service thuần `capacity.ts`.
- Promo: tách preview plan/class/court, bỏ `throw` cuối sau nhánh luôn trả kết quả; dùng `INT4_MAX` sẵn có. `sqlPatch` dùng chung cho promo và training, giữ thứ tự tham số, SQL cast và giá trị null.
- Routes: chuyển logic của `app.book`, `app.classes`, `desk.payments`, `manager.audit`, `manager.courts`, `manager.index`, `manager.media`, `manager.sports` sang 8 hook ở `src/client/lib/pages/`. Các kiểu đã export từ route media/sports được re-export để giữ đường import cũ. Không tách component có JSX.
- Code chết: bỏ `DAY_MS` ở check-in, tham số `sql` riêng tư của `assertBookWindow` và cập nhật mọi caller; bỏ `first`, binding `res` và import không dùng. Đã rà tên, `<Name`, namespace và chẩn đoán unused của TypeScript. Không tìm thấy export cấp module đủ bằng chứng để xóa toàn hàm. Các lần đọc DB/API vẫn giữ lại dù bỏ binding nhận kết quả.

### Hiệu năng và tính tương đương

| Thay đổi | Công việc giảm | Vì sao kết quả không đổi |
| --- | --- | --- |
| Ghi nhớ giờ cao điểm trong một lần tổng hợp công suất | Mỗi cặp môn/giờ chỉ quét `price_rules` một lần, thay vì lặp lại cho mỗi sân cùng môn. Từ khoảng `C × H × R` xuống `S × H × R + C × H`, với C sân, S môn, H giờ, R quy tắc | Dùng đúng danh sách quy tắc vừa đọc; giữ so sánh `start_min <= hour*60 < end_min`. Cache chỉ sống trong lần gọi. Thứ tự Map, phép cộng và làm tròn giữ nguyên; 50 bộ dữ liệu đối chiếu bằng nhau |
| `sqlPatch`, helper asset HLV | Bỏ logic dựng assignment và insert asset bị lặp | Không giảm/chạy song song query; câu SQL, tham số và vị trí side effect giữ nguyên |

Việc chuyển logic route sang hook không được tính là giảm re-render. Không thay dependency effect/memo, chính sách reload, debounce, thứ tự hook hoặc thời điểm gửi API. Không áp dụng gộp query/N+1 chưa có bằng chứng bảo toàn thời điểm đọc và transaction.

### Kiểm tra

- `npx.cmd tsc --noEmit`: **PASS** sau các lần sửa tệp và ở lần kiểm tra cuối. Log từng tệp nằm tại `.cache/refactor/round3/tsc-*.log`.
- Build cuối mỗi lô handlers/routes và `npm.cmd run build` cuối lượt: **PASS**, gồm client, SSR và output Vercel. `DATABASE_URL` không được đặt trong tiến trình build; migration bỏ qua, không sửa dữ liệu DB.
- `npx.cmd tsx --test src/server/controllers/tx.test.ts src/server/controllers/ratelimit.test.ts`: **lỗi môi trường**, `uv_os_get_passwd returned ENOMEM` khi tsx khởi động, cùng lỗi lượt trước.
- Chạy đúng hai tệp trên bằng Node loader thay thế: **153/153 PASS**, 37 suite, không skip. Chạy lại sau khi sửa thanh toán quầy/online vẫn pass. Lệnh: `node --experimental-transform-types --loader ./.cache/refactor/resolve.mjs --test src/server/controllers/tx.test.ts src/server/controllers/ratelimit.test.ts`.
- `node --test scripts/refactor-simplify.test.mjs`: **6/6 PASS**, gồm 3 test mới cho thứ tự/cast/null của SQL patch, công suất sân và promo preview.
- `npm.cmd test`: **chưa pass toàn lệnh**. Nhóm Node đạt **139/139**, sau đó tsx lỗi môi trường trên; glob nhóm scripts vẫn báo 0 test trên Windows. Nhóm refactor được chạy trực tiếp riêng như trên.
- Đối chiếu bản đầu lượt và bản sửa: **182 kịch bản PASS** cho công suất, status/metadata sân, status/role nhân sự, thanh toán quầy, tạo/tái dùng link và retry mã trùng. So sánh response, lỗi, tham số và thứ tự SQL/side effect; SQL được chuẩn hóa khoảng trắng khi so sánh. Không gọi payOS thật.
- AST: **12 tệp TSX đã sửa có toàn bộ khối JSX giống nguyên văn** sau chuẩn hóa CRLF/LF. **288 statement** ngoài JSX của 8 route giữ nguyên trong hook, ngoại trừ chuyển `Route.useSearch()` thành hook được truyền vào và bỏ binding `res` không dùng. Không đổi thứ tự hook hoặc dependency.
- Kiểm tra toàn nguồn: **không thêm comment**. Không có diff ở CSS, hai tệp dịch bị cấm, migrations, seed, route tree hoặc package/lockfile. `git diff --check`: **PASS**.
- Không thực hiện đối chiếu ảnh theo pixel trong lượt này; kiểm tra JSX/logic không được mô tả là kiểm thử ảnh trình duyệt.
- MCP graph bị chính sách công cụ chặn; graft CLI vẫn lỗi thiếu native build `tree-sitter-kotlin`. Dùng thẻ graph hiện có và tìm kiếm dự phòng; chưa refresh được graph.

Log, bản chụp nguồn đầu lượt và script kiểm tra chi tiết nằm ở `.cache/refactor/round3/`; test hồi quy được giữ trong `scripts/refactor-simplify.test.mjs`.

### Những chỗ không sửa và phần mục tiêu còn lại

- Không xóa `NextFreeCard` dù TypeScript báo không dùng: hàm chứa JSX/GSAP, trong phạm vi animation mà yêu cầu cấm sửa. Không thay `fx.tsx`, `gl.tsx`, `motion.tsx`, GSAP, style, className, aria, chữ hiển thị, ảnh hoặc breakpoint.
- Không hợp nhất các nhánh status-only/metadata sân, đổi chính sách giá hoặc bỏ những lần đọc DB chỉ vì kết quả chưa dùng. Không thay cách xử lý amount 0/null, phân quyền, rate limit, response hay thứ tự khóa để làm code ngắn hơn.
- **Chưa đạt mục tiêu mọi hàm trong hai thư mục dưới khoảng 60 dòng.** Bộ quét cuối vẫn ghi nhận **62 hàm/callback không chứa JSX dài hơn 60 dòng**; dài nhất là `managerAssetUpload` 200 dòng ở `assets.ts`. Các phần khác còn gồm `paymentsPending`, `assistantChat`, materialize lịch lớp, hủy/đổi lịch booking và callback chat. Các component có logic trước JSX dài cũng chưa được tách hết. Không tính những phần chưa làm này là đã hoàn tất; danh sách cụ thể ở `.cache/refactor/round3/audit.json`.
