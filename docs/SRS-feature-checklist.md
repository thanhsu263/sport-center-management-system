# Checklist tính năng SRS v2.1 — duyệt để loại bỏ

Cách dùng: đánh `[x]` vào dòng **muốn BỎ** khỏi SRS (và app nếu cần). Dòng để trống = giữ.

Ký hiệu cột cuối:
- ✅ `file:line`: đã grep thấy trong code (có ghi chỗ)
- ✅: có trong code nhưng chưa soát từng con số
- ⚪: chỉ là mô tả tài liệu hoặc hình, không phải logic

---

## A. Tổng quan và phạm vi (Mục I)

- [ ] Ứng dụng phục vụ 1 trung tâm duy nhất ở TP.HCM, gồm các sân cầu lông, bóng rổ, bóng chuyền — ⚪
- [ ] Có 5 cổng: Public `/`, Member `/app`, Desk `/desk`, Coach `/coach`, Manager `/manager` — ✅
- [ ] Ngoài phạm vi: đa chi nhánh, tính lương (payroll), app mobile native, SMS — ⚪
- [ ] Học phí lớp nằm trong gói hội viên, không thu theo buổi — ✅
- [ ] Context diagram có 5 actor người và 3 hệ thống ngoài (payOS, SMTP, Gemini) — ⚪
- [ ] 4 activity diagram: đăng ký, đặt sân + thanh toán, ghi danh lớp/waitlist, hoàn tiền — ⚪

## B. Khách và tài khoản (UC-01 → UC-06)

- [ ] **UC-01** Xem sân, lớp, bảng giá công khai — ✅
- [ ] Chuyển ngôn ngữ EN/VI trên header — ✅
- [ ] **UC-02** Đăng ký hội viên bằng email OTP — ✅
- [ ] OTP hết hạn sau 5 phút — ✅
- [ ] Sai OTP 5 lần thì khóa 15 phút — ✅ `handlers/auth.ts:159`
- [ ] Người dưới 16 tuổi phải nhập thông tin người giám hộ — ✅
- [ ] Bắt buộc tick đồng ý điều khoản — ✅
- [ ] SĐT/email trùng thì báo lỗi (BR-01) — ✅
- [ ] Mật khẩu tối thiểu 8 ký tự, có chữ và số (BR-02) — ✅
- [ ] **UC-03** Đăng nhập / đăng xuất — ✅
- [ ] Phiên hội viên 7 ngày, phiên nhân viên 12 giờ — ✅
- [ ] Sai mật khẩu 5 lần thì khóa 15 phút — ✅ `handlers/auth.ts:229`
- [ ] Nút đăng nhập demo 1 chạm, chỉ bật khi có `VITE_DEMO_LOGINS` — ✅ `routes/login.tsx:26`
- [ ] Hiện OTP trên màn hình khi có `OTP_ECHO` — ✅ `handlers/auth.ts:25`
- [ ] **UC-04** Quên mật khẩu, đặt lại qua email OTP — ✅
- [ ] **UC-05** Sửa hồ sơ cá nhân (gồm ghi chú sức khỏe) — ✅
- [ ] **UC-06** Xem thông báo trong app — ✅
- [ ] Gửi thông báo theo lô 50 tin, thử lại tối đa 5 lần — ✅
- [ ] Nhắc gói sắp hết hạn trước 7, 3 và 0 ngày — ✅

## C. Hội viên: sân, gói, thanh toán (UC-07 → UC-12)

- [ ] **UC-07** Xem lịch của tôi — ✅
- [ ] **UC-08** Đặt sân và thanh toán — ✅
- [ ] Đặt trước tối đa 7 ngày (BR-05) — ✅
- [ ] Tối đa 2 slot/người/ngày — ✅
- [ ] Giữ chỗ 5 phút khi đang thanh toán — ✅
- [ ] Cọc 30% cho giờ cao điểm — ✅
- [ ] Trả bằng giờ trong gói (plan quota) — ✅
- [ ] Chuyển khoản ngân hàng, giữ 120 phút chờ lễ tân xác nhận — ✅
- [ ] payOS VietQR, xác nhận bằng webhook hoặc polling 3 giây — ✅ `components/pay-online.tsx:40`
- [ ] Nhập mã khuyến mãi khi đặt sân — ✅
- [ ] Trùng giờ lớp đang học thì hỏi xác nhận (BR-09) — ✅
- [ ] Slot chưa có giá thì báo hỏi quầy (BR-37) — ✅
- [ ] **UC-09** Đổi giờ hoặc hủy đặt sân — ✅
- [ ] Chỉ đổi sang slot cùng giá — ✅ `handlers/bookings.ts:1047`
- [ ] Không đổi hoặc hủy trong vòng 2 giờ trước giờ bắt đầu — ✅
- [ ] Hoàn 100% / 50% / 0% theo thời gian báo trước (≥24h / 4–24h / <4h) — ✅
- [ ] **UC-10** Đặt mua gói online, trả tiền tại quầy — ✅
- [ ] Giới hạn đặt gói: 3 lần/phút, 10 lần/giờ — ✅ (`ratelimit.ts`, dùng trong `plans.ts`)
- [ ] **UC-11** Xem biên lai và hóa đơn điện tử PDF — ✅
- [ ] Tích điểm: 10.000đ = 1 điểm, 1 điểm = 100đ — ✅
- [ ] Đổi điểm: tối thiểu 50 điểm, mã dùng trong 60 ngày — ✅ `handlers/bookings.ts:868`, `handlers/extras.ts:558`
- [ ] Hạng thành viên (loyalty tier) — ✅ `handlers/extras.ts:487`
- [ ] **UC-12** Tự check-in bằng QR gate pass hoặc quét mã ở quầy — ✅
- [ ] Tự check-in mặc định TẮT (bật trong cài đặt) — ✅

## D. Hội viên: lớp và luyện tập (UC-13 → UC-17)

- [ ] **UC-13** Ghi danh lớp; lớp đầy thì vào danh sách chờ — ✅
- [ ] Phải có gói còn hạn đúng môn (BR-19) — ✅
- [ ] **UC-14** Nhận suất từ danh sách chờ, có hạn 2 giờ — ✅
- [ ] **UC-15** Rời lớp, bị chặn trong vòng 4 giờ trước buổi kế — ✅
- [ ] **UC-16** Xem tiến độ: giáo án, bài tập về nhà, mục tiêu — ✅
- [ ] **UC-17** Trợ lý AI (Gemini) — ✅
- [ ] Gemini timeout 12 giây, rồi fallback sang xAI Grok, rồi câu trả lời theo luật — ✅ `gemini.ts:8,111`
- [ ] Câu hỏi tối đa 800 ký tự, 20 câu/phút — ✅ `handlers/ops.ts:473`
- [ ] Prompt chỉ chứa dữ liệu trung tâm, không có dữ liệu hội viên — ✅
- [ ] Gửi yêu cầu hỗ trợ (support ticket) cho nhân viên — ✅

## E. Lễ tân (UC-18 → UC-29)

- [ ] **UC-18** Mở và đóng ca thu ngân — ✅
- [ ] Chưa mở ca thì không thu tiền (BR-44) — ✅
- [ ] **UC-19** Quản lý hồ sơ hội viên tại quầy — ✅
- [ ] Đăng ký khách vãng lai (walk-in) — ✅
- [ ] Danh sách hội viên có nguy cơ bỏ (vắng liên tiếp, lâu không đến, gói sắp hết) — ✅ `handlers/attendance.ts:186`
- [ ] Lễ tân reset mật khẩu cho hội viên — ✅
- [ ] **UC-20** Bán, gia hạn gói tại quầy, thu bằng VietQR — ✅
- [ ] Bảo lưu gói 1–90 ngày, hạn mức 30 ngày/năm; mở lại gói — ✅ `handlers/ops.ts:53`
- [ ] **UC-21** Đặt sân tại quầy cho khách walk-in — ✅
- [ ] Đặt cố định hằng tuần 4–12 tuần, giảm 10% — ✅
- [ ] **UC-22** Xử lý thanh toán chờ: thu phần còn lại sau cọc, xác nhận hoặc từ chối chuyển khoản, hủy đơn chưa trả — ✅
- [ ] ~~UC-23 Bán và dùng vé ngày~~: đã gỡ khỏi phạm vi (v2.4)
- [ ] **UC-24** Tạo yêu cầu hoàn tiền — ✅
- [ ] Hoàn ≤ 1.000.000đ thì duyệt ngay, lớn hơn thì cần quản lý duyệt — ✅ `migrations/0002_arena3.sql:36`
- [ ] Hoàn toàn bộ đơn thì trả lại lượt dùng mã khuyến mãi — ✅
- [ ] **UC-25** Check-in sân: từ 15 phút trước đến 10 phút sau giờ bắt đầu — ✅
- [ ] Quá 10 phút không check-in thì đánh dấu no-show — ✅
- [ ] **UC-26** Check-in hội viên ở cổng — ✅
- [ ] Cho qua thủ công (override) phải chọn lý do — ✅
- [ ] Quét lặp trong 120 phút không tính thêm lượt — ✅
- [ ] QR lỗi thì dùng lý do dự phòng — ✅
- [ ] Mã QR đã dùng thì yêu cầu làm mới (BR-30) — ✅
- [ ] **UC-27** Cho thuê dụng cụ và ghi nhận trả — ✅
- [ ] Số lượng 1–99, hạn trả 3 giờ, tính tiền và xuất hóa đơn — ✅ `handlers/desk.ts:1061`
- [ ] Báo hết hàng khi tồn kho không đủ (BR-50) — ✅
- [ ] **UC-28** Phiếu bảo trì (lễ tân + quản lý): mức ưu tiên, chi phí — ✅ `handlers/extras.ts:833`
- [ ] **UC-29** Trả lời yêu cầu hỗ trợ — ✅

## F. Huấn luyện viên (UC-30 → UC-35)

- [ ] **UC-30** Xem lịch dạy và danh sách học viên — ✅
- [ ] **UC-31** Điểm danh buổi học — ✅
- [ ] Sổ điểm danh khóa sau 2 giờ; chỉ quản lý sửa, kèm lý do (BR-35) — ✅
- [ ] Cảnh báo khi học viên vắng liên tiếp (streak) — ✅ `handlers/attendance.ts:239`
- [ ] **UC-32** Soạn giáo án buổi: các block, template — ✅
- [ ] AI gợi ý giáo án — ✅
- [ ] Sao chép giáo án cả tuần — ✅ `handlers/training.ts:974`
- [ ] **UC-33** Ghi kết quả buổi và bài tập: tiêu đề ≤120 ký tự, checklist ≤20 mục — ✅ `handlers/training.ts:262`
- [ ] **UC-34** Đánh giá học viên: trình độ, review 2 hoặc 4 tuần chấm 1–5 — ✅
- [ ] Ghi chú riêng < 2.000 ký tự — ✅ `handlers/training.ts:229`
- [ ] **UC-35** Xem thu nhập tháng — ✅

## G. Quản lý (UC-36 → UC-44)

- [ ] **UC-36** Quản lý tài khoản nhân viên — ✅
- [ ] Cấp mật khẩu tạm — ✅
- [ ] Khóa tài khoản — ✅
- [ ] Đăng xuất khỏi mọi thiết bị — ✅ `handlers/members.ts:8`
- [ ] **UC-37** Quản lý gói hội viên và giá: giảm giá 0–100%, quy tắc giá (price rules) — ✅
- [ ] **UC-38** Quản lý mã khuyến mãi — ✅
- [ ] Mã dài 3–24 ký tự — ✅ `handlers/promos.ts:22`
- [ ] Giảm số tiền cố định theo bội số 1.000đ — ✅
- [ ] Mã đã dùng thì không đổi tên (BR-43) — ✅
- [ ] Mã hết hạn thì báo lỗi (BR-40) — ✅
- [ ] **UC-39** Lên lịch lớp và buổi học — ✅
- [ ] Thời lượng buổi 60, 120 hoặc 180 phút — ✅ `handlers/classes.ts:45`
- [ ] Sức chứa 1–200 — ✅ `handlers/classes.ts:752`
- [ ] Dời buổi trong vòng 12 giờ phải ghi lý do — ✅
- [ ] Buổi bị hủy thì trả lại lượt cho học viên 1 lần — ✅
- [ ] Đổi HLV dạy thay — ✅ `handlers/classes.ts:691`
- [ ] Một HLV không được dạy 2 buổi trùng giờ (NFR-02) — ✅
- [ ] **UC-40** Cài đặt trung tâm (mục J bên dưới) — ✅
- [ ] Bật/tắt module (F4 training tắt thì trả 403 BR-52) — ✅
- [ ] **UC-41** Báo cáo, xuất xlsx/pdf — ✅ `components/report-panels.tsx:30`
- [ ] Xuất hóa đơn điện tử dạng XML — ✅ `handlers/extras.ts:954`
- [ ] **UC-42** Duyệt hoặc từ chối hoàn tiền; người tạo yêu cầu không được tự duyệt — ✅
- [ ] **UC-43** Chốt và trả hoa hồng HLV theo kỳ — ✅ `handlers/extras.ts:694`
- [ ] **UC-44** Xem nhật ký kiểm toán (audit log) — ✅

## H. Tác vụ nền (III.1.4)

- [ ] Hủy giữ chỗ quá hạn (mỗi 15 giây) — ✅
- [ ] Đánh dấu no-show — ✅
- [ ] Tự hoàn tất booking 10 phút sau khi kết thúc — ✅
- [ ] Gửi thông báo trong hàng đợi — ✅
- [ ] Rút link payOS khi giữ chỗ hết hạn — ✅
- [ ] Hết hạn lời mời từ danh sách chờ, chuyển cho người kế — ✅
- [ ] Khóa sổ điểm danh — ✅
- [ ] Hết hạn gói — ✅
- [ ] Nhắc gói sắp hết hạn — ✅
- [ ] Sinh buổi học mỗi 10 phút — ✅
- [ ] Webhook payOS kiểm chữ ký và số tiền — ✅

## I. Yêu cầu phi chức năng (Mục IV)

- [ ] Giao diện chạy được ở bề rộng 375px (NFR-11) — ✅
- [ ] Font Be Vietnam Pro / Newsreader / Anton — ✅
- [ ] Tiền viết `đ` thường, không viết hoa (NFR-13) — ✅
- [ ] Hiệu ứng chỉ để trang trí (NFR-14) — ⚪
- [ ] Không bao giờ có 2 booking trùng giờ sân: khóa dòng + trigger DB (NFR-01) — ✅
- [ ] Booking xác nhận luôn có payment + invoice trong cùng transaction (NFR-03) — ✅
- [ ] Idempotency-Key cho request liên quan tiền hoặc lịch (NFR-08) — ✅
- [ ] Chạy offline bằng PGLite khi không có DATABASE_URL (NFR-09) — ✅
- [ ] `GET /v1/me` đọc song song, 1 round trip (NFR-04) — ✅
- [ ] Endpoint chỉ đọc không mở transaction (NFR-05) — ✅
- [ ] Badge ở quầy chỉ đếm (`?brief=1`) (NFR-06) — ✅
- [ ] Job loop chỉ 1 query khi không có việc (NFR-07) — ✅
- [ ] Mọi thay đổi của nhân viên đều ghi audit, không xóa audit (NFR-15) — ✅
- [ ] Mã hội viên / thanh toán / hóa đơn không bị nhảy số (NFR-16) — ✅
- [ ] Mật khẩu lưu hash có salt; token phiên lưu SHA-256 (NFR-17, 18) — ✅
- [ ] Hội viên chỉ đọc được dữ liệu của mình (NFR-20) — ✅
- [ ] Ghi chú sức khỏe và người giám hộ không gửi cho AI (NFR-21) — ✅
- [ ] File báo cáo tạo theo yêu cầu, không lưu lại (NFR-24) — ✅
- [ ] Bảng mã lỗi API: VALIDATION, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT_SLOT, HOLD_EXPIRED, CONFLICT_STATE, BR_VIOLATION, RATE_LIMITED — ✅
- [ ] Kiểm thử: `npm test`, `npm run check:api`, `npm run typecheck` — ✅

## J. Cài đặt trung tâm (V.2), giá trị mặc định

- [ ] Múi giờ Asia/Ho_Chi_Minh, tiền VND (cố định) — ✅
- [ ] Giờ mở cửa 06:00–22:00, slot 60 phút — ✅
- [ ] Giữ chỗ 5 phút; đặt trước 7 ngày; 2 slot/ngày — ✅
- [ ] Báo trước khi hủy: sân 2 giờ, lớp 4 giờ — ✅
- [ ] Hoàn tiền sân 100% / 50% / 0% — ✅
- [ ] Check-in sân 15 phút trước; no-show sau 10 phút — ✅
- [ ] Cọc 30%, chỉ giờ cao điểm — ✅
- [ ] Đặt cố định 4–12 tuần, giảm 10% — ✅
- [ ] Hạn mức hoàn không cần quản lý 1.000.000đ; VAT 0%; làm tròn 1.000đ — ✅
- [ ] Bảo lưu 30 ngày/năm; tuổi vị thành niên <16; lời mời waitlist 2 giờ — ✅
- [ ] Giữ chuyển khoản 120 phút — ✅
- [ ] Điểm: 10.000đ/điểm, 100đ/điểm — ✅
- [ ] Tự check-in tắt; cửa sổ quét lặp 120 phút — ✅

## K. Phụ lục khác

- [ ] 53 business rule BR-01 → BR-53 (V.1) — ✅
- [ ] 21 thông báo MSG01 → MSG21 (V.4) — ✅
- [ ] ERD, class diagram, screen flow, 44 màn hình (III.1) — ⚪
- [ ] 4 sequence diagram trong UC-02, UC-08, UC-24, UC-26 — ⚪
