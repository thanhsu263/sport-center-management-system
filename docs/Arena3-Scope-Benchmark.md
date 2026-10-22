# Arena3 — So sánh với trung tâm thể thao thật và đề xuất scope mới

Ngày: 2026-10-05 · Dựa trên SRS v1.4.1 và code hiện tại.

## 1. Trung tâm thật vận hành như thế nào

Tổng hợp từ các nguồn công khai (xem mục 7). Có 5 điểm chung:

1. **Sân kín giờ vàng là sống còn.** Giờ cao điểm 17h–21h và cuối tuần có thể kín tới 95%. Giờ sáng và trưa thường vắng. Trung tâm tốt dùng giá theo khung giờ, khách cố định và lớp học để lấp giờ vắng.
2. **Doanh thu không chỉ từ thuê sân.** Chương trình (giải đấu, giao hữu, lớp, học riêng) có thể chiếm khoảng 40% doanh thu. Phần còn lại là thuê sân, thẻ hội viên và dịch vụ phụ: nước, đồ ăn nhẹ, cho thuê vợt, giày, bán phụ kiện.
3. **Khách chia nhóm và được quản lý riêng.** Có hội viên, khách cố định (đặt lặp lại mỗi tuần), khách vãng lai và huấn luyện viên. Mỗi nhóm có giá và ưu đãi khác nhau.
4. **Quy tắc hủy, đổi lịch, đặt cọc phải rõ ràng.** Sân kín giờ vàng mà khách không đến là mất tiền thật.
5. **Tự động hoá cửa, đèn, thanh toán, thông báo.** Mục đích là ít nhân viên mà vẫn chạy 24/7. Khách nhận nhắc lịch qua Zalo, không phải qua email.

## 2. Arena3 đã làm được gì (khớp với thực tế)

| Việc trung tâm thật cần | Arena3 hiện có |
| --- | --- |
| Không bán trùng sân | Có. Khoá sân, chống trùng giờ, giữ chỗ 5 phút |
| Giá theo khung giờ | Có. Bảng giá ngày thường, cuối tuần, lễ, cờ giờ cao điểm |
| Hủy, đổi lịch, no-show | Có. Hủy trước 2 giờ, đổi lịch, tự đánh dấu no-show |
| Thẻ hội viên, đóng băng | Có |
| Lớp học, điểm danh, danh sách chờ | Có, kèm bài tập, đánh giá, cảnh báo vắng liên tục |
| Thu ngân theo ca, hoàn tiền, hoá đơn | Có, kèm payOS QR |
| Cổng QR | Có |
| Khuyến mãi | Có |
| Mượn thiết bị | Có (chưa tính tiền) |
| Báo cáo, audit | Có |

Nền tảng đã khá chắc. Phần còn thiếu nằm ở các nguồn doanh thu và quy trình ngoài thuê sân và lớp.

## 3. Khoảng trống so với thực tế

Mức ưu tiên: **Cao** = trung tâm thật thiếu là mất tiền. **Vừa** = có thì tốt. **Thấp** = để sau.

| # | Khoảng trống | Vì sao quan trọng | Hiện trạng | Ưu tiên |
| --- | --- | --- | --- | --- |
| G1 | **Đặt cố định hàng tuần** (khách cố định, HLV thuê sân dạy) | Đây là cách chính để lấp giờ vàng. SRS ghi 0 chỗ nhắc tới | Chỉ đặt từng buổi | Cao |
| G2 | **Cọc và phạt hủy trễ** | Giảm no-show giờ vàng | Hủy trễ chỉ là không hoàn tiền | Cao |
| G3 | **Bán lẻ và F&B (POS)**: nước, snack, cầu, quấn cán | Doanh thu phụ đáng kể. Lễ tân đang không có chỗ ghi | Không có | Cao |
| G4 | **Cho thuê vợt, giày có tính tiền** | Hiện báo cáo doanh thu của thiết bị là 0 (SRS 10.1) | Chỉ ghi mượn trả | Cao |
| G5 | **Nhắc lịch qua Zalo** | Khách Việt dùng Zalo, ít đọc email. Tin nhắn giảm no-show | SMS đã bỏ, email là stub, chỉ có thông báo trong app | Cao |
| G6 | **Giải đấu và giao hữu** (đăng ký, bốc thăm, lịch, kết quả) | Chương trình chiếm khoảng 40% doanh thu ở trung tâm tốt | Không có | Vừa |
| G7 | **Ghép trận / chơi mở** (open play): người lẻ tìm người chơi chung | Lấp giờ vắng, tạo cộng đồng | Không có | Vừa |
| G8 | **Khách mời, vé ngày** (guest pass, vé lượt) | Khách mới thử trước khi mua thẻ | Removed by scope decision (v2.4) | Vừa |
| G9 | **Tích điểm, giới thiệu bạn bè, hạng thành viên** | Giữ khách. Hiện chỉ có mã khuyến mãi | Không có | Vừa |
| G10 | **Bảo trì sân theo phiếu việc** (thay lưới, sơn sân, sửa đèn) | Sân hỏng mà không ai biết là mất giờ bán | Có trạng thái sân, chưa có phiếu việc | Vừa |
| G11 | **Tính lương và hoa hồng HLV, ca nhân viên** | Trung tâm trả HLV theo buổi dạy. Dữ liệu đã có sẵn | Có điểm danh, chưa tính tiền | Vừa |
| G12 | **Hoá đơn điện tử xuất ra phần mềm kế toán** | Bắt buộc ở Việt Nam khi kinh doanh thật | In được, chưa xuất | Vừa |
| G13 | **Tủ đồ, khăn, phòng tắm** | Trung tâm lớn có | Không có | Thấp |
| G14 | **Điều khiển cửa, đèn tự động theo lịch đặt** | Vận hành 24/7 ít người | Cổng QR chưa nối thiết bị | Thấp |
| G15 | **Nhiều cơ sở** | Khi mở rộng | Chủ ý không làm (một dòng cài đặt duy nhất) | Thấp |
| G16 | **Giá linh hoạt theo độ kín** | Giảm giá giờ vắng, tăng giá giờ vàng kín | Có bảng giá tĩnh | Thấp |

## 4. Scope đề xuất

### Giai đoạn A — "Không bỏ sót tiền" (nên làm trước)
- **G1 Đặt cố định.** Một "lịch lặp" tạo ra các lượt đặt cho từng tuần. Hệ thống kiểm tra trùng như lớp học. Khách cố định có thể bỏ một tuần mà không mất cả lịch.
- **G2 Cọc và phạt hủy.** Cài đặt cọc (ví dụ 30%) cho khung giờ cao điểm. Hủy sau mốc quy định thì mất cọc.
- **G3 + G4 Quầy bán hàng.** Danh mục sản phẩm, bán ngay tại quầy, tính vào ca thu ngân. Thuê vợt và giày thì tạo ra dòng thanh toán thật và hiện trong báo cáo doanh thu.
- **G5 Zalo.** Nhắc lịch trước giờ chơi, báo giữ chỗ hết hạn, báo mã hoá đơn. Bắt đầu từ ZNS của Zalo, giữ thông báo trong app làm dự phòng.

### Giai đoạn B — "Thêm nguồn doanh thu"
G6 giải đấu, G7 chơi mở, G8 vé lượt và khách mời, G9 tích điểm và giới thiệu, G11 hoa hồng HLV.

### Giai đoạn C — "Vận hành chuyên nghiệp"
G10 phiếu bảo trì, G12 xuất hoá đơn điện tử, G13 tủ đồ, G16 giá theo độ kín.

### Để ngoài scope (ghi rõ)
G14 điều khiển thiết bị và G15 nhiều cơ sở. Cả hai cần phần cứng hoặc đổi kiến trúc lớn. Chỉ làm khi có yêu cầu thật.

## 5. Kiến trúc: cần đổi gì

Kiến trúc hiện tại (một lịch, một sổ cái, sân đặt qua `occupancies`) đủ để mở rộng, **không cần viết lại**. Các thay đổi cụ thể:

**1. Giữ nguyên nguyên tắc cốt lõi.** Mọi thứ chiếm sân (đặt lẻ, lịch lặp, lớp, giải đấu, bảo trì) đi qua `occupancies`. Đây là điểm mạnh nhất của hệ thống và là chỗ chống bán trùng. Giải đấu và bảo trì chỉ là thêm loại occupancy mới.

**2. Thêm module, không sửa module cũ.**

| Module mới | Bảng mới (dự kiến) | Ghi chú |
| --- | --- | --- |
| Lịch lặp (G1) | `booking_series` (+ cột `series_id` ở `court_bookings`) | Job sinh lượt đặt trước N tuần |
| Cọc (G2) | cột cọc ở `payments`, mốc ở `center_settings` | Dùng lại luồng hoàn tiền sẵn có |
| Quầy bán (G3, G4) | `products`, `stock_moves`, `sale_lines` | Mọi bán hàng sinh một dòng `payments` thật, gắn vào ca thu ngân |
| Thông báo (G5) | không cần bảng mới | `outbox` đã có. Chỉ thêm kênh Zalo vào dispatcher |
| Giải đấu, chơi mở (G6, G7) | `events`, `event_entries`, `matches` | Chiếm sân bằng `occupancies` |
| Tích điểm (G9) | `loyalty_ledger` | Chỉ ghi thêm, không sửa, giống `audit_logs` |
| Hoa hồng HLV (G11) | `coach_rates`, báo cáo từ `attendance` | Không cần nhập tay, dữ liệu đã có |
| Bảo trì (G10) | `work_orders` | Mở phiếu thì sân chuyển trạng thái bảo trì |

**3. Doanh thu phải đi qua một cửa duy nhất.** Hiện lớp và thiết bị không tạo dòng thanh toán nên báo cáo bằng 0. Quy tắc mới: **mọi khoản thu đều là một dòng `payments`**, cả tiền bán nước, phí thuê vợt, lệ phí giải. Báo cáo doanh thu chỉ đọc từ đó. Việc này sửa luôn giới hạn đã ghi ở SRS 10.1.

**4. Bật từng phần bằng feature flag.** Hệ thống đã có `feature_flags` (F4 là huấn luyện). Mỗi giai đoạn trên là một flag mới: F5 quầy bán, F6 giải đấu, F7 tích điểm. Trung tâm chỉ bật cái cần, và có thể tắt nếu lỗi.

**5. Tách phần gửi tin ra khỏi nghiệp vụ.** Dispatcher của `outbox` nhận kênh qua một giao diện. Thêm Zalo là thêm một bộ gửi, không đụng tới nơi tạo thông báo.

**6. Chuẩn bị nhiều cơ sở nhưng chưa làm.** Chỉ cần thêm cột `site_id` có giá trị mặc định vào các bảng chính ở lần di chuyển dữ liệu kế tiếp. Chưa đổi giao diện. Như vậy sau này mở cơ sở thứ hai không phải đập lại dữ liệu.

**7. Rủi ro cần chú ý.**
- Lịch lặp là chỗ dễ sinh trùng sân nhất. Cần test với lớp học và với đổi giờ.
- Cọc liên quan tiền thật. Cần trường hợp hoàn cọc tự động khi trung tâm hủy sân.
- Zalo cần tài khoản doanh nghiệp (OA). Cần chủ trung tâm đăng ký.
- Hoá đơn điện tử cần chọn nhà cung cấp trước khi thiết kế.

## 6. Việc cần chủ trung tâm quyết định

1. Có làm đặt cố định (G1) và cọc (G2) trước không? Đề xuất: có.
2. Trung tâm có bán nước và đồ ở quầy không? Nếu có thì ưu tiên G3.
3. Có tài khoản Zalo OA chưa?
4. Tỷ lệ cọc và mốc phạt hủy là bao nhiêu?
5. Nhà cung cấp hoá đơn điện tử (nếu có) là ai?

## 7. Nguồn tham khảo

- [Fun&Fit Pickleball & Tennis — ALOBO](https://www.alobo.vn/fun-fit-pickleball/): 9 sân pickleball, kín 95% lúc 17h–21h, bỏ Excel, bỏ đặt trùng.
- [CukCuk — Phần mềm quản lý sân pickleball, cầu lông](https://www.cukcuk.vn/43465/phan-mem-quan-ly-san-pickleball-san-cau-long/)
- [Kootoro — Kinh doanh sân pickleball](https://www.kootoro.com/news/kinh-doanh-san-pickleball): doanh thu thuê sân, F&B, giải đấu, chính sách hủy.
- [CourtReserve — Racquet club business plan](https://courtreserve.com/creating-a-business-plan-for-your-pickleball-club/)
- [Plan2Play — Membership model](https://plan2play.com/blog/club-management/the-smartest-membership-model-to-launch-your-pickleball-center): thẻ năm và thẻ tháng kết hợp.
- [FMX — Sports facility management software](https://www.gofmx.com/blog/sports-facility-management-software/): bảo trì, lịch nhân viên.
- [Playbook365](https://www.playbook365.com/facility-management) và [Anolla](https://anolla.com/en/sports-facility-management-software): danh sách tính năng phần mềm quản lý sân.

Lưu ý: các con số như "chương trình chiếm khoảng 40% doanh thu" và "kín 95%" lấy từ bài viết của các nhà cung cấp phần mềm và trung tâm cụ thể. Dùng làm tham khảo, không phải số liệu thống kê chung.
