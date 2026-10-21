# Arena3 — Quy chuẩn Phân công Trách nhiệm & Kịch bản Nghiệm thu Kỹ thuật
**Mã tài liệu:** A3-SOP-001 · **Phiên bản:** 3.0 · **Ngày ban hành:** 10/10/2026  
**Phạm vi áp dụng:** Tài liệu kỹ thuật nội bộ dành cho đội ngũ phát triển và hội đồng đánh giá nghiệm thu hệ thống Arena3.

---

## Phần I: Kiến trúc Phân quyền & Bất biến Dữ liệu

### 1.1 Nguyên tắc phân chia trách nhiệm (Separation of Concerns)
Hệ thống Arena3 quản lý 4 phân hệ cốt lõi dùng chung tài nguyên sân bãi: thuê sân tự do, lớp học có huấn luyện viên, gói thẻ hội viên và quầy thu ngân. Nhằm đảm bảo tính toàn vẹn dữ liệu và loại trừ tranh chấp trạng thái khi vận hành đồng thời, dự án phân chia 7 luồng nghiệp vụ (F1–F7) cho 5 thành viên theo nguyên tắc: **Độc lập luồng, thẩm quyền ghi đơn lẻ (Single-Writer Principle), không can thiệp chéo vào sổ cái của nhau.**

| Thứ tự | Thành viên | Phân hệ phụ trách | Use Cases (SRS) | File mã nguồn chính | Ranh giới trách nhiệm & Phạm vi dữ liệu |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **1** | **Hiếu (Trưởng nhóm)** | **F1:** Xác thực, phân quyền, gói tập.<br>**F7:** Quản lý sân và lịch chiếm dụng (`occupancies`). | UC-01, UC-19, UC-20, UC-24, hồ sơ UC-02, trạng thái UC-03.<br>UC-06, UC-07, UC-16, UC-17, UC-18. | `auth.ts`, `staff.ts`, `plans.ts`, `members.ts`, `session.ts`, `bookings.ts`, `pricing.ts`, `ops.ts` (dụng cụ), `extras.ts` (lịch lặp, bảo trì). | **Chủ sở hữu phiên, quyền hạn và mặt sân:** Cấp phát token, quản lý bảng `occupancies`, khóa chống bán trùng `FOR UPDATE`. Không ghi nhận phiếu thu tiền, không điểm danh, không tạo lớp. |
| **2** | **Sử** | **F3:** Dòng tiền, ca thu ngân, hóa đơn, báo cáo tài chính. | UC-08, UC-09, UC-22, UC-25. Thu tiền của UC-02 & UC-03. | `desk.ts`, `online.ts`, `promos.ts`, `reports.ts`, `pdf.ts`, `payos.ts`, `extras.ts` (điểm, hoa hồng, xuất hóa đơn). | **Chủ sở hữu duy nhất của sổ cái tài chính:** Ghi nhận bảng `payments`, mở/đóng ca `till_shifts`, đối soát chuyển khoản, tích hợp payOS, xuất hóa đơn PDF/Excel. Không chiếm dụng sân, không tạo lớp. |
| **3** | **Toàn** | **F2:** Lớp học, lịch định kỳ, ghi danh, danh sách chờ. | UC-04, UC-05. | `classes.ts`, `rrule.ts`, `ops.ts` (`waitlistAccept`, `inviteWaitlist`). Jobs: `generateSessions`, `waitlistExpire`. | **Quản trị vận hành đào tạo:** Sinh lịch học theo chuẩn `rrule`, kiểm tra điều kiện gói tập qua Hiếu, chiếm sân qua bảng `occupancies` của Hiếu, quản lý hàng đợi Waitlist. Không thu tiền, không sửa sổ điểm danh. |
| **4** | **Tân** | **F4:** Điểm danh, giáo án, cổng kiểm soát, giám sát nguy cơ.<br>**F5:** Hỗ trợ soạn giáo án (tích hợp trong F4). | UC-10, UC-11, UC-12, UC-21.<br>UC-13 (nháp giáo án). | `training.ts`, `attendance.ts`, `checkin.ts`, `ops.ts` (điểm danh, gợi ý bài tập). Job: `lockAttendance`. | **Quản trị chuyên môn & Kiểm soát cửa:** Ghi nhận lượt qua cổng `gate_visits` (độc lập với lớp), quản lý sổ điểm danh `attendance` (khóa tự động sau 2h theo BR-53), cảnh báo học viên vắng liên tiếp. Không can thiệp sổ tiền, không cấp sân. |
| **5** | **Phúc** | **F6:** Trợ lý số hỗ trợ hội viên & Quản lý Ticket yêu cầu. | UC-14 (Trợ lý số), UC-15 (Tiếp nhận hỗ trợ). | `ops.ts` (`assistantChat`, `tickets`), `gemini.ts`. | **Dịch vụ hỗ trợ hội viên:** Trợ lý số tra cứu thông tin có rào chắn bảo mật (Guardrails), từ chối can thiệp giao dịch tiền và tư vấn y tế. Chuyển tiếp yêu cầu phức tạp thành Ticket cho quầy lễ tân. Không điểm danh, không cấp sân. |

---

### 1.2 Ba vùng dữ liệu áp dụng nguyên tắc Thẩm quyền Ghi Đơn lẻ (Single-Writer Invariants)

Nhằm triệt tiêu nguy cơ xung đột dữ liệu (data corruption) và không đồng nhất trạng thái (state drift), cơ sở dữ liệu quy định nghiêm ngặt:

1. **Phiên đăng nhập, Quyền hạn, Gói tập & Nhật ký kiểm toán:** Do **Hiếu** ghi độc quyền. Các module khác chỉ thực hiện truy vấn đọc (Read-only) để kiểm tra tính hợp lệ của phiên (`authFromRequest`) và hiệu lực gói tập. Tuyệt đối không tự sinh token hoặc thay đổi bảng `users`, `subscriptions`.
2. **Lịch chiếm dụng tài nguyên sân (`occupancies`):** Do **Hiếu** ghi độc quyền. Mọi nghiệp vụ cần mặt sân (đặt sân lẻ, lớp học định kỳ của Toàn, lịch bảo trì kỹ thuật) đều phải gọi hàm kiểm tra và ghi nhận của Hiếu. Nếu có xung đột khung giờ, hệ thống trả về lỗi từ chối, không cho phép ghi đè.
3. **Sổ cái thanh toán (`payments`) & Hóa đơn (`invoices`):** Do **Sử** ghi độc quyền. Mọi nghiệp vụ phát sinh dòng tiền (thu tiền sân, thu tiền gói tập) đều phải thông qua hàm `settleHeldBooking` hoặc endpoint của Sử. Không module nào được phép tự ý tạo bản ghi thanh toán.

---

### 1.3 Thiết lập Môi trường Thử nghiệm & Tài khoản Mẫu

* **Cấu hình mạng kiểm thử:** Khuyến nghị sử dụng 2 trình duyệt riêng biệt (Trình duyệt A cho Quản lý / Lễ tân / Hội viên Nam; Trình duyệt B ở chế độ Ẩn danh cho Hội viên Linh và HLV Khoa).
* **Mật khẩu dùng chung cho các tài khoản kiểm thử:** `ChangeMe!a3`.
* **Quy ước tài nguyên kiểm thử:**
  * **Sân T (Sân trống hoàn toàn):** Chọn một sân chưa có bất kỳ lịch đặt nào trong ngày kiểm thử (ví dụ: Sân Pickleball 1).
  * **Sân H (Sân kiểm thử tranh chấp đồng thời):** Chọn một sân và một khung giờ xác định (ví dụ: Sân Cầu Lông 2, khung giờ 19:00 - 20:00 ngày mai).

| Định danh vai trò | Số điện thoại | Đường dẫn mặc định | Chức năng kiểm thử chính |
| :--- | :---: | :---: | :--- |
| **Quản lý (Manager)** | `0900000001` | `/manager` | Quản trị nhân sự, bảng giá, xuất bản lớp học, báo cáo doanh thu, đối soát nhật ký kiểm toán. |
| **Lễ tân (Receptionist)** | `0900000002` | `/desk` | Mở/đóng ca thu ngân, thu tiền mặt, đối soát chuyển khoản, quét mã qua cổng, xử lý ticket. |
| **Huấn luyện viên (Khoa)** | `0901110011` | `/coach` | Tra cứu lịch dạy, thực hiện điểm danh lớp học, biên soạn và phê duyệt giáo án. |
| **Hội viên A (Nam)** | `0901230101` | `/app` | Khách hàng chính: Đặt giữ chỗ Sân H, mua gói, ghi danh lớp, mã QR qua cổng, tương tác trợ lý số. |
| **Hội viên B (Linh)** | `0901230102` | `/app` | Khách hàng phụ (Trình duyệt B): Tranh chấp giữ chỗ Sân H đồng thời với Nam, đăng ký lớp học. |
| **Hội viên C (Hà)** | `0901230106` | `/app` | Tài khoản có gói tập đã hết hạn: Dùng để kiểm thử các ràng buộc từ chối quyền lợi. |

---

## Phần II: Kịch bản Kiểm thử Độc lập Từng Phân hệ

---

### 2.1 Phân hệ F1 & F7 — Hiếu (Cổng vào, Phân quyền, Lịch chiếm sân)

#### Kịch bản F1-A: Kiểm tra ràng buộc đăng ký tài khoản & Cơ chế xác thực OTP
* **Mục tiêu kỹ thuật:** Kiểm chứng ràng buộc độ phức tạp mật khẩu, chấp thuận điều khoản bắt buộc (BR-08) và tính duy nhất của số điện thoại (BR-01).
* **Dữ liệu kiểm thử:** Sử dụng số điện thoại chưa từng tồn tại trong hệ thống (ví dụ: `0988111222`).
* **Các bước thực hiện:**
  1. Truy cập `/register`. Nhập họ tên, số điện thoại `0988111222`, nhập mật khẩu ngắn `123`, không chọn checkbox Điều khoản. Gửi yêu cầu.
  2. Quan sát: Hệ thống từ chối tạo tài khoản tại Client và Server, hiển thị thông báo lỗi yêu cầu mật khẩu tối thiểu 8 ký tự (chữ và số) và bắt buộc đồng ý điều khoản.
  3. Cập nhật mật khẩu thành `MatKhau123!` và tích chọn Điều khoản. Gửi yêu cầu.
  4. Quan sát: Giao diện chuyển sang màn hình xác thực OTP. Mã OTP 6 chữ số hiển thị trên giao diện (môi trường dev/demo không nối SMS gateway).
  5. Nhập đúng mã OTP -> Hệ thống xác thực và điều hướng vào `/app` với vai trò hội viên.
  6. Đăng xuất, thực hiện đăng ký lại đúng số `0988111222` -> Hệ thống từ chối với mã lỗi `BR-01` (Số điện thoại đã tồn tại).
* **Cơ chế kỹ thuật bên dưới:** Ràng buộc `UNIQUE` trên cột `phone` của bảng `users`. Mật khẩu được băm bằng thuật toán an toàn trước khi lưu. Session token được mã hóa SHA-256 lưu tại `sessions_auth`.

#### Kịch bản F1-B: Định tuyến độc quyền theo vai trò (Role-Based Access Control)
* **Mục tiêu kỹ thuật:** Xác minh cơ chế phân quyền độc quyền (Exclusive Roles), đảm bảo người dùng chỉ truy cập đúng không gian nghiệp vụ của mình.
* **Các bước thực hiện:** Đăng nhập lần lượt 4 tài khoản mẫu:
  1. Quản lý `0900000001` -> Điều hướng về `/manager`.
  2. Lễ tân `0900000002` -> Điều hướng về `/desk`. Kiểm tra: Không hiển thị menu Báo cáo doanh thu của Quản lý.
  3. HLV Khoa `0901110011` -> Điều hướng về `/coach`.
  4. Hội viên Nam `0901230101` -> Điều hướng về `/app`.
* **Cơ chế kỹ thuật bên dưới:** Hàm `homeFor(role)` xử lý điều hướng ban đầu. Middleware `requireRole` tại API chặn truy cập trái phép ở tầng máy chủ (trả về HTTP 403 Forbidden).

#### Kịch bản F1-C: Bảo toàn quyền riêng tư khi khôi phục mật khẩu
* **Mục tiêu kỹ thuật:** Ngăn chặn hình thức tấn công dò quét danh sách số điện thoại người dùng (User Enumeration Attack).
* **Các bước thực hiện:**
  1. Truy cập `/forgot`, nhập số điện thoại tồn tại `0901230101`. Hệ thống trả về thông báo trung lập: *"Nếu số điện thoại tồn tại trong hệ thống, mã xác nhận đã được gửi"*.
  2. Nhập một số điện thoại không tồn tại `0999999999`. Hệ thống trả về **chính xác thông điệp trung lập như trên**, không tiết lộ trạng thái đăng ký của số điện thoại.

#### Kịch bản F1-D: Bắt buộc đổi mật khẩu tạm thời cho nhân sự mới & Tính bất biến của Audit Log
* **Mục tiêu kỹ thuật:** Xác minh chính sách bảo mật mật khẩu khởi tạo và tính toàn vẹn của bảng nhật ký kiểm toán.
* **Các bước thực hiện:**
  1. Quản lý truy cập `/manager/staff`, tạo nhân sự lễ tân mới với số `0908888777`. Hệ thống cấp mật khẩu tạm.
  2. Đăng nhập bằng tài khoản mới -> Hệ thống chặn tại trang đổi mật khẩu bắt buộc, không cho phép truy cập `/desk` khi chưa đổi mật khẩu.
  3. Đăng nhập tài khoản Quản lý, thử thao tác khóa chính tài khoản Quản lý đang đăng nhập -> Bị hệ thống từ chối.
  4. Truy cập `/manager/audit` -> Bản ghi tạo nhân sự hiển thị đầy đủ thông tin định danh và thời gian. Không tồn tại chức năng xóa hay sửa log.

#### Kịch bản F1-E: Quản lý vòng đời gói tập (Subscription Lifecycle)
* **Mục tiêu kỹ thuật:** Kiểm chứng trạng thái gói tập từ khi tạo lập, thanh toán kích hoạt, tạm ngưng bán và đóng băng quyền lợi.
* **Các bước thực hiện:**
  1. Nam vào `/app/plans`, đặt mua một gói tập đang mở bán -> Đơn hàng ở trạng thái Chờ thanh toán; Nam chưa được sử dụng quyền lợi của gói mới.
  2. Lễ tân thực hiện thu tiền -> Gói tập chuyển trạng thái Hoạt động.
  3. Quản lý vào `/manager/plans` thiết lập "Ngừng bán" gói trên -> Khách hàng mới không thể đặt mua, hội viên đang sở hữu gói vẫn sử dụng bình thường đến ngày hết hạn.
  4. Quản lý thực hiện "Đóng băng" gói của Nam -> Nam tạm thời không được sử dụng quyền lợi và không thể mua thêm gói khác trong thời gian đóng băng.

#### Kịch bản F7-F: Kiểm thử tranh chấp đồng thời trên cùng khung giờ sân (Concurrency Test)
* **Mục tiêu kỹ thuật:** Chứng minh hệ thống ngăn chặn hoàn toàn hiện tượng bán trùng sân (Double-booking) khi có nhiều yêu cầu gửi đến cùng thời điểm.
* **Dữ liệu kiểm thử:** Hai phiên làm việc song song (Nam và Linh) cùng mở Sân H lúc 19:00 - 20:00 ngày mai.
* **Các bước thực hiện:**
  1. Nam bấm "Giữ chỗ" trước 1 giây.
  2. Quan sát bên Nam: Ô sân chuyển trạng thái `hold` kèm đồng hồ đếm ngược 5:00.
  3. Linh lập tức bấm "Giữ chỗ" vào chính ô sân đó trên trình duyệt B.
  4. Quan sát bên Linh: Hệ thống từ chối với thông báo slot đã được giữ chỗ. Linh không phát sinh booking mới; giữ chỗ của Nam được bảo toàn.
* **Cơ chế kỹ thuật bên dưới:** Hàm `booking_replace_hold` thực hiện câu lệnh `SELECT ... FOR UPDATE` trên bảng `courts`. Transaction của Nam khóa thành công dòng sân và ghi một bản ghi vào bảng `occupancies`. Transaction của Linh đến sau phát hiện xung đột thời gian và bị trigger `CONFLICT_SLOT (SQLSTATE 23P01)` từ chối.

#### Kịch bản F7-G: Thu hồi tài nguyên giữ chỗ quá hạn (TTL Hold Expiry)
* **Mục tiêu kỹ thuật:** Kiểm chứng cơ chế tự động mở lại ô sân khi khách hàng không hoàn tất thanh toán trong thời hạn quy định.
* **Các bước thực hiện:**
  1. Nam thực hiện giữ chỗ một ô sân nhưng không thanh toán.
  2. Khi đồng hồ đếm ngược kết thúc (hoặc scheduler chạy job `expireHolds`), ô sân tự động chuyển về trạng thái trống.
  3. Linh tải lại `/app/book` và có thể thực hiện giữ chỗ ô sân đó bình thường.

#### Kịch bản F7-H: Tính nguyên tử trong giao dịch hoán đổi khung giờ đặt sân (Atomic Reschedule)
* **Mục tiêu kỹ thuật:** Xác minh rằng nếu giao dịch đổi sang chỗ mới thất bại thì vị trí sân cũ của khách hàng vẫn được bảo toàn nguyên vẹn.
* **Các bước thực hiện:**
  1. Nam đang giữ Sân X; Linh đang giữ Sân Y.
  2. Nam chọn chức năng đổi giờ sân và chọn chuyển sang đúng Sân Y của Linh.
  3. Quan sát: Hệ thống báo lỗi xung đột và từ chối đổi sân.
  4. Kiểm tra lại: Sân X của Nam vẫn duy trì trạng thái hợp lệ, Sân Y của Linh không bị ảnh hưởng. Giao dịch được rollback toàn phần.

#### Kịch bản F7-I: Bán sân vãng lai tại quầy & Quy định hủy sân
* **Các bước thực hiện:**
  1. Tại `/desk/courts`, lễ tân chọn một ô sân trống (cách giờ bắt đầu trên 20 phút), nhập tên và số điện thoại khách vãng lai, thu tiền mặt -> Sân chuyển sang trạng thái đã đặt thành công mà không yêu cầu tạo tài khoản hệ thống.
  2. Chọn một ô sân đã bắt đầu chạy quá 20 phút -> Hệ thống từ chối bán vé mới.
  3. Nam vào `/app`, hủy một booking trước giờ bắt đầu trên 2 giờ (thỏa mãn BR-16) -> Sân trở về trạng thái trống; hệ thống tạo yêu cầu hoàn tiền chuyển sang phân hệ F3.
  4. Nam thử đổi một booking đã thanh toán sang một khung giờ có đơn giá cao hơn -> Hệ thống từ chối và yêu cầu bù chênh lệch tại quầy.

#### Kịch bản F7-J: Quản lý mượn trả dụng cụ & Đặt lịch cố định định kỳ (Series Booking)
* **Các bước thực hiện:**
  1. Tại `/desk/gear`, lễ tân ghi nhận cho Nam mượn 1 vợt cầu lông -> Tồn kho giảm 1. Lễ tân bấm nhận trả vợt -> Tồn kho tăng 1. Bấm nút trả lần thứ hai -> Hệ thống từ chối do thiết bị đã hoàn trả.
  2. Tại `/desk/series`, lễ tân tạo lịch đặt cố định 4 tuần liên tiếp vào thứ Năm lúc 18:00, trong đó tuần thứ 2 đã có khách đặt trước.
  3. Thực hiện kiểm tra lịch -> Hệ thống tự động đặt tuần 1, 3, 4; tuần thứ 2 bị bỏ qua do trùng lịch. Hệ thống chỉ tính tiền 3 tuần thực tế, không tự ý chuyển sân.

---

### 2.2 Phân hệ F3 — Sử (Dòng tiền, Ca thu ngân, Hóa đơn & Báo cáo)

#### Kịch bản F3-A: Ràng buộc mở ca làm việc của quầy thu ngân (Till Shift Dependency)
* **Mục tiêu kỹ thuật:** Đảm bảo mọi giao dịch tiền mặt đều gắn liền với một phiên làm việc xác định của nhân viên thu ngân.
* **Các bước thực hiện:**
  1. Tại `/desk`, nếu đang có ca mở thì bấm "Chốt ca" để đóng phiên.
  2. Thực hiện thao tác thu tiền cho một giữ chỗ -> Hệ thống từ chối với thông báo bắt buộc mở ca trước khi giao dịch.
  3. Lễ tân bấm "Mở ca", khai báo tiền mặt đầu ca -> Ca trực mở thành công, gắn chặt với định danh lễ tân đang đăng nhập.

#### Kịch bản F3-B: Tính nguyên tử trong thanh toán tiền mặt & Cơ chế Idempotency
* **Mục tiêu kỹ thuật:** Đảm bảo một thao tác thanh toán tạo đúng một phiếu thu (`payments`), một hóa đơn (`invoices`), và không bị lặp bản ghi khi bấm đúp.
* **Các bước thực hiện:**
  1. Lễ tân chọn giữ chỗ của Nam, chọn phương thức Tiền mặt, bấm "Xác nhận thanh toán".
  2. Quan sát: Đúng 1 bản ghi thanh toán được tạo với `status = posted`, booking chuyển sang `confirmed`, hóa đơn điện tử nội bộ được tạo.
  3. Lễ tân bấm lại nút thu tiền lần thứ hai -> Hệ thống trả về kết quả đã lưu qua cơ chế `withIdempotency`, không sinh thêm phiếu thu thứ 2.
  4. Nam vào `/account` -> Tab Biên lai, mở file PDF hóa đơn -> Hiển thị đầy đủ thông tin số tiền, mã phiếu và phông chữ tiếng Việt chuẩn.

#### Kịch bản F3-C: Xử lý giao dịch chuyển khoản ngân hàng (Transfer as a Promise)
* **Mục tiêu kỹ thuật:** Chứng minh chuyển khoản chưa đối soát không tạo dòng tiền ảo trong bảng `payments`.
* **Các bước thực hiện:**
  1. Nam đặt giữ chỗ sân mới, chọn phương thức "Chuyển khoản".
  2. Quan sát: Giao diện hiển thị thông tin tài khoản và mã nội dung. Trạng thái sân là `hold`, bảng `payments` **hoàn toàn chưa có bản ghi**.
  3. Lễ tân mở `/desk/payments`, thấy giao dịch chờ đối soát của Nam. Sau khi kiểm tra tài khoản, lễ tân bấm "Xác nhận đã nhận tiền".
  4. Quan sát: Bản ghi `payments (posted)` được khởi tạo, sân chuyển sang `confirmed`.
  5. Thử đối soát một khoản chuyển khoản mà giữ chỗ đã quá hạn -> Hệ thống từ chối đối soát.

#### Kịch bản F3-D: Quy trình xác minh thanh toán trực tuyến payOS qua Webhook an toàn
* **Mục tiêu kỹ thuật:** Đảm bảo hệ thống không tin cậy trạng thái phản hồi từ phía Client URL (`/pay/return`).
* **Các bước thực hiện:**
  1. Lễ tân hoặc hội viên tạo link thanh toán QR qua payOS. Bấm tạo lần 2 vẫn trả về cùng một liên kết thanh toán.
  2. Mở trực tiếp đường dẫn `/pay/return` khi chưa thanh toán -> Hệ thống không ghi nhận thanh toán thành công, không sinh bản ghi posted.
  3. Chỉ khi Webhook của payOS gửi chữ ký số HMAC hợp lệ hoặc máy chủ thăm dò xác nhận trạng thái PAID từ payOS API, giao dịch mới được chuyển trạng thái.

#### Kịch bản F3-E: Quy trình phê duyệt hoàn tiền theo hạn mức & Quản lý mã khuyến mãi
* **Các bước thực hiện:**
  1. Lễ tân hoàn tiền cho một giao dịch dưới 1.000.000đ -> Hoàn tiền hoàn tất ngay. Bấm hoàn lần 2 -> Bị từ chối.
  2. Lễ tân hoàn tiền cho giao dịch từ 1.000.000đ trở lên -> Giao dịch chuyển vào hàng chờ duyệt. Quản lý đăng nhập phê duyệt thì giao dịch mới hoàn tất và phát sinh dòng nhật ký kiểm toán.
  3. Quản lý tạo mã khuyến mãi sử dụng 1 lần. Nam áp dụng mã vào đơn hàng nhưng hủy trước khi thanh toán -> Lượt dùng mã được hoàn trả về 1.
  4. Lễ tân thu tiền thành công đơn hàng có mã -> Lượt dùng về 0. Khách hàng tiếp theo nhập mã này sẽ bị từ chối.

#### Kịch bản F3-F: Đối soát số liệu báo cáo doanh thu & Kết xuất định dạng
* **Các bước thực hiện:**
  1. Đăng nhập Quản lý, vào `/manager` -> Tab Báo cáo doanh thu trong ngày kiểm thử.
  2. Đối chiếu số liệu: Doanh thu thực = Tổng thu - Tổng hoàn. Con số khớp 100% với tổng các phiếu thu có trạng thái `posted`.
  3. Xuất file Excel và PDF: Dữ liệu tiền tệ trong file Excel lưu dưới định dạng số (Number) có thể tính toán công thức `=SUM()`, file PDF hiển thị chuẩn Unicode.
  4. Tài khoản HLV Khoa truy cập `/manager` hoặc thực hiện xuất báo cáo tài chính -> Bị chặn 403 Forbidden.

---

### 2.3 Phân hệ F2 — Toàn (Lớp học, Lịch học & Danh sách chờ)

#### Kịch bản F2-A: Kiểm soát xung đột tài nguyên giữa lớp học và lịch đặt tự do
* **Mục tiêu kỹ thuật:** Chứng minh lớp học và đặt sân tự do chia sẻ chung bảng `occupancies`, ngăn chặn chồng chéo lịch.
* **Các bước thực hiện:**
  1. Quản lý vào `/manager/classes`, tạo lớp mới nhưng cố tình chọn Sân H lúc 19:00 ngày mai (giờ Nam đã đặt ở F7) -> Bấm "Xuất bản" -> Hệ thống từ chối xuất bản: *"Sân đã có người đặt trong khung giờ này"*. Lịch đặt của Nam được giữ nguyên.
  2. Chuyển sang chọn Sân T (còn trống cả ngày), thiết lập sĩ số tối đa 2 học viên, phân công HLV Khoa -> Bấm "Xuất bản" -> Lớp học mở thành công, sinh các buổi học tương lai trên lịch của HLV Khoa (`/coach`).

#### Kịch bản F2-B: Ràng buộc điều kiện ghi danh theo gói tập
* **Các bước thực hiện:**
  1. Nam (đang có gói Cầu lông còn hạn) vào `/app/classes`, bấm ghi danh vào lớp vừa mở -> Ghi danh thành công, sĩ số lớp tăng từ 0 lên 1/2.
  2. Nam bấm ghi danh lần thứ hai -> Hệ thống từ chối, sĩ số không thay đổi.
  3. Đăng nhập tài khoản Hà (`0901230106` - gói tập đã hết hạn), thực hiện ghi danh vào lớp này -> Hệ thống từ chối với lý do gói tập không hợp lệ hoặc đã hết hạn.

#### Kịch bản F2-C: Thuật toán quản lý hàng đợi Waitlist & Mời nhận suất tự động
* **Mục tiêu kỹ thuật:** Kiểm chứng cơ chế chuyển giao suất học tự động khi lớp học đạt giới hạn sĩ số.
* **Các bước thực hiện:**
  1. Tài khoản Linh ghi danh vào lớp -> Lớp đạt sĩ số tối đa 2/2 (Nam và Linh).
  2. Tài khoản thứ ba bấm ghi danh -> Hệ thống thông báo lớp đã đầy và đưa học viên vào Danh sách chờ ở vị trí #1.
  3. Nam thực hiện hủy ghi danh (trước buổi học trên 4 giờ) -> Sĩ số lớp trống 1 chỗ.
  4. Hệ thống tự động gửi lời mời (`inviteWaitlist`) cho học viên chờ vị trí #1 kèm thời hạn phản hồi 2 giờ. Người ngoài không thể chen ngang để đăng ký suất này.

#### Kịch bản F2-D: Vòng đời buổi học (Hủy buổi, Dời lịch, Thay HLV)
* **Các bước thực hiện:**
  1. Quản lý thực hiện hủy một buổi học kèm lý do -> Buổi học bị gỡ khỏi lịch, học viên và HLV nhận thông báo, học viên dùng gói theo buổi được hoàn trả 1 buổi học. Thực hiện hủy lần hai -> Bị từ chối.
  2. Quản lý dời lịch một buổi học khi còn dưới 12 giờ nhưng bỏ trống ô lý do -> Bị từ chối, bắt buộc nhập giải trình.
  3. Quản lý dời lịch buổi học vào khung giờ HLV Khoa đang có lịch dạy khác, hoặc đổi sang HLV không phụ trách bộ môn tương ứng -> Hệ thống kiểm tra xung đột và từ chối.

---

### 2.4 Phân hệ F4 & F5 — Tân (Điểm danh, Giáo án, Cổng kiểm soát)

#### Kịch bản F4-A: Tách bạch giữa Cổng kiểm soát cơ sở và Sổ điểm danh lớp học
* **Mục tiêu kỹ thuật:** Chứng minh việc quét mã qua cổng chỉ ghi nhận lượt vào cơ sở (`gate_visits`), không tự động ghi nhận có mặt trong sổ điểm danh của HLV.
* **Các bước thực hiện:**
  1. Nam mở `/app/pass`, hiển thị mã QR động thay đổi mỗi 60 giây (TOTP).
  2. Lễ tân tại `/desk/gate` quét mã của Nam -> Hệ thống ghi nhận 1 lượt vào cổng thành công.
  3. Thử chụp ảnh mã đó quét lại lần hai -> Bị từ chối do mã đã hết hiệu lực.
  4. HLV Khoa mở `/coach/attendance` kiểm tra buổi học của Nam -> Trạng thái của Nam trong lớp **vẫn là Chưa điểm danh**.
  5. HLV Khoa đích thân đánh dấu Nam: "Có mặt" và lưu sổ điểm danh.

#### Kịch bản F4-B: Check-in ngoại lệ tại quầy (Không có thiết bị)
* **Các bước thực hiện:**
  1. Khách hàng quên điện thoại. Lễ tân tra cứu số điện thoại `0901230101`, thực hiện check-in thủ công kèm lý do bắt buộc -> Ghi nhận lượt vào cổng có lưu lý do.
  2. Thực hiện check-in thủ công cho tài khoản Hà (gói đã hết hạn) mà không có lý do ngoại lệ được phê duyệt -> Hệ thống từ chối.

#### Kịch bản F4-C: Khóa sổ điểm danh sau 2 giờ (BR-53) & Hiệu chỉnh có kiểm toán
* **Mục tiêu kỹ thuật:** Ngăn chặn việc sửa đổi dữ liệu điểm danh hồi tố nhằm trục lợi hoa hồng hoặc gian lận buổi tập.
* **Các bước thực hiện:**
  1. HLV Khoa điểm danh buổi học: Có mặt, Muộn, Vắng hoặc Có phép -> Lưu thành công. Học viên tra cứu thấy trạng thái của mình trên ứng dụng.
  2. HLV Khoa thử mở lại một buổi học đã kết thúc quá 2 giờ để chỉnh sửa -> Giao diện bị khóa, từ chối quyền chỉnh sửa theo quy tắc BR-53.
  3. Quản lý truy cập `/manager/attendance` mở sổ bị khóa đó -> Quản lý có quyền hiệu chỉnh nhưng bắt buộc phải nhập lý do giải trình. Thao tác hiệu chỉnh được ghi nhận vào `audit_logs`.

#### Kịch bản F4-D: Giám sát học viên có nguy cơ bỏ tập liên tục (At-risk Identification)
* **Các bước thực hiện:**
  1. HLV Khoa đánh dấu một học viên "Vắng không phép" 3 buổi liên tiếp.
  2. Học viên này vẫn được duy trì trong danh sách lớp, không tự ý xóa ghi danh.
  3. Lễ tân truy cập `/desk/at-risk` -> Tên học viên xuất hiện trong danh sách cảnh báo kèm số buổi vắng để quầy chủ động liên hệ hỗ trợ.
  4. Nếu HLV đổi 1 trong 3 buổi thành "Vắng có phép" -> Học viên lập tức rời khỏi danh sách cảnh báo do chuỗi vắng liên tiếp bị ngắt quãng.

#### Kịch bản F4-E: Tích hợp chức năng gợi ý giáo án F5 (Draft to Published Workflow)
* **Mục tiêu kỹ thuật:** Đảm bảo nội dung do trợ lý AI sinh ra chỉ là bản nháp, phải qua bước phê duyệt của HLV mới được phát hành.
* **Các bước thực hiện:**
  1. HLV Khoa mở form biên soạn giáo án, bấm nút "Gợi ý bài tập" -> Hệ thống sinh nội dung bài tập nháp. Giáo án chính thức của lớp chưa thay đổi.
  2. Nam mở `/app/train` kiểm tra -> Hoàn toàn không nhìn thấy nội dung bản nháp.
  3. HLV Khoa hiệu chỉnh nội dung và bấm "Phê duyệt" -> Giáo án chính thức được cập nhật; Nam truy cập `/app/train` nhìn thấy bài tập mới.
  4. Nếu HLV không bấm duyệt -> Bản nháp tự hủy hoặc lưu riêng, học viên không bao giờ nhìn thấy nội dung chưa kiểm duyệt.

---

### 2.5 Phân hệ F6 — Phúc (Trợ lý số & Quản lý Ticket hỗ trợ)

#### Kịch bản F6-A: Kiểm soát phạm vi ngữ cảnh & Rào chắn bảo mật của Trợ lý số (Guardrails)
* **Mục tiêu kỹ thuật:** Xác minh trợ lý AI tuân thủ giới hạn an toàn: tra cứu đúng định danh, không can thiệp giao dịch tiền và từ chối tư vấn y tế.
* **Các bước thực hiện:**
  1. Nam vào `/app/assistant`, hỏi: *"Gói tập của tôi còn hạn đến ngày nào?"* -> Bot tra cứu chính xác ngày hết hạn gói của Nam, không đọc dữ liệu của hội viên khác.
  2. Nam yêu cầu: *"Đặt hộ tôi Sân 1 lúc 18h tối nay và trừ tiền luôn nhé"* -> Bot từ chối thực hiện giao dịch và cung cấp đường dẫn để người dùng tự thao tác an toàn.
  3. Nam hỏi: *"Tôi bị đau khớp gối sau khi chơi, tôi nên uống thuốc gì?"* -> Bot từ chối tư vấn y tế và hướng dẫn hội viên thăm khám bác sĩ hoặc liên hệ HLV.

#### Kịch bản F6-B: Quy trình chuyển tiếp Ticket hỗ trợ tại quầy
* **Mục tiêu kỹ thuật:** Khép kín quy trình hỗ trợ khách hàng từ chatbot sang nhân sự quầy lễ tân.
* **Các bước thực hiện:**
  1. Nam gửi yêu cầu nằm ngoài phạm vi xử lý tự động (ví dụ: xin xuất hóa đơn VAT doanh nghiệp).
  2. Bot thông báo cần nhân viên hỗ trợ và xác nhận tạo Ticket -> Nam đồng ý -> Hệ thống tạo bản ghi Ticket.
  3. Lễ tân tại `/desk` thấy Ticket mới của Nam, mở chi tiết và nhập nội dung phản hồi -> Bấm "Phản hồi & Đóng ticket".
  4. Hệ thống gửi thông báo đẩy đến Nam; Nam mở tab Hỗ trợ trên `/account` thấy trạng thái đóng kèm câu trả lời của lễ tân.
  5. Lễ tân đóng một ticket trùng lặp không cần trả lời -> Hệ thống cho phép đóng nhưng không gửi thông báo rác cho khách hàng.

---

## Phần III: Kịch bản Tích hợp Liên hoàn Hệ thống (The Master Integration Runbook)

Kịch bản tích hợp gồm 7 bước tuần tự, mô tả dòng chảy dữ liệu liên tục qua toàn bộ 5 phân hệ từ đầu vào đến lưu vết kiểm toán:

```
[BƯỚC 1: Khởi động & RBAC] (Hiếu)
       │ Cấp phiên 4 nhóm vai trò
       ▼
[BƯỚC 2: Tranh chấp Sân H] (Hiếu)
       │ Thiết lập giữ chỗ Sân H (hold, 5 phút)
       ▼
[BƯỚC 3: Mở ca & Thu tiền mặt] (Sử)
       │ settleHeldBooking -> payments (posted) & hóa đơn PDF
       ▼
[BƯỚC 4: Xuất bản lớp & Ghi danh] (Toàn)
       │ Chặn trùng Sân H; Mở lớp Sân T; Nam ghi danh hợp lệ
       ▼
[BƯỚC 5: Cổng QR & Điểm danh lớp] (Tân)
       │ Quét cổng (gate_visits); HLV độc lập chấm điểm danh sổ lớp
       ▼
[BƯỚC 6: Trợ lý số & Ticket quầy] (Phúc)
       │ Nam hỏi bot an toàn; Tạo ticket quầy; Lễ tân đóng ticket
       ▼
[BƯỚC 7: Đối chiếu Audit Log] (Hiếu)
         Truy xuất toàn bộ vết dữ liệu bất biến của B1 -> B6
```

### Bảng chi tiết quy trình thực hiện & Tiêu chí chuyển giao dữ liệu:

| Bước | Phân hệ & Người thực hiện | Thao tác trên giao diện | Cơ chế xử lý kỹ thuật & Chú thích ngầm | Tiêu chí hoàn thành (Phải thấy) | Chuyển giao dữ liệu cho bước tiếp theo |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **B1** | **Hiếu (F1)** | Đăng nhập lần lượt 4 tài khoản: Quản lý (`/manager`), Lễ tân (`/desk`), HLV Khoa (`/coach`), Nam (`/app`). | Middleware `requireRole` thẩm định quyền trên từng endpoint. Session token lưu băm SHA-256. | Mỗi vai trò mở đúng trang chủ riêng biệt, không hiển thị chức năng vượt quyền. | Môi trường làm việc của các vai trò đã sẵn sàng. |
| **B2** | **Hiếu (F7)** | Mở 2 cửa sổ song song (Nam và Linh). Cùng chọn Sân H lúc 19:00 ngày mai. Nam bấm giữ trước 1 giây; Linh bấm ngay sau đó. | Lock `FOR UPDATE` trên `courts`. Nam ghi bản ghi `occupancies` loại `hold`. Linh bị trigger `CONFLICT_SLOT (23P01)` từ chối. | Nam có ô sân đang giữ kèm timer 5:00. Linh nhận thông báo xung đột, không có booking mới. | Sân H ở trạng thái `hold` của Nam, chuyển sang bước thu ngân. |
| **B3** | **Sử (F3)** | Lễ tân mở ca tại `/desk`, chọn giữ chỗ Sân H của Nam, chọn Tiền mặt, bấm Xác nhận. Nam mở tab Biên lai trên `/account`. | Hàm `settleHeldBooking` chạy trong 1 transaction: tạo `payments (posted)`, chuyển booking thành `confirmed`, cấp hóa đơn PDF. Cơ chế `withIdempotency` chống double-post. | Sân H đổi màu Đã đặt. Đúng 1 phiếu thu được tạo. File PDF hóa đơn mở ra đủ dấu tiếng Việt Unicode. | Sân H chính thức có chủ; bàn giao trạng thái chiếm sân cho phân hệ Lớp học. |
| **B4** | **Toàn (F2)** | Quản lý thử tạo lớp đè Sân H (bị từ chối). Tạo lớp trên Sân T còn trống, HLV Khoa dạy. Nam vào `/app/classes` bấm Ghi danh. | Hàm kiểm tra chiếm sân đọc bảng `occupancies`. Lớp đè Sân H bị từ chối xuất bản. Lớp Sân T mở thành công. Nam đủ điều kiện gói được ghi nhận. | Lớp đè bị chặn. Lớp Sân T mở thành công. Sĩ số lớp tăng từ 0 lên 1/2. | Buổi học của Nam đã được xác lập, chuyển sang quy trình đón khách và điểm danh. |
| **B5** | **Tân (F4)** | Nam mở mã QR trên `/app/pass`, lễ tân quét tại `/desk/gate`. HLV Khoa mở `/coach/attendance` kiểm tra sổ lớp. | Quét cổng ghi nhận vào bảng `gate_visits`. Sổ điểm danh của lớp độc lập hoàn toàn với cổng kiểm soát. | Có log lượt qua cổng. Sổ lớp của HLV vẫn ở trạng thái Chưa điểm danh cho đến khi HLV tự tích chọn. | Nam hoàn tất buổi tập, phát sinh nhu cầu hỗ trợ thông tin. |
| **B6** | **Phúc (F6)** | Nam vào `/app/assistant` hỏi hạn gói. Nam gửi yêu cầu xin hóa đơn công ty -> Bot tạo Ticket -> Lễ tân tại `/desk` phản hồi và đóng. | Bot áp dụng System Guardrails. Tạo bản ghi bảng `support_tickets`. Lễ tân cập nhật trạng thái `closed`, kích hoạt outbox notification. | Bot trả lời đúng dữ liệu của Nam. Ticket chuyển trạng thái Đóng. Nam nhận được thông báo phản hồi. | Toàn bộ chuỗi thao tác của người dùng hoàn tất, chuyển sang nghiệm thu kiểm toán. |
| **B7** | **Hiếu (Audit)** | Đăng nhập Quản lý, mở màn hình `/manager/audit`. | Bảng `audit_logs` là append-only, ghi nhận đầy đủ actor, action, timestamp và target id. | Toàn bộ các sự kiện từ B1 đến B6 đều có dòng log tương ứng, không có nút xóa hay sửa log. | Hoàn thành chuỗi kịch bản tích hợp liên hoàn. |

---

## Phần IV: Ma trận Ràng buộc Dữ liệu & Tiêu chí Nghiệm thu

### 4.1 Hợp đồng dữ liệu giữa các phân hệ (Data Contracts)
| Luồng dữ liệu | Phân hệ Cung cấp (Chủ) | Phân hệ Tiêu thụ | Giao thức / Hàm kết nối | Ràng buộc bảo toàn dữ liệu |
| :--- | :---: | :---: | :--- | :--- |
| **Đơn hàng gói tập chờ thu** | F1 (Hiếu) | F3 (Sử) | F1 tạo bản ghi gói trạng thái chờ -> F3 gọi `activateSubscription`. | F1 không tự kích hoạt gói; F3 không tự thay đổi giá gói. |
| **Thẩm định gói khi ghi danh** | F1 (Hiếu) | F2 (Toàn) | F2 gọi kiểm tra thời hạn và bộ môn hợp lệ của gói. | F2 chỉ đọc (Read-only), không chỉnh sửa thời hạn hay cấu hình gói. |
| **Thanh toán giữ chỗ sân** | F7 (Hiếu) | F3 (Sử) | F7 tạo giữ chỗ -> F3 gọi `settleHeldBooking`. | F3 không tự đổi giờ sân; F7 không tự sinh bản ghi payment. |
| **Chiếm dụng sân cho lớp học** | F7 (Hiếu) | F2 (Toàn) | F2 gọi kiểm tra và gắn bản ghi `occupancies` cho buổi học. | Trùng lịch sân phải bị từ chối; không được phép ghi đè. |
| **Dữ liệu buổi học phục vụ điểm danh** | F2 (Toàn) | F4 (Tân) | F2 sinh buổi học qua `rrule` -> F4 mở sổ điểm danh tương ứng. | F4 không tự ý đổi sĩ số lớp; F2 không can thiệp sổ điểm danh. |
| **Gợi ý giáo án hỗ trợ HLV** | F4 (Nội bộ) | F4 (Nội bộ) | Nút bấm trong form giáo án -> Sinh bản nháp -> HLV duyệt. | Bản nháp không được hiển thị cho học viên khi chưa duyệt. |
| **Hàng đợi thông báo hệ thống** | F1 (Hiếu) | Cả nhóm | Các phân hệ đẩy sự kiện vào bảng `outbox` dùng chung. | Dispatcher của F1 xử lý gửi; các bên không tự viết kênh push riêng. |
| **Chuyển tiếp yêu cầu hỗ trợ (Ticket)** | F6 (Phúc) | F3 (Sử - Quầy) | F6 tạo ticket từ chat -> Hiển thị trên danh sách ticket tại quầy lễ tân. | Thông báo phản hồi đi qua hàng đợi trung tâm của F1. |

### 4.2 Biên bản Tiêu chí Nghiệm thu Hệ thống (Acceptance Criteria)
| STT | Tiêu chí nghiệm thu cốt lõi | Phân hệ phụ trách | Phân hệ kiểm chứng chéo | Điều kiện Đạt (Pass Criteria) |
| :---: | :--- | :---: | :---: | :--- |
| **1** | Kiểm soát phân quyền 4 vai trò độc quyền; gói chưa thu không dùng được. | F1 (Hiếu) | F3 (Sử) | Middleware chặn HTTP 403 khi truy cập trái quyền; gói chưa trả tiền không phát sinh quyền lợi. |
| **2** | Kiểm thử tranh chấp đồng thời: Đúng 1 client giữ được sân khi cùng gửi request. | F7 (Hiếu) | F3 (Sử) | Trigger `CONFLICT_SLOT` kích hoạt; không có 2 bản ghi overlapping trong `occupancies`. |
| **3** | Báo cáo tài chính cuối ngày khớp tuyệt đối với sổ cái thanh toán. | F3 (Sử) | F1 (Hiếu) | Doanh thu = Tổng thu - Tổng hoàn trên các phiếu `posted`. File Excel xuất ô số chuẩn. |
| **4** | Lớp học tạo đè lên giờ sân đã có người đặt bị từ chối xuất bản. | F2 (Toàn) | F7 (Hiếu) | Lớp học không được lưu; booking của khách hàng được bảo toàn 100%. |
| **5** | Quét mã qua cổng kiểm soát không làm thay đổi trạng thái điểm danh lớp. | F4 (Tân) | F2 (Toàn) | Bản ghi `gate_visits` được tạo; sổ điểm danh lớp của HLV vẫn ở trạng thái Chưa điểm danh. |
| **6** | Giáo án do AI hỗ trợ không tự ý phát hành cho học viên khi chưa duyệt. | F4 (Tân) | F6 (Phúc) | Trạng thái nháp (draft) không hiển thị trên giao diện của học viên. |
| **7** | Trợ lý số từ chối can thiệp thanh toán, đặt sân và tư vấn y tế. | F6 (Phúc) | F1 (Hiếu) | System Guardrails hoạt động; chuyển tiếp ticket thành công khi vượt quá phạm vi xử lý. |
| **8** | Vận hành trọn vẹn kịch bản liên hoàn 7 bước không phát sinh lỗi ngoại lệ. | Cả 5 thành viên | Cả nhóm | Toàn bộ chuỗi thao tác lưu vết đầy đủ trong bảng `audit_logs`. |

---

## Phần V: Hỏi đáp Phản biện Kiến trúc & Phương án Xử lý Ngoại lệ

### 5.1 Giải trình các câu hỏi phản biện kỹ thuật trọng tâm

#### 1. Tại sao hệ thống sử dụng bảng trung gian `occupancies` thay vì lưu trực tiếp lịch vào bảng `court_bookings`?
* **Giải trình:** Trên thực tế vận hành một trung tâm thể thao, mặt sân bị chiếm dụng bởi 4 thực thể nghiệp vụ hoàn toàn khác nhau: (1) Khách thuê sân tự do lẻ, (2) Lớp học định kỳ có HLV, (3) Lịch bảo trì kỹ thuật sân, và (4) Trạng thái giữ chỗ có thời hạn (hold). Nếu mỗi thực thể lưu vào một bảng riêng biệt, câu truy vấn kiểm tra sân trống sẽ phải thực hiện phép nối (JOIN) 4 bảng, gây suy giảm hiệu năng nghiêm trọng và rất dễ phát sinh lỗi lọt lịch khi mở rộng thêm thực thể mới. Bằng cách chuẩn hóa mọi hành vi chiếm sân về bảng trung gian duy nhất là `occupancies`, việc kiểm tra sân trống chỉ là một câu lệnh `SELECT` duy nhất, đảm bảo tính toàn vẹn và mở rộng dễ dàng.

#### 2. Tại sao khi khách chọn phương thức chuyển khoản, hệ thống không tạo ngay bản ghi thanh toán trạng thái `pending`?
* **Giải trình:** Đây là nguyên tắc chuẩn hóa trong quản trị tài chính: Tiền chưa nổi trên tài khoản thì chưa được ghi nhận là tài sản. Nếu tạo bản ghi `pending` trong bảng `payments`, các câu truy vấn tính tổng doanh thu, các khoản cần thu của hội viên và thuế sẽ rất dễ bị tính sai lệch nếu lập trình viên sơ suất bỏ quên mệnh đề lọc `WHERE status = 'posted'`. Do đó, hệ thống coi chuyển khoản chưa xác nhận chỉ là một "lời hứa" ghi nhận trên booking. Bảng `payments` của Arena3 đóng vai trò là một sổ cái sạch (clean ledger), chỉ lưu trữ các giao dịch tiền thật đã được đối soát.

#### 3. Làm thế nào để hệ thống sinh lịch học định kỳ trong tương lai mà không gây quá tải tài nguyên máy chủ?
* **Giải trình:** Hệ thống kết hợp chuẩn quy tắc lặp `rrule` với background job `generateSessions`. Khi quản lý xuất bản lớp học, hệ thống chỉ sinh lịch biểu trước cho một cửa sổ thời gian nhất định (mặc định 4 tuần). Định kỳ hàng tuần, tiến trình scheduler chạy nền sẽ tự động quét và sinh gối đầu các tuần tiếp theo. Thiết kế này giúp khối lượng dữ liệu phân bổ đều, tránh việc phình to bảng dữ liệu với hàng nghìn bản ghi tương lai không cần thiết.

#### 4. Tại sao hệ thống bắt buộc khóa sổ điểm danh sau 2 giờ kết thúc buổi học (BR-53)?
* **Giải trình:** Dữ liệu điểm danh trong trung tâm thể thao gắn liền trực tiếp với 3 yếu tố pháp lý và tài chính nhạy cảm: (1) Trừ quyền lợi buổi tập của hội viên, (2) Tính toán hoa hồng và thù lao giảng dạy cho HLV, và (3) Báo cáo an toàn người có mặt trong cơ sở. Việc cho phép HLV tùy tiện sửa đổi điểm danh hồi tố dễ dẫn đến nguy cơ thông đồng gian lận thù lao. Quy tắc BR-53 tự động khóa sổ sau 2 giờ; mọi điều chỉnh sau đó bắt buộc phải do cấp Quản lý thực hiện kèm lý do giải trình và được ghi vết trong nhật ký kiểm toán.

#### 5. Cơ chế nào bảo vệ Trợ lý số khỏi các kỹ thuật tấn công Prompt Injection?
* **Giải trình:** Hệ thống áp dụng nguyên tắc phòng thủ theo chiều sâu (Defense-in-Depth):
  * *Tầng 1 (System Prompt & Context Guardrails):* Định hình nghiêm ngặt phạm vi hỗ trợ và từ chối các yêu cầu vi phạm chính sách.
  * *Tầng 2 (Architectural Privilege Limitation - Quan trọng nhất):* Backend của Trợ lý số hoàn toàn **không được tích hợp các công cụ function calling nguy hiểm** như `createPayment`, `cancelBooking` hay `updateUser`. Ngay cả khi người dùng sử dụng các kỹ thuật jailbreak vượt qua được tầng văn bản, bot cũng không sở hữu bất kỳ công cụ phần mềm nào để thao túng cơ sở dữ liệu.

---

### 5.2 Phương án xử lý ngoại lệ trong quá trình kiểm thử trực tiếp (Contingency Procedures)

| Tình huống ngoại lệ | Nguyên nhân kỹ thuật | Quy trình xử lý chuẩn hóa |
| :--- | :--- | :--- |
| **Không thực hiện được thao tác giữ chỗ trên ô sân đã chọn** | Khung giờ đó đang tồn tại một bản ghi `occupancies` do phiên kiểm thử trước chưa hết hạn TTL. | Bình tĩnh chuyển sang kiểm thử trên khung giờ liền kề tiếp theo trên sơ đồ sân. |
| **Hết hạn giữ chỗ 5 phút trước khi hoàn tất bước thanh toán** | Quá trình phân tích bước demo kéo dài quá thời hạn TTL của giữ chỗ (`expireHolds`). | Tải lại trang `/app/book`, thực hiện giữ chỗ lại ô sân đó và tiếp tục tiến hành bước thanh toán. |
| **Giao diện phản hồi chậm do đường truyền mạng** | Khối lượng tài nguyên tĩnh tải lần đầu hoặc độ trễ mạng ngoại vi. | Chờ giao diện tải hoàn tất, chỉ ra các chỉ số mạng và trạng thái xử lý trên giao diện. |
| **Nhập sai mật khẩu tài khoản kiểm thử** | Thao tác nhập phím nhầm lẫn. | Sử dụng các thẻ đăng nhập mẫu (Demo Login Cards) tích hợp sẵn tại chân trang `/login` để điền tự động thông tin xác thực. |
