# TỔNG HỢP SƠ ĐỒ ĐẶC TẢ YÊU CẦU PHẦN MỀM (SRS DIAGRAMS)

**Dự án:** Hệ Thống Quản Lý Khu Phức Hợp Thể Thao ARENA 3  
**Phiên bản SRS:** v2.4 (Cập nhật chuẩn hoá quy chuẩn Draw.io XML)  
**Quy chuẩn sơ đồ:** Tuân thủ chuẩn Draw.io XML (Lưu trữ độc lập tại `docs/diagrams/` và `docs/diagrams/srs/`)

---

## 1. Biểu đồ Use Case Tổng Thể (Use Case Diagram)

### 1.1 Danh sách Tác nhân (Actors)
- **Khách vãng lai (Guest)**: Người dùng chưa có tài khoản, tìm hiểu dịch vụ, xem sân, đăng ký.
- **Hội viên (Member)**: Khách hàng đã đăng ký tài khoản thành viên.
- **Lễ tân (Receptionist)**: Nhân viên quầy đón tiếp, bán gói, thu tiền, check-in.
- **Huấn luyện viên (Coach)**: Nhân sự phụ trách lớp học, điểm danh, đánh giá tiến độ học viên.
- **Quản lý (Manager)**: Quản trị viên trung tâm, cấu hình giá, nhân sự, duyệt hoàn tiền, báo cáo.
- **Trợ lý AI (AI Assistant)**: Hệ thống AI tư vấn thông minh, phân tích dữ liệu.
- **Hệ thống Email (Mail System)**: Hệ thống bên ngoài cung cấp dịch vụ gửi email OTP, thông báo và hóa đơn.
- **Tiến trình lập lịch (Scheduler)**: Dịch vụ nền tự động hóa (giải phóng giữ chỗ, no-show, sinh ca lớp).

### 1.2 Bảng phân rã Use Case theo Phân hệ

> **Quy chuẩn lưu trữ:** Toàn bộ sơ đồ Use Case được thiết kế chuẩn Draw.io XML và kiểm tra tự động qua script `check-drawio.mjs`:
> - Sơ đồ Use Case tổng thể: [diagrams/use-case-diagram.drawio](diagrams/use-case-diagram.drawio)
> - Sơ đồ phân rã từng phân hệ: `docs/diagrams/srs/03-uc-account.drawio` đến `10-uc-manager-oversight.drawio`.

| Nhóm chức năng | Tác nhân chính (Actors) | Danh sách Use Cases cốt lõi | Sơ đồ Draw.io tương ứng |
| :--- | :--- | :--- | :--- |
| **Xác thực & Tài khoản** | Khách vãng lai, Hội viên, Nhân sự | UC-01 (Đăng ký), UC-02 (OTP), UC-03 (Đăng nhập/Đổi mật khẩu) | `docs/diagrams/srs/03-uc-account.drawio` |
| **Đặt sân & Lịch thi đấu** | Hội viên, Khách walk-in, Lễ tân | UC-04 (Đặt sân), UC-05 (Thanh toán cọc/chuyển khoản), UC-06 (Huỷ/Dời lịch) | `docs/diagrams/srs/04-uc-member-booking.drawio` |
| **Gói tập & Lớp huấn luyện** | Hội viên, HLV | UC-07 (Mua gói), UC-08 (Ghi danh lớp), UC-09 (Waitlist giữ chỗ) | `docs/diagrams/srs/05-uc-member-classes.drawio` |
| **Nghiệp vụ Quầy Lễ tân** | Lễ tân | UC-15 (Check-in cổng QR), UC-16 (Bán gói), UC-17 (Thu tiền & Hoá đơn), UC-18 (Ca trực két) | `docs/diagrams/srs/06-uc-desk-sales.drawio` |
| **Vận hành & Tiện ích quầy** | Lễ tân | UC-19 (Cho thuê vợt/dụng cụ), UC-20 (Lost & Found) | `docs/diagrams/srs/07-uc-desk-operations.drawio` |
| **Sổ Huấn luyện viên** | Huấn luyện viên | UC-21 (Lịch dạy), UC-22 (Điểm danh), UC-24 (Đánh giá & Bài tập) | `docs/diagrams/srs/08-uc-coach.drawio` |
| **Quản trị & Cấu hình** | Quản lý | UC-25 (Bảng giá), UC-26 (Nhân sự), UC-27 (Duyệt hoàn tiền), UC-28 (Báo cáo) | `docs/diagrams/srs/09-uc-manager-setup.drawio` |

---

## 2. Biểu đồ Ngữ Cảnh (Context Diagram / DFD Level 0)

### 2.1 Quy tắc chuẩn hóa
- **Thực thể ngoài (External Entities)**: `Khách vãng lai (Guest)`, `Hội viên (Member)`, `Lễ tân (Receptionist)`, `Huấn luyện viên (Coach)`, `Quản lý (Manager)`, `Hệ thống Email (Mail System)`, `Cổng thanh toán trực tuyến (payOS)`.
- **Hệ thống trung tâm**: `Hệ Thống Quản Lý Thể Thao ARENA 3`.
- **Quy chuẩn luồng dữ liệu (Data Flows)**: **100% sử dụng CỤM DANH TỪ** (Noun Phrases), tuyệt đối không dùng động từ làm tên luồng dữ liệu.

### 2.2 Bảng luồng dữ liệu vào/ra Ngữ cảnh

> **Quy chuẩn lưu trữ:** Sơ đồ Ngữ Cảnh được lưu trữ độc lập tại:
> - Context Diagram tổng thể: [diagrams/context-diagram.drawio](diagrams/context-diagram.drawio)
> - Sơ đồ phân rã DFD: [diagrams/srs/01-context-diagram.drawio](diagrams/srs/01-context-diagram.drawio).

| Thực thể ngoài (External Entity) | Luồng dữ liệu vào Hệ thống (Data Inflows) | Luồng dữ liệu ra từ Hệ thống (Data Outflows) |
| :--- | :--- | :--- |
| **Khách vãng lai (Guest)** | Thông tin đăng ký tài khoản, Mã OTP xác nhận | Danh mục gói tập thể thao, Thông tin lịch sân & giá dịch vụ, Thông báo tạo tài khoản |
| **Hội viên (Member)** | Yêu cầu đặt sân & giữ chỗ, Yêu cầu mua gói tập, Yêu cầu ghi danh lớp học, Mã QR check-in, Câu hỏi tư vấn AI | Thông tin chi tiết gói tập, Xác nhận đặt sân & giữ chỗ, Thẻ hội viên số & mã QR pass, Lịch tập & chuyên cần, Câu trả lời tư vấn từ AI |
| **Huấn luyện viên (Coach)** | Dữ liệu điểm danh lớp học, Dữ liệu đánh giá học viên, Kế hoạch đào tạo & bài tập | Danh sách lớp học phân công, Lịch dạy & danh sách học viên, Thông báo thay đổi lịch ca |
| **Lễ tân quầy (Receptionist)** | Mã check-in cửa (QR/Barcode), Dữ liệu thu tiền mặt & quẹt thẻ, Báo cáo kiểm kê chốt ca két | Trạng thái xác thực check-in, Mã VietQR ngân hàng, Hóa đơn / Biên lai thanh toán, Thông tin hồ sơ hội viên |
| **Quản lý trung tâm (Manager)** | Cấu hình bảng giá & chính sách, Thông tin phân quyền nhân sự, Quyết định duyệt hoàn tiền | Báo cáo doanh thu & lấp đầy sân, Danh sách hoàn tiền chờ duyệt, Báo cáo phân tích chuyên sâu từ AI, Nhật ký kiểm toán hệ thống |
| **Hệ thống Email (Mail System)** | Trạng thái biên nhận & gửi email | Yêu cầu gửi email mã OTP, Yêu cầu gửi email thông báo đặt sân, Yêu cầu gửi email hóa đơn điện tử |
| **Cổng thanh toán (payOS)** | Kết quả xác nhận giao dịch (Webhook) | Dữ liệu đơn thanh toán trực tuyến |

---

## 3. Swimlane Diagram (Sơ đồ Phân Làn Nghiệp Vụ)
### Quy trình: Đăng Ký Tài Khoản Có Xác Thực Mã OTP Qua Mail System (Register with Mail OTP)

### 3.1 Các làn thực thi (5 Lanes)
1. **Khách vãng lai (Guest)**: Nhập thông tin đăng ký, nhận email, nhập mã OTP.
2. **Giao diện Webapp (Frontend)**: Kiểm tra ràng buộc phía client, gửi API request, hiển thị bộ đếm OTP.
3. **Máy chủ API (Backend Server)**: Xử lý quy tắc nghiệp vụ (BR-01, BR-02, BR-07, BR-08), sinh mã OTP ngẫu nhiên, phát hành JWT token.
4. **Hệ thống Email (Mail System)**: Nhận bản tin gửi mail, định dạng mẫu email OTP, thực thi gửi tới hộp thư khách hàng.
5. **Cơ sở dữ liệu (Database)**: Kiểm tra số điện thoại/email tồn tại, lưu trữ mã OTP có thời hạn (TTL 60s), lưu trữ hồ sơ hội viên chính thức.

### 3.2 Bảng phân bước Phân làn nghiệp vụ

> **Quy chuẩn lưu trữ:** Sơ đồ Activity và Sequence chuẩn Draw.io XML lưu tại:
> - Activity Diagram: [diagrams/activity-diagram.drawio](diagrams/activity-diagram.drawio) và `diagrams/srs/11-ad-register.drawio`
> - Sequence Diagram: [diagrams/sequence-diagram.drawio](diagrams/sequence-diagram.drawio) và `diagrams/srs/15-sd-register.drawio`

| Giai đoạn | Khách vãng lai (Guest) | Giao diện Webapp (Frontend) | Máy chủ API (Backend) | Hệ thống Email / Database |
| :---: | :--- | :--- | :--- | :--- |
| **Giai đoạn 1: Nhập liệu** | Điền biểu mẫu đăng ký (Họ tên, SĐT, Email, Mật khẩu, Ngày sinh, Đồng ý điều khoản) | Kiểm tra định dạng dữ liệu (SĐT Việt Nam hợp lệ, Mật khẩu >= 8 ký tự mix chữ/số) | Nhận `POST /v1/auth/register-request` | DB: Query kiểm tra trùng lặp (SELECT WHERE phone = $1 OR email = $2) |
| **Giai đoạn 2: Phát sinh OTP** | Chờ nhận email chứa mã xác thực | Hiển thị thông báo & kích hoạt bộ đếm ngược 60 giây | Tạo mã OTP 6 chữ số ngẫu nhiên, gắn hạn dùng TTL = 60s | Mail: Gửi thư chứa mã OTP đến hộp thư người dùng; DB: Lưu bản ghi tạm vào `auth_otps` |
| **Giai đoạn 3: Xác thực OTP** | Nhập 6 chữ số OTP vào giao diện | Gửi `POST /v1/auth/register-verify` | Đối chiếu mã OTP và thời hạn hiệu lực (attempts < 5) | DB: Kích hoạt tài khoản, gán mã hội viên mới |
| **Giai đoạn 4: Kích hoạt & Đăng nhập** | Nhận thông báo chào mừng, chuyển hướng vào `/app` | Lưu phiên đăng nhập Session Token, hiển thị Toast thành công | Phát hành Session Token (thời hạn 7 ngày theo FR-M08) | Mail: Gửi thư chào mừng thành viên; DB: Ghi audit log đăng ký |

---

## 4. Tóm tắt Đối chiếu với Yêu cầu Thẩm định SRS (Verification Matrix)

| Yêu cầu phản hồi từ Sheet SRS | Hiện trạng đã xử lý | Vị trí minh chứng |
| --- | --- | --- |
| **Thêm actor AI Assistant** | Đã bổ sung Actor `AI Assistant`, với các Use Case tư vấn khách, gợi ý sân và phân tích vận hành. | Mục 1.1, 1.2, 2.1 |
| **Thêm actor Mail System** | Đã bổ sung External Entity `Mail System`, liên kết gửi OTP, email xác nhận và hóa đơn. | Mục 1.1, 1.2, 2.1, 2.2, 3.2 |
| **Thêm actor Guest** | Đã bổ sung Actor `Guest` (Khách vãng lai) với các Use Case xem sân, xem gói và đăng ký tài khoản. | Mục 1.1, 1.2, 2.1, 2.2 |
| **Context Diagram: Thêm luồng Member xem gói** | Đã bổ sung luồng: `Thông tin chi tiết gói tập` & `Danh mục gói tập thể thao` gửi tới Member. | Mục 2.2 (Member Flows) |
| **Context Diagram: Thêm luồng Coach đánh giá học viên** | Đã bổ sung luồng: `Dữ liệu đánh giá học viên` từ Coach gửi vào Hệ thống. | Mục 2.2 (Coach Flows) |
| **Context Diagram: Toàn bộ luồng là DANH TỪ** | 100% tên luồng trên sơ đồ và bảng mô tả là danh từ/cụm danh từ (Noun phrases). Không có động từ. | Mục 2.1, 2.2 |
| **Swimlane Diagram: Chi tiết đăng ký với Mail OTP** | Thiết kế sơ đồ 5 làn chi tiết đầy đủ từng bước từ nhập liệu, gửi OTP qua Mail System đến kích hoạt hội viên. | Mục 3.1, 3.2 |
