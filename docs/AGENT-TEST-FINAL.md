# BƯỚC CUỐI — GOM BỘ BÀN GIAO CHO DEV (ARENA 3)

Vòng 4 đã được chấp nhận. Luật cứng mục 1 của `docs/AGENT-TEST-INSTRUCTIONS.md` giữ nguyên (không sửa `src/`).
Mọi đầu ra ghi vào `test-output/final/`. Ghi tiến độ vào `test-output/final/PROGRESS.md` sau mỗi bước.

## 1. Dọn các điểm còn lệch (mỗi điểm kèm bằng chứng đọc từ file/log)

- Đọc lại `auth.ts`, ghi CHÍNH XÁC dòng tăng `failed_logins` (login) và dòng tăng `attempts` (OTP).
- F-27: đếm lại số route bị ảnh hưởng từ `14a-500-errors.json`. F-28 cũng vậy.
  Ghi chú 14a phải phân rã đủ 36 FAIL = F-27 + F-28 + F-24 + F-25 + F-18.
- F-04: in chính xác số hội viên tạo thành công trước khi va chạm, lấy từ log.
- ST-ENR-04: trích handler chứng minh 409 hợp lệ. Không chứng minh được → trả kỳ vọng về 404 và chạy lại.
- In đầy đủ 17 FAIL của 14f (đủ mọi hàng).

## 2. Chuẩn hoá severity

- Chỉ dùng HIGH / MEDIUM / LOW theo mục 15 của INSTRUCTIONS.
- F-11 và F-15 phải xếp lại mức (không dùng WARN). Mỗi lần đổi severity ghi một dòng lý do.
- F-12: kiểm báo cáo doanh thu (`/reports`) có cộng payment `quota` không.
  Có → giữ MEDIUM, ghi "doanh thu báo cáo bị thổi phồng". Không → ghi rõ phạm vi chỉ là hoá đơn.

## 3. `test-output/final/BUGS-FINAL.md`

Sắp theo severity rồi theo id. Mỗi bug có:
- tiêu đề một dòng, severity, endpoint;
- bước tái hiện tối thiểu (dạng request, không chứa token thật), status + body thực tế / kỳ vọng;
- nguyên nhân gốc kèm file:dòng;
- HƯỚNG SỬA đề xuất bằng lời, không viết patch
  (vd F-01/F-02: ghi bộ đếm bằng kết nối/transaction riêng đã commit, hoặc commit trước khi throw);
- regression ids: các test case sẽ chuyển sang PASS khi bug được sửa.

Gộp các finding cùng nguyên nhân gốc thành "nhóm sửa", giữ nguyên id cũ:
- F-01 + F-02: `withTx` rollback xoá bộ đếm;
- F-18 + F-24 + F-25: lỗi FK 23503 chưa được map;
- F-10: thứ tự kiểm quyền (validation/query chạy trước 403);
- các nhóm khác nếu phát hiện cùng gốc.

## 4. `scripts/tests/agent/regression.mjs`

- Chỉ chạy các regression id ở bước 3, gom theo suite, restart server cho mỗi suite.
- In bảng: bug | regression ids | PASS/FAIL.
- Mục đích: dev sửa xong chạy một lệnh là biết bug nào đã hết.

## 5. Chạy lại toàn bộ một lượt

- Chạy lại TOÀN BỘ suite 01 → 14f từ đầu trên server sạch, một lượt, không sửa gì giữa chừng.
- So với RECONCILE vòng 4: liệt kê mọi id đổi verdict (phát hiện test chập chờn).

## 6. `test-output/final/HANDOFF.md` (tối đa 1 trang)

- số liệu cuối từ reconcile;
- top 5 bug nên sửa trước và lý do;
- danh sách nhóm sửa;
- cách chạy `regression.mjs`;
- danh sách test chập chờn (nếu có);
- các mục NEEDS-HUMAN còn mở.
