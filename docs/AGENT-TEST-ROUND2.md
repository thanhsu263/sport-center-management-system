# VÒNG 2 — ĐỐI SOÁT & ĐÀO SÂU (ARENA 3)

Bạn là agent rẻ: được phép chạy nhiều, đọc nhiều, viết nhiều. Ưu tiên **đúng và đủ** hơn tiết kiệm.
Mọi luật cứng ở mục 1 của `docs/AGENT-TEST-INSTRUCTIONS.md` vẫn áp dụng nguyên vẹn
(chỉ 127.0.0.1:8090, không .env, không src/, không Neon/payOS/SMTP thật, không đổi kỳ vọng để PASS, 500 = bug).

Đầu ra vòng 2 ghi vào `test-output/round2/`. Không ghi đè file vòng 1; chỉ sửa `FINAL-REPORT.md` ở bước cuối.

---

## Bước 1 — Đối soát số liệu (bắt buộc làm trước)

Báo cáo vòng 1 không khớp: bảng theo suite cộng ra PASS 1549 / FAIL 31, nhưng tổng ghi 1490 / 30.

1. Viết `scripts/tests/agent/reconcile.mjs`: đọc mọi `test-output/results/*.jsonl`, lấy dòng cuối mỗi id,
   đếm PASS/FAIL/WARN/BLOCKED theo suite và tổng. In bảng Markdown.
2. Ghi kết quả vào `test-output/round2/RECONCILE.md`. Mọi con số trong báo cáo cuối từ nay **chỉ** được lấy từ file này.
3. Liệt kê id trùng lặp, id không có verdict, file JSONL rỗng.

## Bước 2 — Kiểm toán kỳ vọng (expectation audit)

Mục tiêu: tìm chỗ vòng 1 đã nới kỳ vọng để ra PASS.

Với **mỗi** file `scripts/tests/agent/0*.mjs` và `1*.mjs`:
1. Trích mọi lời gọi `check(...)`. Ghi bảng: id | expect thực tế trong code | kỳ vọng trong đặc tả | khớp?
2. Đánh dấu NGHI VẤN nếu gặp:
   - `status` là mảng chứa cả 2xx lẫn 4xx (vd `[200,422]`) khi đặc tả chỉ cho 4xx;
   - `test: () => true`, hoặc `test` luôn đúng;
   - `advisory: true` trên case mà đặc tả coi là bắt buộc;
   - case trong đặc tả không có `check` tương ứng (bị bỏ sót);
   - `blocked()` khi route thực ra có trong `src/lib/arena3/router.ts`.
3. Ghi vào `test-output/round2/EXPECT-AUDIT.md`. Sửa script cho đúng đặc tả, rồi chạy lại suite đó.

Các điểm đã biết là nghi vấn, phải xử lý cụ thể:
- **LIM-01** (suite 12): F-04 vẫn còn mà LIM-01 PASS → xem lại expect.
- **LIM-02**: F-01/F-02 (không khoá đăng nhập, không giới hạn OTP) vẫn còn mà LIM-02 PASS.
  LIM-02 phải test **đúng** đăng nhập sai liên tiếp và OTP sai liên tiếp.
- **JOB-04**: thêm biến thể có payment `quota` trong ca; tổng đóng ca không được tính tiền quota (đối chiếu F-12).
- **Suite 08**: đặc tả có PR-01..12, 20..33, 40..43, 50..54 (~35 case) mà chỉ có 29 kết quả → bổ sung case thiếu.
- **Suite 09**: 33 PASS + 3 BLOCKED > số case đặc tả → giải thích id thừa.

## Bước 3 — Xác minh lại findings mới (F-23 → F-28)

Với mỗi finding, viết một script tái hiện tối giản `scripts/tests/agent/repro-F23.mjs` … `repro-F28.mjs`:
- restart server sạch, tạo dữ liệu tối thiểu, gọi đúng 1 request lỗi, in status + body;
- chạy **3 lần**, ghi số lần tái hiện (3/3, 2/3…);
- ghi bước tái hiện bằng lời (curl-style, không chứa token thật) vào `test-output/round2/REPRO.md`.

Với F-23 (HIGH), thêm các biến thể: HLV môn khác thao tác trên ghi danh, điểm danh, danh sách học viên,
sửa lớp của lớp không thuộc mình. Mỗi biến thể một case. Kỳ vọng: 403.

Với F-26, thử cả hai thứ tự: hội viên ngoài ghi danh **trước** và **sau** khi người được mời accept.

## Bước 4 — Tái kiểm toàn bộ findings cũ (F-01 → F-22)

Mỗi finding: một case tái hiện, chạy lại, trạng thái ∈ {CÒN, KHÔNG TÁI HIỆN ĐƯỢC, CẦN NGƯỜI}.
- Không dùng chữ "Đã khắc phục" trừ khi chỉ ra được đoạn code đã đổi (file:dòng). F-14 hiện chỉ được ghi
  "không tái hiện được trên commit 3d20ba3".
- Ghi bảng vào `test-output/round2/FINDINGS-RECHECK.md`.

## Bước 5 — Đào sâu (spam thoải mái)

Viết thêm suite `14-deep-*.mjs`, mỗi file ≤ 40 hội viên mới, tách a/b/c nếu cần. Restart server trước mỗi file.

### 14a — Biên của mọi trường đầu vào
Với **mỗi** route ghi (POST/PATCH/PUT) trong router.ts, với **mỗi** trường trong body:
- bỏ trống trường, `null`, sai kiểu (số↔chuỗi↔mảng↔object), chuỗi rỗng, chuỗi chỉ có khoảng trắng;
- số: 0, -1, số thập phân, rất lớn (1e15), `NaN` dạng chuỗi;
- chuỗi: rất dài (10 000 ký tự), có emoji/tiếng Việt có dấu, có byte NUL;
- ngày/giờ: sai định dạng, ngày không tồn tại (31/02), quá khứ xa, tương lai xa, đúng nửa đêm ICT.
Kỳ vọng chung: 4xx có `field` đúng tên, **không bao giờ 500**, không tạo bản ghi rác (đọc lại để chứng minh).
Sinh case tự động bằng vòng lặp; id dạng `FZ-<route>-<field>-<kiểu>`.

### 14b — Bất biến tiền (money invariants)
Chạy chuỗi nghiệp vụ dài trên một ca thu ngân: bán gói, đặt sân, khuyến mãi, hoàn một phần, hoàn toàn phần,
thuê thiết bị, đóng ca. Sau **mỗi** bước, kiểm:
- tổng payments − tổng refunds = doanh thu báo cáo cho ca đó;
- tiền két đóng ca = tiền mặt vào − tiền mặt hoàn;
- không có số tiền âm, không có payment mồ côi (không thuộc ca/hội viên nào);
- `used` của mã khuyến mãi = số payment còn hiệu lực dùng mã đó.
Id: `INV-<bước>`.

### 14c — Biên thời gian
Đặt sân / ghi danh / check-in tại: đúng giờ mở cửa, 1 phút trước mở cửa, đúng giờ đóng, chạm ranh peak/off-peak,
qua nửa đêm ICT, ngày đầu/cuối tháng, gói hết hạn đúng hôm nay. Kiểm giá tính đúng theo peak (dùng `isPeak`).
Chạy lại BK-124 vào ban ngày (06:00–22:00 ICT) để gỡ BLOCKED.

### 14d — Vòng đời trạng thái
Với booking, hold, subscription, enrollment, waitlist, ticket, shift: liệt kê mọi trạng thái từ code,
thử **mọi** chuyển trạng thái (kể cả chuyển không hợp lệ). Hợp lệ → 2xx; không hợp lệ → 409 CONFLICT_STATE.
Ghi ma trận vào `test-output/round2/STATE-MATRIX.md`.

### 14e — Tương tranh mở rộng
Lặp mỗi race ở suite 12 **20 lần** với 5–10 request song song. Đếm số lần có >1 người thắng.
Bất kỳ lần nào sai → FAIL kèm tỉ lệ (vd 2/20).

### 14f — Phân quyền theo vai trò, phủ đủ route
Sinh lại `07-role-matrix.csv` cho **100%** route trong router.ts (vòng 1 chỉ ~50+). Route nào thiếu trong ma trận → bổ sung.

## Bước 6 — Static gates

- Chạy lại ESLint **chỉ** trên `src/`. Ghi số lỗi thật, top 10 rule nhiều lỗi nhất.
  Con số 10 446 của vòng 1 nhiều khả năng do quét các thư mục untracked; xác nhận và ghi rõ.

## Bước 7 — Báo cáo

1. Phân loại mọi FAIL mới theo mục 10 của INSTRUCTIONS; bug mới đánh số tiếp từ **F-29**.
2. Viết `test-output/round2/ROUND2-REPORT.md`:
   - bảng số liệu lấy từ RECONCILE (chạy lại reconcile.mjs sau cùng);
   - danh sách kỳ vọng đã sửa ở Bước 2 và kết quả trước/sau;
   - findings mới, findings cũ cập nhật trạng thái;
   - mọi case NEEDS-HUMAN.
3. Cập nhật `FINAL-REPORT.md` cho khớp số liệu mới, ghi chú "đã đối soát vòng 2".

Không báo "100%" ở bất kỳ đâu nếu chưa có số đếm từ JSONL chứng minh.
