# Arena3 · Tài liệu Phân công 5 người & Cẩm nang Kịch bản Demo Chi tiết
**Mã tài liệu:** A3-TEAM-001-EXT · **Ngày cập nhật:** 09/10/2026 · **Phiên bản:** 2.1 (Tập trung chú thích chuyên sâu & hướng dẫn demo từng bước, không gò bó thời gian)  
**Trạng thái:** Dành cho buổi bảo vệ đồ án / Demo nghiệm thu trực tiếp trước hội đồng chấm thi

---

## 1. Nguyên tắc cốt lõi & Quy chuẩn Diễn tập

### 1.1 Nguyên tắc phân vai & ranh giới trách nhiệm
Bảy phân hệ nghiệp vụ (F1–F7) được chia cho 5 thành viên theo nguyên tắc: **Độc lập luồng, một người ghi một vùng dữ liệu, không giẫm chân nhau, demo tuần tự theo sự kiện**:
* **Hiếu (Trưởng nhóm - Hạng 1):** Nắm **F1** (Cổng vào, phân quyền, gói tập) và **F7** (Lịch chiếm sân `occupancies`, giữ chỗ, giải quyết xung đột). Hiếu là người mở màn và chốt hạ hệ thống.
* **Sử (Hạng 2):** Nắm **F3** (Tiền tệ, ca thu ngân, hóa đơn, hoàn tiền, báo cáo doanh thu). Toàn bộ sổ cái tài chính chỉ một mình Sử ghi.
* **Toàn (Hạng 3):** Nắm **F2** (Lớp học, lịch lặp, ghi danh, danh sách chờ). Toàn chỉ gọi Hiếu để chiếm sân và đọc gói tập từ Hiếu.
* **Tân (Hạng 4):** Nắm **F4** (Điểm danh, giáo án, cổng QR, cảnh báo nguy cơ nghỉ). **F5 (Gợi ý bài tập AI)** tích hợp trực tiếp làm nút bấm nháp trong giáo án của Tân.
* **Phúc (Hạng 5):** Nắm **F6** (Trợ lý hỏi đáp AI & Quản lý Ticket hỗ trợ). Chỉ làm việc qua giao diện chat và hàng ticket, không đụng tiền, không đụng sân.

### 1.2 Ba "vùng cấm kỵ" trong cơ sở dữ liệu (Chỉ một người được ghi)
| Vùng dữ liệu | Chủ sở hữu ghi | Quy tắc cho các thành viên khác |
| :--- | :--- | :--- |
| **Phiên đăng nhập, OTP, gói, cờ, audit** | **Hiếu** | Các bên chỉ gọi để kiểm tra quyền và thời hạn gói. Tuyệt đối không tự cấp token, không tự sửa bảng `users` / `subscriptions`. |
| **Lịch chiếm sân (`occupancies`)** | **Hiếu** | Toàn (lớp) hay Tân (sự kiện) muốn dùng sân đều phải gọi hàm của Hiếu. Nếu trùng lịch sẽ nhận lỗi từ chối, không được ghi đè. |
| **Phiếu thu (`payments`) & Hóa đơn** | **Sử** | Hiếu (sân) hay Toàn (lớp) cần thu tiền đều phải gọi qua `settleHeldBooking` hoặc endpoint của Sử. Tuyệt đối không tự tạo dòng tiền giả. |

### 1.3 Quy chuẩn thiết bị & Chuẩn bị trước giờ demo
1. **Thiết lập 2 trình duyệt riêng biệt:**
   * *Trình duyệt 1 (Chính - Chrome thông thường):* Dùng cho Quản lý / Lễ tân / Hội viên Nam.
   * *Trình duyệt 2 (Ẩn danh - Incognito / Profile thứ hai):* Dùng cho Linh (đấu slot tranh chấp) hoặc HLV Khoa.
2. **Quy tắc vàng khi trình bày:**
   * **NÓI MỤC TIÊU VÀ KẾT QUẢ KỲ VỌNG TRƯỚC KHI CLICK CHUỘT:** Giúp hội đồng biết mình sắp chứng minh điều gì. Tránh bấm xong mới giải thích thì giao diện đã nhảy qua bước khác.
   * **CHỈ RÕ CỘT "PHẢI THẤY":** Khi kết quả hiện ra (Toast thông báo, đổi màu ô sân, dòng audit log), dùng con trỏ chuột khoanh vùng để người chấm nhìn thấy rõ ràng.
3. **Dữ liệu chuẩn bị sẵn ra giấy:**
   * Chọn 1 ngày cụ thể trong 7 ngày tới (ví dụ: ngày mai).
   * **Sân T (Sân Trống):** Chọn 1 sân hoàn toàn trống cả ngày (ví dụ: Sân Pickleball 1).
   * **Sân H (Sân Huyết Chiến / Đấu Slot):** Chọn 1 sân và 1 khung giờ đẹp (ví dụ: Sân Cầu Lông 2, khung 18:00 - 19:00).
   * Mật khẩu dùng chung cho mọi tài khoản test: `ChangeMe!a3`.

---

## 2. Kịch bản Chi tiết, Chú thích Kỹ thuật & Hướng dẫn Từng Bước cho 5 Thành viên

---

### PHẦN 1: HIẾU (Trưởng nhóm) — F1 (Xác thực, Gói) & F7 (Sơ đồ sân, Chiếm sân)

#### A. Trách nhiệm kỹ thuật & Business Rules (BR)
* **File phụ trách:** `src/lib/arena3/handlers/auth.ts`, `staff.ts`, `plans.ts`, `members.ts`, `bookings.ts`, `pricing.ts`, `ops.ts` (mượn vợt), `extras.ts` (đặt cố định, bảo trì).
* **Quy tắc cốt lõi:**
  * **BR-01 & BR-02:** Một SĐT chỉ tạo 1 tài khoản; mật khẩu tối thiểu 8 ký tự kèm chữ và số.
  * **BR-08:** Bắt buộc đồng ý điều khoản dịch vụ và chính sách bảo mật dữ liệu.
  * **BR-16:** Cửa sổ hủy sân tối thiểu 2 giờ (hoặc theo bậc cọc).
  * **Khóa chống đua (Race Condition):** Hàm `booking_replace_hold` khóa dòng sân bằng câu lệnh `SELECT ... FOR UPDATE` trên bảng `courts`, đảm bảo 2 request đến cùng mili-giây sẽ được tuần tự hóa và bắt trigger `CONFLICT_SLOT (23P01)`.
  * **Trạng thái giữ chỗ (Hold State):** Ô sân được giữ bằng một dòng `occupancies` có `kind = 'hold'` và cột `hold_until = NOW() + 5 phút`. Không dùng bộ đếm RAM, tiến trình sweeper chạy nền định kỳ quét sạch.

---

#### B. Hướng dẫn thao tác & Lời thoại kịch bản F1 (Cổng vào & Nhân sự)

##### Kịch bản F1-A: Đăng ký thành viên & Xác thực OTP
* **Mục tiêu:** Chứng minh validation chặt chẽ, bảo mật OTP và nguyên tắc SĐT duy nhất.
* **Chuẩn bị:** Chọn 1 số điện thoại mới toanh chưa có trong DB (ví dụ: `0988111222`).
* **Thao tác từng click:**
  1. Mở trang `/register`.
  2. Nhập họ tên "Nguyễn Văn Thử", nhập số `0988111222`, mật khẩu nhập ngắn `123`, không tích checkbox Điều khoản. Bấm nút "Đăng ký".
  3. *Phải thấy:* Form chặn lại với cảnh báo đỏ yêu cầu mật khẩu trên 8 ký tự và phải đồng ý điều khoản.
  4. Sửa mật khẩu thành `MatKhau123!`, tích chọn Điều khoản. Bấm "Đăng ký".
  5. *Phải thấy:* Chuyển sang màn nhập OTP. Mã OTP 6 số hiện trên màn hình (môi trường dev/demo hiển thị trực tiếp).
  6. Nhập đúng mã OTP -> Bấm xác nhận -> *Phải thấy:* Chuyển thẳng vào `/app` với vai trò Hội viên mới.
  7. Đăng xuất, quay lại `/register`, nhập lại đúng số `0988111222` để đăng ký lần nữa -> *Phải thấy:* Bị từ chối ngay: "Số điện thoại đã tồn tại".
* **Lời thoại người demo (Hiếu - Nói trước khi bấm):**
  > *"Em xin mở đầu bằng luồng xác thực F1. Trước tiên em kiểm thử các ràng buộc bảo mật: mật khẩu ngắn và chưa tích điều khoản sẽ bị chặn ngay tại Client và Server. Khi nhập đúng, hệ thống yêu cầu OTP 2 lớp. Do môi trường thử nghiệm chưa nối SMS Brandname, mã OTP được giả lập hiển thị trực tiếp. Sau khi xác thực đúng, phiên làm việc được cấp token SHA-256 thời hạn 7 ngày. Cuối cùng, em chứng minh nguyên tắc BR-01: một số điện thoại tuyệt đối không thể tạo tài khoản thứ hai."*
* **Chú thích kỹ thuật (Under the hood):**
  * Database dùng Unique Constraint trên cột `phone` của bảng `users`.
  * Token phiên lưu ở bảng `sessions_auth` dưới dạng băm **SHA-256**, không lưu raw token, ngăn ngừa lộ lọt nếu bị dump DB.
* **Bẫy thao tác cần tránh:** Không dùng các số mẫu có sẵn (`0901230101` của Nam) để đăng ký vì sẽ dính lỗi đã tồn tại ngay từ bước 1.

##### Kịch bản F1-B: Đăng nhập phân quyền 4 vai trò (RBAC)
* **Mục tiêu:** Chứng minh kiến trúc phân quyền dựa trên vai trò, mỗi vai trò điều hướng về đúng trang làm việc độc lập.
* **Thao tác:** Bấm lần lượt 4 thẻ tài khoản demo trên trang `/login`:
  1. Quản lý `0900000001` -> Vào `/manager` (Thấy menu Quản trị, Báo cáo, Cấu hình).
  2. Lễ tân `0900000002` -> Vào `/desk` (Thấy sơ đồ sân, ca trực, quầy thu; không thấy báo cáo tài chính cấp quản lý).
  3. HLV Khoa `0901110011` -> Vào `/coach` (Thấy lịch dạy, sổ điểm danh, giáo án).
  4. Hội viên Nam `0901230101` -> Vào `/app` (Giao diện mobile-first đặt sân, xem gói tập).
* **Lời thoại người demo (Hiếu):**
  > *"Hệ thống áp dụng cơ chế phân quyền độc quyền (exclusive roles). Khi đăng nhập, hàm `homeFor(role)` tự động điều hướng về màn hình nghiệp vụ chuẩn. Các URL của vai trò khác bị chặn hoàn toàn ở tầng Server qua middleware `requireRole`, không chỉ ẩn giao diện đơn thuần."*

##### Kịch bản F1-C: Quên mật khẩu không lộ số điện thoại (Privacy-safe Reset)
* **Thao tác:** Mở `/forgot`.
  1. Nhập số của Nam `0901230101` -> Hệ thống báo: "Nếu số điện thoại tồn tại, mã khôi phục đã được gửi" và chuyển sang bước OTP.
  2. Nhập số hoàn toàn không tồn tại `0999999999` -> Hệ thống trả về **cùng một thông điệp như trên**, không báo "Số này chưa đăng ký".
* **Chú thích kỹ thuật:** Ngăn chặn hình thức tấn công User Enumeration (dò quét danh sách khách hàng của đối thủ).

##### Kịch bản F1-D: Nhân sự mới bắt buộc đổi mật khẩu tạm
* **Thao tác:**
  1. Vào `/manager/staff`, tạo nhân viên lễ tân mới với số `0908888777`. Hệ thống sinh mật khẩu tạm ngẫu nhiên.
  2. Đăng xuất, dùng số `0908888777` đăng nhập bằng mật khẩu tạm.
  3. *Phải thấy:* Màn hình chặn ngay tại `/account`, bắt buộc đổi mật khẩu mới trước khi cho phép vào quầy `/desk`.
  4. Đăng nhập lại tài khoản Quản lý, thử bấm nút "Khóa tài khoản" vào chính tài khoản Quản lý đang đăng nhập -> *Phải thấy:* Bị từ chối (Tránh tự khóa mất quyền).
  5. Mở `/manager/audit` -> *Phải thấy:* Dòng sự kiện tạo nhân sự mới được ghi vết bất biến (immutable), không có nút xóa.

##### Kịch bản F1-E: Vòng đời gói tập (Subscription Lifecycle)
* **Thao tác:**
  1. Nam vào `/app/plans`, chọn gói "Cầu lông 30 ngày". Gói rơi vào trạng thái `Chờ thanh toán` (Chưa được dùng quyền lợi).
  2. Lễ tân (Sử) thu tiền -> Gói chuyển sang `Đang kích hoạt`.
  3. Quản lý vào `/manager/plans` bấm "Ngừng bán" gói đó -> Khách mới không mua thêm được, người đang giữ gói cũ vẫn dùng đến hết hạn.
  4. Quản lý bấm "Đóng băng" gói của Nam -> Trong thời gian đóng băng, Nam không thể mua thêm gói mới và thời hạn gói được tạm ngưng.

---

#### C. Hướng dẫn thao tác & Lời thoại kịch bản F7 (Lịch sân & Chống bán trùng)

##### Kịch bản F7-F: Hai máy tranh chấp một giờ sân (Concurrency Battle) — *MỤC ĐINH CỦA BUỔI DEMO*
* **Mục tiêu:** Chứng minh hệ thống không bao giờ bị bán trùng sân (Double Booking) khi hai khách cùng bấm giữ một ô sân tại cùng một thời điểm.
* **Chuẩn bị:** Mở 2 cửa sổ cạnh nhau trên màn hình:
  * Bên trái: Nam (`/app/book`).
  * Bên phải (Ẩn danh): Linh (`/app/book`).
  * Cùng chọn ngày mai, môn Cầu lông, Sân H, khung giờ 19:00 - 20:00. Cả hai đều thấy ô màu xanh (Trống).
* **Thao tác từng click:**
  1. Nam bấm "Giữ chỗ" trước 1 giây.
  2. *Phải thấy bên Nam:* Ô chuyển sang trạng thái "Đang giữ chỗ" kèm đồng hồ đếm ngược 5:00 phút.
  3. Ngay lập tức bên Linh bấm "Giữ chỗ" vào chính ô đó.
  4. *Phải thấy bên Linh:* Hiện thông báo từ chối (Slot đã có người giữ). Linh không có booking mới, giữ chỗ của Nam vẫn an toàn.
* **Lời thoại người demo (Hiếu - Nói trước khi bấm):**
  > *"Thưa thầy cô, đây là bài toán cốt lõi của trung tâm thể thao: chống bán trùng sân khi tải cao. Em đang mô phỏng Nam và Linh cùng nhắm vào Sân H lúc 19h. Khi Nam bấm giữ chỗ, backend thực hiện câu lệnh `SELECT ... FOR UPDATE` trên bảng `courts` và ghi một bản ghi vào bảng `occupancies`. Ngay khoảnh khắc sau đó Linh bấm, transaction của Linh gặp xung đột và bị trigger `CONFLICT_SLOT` từ chối ngay lập tức. Sân H thuộc về Nam trọn vẹn trong 5 phút."*
* **Chú thích kỹ thuật (Under the hood):**
  * PostgreSQL trigger kiểm tra chồng lấn thời gian qua khoảng timestamp `[start_at, end_at)`.
  * Lock `FOR UPDATE` tuần tự hóa các yêu cầu đồng thời vào cùng một sân, triệt tiêu race condition.

##### Kịch bản F7-G: Hết hạn giữ chỗ thì tự động nhả sân (Hold Expiry)
* **Thao tác:**
  1. Nam giữ một ô sân nhưng không thanh toán.
  2. Quan sát đồng hồ đếm ngược: Nếu hết 5 phút hoặc khi scheduler chạy `expireHolds`, ô sân tự động chuyển về trạng thái Trống.
  3. Linh tải lại trang `/app/book` và có thể giữ lại chính ô sân đó bình thường.
* **Chú thích kỹ thuật:** Trạng thái giữ chỗ được ghi trong DB với `hold_until = NOW() + 5 phút`. Không duy trì connection giữ chỗ trong RAM.

##### Kịch bản F7-H: Đổi giờ sân nguyên tử (Atomic Reschedule Rollback)
* **Thao tác:**
  1. Nam đang giữ Sân X. Linh đang giữ Sân Y.
  2. Nam chọn chức năng "Đổi giờ sân" và cố tình chọn sang Sân Y của Linh.
  3. *Phải thấy:* Bị từ chối. Sân X của Nam vẫn còn nguyên, Sân Y của Linh vẫn an toàn. Transaction được rollback toàn bộ.

##### Kịch bản F7-I: Khách vãng lai (Walk-in) & Ràng buộc hủy sân
* **Thao tác:**
  1. Tại `/desk/courts`, khách vãng lai đến quầy. Lễ tân chọn 1 ô sân còn trống trên 20 phút, nhập tên và số điện thoại bất kỳ (không cần tạo tài khoản hệ thống), chọn thu tiền mặt -> *Phải thấy:* Sân được xác nhận thành công.
  2. Thử chọn 1 ô sân đã bắt đầu chạy quá 20 phút -> *Phải thấy:* Bị từ chối bán (ngăn chặn bán gian lận giờ đã trôi qua).
  3. Nam vào `/app`, hủy một booking trước giờ chơi 3 tiếng (lớn hơn mốc 2 tiếng quy định) -> *Phải thấy:* Hủy thành công, sân trở lại trạng thái trống, phát sinh yêu cầu hoàn tiền cho Sử xử lý.
  4. Nam thử đổi một sân đã thanh toán sang một khung giờ có giá cao hơn -> *Phải thấy:* Bị từ chối, yêu cầu thanh toán chênh lệch tại quầy.

##### Kịch bản F7-J: Mượn trả dụng cụ & Đặt lịch cố định (Series Booking)
* **Thao tác:**
  1. Tại `/desk/gear`, lễ tân cho Nam mượn 1 vợt cầu lông -> Số lượng tồn kho giảm 1. Lễ tân bấm nhận trả vợt -> Tồn kho tăng lại 1. Bấm nút trả lần thứ 2 -> *Phải thấy:* Bị từ chối vì dụng cụ đã trả xong.
  2. Tại `/desk/series`, lễ tân đặt lịch cố định cho khách 4 tuần liên tiếp vào thứ Năm 18h. Trong đó tuần thứ 2 đã có người đặt trước.
  3. Bấm "Kiểm tra lịch" -> *Phải thấy:* Tuần 1, 3, 4 đặt thành công; Tuần 2 bị bỏ qua do trùng lịch. Hệ thống chỉ tính tiền 3 tuần, không tự ý nhảy sang sân khác.

---

#### D. Bộ câu hỏi phản biện & Phương án trả lời (Dành cho Hiếu)
* **Câu hỏi 1 (Giảng viên):** *"Tại sao hệ thống của em không lưu trực tiếp vào bảng `court_bookings` mà phải đẻ ra bảng trung gian `occupancies`?"*
  * **Hiếu trả lời:** *"Dạ thưa thầy, trên một sân thể thao thực tế có tới 4 loại hoạt động cùng chiếm dụng mặt sân: Đặt sân lẻ của khách, Lớp học định kỳ, Lịch bảo trì kỹ thuật, và Giữ chỗ chờ thanh toán. Nếu mỗi loại lưu một bảng riêng thì câu truy vấn kiểm tra sân trống sẽ phải JOIN 4 bảng, rất chậm và cực kỳ dễ sinh lỗi lọt lịch khi mở rộng tính năng mới. Bằng cách quy về một bảng duy nhất là `occupancies`, việc kiểm tra sân trống chỉ là một câu lệnh `SELECT` duy nhất trên một bảng, đảm bảo tính toàn vẹn tuyệt đối."*
* **Câu hỏi 2 (Giảng viên):** *"Nếu hai người cùng bấm đặt sân cùng một mili-giây thì ở mức database xử lý thế nào để không bị race condition?"*
  * **Hiếu trả lời:** *"Dạ, hệ thống sử dụng cơ chế khóa bi quan (pessimistic locking) bằng `SELECT ... FOR UPDATE` trên dòng của sân đó trong bảng `courts`. Nhờ đó hai transaction bắt buộc phải xếp hàng tuần tự. Người đến trước sẽ ghi thành công dòng `occupancies`, người đến sau khi đọc dữ liệu đã commit sẽ thấy sân không còn trống và kích hoạt trigger `CONFLICT_SLOT` trả về mã lỗi 23P01."*

---

### PHẦN 2: SỬ — F3 (Sổ cái Tiền tệ, Ca Thu ngân, Hóa đơn & Báo cáo)

#### A. Trách nhiệm kỹ thuật & Business Rules (BR)
* **File phụ trách:** `src/lib/arena3/handlers/desk.ts`, `online.ts`, `promos.ts`, `reports.ts`, `pdf.ts`, `payos.ts`, `extras.ts` (điểm thưởng, hoa hồng, xuất hóa đơn).
* **Quy tắc cốt lõi:**
  * **Mở ca trước khi thu:** Lễ tân không thể thu tiền nếu chưa mở ca trực (`till_shifts`). Tiền thu vào gắn chặt với `shift_id` của nhân viên đó.
  * **Nguyên tắc "Chuyển khoản là lời hứa":** Khi khách chọn chuyển khoản, hệ thống **tuyệt đối không tạo bản ghi thanh toán** (không tạo row `payments` với status pending). Khoản tiền chỉ là lời hứa ghi nhận trên booking. Khi nào lễ tân đối soát thấy tiền nổi trên tài khoản ngân hàng và bấm "Xác nhận" thì mới gọi `settleHeldBooking` để tạo phiếu thu `posted`.
  * **Tính lũy kế & Idempotency:** Bấm nút thanh toán 2 lần liên tiếp không bao giờ sinh ra 2 phiếu thu nhờ cơ chế `withIdempotency` với `idempotency_keys`.
  * **Báo cáo số chuẩn:** Số liệu báo cáo doanh thu đọc duy nhất từ bảng `payments` (`posted` trừ `refunded`). File Excel xuất ra phải định dạng cell dạng Number (tính toán được SUM), PDF tiếng Việt phải hiển thị đầy đủ dấu font Unicode.

---

#### B. Hướng dẫn thao tác & Lời thoại kịch bản F3 (Tiền tệ & Báo cáo)

##### Kịch bản F3-A: Ràng buộc mở ca thu ngân
* **Mục tiêu:** Không có ca trực thì không được chạm vào dòng tiền.
* **Thao tác:**
  1. Vào `/desk`, nếu đang có ca mở thì bấm "Chốt ca" để đưa quầy về trạng thái đóng.
  2. Thử thực hiện thu tiền cho một giữ chỗ bất kỳ -> *Phải thấy:* Bị từ chối: "Vui lòng mở ca làm việc trước khi thực hiện giao dịch".
  3. Lễ tân bấm "Mở ca", nhập số tiền mặt đầu ca (ví dụ: `500.000đ`). *Phải thấy:* Ca trực mở thành công, gắn đúng ID của lễ tân đó.
* **Lời thoại người demo (Sử - Nói trước khi bấm):**
  > *"Em xin phép trình bày phân hệ F3 - Quản lý tài chính và dòng tiền. Nguyên tắc đầu tiên của quầy thu ngân là tính trách nhiệm cá nhân: Lễ tân bắt buộc phải mở ca làm việc và khai báo tiền mặt đầu ca. Mọi giao dịch thu chi trong ca đều gắn chặt với định danh của nhân viên trực quầy."*

##### Kịch bản F3-B: Thanh toán tiền mặt nguyên tử & Xuất hóa đơn PDF
* **Mục tiêu:** Một lần bấm sinh đúng một phiếu thu, một hóa đơn, chuyển trạng thái sân và cho phép in hóa đơn PDF tiếng Việt.
* **Thao tác:**
  1. Lễ tân chọn giữ chỗ của Nam (vừa tạo ở phần F7 của Hiếu).
  2. Chọn phương thức "Tiền mặt", bấm "Xác nhận thanh toán".
  3. *Phải thấy:* Đúng 1 phiếu thu được tạo (`status = posted`), booking chuyển sang `confirmed`, hóa đơn điện tử nội bộ được cấp mã.
  4. Lễ tân cố tình bấm lại nút thu tiền lần thứ hai -> *Phải thấy:* Hệ thống chặn lại, không sinh thêm phiếu thứ hai.
  5. Nam vào `/account` -> Tab "Biên lai", mở file PDF hóa đơn -> *Phải thấy:* File hiển thị đầy đủ logo trung tâm, mã phiếu, số tiền, ngày giờ và tiếng Việt có dấu chuẩn UTF-8.

##### Kịch bản F3-C: Đối soát chuyển khoản thủ công (Transfer Verification)
* **Thao tác:**
  1. Nam đặt 1 ô sân mới, chọn phương thức "Chuyển khoản ngân hàng".
  2. Màn hình của Nam hiện thông tin STK và mã nội dung chuyển khoản. Trạng thái sân vẫn là `hold`, trong database chưa hề có dòng tiền nào ở bảng `payments`.
  3. Lễ tân mở `/desk/payments`, thấy giao dịch chờ đối soát của Nam. Lễ tân kiểm tra tài khoản và bấm "Xác nhận đã nhận tiền".
  4. *Phải thấy:* Giao dịch mới chính thức ghi nhận vào sổ cái `payments` và sân chuyển sang `confirmed`.
  5. Thử đối soát một giao dịch chuyển khoản mà khách để quá hạn 2 tiếng -> *Phải thấy:* Bị từ chối đối soát vì slot đã hết hạn.

##### Kịch bản F3-D: Cổng thanh toán trực tuyến payOS & Webhook an toàn
* **Thao tác:**
  1. Lễ tân hoặc khách tạo link thanh toán QR qua payOS. Bấm lần hai vẫn ra đúng link cũ.
  2. Mở thử trang `/pay/return` khi chưa thực hiện quét mã thanh toán -> *Phải thấy:* Màn hình không ghi nhận thanh toán thành công, không có phiếu posted nào sinh ra.
* **Chú thích kỹ thuật:** Hệ thống không tin cậy tham số URL từ trang return phía Client. Chỉ khi Webhook của payOS gửi kèm chữ ký số HMAC-SHA256 hợp lệ hoặc tiến trình Server polling kiểm tra trạng thái PAID từ payOS API thì hệ thống mới gọi `settleHeldBooking`.

##### Kịch bản F3-E: Quy trình hoàn tiền có kiểm soát & Mã giảm giá một lần
* **Thao tác:**
  1. Lễ tân thực hiện hoàn tiền cho một phiếu dưới 1.000.000đ -> *Phải thấy:* Hoàn tiền thành công ngay lập tức. Thử bấm hoàn lần 2 -> Bị từ chối.
  2. Lễ tân thực hiện hoàn tiền cho khoản trên 1.000.000đ (ví dụ hủy gói tập 1.500.000đ) -> *Phải thấy:* Phiếu rơi vào trạng thái "Chờ duyệt". Quản lý vào `/manager` phê duyệt thì tiền mới được hoàn, phát sinh bản ghi trong `audit_logs`.
  3. Quản lý tạo mã khuyến mãi 1 lượt (ví dụ `ARENA50`). Nam nhập mã vào đơn đặt sân nhưng sau đó hủy đơn trước khi thanh toán -> *Phải thấy:* Lượt sử dụng mã được hoàn trả về 1.
  4. Lễ tân thu tiền thành công đơn của Nam có dùng mã `ARENA50` -> *Phải thấy:* Lượt sử dụng về 0. Người thứ hai (Linh) nhập mã này sẽ bị từ chối ngay.

##### Kịch bản F3-F: Báo cáo tài chính & Đối soát sổ cái
* **Thao tác:**
  1. Đăng nhập Quản lý, vào `/manager` -> Tab "Báo cáo doanh thu".
  2. Chọn đúng ngày vừa demo, kiểm tra các con số: Tổng thu - Tổng hoàn = Doanh thu thực. Con số khớp 100% với danh sách phiếu thu `posted` trong ngày.
  3. Bấm "Xuất Excel" và "Xuất PDF". Mở file Excel: Các cột số tiền là kiểu số (Number) có thể tính toán hàm `=SUM()`, không phải dạng chuỗi văn bản (String).
  4. Đăng nhập HLV Khoa, thử truy cập `/manager` hoặc xuất báo cáo tài chính -> *Phải thấy:* Bị chặn 403 Forbidden ngay lập tức.

---

#### C. Bộ câu hỏi phản biện & Phương án trả lời (Dành cho Sử)
* **Câu hỏi 1 (Giảng viên):** *"Tại sao khi khách chọn chuyển khoản ngân hàng, em không tạo luôn một dòng payment với trạng thái `pending` trong database cho tiện theo dõi?"*
  * **Sử trả lời:** *"Dạ thưa thầy, thiết kế này xuất phát từ nguyên tắc kế toán: Tiền chưa về tài khoản thì chưa phải là tài sản. Nếu tạo dòng `pending` trong bảng `payments`, các câu truy vấn tính tổng doanh thu, các khoản cần thu của hội viên và thuế sẽ rất dễ bị tính nhầm nếu lập trình viên sơ suất quên mệnh đề `WHERE status = 'posted'`. Vì vậy hệ thống coi chuyển khoản chỉ là một 'lời hứa' gắn trên booking. Bảng `payments` của trung tâm là sổ cái sạch, chỉ ghi nhận những giao dịch tiền thật đã được xác minh."*
* **Câu hỏi 2 (Giảng viên):** *"Nếu khách quét mã thanh toán payOS thành công nhưng mạng bị rớt, webhook và trình duyệt cùng gọi về máy chủ một lúc thì có bị cộng tiền 2 lần không?"*
  * **Sử trả lời:** *"Dạ hoàn toàn không thể bị trùng. Cả hai luồng webhook và polling đều phải đi qua hàm `settleHeldBooking` được bọc bởi wrapper `withIdempotency` với khóa duy nhất là mã đơn hàng. Nếu transaction đầu tiên đã xử lý và ghi nhận, transaction thứ hai đến sẽ trả về ngay kết quả đã lưu mà không thực thi lại logic trừ tiền."*

---

### PHẦN 3: TOÀN — F2 (Quản lý Lớp học, Lịch học & Danh sách chờ)

#### A. Trách nhiệm kỹ thuật & Business Rules (BR)
* **File phụ trách:** `src/lib/arena3/handlers/classes.ts`, `rrule.ts`, `ops.ts` (`waitlistAccept`, `inviteWaitlist`).
* **Jobs nền:** `generateSessions` (sinh các buổi học tương lai theo quy tắc rrule), `waitlistExpire` (quá hạn giữ suất chờ thì chuyển cho người tiếp theo).
* **Ranh giới dữ liệu:**
  * Toàn **không tự tạo sân**: Để mở lớp, Toàn phải gọi hàm kiểm tra và chiếm sân từ phân hệ F7 của Hiếu.
  * Toàn **không sửa sổ điểm danh**: Việc điểm danh sau khi lớp diễn ra thuộc quyền của Tân (F4).
  * Kiểm tra điều kiện ghi danh: Học viên phải có gói tập còn hạn và đúng bộ môn (đọc quyền từ F1 của Hiếu).

---

#### B. Hướng dẫn thao tác & Lời thoại kịch bản F2 (Lớp học & Danh sách chờ)

##### Kịch bản F2-A: Xuất bản lớp học & Chặn xung đột sân với lịch đặt của khách
* **Mục tiêu:** Chứng minh lớp học và lịch thuê sân của khách dùng chung một không gian lịch, không thể đè lên nhau.
* **Chuẩn bị:** Cần Sân T (đang trống) và Sân H (đã có Nam đặt ở phần F7 của Hiếu).
* **Thao tác:**
  1. Quản lý vào `/manager/classes`, tạo lớp "Cầu lông Cơ bản", chọn Sân T, khung giờ 08:00 - 09:30 thứ Bảy hàng tuần, sĩ số tối đa 2 học viên, phân công HLV Khoa. Bấm "Xuất bản".
  2. *Phải thấy:* Lớp mở thành công. HLV Khoa đăng nhập `/coach` thấy lịch dạy mới; Nam vào `/app/classes` thấy lớp mở để đăng ký.
  3. Quản lý tiếp tục tạo lớp thứ hai, nhưng cố tình chọn Sân H vào đúng khung 19:00 - 20:00 ngày mai (giờ Nam đã đặt sân) -> Bấm "Xuất bản".
  4. *Phải thấy:* Bị từ chối ngay lập tức: "Sân đã có người đặt trong khung giờ này". Booking của Nam được bảo toàn 100%.
* **Lời thoại người demo (Toàn - Nói trước khi bấm):**
  > *"Em xin tiếp nối phần trình bày với phân hệ F2 - Quản lý lớp học. Điểm đặc biệt của Arena3 là lớp học không hoạt động độc lập mà chia sẻ chung tài nguyên sân bãi với khách thuê lẻ. Khi em tạo lớp trên Sân T còn trống, hệ thống tự động sinh các buổi học và gán HLV. Nhưng khi em cố tình tạo lớp đè lên Sân H mà bạn Nam đã đặt trước đó, backend lập tức từ chối và bảo vệ quyền lợi của khách đặt lẻ."*

##### Kịch bản F2-B: Ràng buộc ghi danh (Đúng gói, không ghi danh đúp)
* **Thao tác:**
  1. Nam (đang có gói Cầu lông còn hạn) vào `/app/classes`, bấm "Ghi danh" vào lớp vừa mở -> *Phải thấy:* Ghi danh thành công, sĩ số lớp tăng từ 0 lên 1/2.
  2. Nam bấm nút "Ghi danh" một lần nữa -> *Phải thấy:* Bị từ chối, sĩ số không đổi.
  3. Đăng nhập bằng tài khoản Hà (`0901230106` - tài khoản có gói đã hết hạn), cố tình bấm "Ghi danh" vào lớp này -> *Phải thấy:* Bị từ chối ngay: "Gói tập không hợp lệ hoặc đã hết hạn".

##### Kịch bản F2-C: Danh sách chờ tự động (Waitlist Queue & Auto-promote) — *ĐIỂM SÁNG NGHỆP VỤ*
* **Mục tiêu:** Chứng minh khi lớp đầy, học viên mới sẽ vào danh sách chờ và tự động nhận lời mời khi có người hủy chỗ.
* **Thao tác:**
  1. Dùng tài khoản Linh vào ghi danh -> *Phải thấy:* Lớp đạt sĩ số tối đa 2/2 (Nam và Linh).
  2. Dùng tài khoản thứ ba (học viên khác) bấm ghi danh -> *Phải thấy:* Hệ thống thông báo lớp đã đầy và hỏi có muốn vào Danh sách chờ không. Học viên đồng ý -> Nhận vị trí Chờ số 1.
  3. Nam (trước giờ học trên 4 tiếng) bấm "Hủy ghi danh" -> *Phải thấy:* Sĩ số lớp trống 1 chỗ.
  4. *Phải thấy:* Hệ thống tự động gửi lời mời (`inviteWaitlist`) cho học viên chờ số 1 kèm thời hạn giữ chỗ 2 tiếng. Người ngoài không thể chen ngang vào cướp suất này.

##### Kịch bản F2-D: Vòng đời buổi học (Hủy buổi, Dời lịch, Thay HLV)
* **Thao tác:**
  1. Quản lý vào hủy một buổi học do thời tiết xấu, nhập lý do "Bảo trì đột xuất" -> *Phải thấy:* Buổi học biến mất khỏi lịch, Nam và HLV nhận được thông báo, học viên dùng gói theo buổi được tự động hoàn trả 1 buổi. Quản lý thử bấm hủy lần nữa -> Bị từ chối.
  2. Quản lý dời lịch một buổi học khi còn dưới 12 giờ nhưng bỏ trống ô lý do -> *Phải thấy:* Bị từ chối, bắt buộc phải nhập lý do giải trình.
  3. Quản lý dời lịch buổi học vào khung giờ mà HLV Khoa đang bận dạy ở một lớp khác, hoặc đổi sang HLV không có chuyên môn Cầu lông -> *Phải thấy:* Hệ thống kiểm tra xung đột và từ chối.

---

#### C. Bộ câu hỏi phản biện & Phương án trả lời (Dành cho Toàn)
* **Câu hỏi 1 (Giảng viên):** *"Làm thế nào để hệ thống sinh ra lịch học cho cả tháng mà không bị lag máy chủ?"*
  * **Toàn trả lời:** *"Dạ thưa thầy, hệ thống sử dụng chuẩn quy tắc lặp `rrule` kết hợp với background job `generateSessions`. Khi quản lý xuất bản lớp, hệ thống chỉ tính toán và sinh lịch trước cho một khoảng thời gian nhất định (ví dụ 4 tuần). Định kỳ hàng tuần job scheduler sẽ tự động chạy quét để sinh tiếp các tuần tiếp theo, giúp tải máy chủ phân bổ đều và dữ liệu luôn nhẹ nhàng."*
* **Câu hỏi 2 (Giảng viên):** *"Nếu một học viên hủy lớp thì người trong danh sách chờ có bị tự động trừ tiền/trừ buổi ngay không?"*
  * **Toàn trả lời:** *"Dạ không ạ. Hệ thống không tự ý trừ quyền lợi của học viên trong waitlist mà gửi một thông báo kèm lời mời nhận suất có thời hạn (ví dụ 2 giờ). Học viên có quyền bấm 'Chấp nhận' hoặc 'Từ chối'. Nếu quá thời hạn mà học viên không phản hồi, job `waitlistExpire` sẽ chuyển lượt cho người tiếp theo trong hàng đợi."*

---

### PHẦN 4: TÂN — F4 (Điểm danh, Giáo án, Cổng kiểm soát & Tích hợp F5)

#### A. Trách nhiệm kỹ thuật & Business Rules (BR)
* **File phụ trách:** `src/lib/arena3/handlers/training.ts`, `attendance.ts`, `checkin.ts`, `ops.ts` (điểm danh, gợi ý bài tập).
* **Job nền:** `lockAttendance` (tự động khóa sổ điểm danh sau 2 giờ kể từ khi buổi học kết thúc - BR-53).
* **Nguyên tắc phân biệt Cổng vs Lớp:**
  * **Quét cổng (`/desk/gate`):** Chỉ xác nhận hội viên bước chân qua cửa trung tâm thể thao (`gate_visits`). **Tuyệt đối không tự động đánh dấu "Có mặt" trong lớp học**.
  * **Điểm danh lớp (`/coach/attendance`):** Phải do đích thân HLV phụ trách lớp tích chọn trong giờ học.
* **Quy tắc F5 (Gợi ý bài tập AI):** Không phải là một màn hình tách rời mà là một nút tiện ích trong luồng soạn giáo án. Bài tập do AI gợi ý chỉ là bản nháp (`draft`), bắt buộc HLV phải xem xét, chỉnh sửa và bấm duyệt (`approved`) thì học viên mới nhìn thấy.

---

#### B. Hướng dẫn thao tác & Lời thoại kịch bản F4 (Điểm danh, Cổng & Giáo án)

##### Kịch bản F4-A: Cổng kiểm soát QR động không thay thế điểm danh lớp
* **Mục tiêu:** Chứng minh cổng QR bảo mật chống chụp màn hình chia sẻ và tách bạch hoàn toàn với sổ điểm danh lớp.
* **Thao tác:**
  1. Nam mở `/app/pass` trên điện thoại. Mã QR hiển thị kèm đồng hồ đếm ngược tự động xoay mã sau mỗi 60 giây (TOTP).
  2. Lễ tân tại `/desk/gate` quét mã của Nam -> *Phải thấy:* Tên Nam, hạn gói, lịch hôm nay. Ghi nhận 1 lượt vào cổng.
  3. Thử chụp ảnh mã đó quét lại lần hai -> *Phải thấy:* Bị từ chối ngay.
  4. HLV Khoa mở `/coach/attendance` kiểm tra lớp học của Nam -> *Phải thấy:* Trạng thái của Nam vẫn là "Chưa điểm danh", chứng minh cổng không ghi hộ sổ lớp.
* **Lời thoại người demo (Tân - Nói trước khi bấm):**
  > *"Em xin trình bày phân hệ F4 - Quản lý huấn luyện và vận hành cổng. Đầu tiên là màn hình cổng kiểm soát. Mã QR của hội viên được sinh động mỗi 60 giây để chống gian lận dùng chung vé. Khi quét thành công, hệ thống chỉ ghi nhận lượt qua cổng. Như thầy cô thấy trên màn hình HLV của bạn Khoa, trạng thái của Nam trong lớp vẫn chưa có mặt. Đây là thiết kế thực tế: khách đến trung tâm uống nước hoặc khởi động chưa chắc đã vào lớp học."*

##### Kịch bản F4-B: Check-in thủ công tại quầy (Quên điện thoại)
* **Thao tác:**
  1. Khách quên điện thoại hoặc hết pin. Lễ tân tìm kiếm số `0901230101`, chọn "Check-in thủ công", bắt buộc nhập lý do "Khách hết pin" -> *Phải thấy:* Ghi nhận lượt vào cổng có lưu lý do.
  2. Thử check-in thủ công cho tài khoản Hà (gói đã hết hạn) mà không có lý do ngoại lệ được phê duyệt -> *Phải thấy:* Bị từ chối.

##### Kịch bản F4-C: Sổ điểm danh HLV & Khóa sổ sau 2 giờ (BR-53)
* **Thao tác:**
  1. HLV Khoa vào `/coach/attendance`, đánh dấu Nam: "Có mặt", học viên khác đánh "Vắng không phép". Bấm Lưu. Nam mở `/app` thấy ngay trạng thái của mình.
  2. Thử mở một buổi học đã kết thúc cách đây hơn 2 giờ để sửa đổi -> *Phải thấy:* Giao diện bị khóa cứng, HLV không thể sửa đổi (Quy tắc BR-53).
  3. Đăng nhập Quản lý, vào `/manager/attendance` mở sổ bị khóa đó -> *Phải thấy:* Quản lý có quyền sửa đổi nhưng bắt buộc phải điền ô "Lý do điều chỉnh" (ví dụ: "Đính chính do HLV nhầm lẫn"). Thao tác sửa đổi được ghi vết chi tiết vào `audit_logs`.

##### Kịch bản F4-D: Cảnh báo học viên có nguy cơ bỏ tập (At-risk Students)
* **Thao tác:**
  1. HLV Khoa đánh dấu một học viên "Vắng không phép" 3 buổi liên tiếp.
  2. Học viên này không bị xóa khỏi lớp (để bảo vệ quyền lợi hợp đồng).
  3. Lễ tân mở màn hình `/desk/at-risk` -> *Phải thấy:* Tên học viên này tự động nổi lên trong danh sách cảnh báo kèm số buổi vắng để lễ tân chủ động gọi điện chăm sóc.
  4. Nếu HLV đổi 1 trong 3 buổi thành "Vắng có phép" -> *Phải thấy:* Học viên lập tức biến mất khỏi danh sách At-risk vì chuỗi vắng liên tiếp đã bị ngắt.

##### Kịch bản F4-E: Soạn giáo án & Tích hợp gợi ý bài tập F5 (AI Draft to Approved)
* **Thao tác:**
  1. HLV Khoa vào màn hình soạn giáo án cho lớp Cầu lông.
  2. Bấm nút "Xin gợi ý bài tập (AI Assist)" -> *Phải thấy:* Hệ thống trả về bản nháp gợi ý 3 bài tập bổ trợ thể lực và kỹ thuật giao cầu.
  3. Nam mở `/app/train` kiểm tra -> *Phải thấy:* Hoàn toàn chưa thấy bài tập mới (Bản nháp đang ở trạng thái private).
  4. HLV Khoa chỉnh sửa lại số hiệp và thời gian nghỉ, sau đó bấm nút "Phê duyệt & Xuất bản giáo án".
  5. Nam tải lại `/app/train` -> *Phải thấy:* Bài tập chính thức xuất hiện kèm hướng dẫn chi tiết của HLV.

---

#### C. Bộ câu hỏi phản biện & Phương án trả lời (Dành cho Tân)
* **Câu hỏi 1 (Giảng viên):** *"Tại sao lại phải khóa sổ điểm danh sau 2 tiếng mà không cho HLV thoải mái sửa đến cuối ngày?"*
  * **Tân trả lời:** *"Dạ thưa thầy, trong vận hành trung tâm thể thao, dữ liệu điểm danh liên quan trực tiếp đến 3 việc nhạy cảm: Trừ buổi tập của khách, Tính hoa hồng dạy cho HLV, và Báo cáo an toàn người có mặt trong sân. Nếu để HLV tự do sửa điểm danh hồi tố sẽ rất dễ xảy ra gian lận thông đồng điểm danh khống để lấy hoa hồng. Vì vậy sau 2 giờ hệ thống sẽ khóa tự động (BR-53), chỉ có Quản lý mới có quyền điều chỉnh kèm lý do bắt buộc và ghi audit log."*
* **Câu hỏi 2 (Giảng viên):** *"Nếu mất kết nối internet hoặc API AI Gemini bị hết hạn ngạch (quota) thì nút gợi ý bài tập có bị sập không?"*
  * **Tân trả lời:** *"Dạ không ạ. Module gợi ý bài tập được thiết kế có tầng fallback an toàn: Nếu không gọi được Gemini API, hệ thống sẽ tự động lấy các bài tập chuẩn từ ngân hàng mẫu nội bộ (rule-based library) và hiển thị ghi chú nguồn mẫu cho HLV, đảm bảo luồng công việc của HLV không bao giờ bị gián đoạn."*

---

### PHẦN 5: PHÚC — F6 (Trợ lý Hội viên AI & Quản lý Ticket Hỗ trợ)

#### A. Trách nhiệm kỹ thuật & Business Rules (BR)
* **File phụ trách:** `src/lib/arena3/handlers/ops.ts` (các hàm `assistantChat`, `tickets`), `gemini.ts`.
* **Kênh liên lạc:** Kênh gửi thông báo đẩy (notifications) đi qua hàng đợi trung tâm của Hiếu. Phúc không tự viết cơ chế push riêng.
* **Nguyên tắc an toàn AI (Guardrails):**
  * **Xác thực ngữ cảnh:** Bot chỉ trả lời thông tin của chính người đang đăng nhập (ví dụ: ngày hết hạn gói, lịch đặt của tôi). Tuyệt đối không đọc trộm dữ liệu người khác.
  * **Không đụng chạm tiền bạc/đặt chỗ:** Bot không có quyền tự ý tạo booking hay trừ tiền trong ví. Bot chỉ hướng dẫn các bước và cung cấp đường dẫn đến màn hình thao tác.
  * **Từ chối tư vấn y tế:** Tuyệt đối không kê đơn thuốc hoặc tư vấn chữa trị chấn thương; luôn hướng dẫn hội viên gặp bác sĩ hoặc HLV chuyên môn.
  * **Escalation mượt mà:** Khi không giải đáp được hoặc hội viên có khiếu nại, bot tự động đề xuất chuyển thành Ticket gửi đến quầy lễ tân.

---

#### B. Hướng dẫn thao tác & Lời thoại kịch bản F6 (Trợ lý & Ticket)

##### Kịch bản F6-A: Trợ lý thông minh có kiểm soát ngữ cảnh (Safe AI Assistant)
* **Mục tiêu:** Chứng minh bot trả lời chuẩn xác dữ liệu riêng tư và tuân thủ tuyệt đối các ranh giới an toàn.
* **Thao tác:**
  1. Nam vào `/app/assistant`, gõ: *"Gói tập của tôi còn hạn đến ngày nào?"* -> *Phải thấy:* Bot tra cứu chính xác ngày hết hạn gói của Nam.
  2. Nam gõ tiếp: *"Bạn đặt hộ tôi sân cầu lông số 1 lúc 18h tối nay và trừ tiền luôn nhé"* -> *Phải thấy:* Bot lịch sự từ chối: *"Tôi không có thẩm quyền đặt sân hoặc trừ tiền thay bạn. Vui lòng bấm vào đây để tự chọn sân và thanh toán an toàn."*
  3. Nam gõ: *"Tôi bị đau nhói ở khớp gối sau khi đánh cầu, tôi nên uống thuốc gì?"* -> *Phải thấy:* Bot từ chối tư vấn y tế và khuyên hội viên chườm đá tạm thời và liên hệ ngay bác sĩ y khoa hoặc HLV.
* **Lời thoại người demo (Phúc - Nói trước khi bấm):**
  > *"Em xin kết thúc vòng demo cá nhân với phân hệ F6 - Trợ lý ảo hội viên và hệ thống Ticket. Trợ lý AI của Arena3 không phải là một chatbot thông thường chém gió, mà được thiết lập các rào chắn kỹ thuật (System Guardrails) nghiêm ngặt. Bot chỉ truy xuất đúng dữ liệu cá nhân của hội viên đang chat, kiên quyết từ chối can thiệp vào giao dịch tài chính để tránh lỗi mất tiền, và tuyệt đối không đưa ra lời khuyên y tế vi phạm chính sách."*

##### Kịch bản F6-B: Chuyển tiếp câu hỏi khó thành Ticket quầy & Lễ tân phản hồi
* **Mục tiêu:** Khép kín vòng đời hỗ trợ khách hàng từ chatbot đến nhân viên thật.
* **Thao tác:**
  1. Nam gõ một câu hỏi khiếu nại nằm ngoài phạm vi bot: *"Tôi muốn xin hóa đơn VAT công ty cho gói tập đã mua tuần trước thì làm thế nào?"*
  2. Bot thông báo câu hỏi cần nhân viên hỗ trợ và hỏi: *"Bạn có muốn gửi yêu cầu này đến quầy lễ tân không?"* -> Nam bấm "Đồng ý gửi Ticket".
  3. Lễ tân tại `/desk` thấy mục Ticket hỗ trợ mới xuất hiện dòng yêu cầu của Nam. Lễ tân bấm mở, nhập câu trả lời: *"Chào anh Nam, quầy lễ tân đã xuất hóa đơn điện tử cho anh, anh vui lòng kiểm tra email hoặc tải tại tab Biên lai nhé."* -> Bấm "Phản hồi & Đóng Ticket".
  4. *Phải thấy:* Màn hình của Nam nhận được thông báo đẩy, mở tab Hỗ trợ trên `/account` thấy ticket đã đóng kèm lời nhắn chi tiết từ lễ tân.
  5. Lễ tân thử đóng một ticket trùng lặp mà không cần trả lời -> *Phải thấy:* Hệ thống cho phép đóng nhưng không gửi thông báo rác cho khách.

---

#### C. Bộ câu hỏi phản biện & Phương án trả lời (Dành cho Phúc)
* **Câu hỏi 1 (Giảng viên):** *"Làm thế nào để tránh tình trạng Prompt Injection khi người dùng cố tình lừa bot thực hiện hành vi xấu?"*
  * **Phúc trả lời:** *"Dạ thưa thầy, bot được bảo vệ bằng 2 tầng: Tầng 1 là System Prompt định nghĩa chặt chẽ nhiệm vụ và từ chối các câu lệnh thay đổi vai trò (jailbreak). Tầng 2 là tầng quan trọng nhất: Backend của bot hoàn toàn KHÔNG ĐƯỢC CẤP các function calling nguy hiểm như `createPayment` hay `cancelBooking`. Cho dù bot có bị đánh lừa trong câu chữ thì nó cũng không có công cụ phần mềm nào để thao túng dữ liệu trong database."*
* **Câu hỏi 2 (Giảng viên):** *"Nếu lễ tân quên không trả lời ticket của khách thì hệ thống có cơ chế gì nhắc nhở không?"*
  * **Phúc trả lời:** *"Dạ, các ticket quá hạn chưa xử lý sẽ được đổi màu cảnh báo nổi bật trên dashboard `/desk` của lễ tân và hiển thị thống kê thời gian phản hồi trung bình trong báo cáo của Quản lý để đánh giá chất lượng phục vụ."*

---

## 3. Kịch bản Buổi Demo Chung Liên Hoàn (The Master Sequential Flow)

Quy trình phối hợp 7 bước liên tục giữa cả 5 thành viên. Chạy theo **chuỗi sự kiện nghiệp vụ thực tế**, người trước xong bước của mình thì chuyển giao rõ ràng cho người kế tiếp:

| Bước | Người phụ trách | Vai trò / Module | Hành động chi tiết | Bàn giao cho bước tiếp |
| :---: | :--- | :--- | :--- | :--- |
| **B1** | Hiếu (Trưởng nhóm) | Quản lý / F1 & F7 | Đăng nhập 4 vai trò, xác thực phân quyền RBAC độc lập | Bắt đầu tranh chấp sân |
| **B2** | Hiếu (Trưởng nhóm) | Hội viên Nam & Linh | Tạo giữ chỗ đồng thời trên cùng Sân H; Concurrency lock bảo vệ ô sân, chỉ 1 người thành công | Bàn giao giữ chỗ Sân H cho Lễ tân |
| **B3** | Sử | Lễ tân / F3 | Lễ tân mở ca trực, thu tiền mặt tại quầy, xuất hoá đơn biên lai PDF chuẩn VAT | Bàn giao Sân H (đã bán) & Sân T (trống) |
| **B4** | Toàn | Quản lý / F2 | Tạo lớp đè Sân H (bị chặn do xung đột), mở lớp Sân T, hội viên ghi danh | Bàn giao danh sách lớp học |
| **B5** | Tân | HLV Khoa / F4 & F5 | Hội viên quét mã QR qua cổng -> HLV mở sổ điểm danh, ghi nhận kết quả rèn luyện | Bàn giao hội viên hoàn thành buổi học |
| **B6** | Phúc | Hội viên & Lễ tân / F6 | Hội viên tra cứu lịch sử, gửi ticket hỗ trợ tới quầy; Lễ tân tiếp nhận và đóng ticket | Bàn giao dữ liệu chuỗi thao tác |
| **B7** | Hiếu (Trưởng nhóm) | Quản trị / Audit | Mở màn hình Audit Log đối chiếu toàn bộ vết dữ liệu liên hoàn từ B1 đến B6 | Hoàn tất buổi nghiệm thu liên hoàn |

*(Sơ đồ tuần tự chuẩn Draw.io XML lưu tại [diagrams/sequence-diagram.drawio](diagrams/sequence-diagram.drawio)).*

### Hướng dẫn chi tiết từng bước & Lời thoại chuyển giao (Handoff Cues):

#### Bước 1: Khởi động hệ thống & Phân quyền 4 vai trò
* **Người thực hiện:** Hiếu
* **Thao tác:** Mở trình duyệt, đăng nhập lần lượt Quản lý (`/manager`), Lễ tân (`/desk`), HLV Khoa (`/coach`), Nam (`/app`).
* **Lời thoại người demo:**
  > *"Kính thưa quý thầy cô, nhóm chúng em xin trình bày buổi demo liên hoàn hệ thống Arena3. Em xin bắt đầu bằng việc chứng minh kiến trúc bảo mật phân quyền 4 vai trò hoạt động độc lập: Quản lý thấy báo cáo, Lễ tân thấy quầy thu và sơ đồ sân, HLV thấy sổ lớp, và Hội viên thấy giao diện mobile."*
* **Điểm kiểm tra (Phải thấy):** Mỗi vai điều hướng vào đúng trang chủ riêng biệt, không bị lộ chức năng chéo.

#### Bước 2: Tranh chấp Sân H (Chống bán trùng Concurrency)
* **Người thực hiện:** Hiếu
* **Thao tác:** Mở 2 cửa sổ cạnh nhau (Nam và Linh), cùng chọn Sân H lúc 19:00 ngày mai. Nam bấm "Giữ chỗ" trước 1 giây. Linh bấm ngay sau đó.
* **Lời thoại người demo:**
  > *"Bây giờ là tình huống cao điểm: Nam và Linh cùng tranh chấp Sân H. Khi Nam bấm giữ chỗ, hệ thống lập tức khóa dòng sân. Linh bấm ngay sau đó nhận thông báo từ chối. Sân H thuộc về Nam trong 5 phút giữ chỗ."*
* **Điểm kiểm tra (Phải thấy):** Nam có ô đang giữ kèm đồng hồ đếm ngược 5:00; Linh bị từ chối; không bị bán trùng.
* **Câu chuyển giao (Hiếu bàn giao cho Sử):**
  > *"Hiện tại Sân H đang được Nam giữ chỗ chờ thanh toán. Em xin nhường lại quyền điều khiển cho bạn Sử để xử lý dòng tiền tại quầy thu ngân."*

#### Bước 3: Mở ca trực, Thu tiền mặt & Xuất hóa đơn PDF
* **Người thực hiện:** Sử
* **Thao tác:** Lễ tân mở ca thu ngân tại `/desk`, chọn giữ chỗ Sân H của Nam, chọn phương thức Tiền mặt, bấm "Xác nhận thanh toán". Sau đó Nam mở tab Biên lai trên `/account` xem file PDF.
* **Lời thoại người demo:**
  > *"Em là Sử, phụ trách tài chính. Đầu tiên lễ tân mở ca làm việc. Sau đó thực hiện thu tiền mặt cho giữ chỗ Sân H của Nam. Một lần bấm sinh ra đúng một phiếu thu posted và hóa đơn PDF tiếng Việt. Sân H chính thức chuyển sang trạng thái đã đặt."*
* **Điểm kiểm tra (Phải thấy):** Ô sân chuyển sang màu Đã đặt; có đúng 1 phiếu thu; file PDF mở ra có đủ dấu tiếng Việt Unicode.
* **Câu chuyển giao (Sử bàn giao cho Toàn):**
  > *"Sân H đã chính thức có chủ và dòng tiền đã được ghi sổ cái an toàn. Tiếp theo xin mời bạn Toàn demo luồng lớp học và tương tác chiếm sân."*

#### Bước 4: Mở lớp học, Chặn trùng sân & Ghi danh học viên
* **Người thực hiện:** Toàn
* **Thao tác:** Quản lý tạo lớp cố tình chọn đè lên Sân H lúc 19:00 ngày mai (bị từ chối). Sau đó tạo lớp trên Sân T còn trống, HLV Khoa dạy. Nam vào `/app/classes` bấm Ghi danh.
* **Lời thoại người demo:**
  > *"Em là Toàn phụ trách lớp học. Em thử tạo lớp đè vào Sân H mà Nam vừa mua thì hệ thống từ chối ngay lập tức. Em chuyển sang Sân T còn trống, lớp mở thành công và Nam thực hiện ghi danh chính thức bằng gói tập của mình."*
* **Điểm kiểm tra (Phải thấy):** Lớp đè bị chặn; lớp Sân T mở thành công; Nam tăng sĩ số lớp lên 1.
* **Câu chuyển giao (Toàn bàn giao cho Tân):**
  > *"Lớp học đã sẵn sàng và Nam đã ghi danh thành công. Xin mời bạn Tân thực hiện quy trình đón học viên qua cổng và điểm danh lớp."*

#### Bước 5: Quét mã QR qua cổng & Điểm danh lớp độc lập
* **Người thực hiện:** Tân
* **Thao tác:** Nam mở mã QR TOTP trên `/app/pass`, lễ tân quét tại `/desk/gate`. Sau đó HLV Khoa mở `/coach/attendance` kiểm tra sổ lớp.
* **Lời thoại người demo:**
  > *"Em là Tân. Nam đến sân mở mã QR động 60 giây để qua cổng kiểm soát. Lễ tân quét mã thành công và ghi nhận lượt qua cổng. Nhưng khi HLV Khoa mở sổ lớp, Nam vẫn ở trạng thái Chưa điểm danh. Điểm danh lớp tách biệt hoàn toàn với cổng vào."*
* **Điểm kiểm tra (Phải thấy):** Có log lượt qua cổng; sổ lớp chưa bị tích Có mặt tự động.
* **Câu chuyển giao (Tân bàn giao cho Phúc):**
  > *"Sau khi Nam hoàn thành buổi tập, Nam có một số thắc mắc cần giải đáp. Xin mời bạn Phúc tiếp quản với luồng Trợ lý AI và hỗ trợ khách hàng."*

#### Bước 6: Hỏi đáp Trợ lý AI & Tạo Ticket gửi quầy lễ tân
* **Người thực hiện:** Phúc
* **Thao tác:** Nam vào `/app/assistant` hỏi hạn gói cá nhân. Sau đó hỏi một câu khiếu nại khó -> Bot đề xuất gửi Ticket -> Nam đồng ý -> Lễ tân tại `/desk` phản hồi và đóng ticket -> Nam nhận thông báo đẩy.
* **Lời thoại người demo:**
  > *"Em là Phúc. Nam mở trợ lý ảo hỏi hạn gói tập cá nhân. Sau đó Nam gửi yêu cầu xin hóa đơn công ty. Trợ lý chuyển thành Ticket quầy. Lễ tân tại quầy tiếp nhận, phản hồi và đóng ticket thành công. Nam nhận được thông báo ngay trong ứng dụng."*
* **Điểm kiểm tra (Phải thấy):** Bot trả lời đúng hạn của Nam; Ticket đóng; Nam nhận thông báo đẩy.
* **Câu chuyển giao (Phúc bàn giao lại cho Hiếu):**
  > *"Chuỗi trải nghiệm của hội viên đã hoàn tất. Xin mời bạn Hiếu mở Nhật ký kiểm toán để tổng kết toàn bộ dữ liệu."*

#### Bước 7: Đối chiếu Nhật ký kiểm toán (Audit Logs) & Tổng kết
* **Người thực hiện:** Hiếu
* **Thao tác:** Đăng nhập Quản lý, mở trang `/manager/audit`.
* **Lời thoại người demo:**
  > *"Để tổng kết toàn bộ buổi demo, em xin mở màn hình Nhật ký kiểm toán (Audit Logs). Tất cả các hành động từ tạo nhân sự, giữ sân, thu tiền, ghi danh lớp, qua cổng đến xử lý ticket vừa rồi đều được lưu vết bất biến với đầy đủ định danh người thực hiện và mốc thời gian chính xác. Nhóm chúng em xin kết thúc phần demo và sẵn sàng lắng nghe câu hỏi từ quý thầy cô."*
* **Điểm kiểm tra (Phải thấy):** Toàn bộ chuỗi thao tác của 5 bạn đều xuất hiện đầy đủ trong Audit Log.

---

## 4. Bảng Bàn Giao Dữ Liệu & Nghiệm Thu Chéo (Internal Sign-off)

### 4.1 Ma trận bàn giao dữ liệu giữa các thành viên
| Luồng dữ liệu | Người cấp (Chủ) | Người nhận | Phương thức kết nối (Contract API/DB) | Quy tắc an toàn |
| :--- | :---: | :---: | :--- | :--- |
| **Gói chờ thu** | Hiếu | Sử | Hiếu tạo đơn chờ -> Sử gọi `activateSubscription`. | Hiếu không tự kích hoạt gói; Sử không tự sửa giá gói. |
| **Kiểm tra gói học viên** | Hiếu | Toàn | Toàn gọi kiểm tra gói còn hạn và đúng bộ môn. | Toàn chỉ đọc (Read-only), không chỉnh sửa thời hạn gói. |
| **Giữ sân thanh toán** | Hiếu | Sử | Hiếu tạo giữ chỗ -> Sử gọi `settleHeldBooking`. | Sử không tự đổi giờ sân; Hiếu không tự tạo payment. |
| **Chiếm sân cho lớp** | Hiếu | Toàn | Toàn gọi kiểm tra và gắn `occupancies` cho buổi học. | Trùng lịch sân phải bị từ chối, không được ghi đè. |
| **Dữ liệu buổi học** | Toàn | Tân | Toàn sinh buổi học -> Tân mở sổ điểm danh. | Tân không tự ý tăng giảm sĩ số lớp; Toàn không sửa điểm danh. |
| **Gợi ý bài tập AI** | Tân | Tân (Nội bộ) | Nút bấm trong form soạn giáo án -> Sinh bản nháp -> Duyệt. | Giáo án nháp không được hiển thị cho học viên. |
| **Hàng đợi thông báo** | Hiếu | Cả nhóm | Bất kỳ ai cần báo tin đều đẩy sự kiện vào `outbox`. | Hiếu là dispatcher gửi đi, các bạn không viết kênh gửi riêng. |
| **Chuyển tiếp Ticket** | Phúc | Lễ tân (Sử) | Phúc tạo ticket từ chat -> Hiện lên quầy lễ tân xử lý. | Thông báo trả lời đi qua hàng đợi trung tâm của Hiếu. |

### 4.2 Biên bản nghiệm thu chéo trước giờ bảo vệ
| STT | Nội dung nghiệm thu cốt lõi | Người thực hiện | Người ký duyệt chéo | Tiêu chí đạt (Pass Criteria) |
| :---: | :--- | :---: | :---: | :--- |
| 1 | Bốn vai vào đúng 4 trang chủ; gói chưa trả tiền không dùng được. | Hiếu | Sử | Phân quyền 403 chặt chẽ; không dùng chùa quyền lợi. |
| 2 | Hai trình duyệt cùng giữ 1 ô sân, chỉ duy nhất 1 người được giữ. | Hiếu | Sử | Bắt được trigger `CONFLICT_SLOT`, giữ chỗ an toàn 5 phút. |
| 3 | Báo cáo doanh thu cuối ngày khớp 100% với các phiếu thu posted. | Sử | Hiếu | Tổng thu - Tổng hoàn khớp số; file Excel xuất dạng Number. |
| 4 | Lớp học tạo đè lên giờ sân đã bán bị từ chối ngay lập tức. | Toàn | Hiếu | Lớp không được xuất bản; booking của khách không bị mất. |
| 5 | Quét mã qua cổng thành công không làm học viên thành "Có mặt". | Tân | Toàn | Có log cổng; sổ lớp của HLV vẫn ở trạng thái Chưa điểm danh. |
| 6 | Bài tập do AI gợi ý không tự động hiển thị cho học viên. | Tân | Phúc | Phải qua bước HLV chỉnh sửa và bấm Duyệt chính thức. |
| 7 | Trợ lý ảo từ chối đặt sân, không đụng tiền; câu khó chuyển thành ticket. | Phúc | Hiếu | Không có lỗ hổng trừ tiền tự động; ticket đóng có phản hồi. |
| 8 | Chạy trọn vẹn kịch bản liên hoàn 7 bước đúng quy trình. | Cả 5 người | Cả nhóm | Không vấp, không lỗi console trình duyệt, ăn khớp 100%. |

---

## 5. Cẩm nang Xử lý Sự cố & Kế hoạch Dự phòng (Troubleshooting Guide)

Khi đi demo trực tiếp trước hội đồng, nếu gặp sự cố kỹ thuật ngoài ý muốn, các bạn bình tĩnh áp dụng quy trình xử lý sau:

| Sự cố phát sinh | Nguyên nhân khả dĩ | Hành động xử lý ngay tại chỗ (Trong 10 giây) |
| :--- | :--- | :--- |
| **Bấm giữ sân bị báo lỗi không giữ được** | Khung giờ đó vừa bị ai đó bấm giữ thử trước hoặc dữ liệu cũ chưa dọn. | Bình tĩnh nói: *"Dạ khung giờ này vừa có khách đặt trước, em xin phép chọn sang khung giờ kế tiếp ngay bên cạnh"*. |
| **Đồng hồ đếm ngược 5 phút bị hết hạn trước khi kịp thanh toán** | Nói chuyện quá lâu lúc demo khiến giữ chỗ bị hết hạn. | Tải lại trang, bấm giữ lại ô đó trong 3 giây và thanh toán ngay. |
| **Không tải được mã QR payOS hoặc mạng chập chờn** | Chưa cấu hình API payOS hoặc mạng hội đồng bị chặn cổng. | Chuyển ngay sang kịch bản: *"Trung tâm luôn ưu tiên phương thức thanh toán tiền mặt tại quầy và chuyển khoản ngân hàng trực tiếp"*. |
| **Nút gợi ý bài tập AI (F5) quay vòng tròn quá lâu** | Mạng lag hoặc API Gemini phản hồi chậm. | Hệ thống tự động kích hoạt chế độ Fallback nội bộ lấy bài tập mẫu có sẵn sau timeout. HLV vẫn thao tác duyệt bình thường. |
| **Quên mật khẩu tài khoản demo** | Gõ nhầm mật khẩu. | Bấm ngay vào các thẻ tài khoản demo sẵn có ở góc dưới màn hình đăng nhập (chế độ demo login tự điền thông tin). |

---
*Tài liệu này được lập để làm kim chỉ nam chuẩn hóa cho toàn đội ngũ Arena3. Chúc nhóm bảo vệ thành công rực rỡ!*
