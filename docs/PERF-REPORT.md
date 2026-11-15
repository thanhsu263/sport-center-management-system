# Báo cáo giáo án và hiệu năng Arena3

Ngày đo: 09/11/2026. Không commit/push; không thay JSX/className, bản dịch, CSS, migrations, seed, package hoặc routeTree.gen.ts.

## Giáo án có thể publish ngay

- Prompt yêu cầu đủ title, minutes, phase, intensity, description, equipment và target đo được; giữ ngôn ngữ coach, JSON và thinkingBudget=0; tăng output lên 4096 token.
- Parser dùng chung PLAN_PHASES và INTENSITIES với validator. Giữ enum hợp lệ, suy ra phase thiếu/sai theo vị trí, intensity mặc định medium. Minutes hữu hạn, nguyên 3–45; title tối đa 60, description tối đa 600, equipment/target tối đa 200 ký tự. Bỏ control characters và block không có title.
- Description/equipment/target thiếu được điền. Không có phản hồi hoặc JSON hỏng cũng đi qua cùng bước chuẩn hóa. Không nới validator publish.
- Client đã map đủ các trường block vào form và gửi lại khi lưu; giữ mapping và khả năng sửa từng trường, bổ sung nhận note gợi ý. Không đổi giao diện.
- Ba test mới gọi trainingSuggest rồi trainingCreate với published=true và đọc lại dữ liệu đã lưu: AI trả trường sai/thiếu/quá dài, AI không khả dụng, JSON hỏng.

## Phương pháp đo

Probe: [scripts/perf-probe.mjs](../scripts/perf-probe.mjs). Chạy handler thật trên PGlite cô lập, không gọi DB đang dùng hoặc dịch vụ thanh toán bên ngoài. Đọc migrations hiện có để dựng schema, không thay migrations/seed. Bổ sung dữ liệu benchmark trong script: 20 sân, 500 lớp, 500 audit tạo lớp, 12.000 khoản thu/hoàn tiền, 600 occupancy và một hội viên; cộng dữ liệu mẫu có sẵn.

Mỗi ca có 2 lượt làm nóng và 9 lượt đo; bảng ghi median của thời gian handler bằng performance.now(). Đếm mọi lần gọi Sql.query và tagged template ở ranh giới driver; không đếm BEGIN/ROLLBACK hoặc query chuẩn bị fixture. Đây là số lệnh SQL client gửi, không phải số scan/subquery/statement bên trong stored function/trigger. Luồng giữ chỗ và thanh toán chạy thật nhưng rollback sau từng lượt.

Dashboard là tổng công việc của 4 handler mà useManagerOverview gọi: doanh thu, báo cáo occupancy, lịch sân và staff. Probe chạy tuần tự nên đây không phải thời gian tải trang khi trình duyệt gửi song song.

TRƯỚC/SAU chạy tuần tự, không chạy build/test đồng thời; SAU khôi phục chính snapshot PGlite của TRƯỚC. Node v24.22.2, PGlite theo dependency hiện có. Báo cáo dùng kỳ 01–30/11/2026, so sánh kỳ trước theo logic hiện tại; lịch sân ngày 09/11; giữ chỗ chọn ngày mai lúc 13h để qua booking horizon. Hàng chờ desk dùng cửa sổ trượt 30 ngày theo thời gian chạy.

Dữ liệu thô gồm min/max, query counts, SQL và hash: [TRƯỚC](perf/before.json), [SAU](perf/after.json). Ca đọc so sánh SHA-256 toàn response, gồm thứ tự mảng; ca ghi so sánh status và kết quả nghiệp vụ ổn định (giá/trạng thái/amount/method/tổng hóa đơn), bỏ UUID/code/thời điểm sinh mới. Tất cả 10 ca khớp hash.

## Kết quả

| Ca đo | Trước (ms) | Sau (ms) | Query trước | Query sau |
|---|---:|---:|---:|---:|
| Lịch sân | 4.364 | 3.206 | 2 | 2 |
| Tìm ngày còn sân (31 ngày) | 32.148 | 21.468 | 3 | 3 |
| Giữ chỗ đặt sân | 21.007 | 15.832 | 12 | 12 |
| Danh sách lớp (manager) | 65.469 | 55.686 | 1 | 1 |
| Báo cáo doanh thu | 159.329 | 61.106 | 8 | 6 |
| Báo cáo công suất | 1043.855 | 636.950 | 7 | 5 |
| Báo cáo hội viên | 53.143 | 44.570 | 4 | 4 |
| Dashboard manager (4 API) | 102.445 | 64.793 | 12 | 10 |
| Hàng chờ thanh toán desk | 27.481 | 26.987 | 5 | 5 |
| Tạo thanh toán desk | 11.528 | 10.880 | 18 | 18 |

Thời gian chịu ảnh hưởng JIT, GC và tải CPU Windows; đây không phải SLA production. Các ca không sửa cũng dao động. Bằng chứng chắc chắn hơn là response giữ nguyên và giảm đúng 2 query mỗi request ở ba ca tối ưu; không quy toàn bộ chênh lệch ms cho thay đổi code.

## Thay đổi dựa trên số liệu

1. revenueBody được gọi hai lần cho báo cáo doanh thu; kỳ trước chỉ lấy totals/by_source nhưng vẫn tính by_shift/by_day. Thêm includeDetails mặc định true; chỉ bỏ hai truy vấn ở caller dùng bản tóm tắt. Kỳ hiện tại vẫn trả đầy đủ. Áp dụng cùng cách cho export doanh thu và phần doanh thu trong capacityBody. Không cache hoặc chia sẻ dữ liệu giữa request.
2. loadCapacityCells trước chạy subquery occupancy riêng cho từng sân × ngày × giờ (ít nhất 20 × 30 × 16 = 9.600 ô benchmark). Chuyển sang LEFT JOIN + GROUP BY theo đúng ô rồi tổng hợp như cũ. Giữ giao nhau nửa mở, loại hold/maintenance, timezone ICT, quy tắc sân retired, cắt phút tại biên giờ và cast số phút từng ô trước khi cộng. FILTER loại hàng null của LEFT JOIN, giữ ô trống bằng 0. Số lệnh SQL của phép tính này vẫn là 1: giảm tính toán lặp trong SQL, không giảm round-trip.
3. Chỉ thay truy vấn đọc. Không thay thứ tự khóa transaction, booking_replace_hold, ghi thanh toán, hóa đơn, outbox, audit, promo, payOS hoặc nghiệp vụ giữ ghế.

## Index đề xuất, chưa tạo

Đã đối chiếu index hiện có trong migrations: occupancies_day_idx(court_id,start_at), payments_created_idx(created_at), payments_ref_idx(ref_type,ref_id), audit_logs_at_idx(at), enrollments(class_id,user_id), sessions(class_id,start_at). Không đề xuất bản sao các index này.

| Index ứng viên | WHERE/JOIN liên quan và lý do |
|---|---|
| audit_logs(entity_id, at DESC) WHERE action='create_class' | classesList chạy lateral max(at) theo entity_id cho mỗi lớp. Index at hiện tại không dẫn bằng entity_id; ca 500 lớp vẫn tốn khoảng 55–65 ms dù chỉ 1 query. |
| payments(((created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)) WHERE status='posted' | revenueBody lọc/join theo ngày ICT. B-tree created_at hiện tại không trực tiếp phục vụ biểu thức này; cần kiểm tra selectivity và chi phí ghi trên Postgres thật. |
| occupancies(end_at, start_at) INCLUDE (court_id, kind, ref_id) | occupancyGet/availabilityGet lọc khoảng thời gian toàn sân, không có điều kiện court_id đứng đầu index hiện tại. Là ứng viên cho lịch sử lớn; cần EXPLAIN ANALYZE trước khi chọn thứ tự cột. |

Đây là ứng viên từ điều kiện truy vấn và schema, chưa xác nhận lợi ích bằng EXPLAIN trên production. Không tạo migration, không CREATE INDEX và không thay schema.

## Những gì không sửa

- Lịch sân, giữ chỗ và desk: không có N+1 round-trip theo số hàng trong các ca đo (lần lượt 2/3/12 và 5/18 query). Các query nối tiếp ở luồng ghi phục vụ khóa, đối soát, hóa đơn và audit; chưa có số liệu cô lập chứng minh có thể bỏ an toàn.
- classesList có correlated lateral audit theo lớp; chưa thử index vì yêu cầu chỉ báo cáo index. Giữ thứ tự lớp và cách chọn enrollment.
- membersReportBody/loadMemberClasses có correlated aggregate theo tháng/lớp và hai count attendance; mới đo tổng handler, chưa chứng minh phép viết lại tốt hơn. Không sửa suy đoán.
- useManagerOverview lọc staff hai lần, tạo lại chartData/sourceData/trendData; có thể memoize nhưng staff tối đa 100 và chưa đo React render. CapacityPanel đã dùng useMemo cho nhóm sân/giờ cao điểm. Chưa có bằng chứng để thêm useMemo, nên không đổi.
- Không gộp API dashboard hoặc thêm cache: sẽ mở rộng hợp đồng và có rủi ro dữ liệu cũ.
- Export dùng chung tối ưu bỏ chi tiết kỳ trước; chưa benchmark riêng render PDF/XLSX. Loader bỏ import font vì các ca đo chỉ trả JSON.

## Chạy lại

Từ gốc repo, trước thay đổi cần so sánh:

```powershell
node scripts/perf-probe.mjs --output .cache/perf-before.json
```

Sau thay đổi, dùng cùng snapshot, không chạy đồng thời build/test:

```powershell
node scripts/perf-probe.mjs --baseline .cache/perf-before.json --output .cache/perf-after.json
```

Có thể chỉnh --runs hoặc --fixture. Mỗi lần đo TRƯỚC dựng lại fixture và snapshot; SAU tự assert hash theo baseline, fail nếu khác. scripts/tests/agent/ts-loader.mjs dùng TypeScript đã cài để load alias/extension và font trên Node có registerHooks (22.15+), không thêm dependency.

## Kiểm tra cuối

| Kiểm tra | Kết quả |
|---|---|
| npx tsc --noEmit | Đạt, exit 0. |
| npm run build | Đạt, exit 0; client, SSR và Nitro/Vercel tạo output thành công. DATABASE_URL không được đặt nên bước db:migrate tự bỏ qua, không đụng DB ngoài. |
| npx tsx --test src/server/controllers/tx.test.ts src/server/controllers/ratelimit.test.ts | Không khởi động được do uv_os_get_passwd / ENOMEM trong sandbox. Đã ghi lại và tiếp tục theo yêu cầu. |
| Chạy lại hai tệp test trên bằng loader TypeScript | 156/156 test đạt, exit 0; gồm 3 test mới cho gợi ý giáo án. |
| node --experimental-strip-types --test src/server/services/arena3.test.ts | 84/84 test đạt, exit 0. |
| Perf probe TRƯỚC/SAU | 10/10 ca khớp hash; số query ổn định qua các lượt đo. |
| git diff --check | Đạt; chỉ có cảnh báo chuẩn hóa LF/CRLF của Windows. |

Lệnh chạy thay thế cho tsx:

```powershell
node --import ./scripts/tests/agent/ts-loader.mjs --test src/server/controllers/tx.test.ts src/server/controllers/ratelimit.test.ts
```

Trên Windows dùng npm.cmd/npx.cmd vì PowerShell chặn npm.ps1/npx.ps1; npm cache đặt trong workspace để tránh quyền ghi cache hệ thống. Log lượt cuối: .cache/typecheck.log, .cache/build-final.log, .cache/tsx-final.log, .cache/controller-tests-final.log, .cache/service-tests-final.log.

Không thêm comment code. Các tệp bị cấm không xuất hiện trong diff; không commit/push. Codebase Memory MCP bị chặn bởi approval policy, Graft CLI lỗi native tree-sitter-kotlin trên Windows/Node 24, nên tra thẻ graft có sẵn và đọc phạm vi nguồn liên quan; không thay graph hoặc dependency để khắc phục môi trường.
