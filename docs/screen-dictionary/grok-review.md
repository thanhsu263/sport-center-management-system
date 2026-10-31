Tôi sẽ đối chiếu từ điển màn hình với route thật và xem đủ 70 ảnh chụp, chỉ đọc, không sửa file. Trước hết tôi lấy danh sách màn hình, mô tả tiếng Việt và các route nguồn.Mô tả 35 màn đã có. Tiếp theo tôi xem ảnh và đối chiếu nhãn thật t## Điểm (1-10) ## Điểm (1-10) cho: độ chính xác, độ rõ cho người không biết kỹ thuật, bố cục, độ đầy đủ

| Tiêu chí | Điểm | Vì sao |
|---|---|---|
| Độ chính xác | **5/10** | Nhiều trang khớp (S14, S18, S26, S28, S33). Nhiều trang gán nút hoặc việc không có trên màn đó: thanh toán online, huỷ sân, mã thô, đổi email, đăng ký giúp, lịch tuần. |
| Độ rõ cho người không rành kỹ thuật | **4/10** | Câu tiếng Việt đọc được, nhưng ảnh để trống, tiếng Anh lẫn trong ảnh, và chữ như «Mã thô», «đối soát», «OTP», «Gemini», «F4», đường dẫn `/desk/member/{id}` không được giải thích. |
| Bố cục | **6/10** | Mỗi màn một trang ngang, ba cột chữ đều. Giữa ảnh và chữ là một khoảng trống lớn. Ảnh điện thoại in ra quá nhỏ để đọc. Nhiều ảnh bị cắt giữa chữ. |
| Độ đầy đủ | **5/10** | 35 route chính đều có trang. Thiếu màn trả về sau thanh toán, thiếu bước thứ hai (mã xác nhận), thiếu màn chi tiết lớp, và nhiều ảnh không cho thấy đúng việc lời văn đang kể. |

Đã xem đủ 70 ảnh `S01`–`S35` (máy tính và điện thoại), đối chiếu `scripts/screen-dictionary.mjs` dòng 24–69 với route trong `src/routes/`, và xem trang bìa, mục lục, trang S01, trang S06 của PDF (37 trang).

## Lỗi (đánh số, mức Critical/High/Medium/Low)

1. **High — S07. Lời văn nói mua và thanh toán online. Màn hình nói đặt rồi trả tiền tại quầy.**  
   Bằng chứng: `scripts/screen-dictionary.mjs` dòng 34; ảnh `S07-d.jpg`, `S07-m.jpg`. Nút thật là «Mua hoặc gia hạn». Dòng dưới tiêu đề: «Đặt tại đây, thanh toán tại quầy». `src/routes/app.plans.tsx` dòng 86 và 154–155.  
   Sửa: đổi câu thành «Bấm “Mua hoặc gia hạn”, xem ngày hết hạn, rồi ra quầy trả tiền». Tên gói trong ảnh đang là tiếng Anh («Badminton 30 days», «Volleyball 30 days», «Basketball 30 days») — chụp lại sau khi dữ liệu mẫu đã dịch.

2. **High — S06. Ảnh không có lưới giờ trống, và không có nút huỷ sân trên màn này.**  
   Bằng chứng: `S06-d.jpg`, `S06-m.jpg`, trang PDF của S06. Nhìn thấy ngày, môn, nút «Đổi giờ», mã `CRT-…`. Không thấy ô giờ để bấm. Nút khuyến mãi bị cắt thành «Mã khuyến mãi (khôn». Trên điện thoại, ô «T5 / Còn 1» bị cắt mất số. Huỷ sân nằm ở lịch trang chủ hội viên, nút «Hủy» (`src/routes/app.index.tsx` dòng 295–309; `vi.desk.ts` dịch «Cancel» thành «Hủy»). Trang đặt sân chỉ có «Đổi giờ» (`app.book.tsx` dòng 376–379).  
   Sửa: cuộn tới lưới sân rồi chụp; viết «Đổi giờ ở màn Đặt sân. Huỷ ở thẻ “Hôm nay” trên trang Lịch, khi đã có buổi».

3. **High — S10. «Mã thô» không có trên màn hình.**  
   Bằng chứng: dòng 37 của file mô tả; `S10-d.jpg`, `S10-m.jpg`; `src/routes/app.pass.tsx` dòng 111–131. Chữ thật: «Mã mới», mục «Tự vào cổng», ô «Mã từ màn hình lễ tân», nút «Vào cổng». Hội viên quét mã trên màn lễ tân, không đọc một mã chữ cho lễ tân.  
   Sửa: bỏ «Mã thô». Viết đúng bốn chữ trên. Tab vào màn là «Mã QR»; tiêu đề màn là «Mã vào cổng».

4. **High — S13. Đổi email và «đăng xuất mọi thiết bị» không có.**  
   Bằng chứng: dòng 40; `S13-d.jpg`. Tiêu đề thật là «Cài đặt tài khoản». Khối «Không thể đổi tại đây» gồm số điện thoại, email, ngày sinh, mã hội viên (`account.tsx` dòng 155–163). Menu avatar chỉ có «Cài đặt tài khoản» và «Đăng xuất» (`shell.tsx` dòng 229–248) — đăng xuất máy này. Đổi mật khẩu còn giữ các máy khác đăng nhập (`account.tsx` dòng 198). Tab thật: «Hồ sơ», «Bảo mật», «Biên lai», «Hỗ trợ». Ảnh chỉ mở «Hồ sơ». Ô sức khoẻ đang là câu tiếng Anh: «Minor — guardian consent on file».  
   Sửa: «Sửa tên và ghi chú sức khoẻ. Đổi mật khẩu ở tab “Bảo mật”. Xem biên lai ở tab “Biên lai”. Đăng xuất bằng menu ảnh đại diện. Đổi số điện thoại hoặc email thì nhờ lễ tân.» Chụp thêm tab Bảo mật. Dịch câu ghi chú sức khoẻ.

5. **High — S16. Không phải lịch tuần. Ảnh là một ngày, và mọi ô đều trống.**  
   Bằng chứng: dòng 45; `S16-d.jpg` tiêu đề «Sơ đồ sân», một ngày «4 thg 10 2026», lưới 06–12 toàn ô trắng. `desk.courts.tsx` giữ một `date`, không có nút đổi tuần. Trên điện thoại (`S16-m.jpg`) sân bên phải bị cắt («BC-»). Tab «Sân» chỉ có trên máy tính. Trên điện thoại nút «Thêm» đang sáng — Sân nằm trong «Thêm» (`shell.tsx` dòng 71, `dock: false`).  
   Sửa: «Xem một ngày. Đổi ngày bằng dãy T2–CN hoặc ô ngày. Bấm ô trống để đặt giúp khách.» Chụp một ngày có ô đã đặt. Ghi đường điện thoại: «Thêm → Sân».

6. **High — S19. Không có lọc môn, không có nút đăng ký giúp hội viên.**  
   Bằng chứng: dòng 48; `S19-d.jpg`. Mỗi thẻ chỉ có «Đang mở», mã lớp tiếng Anh (`BAD-ADV-0003`…), nút «Buổi học & học viên». `desk.classes.tsx` không có bộ lọc môn. `class-detail.tsx` xem danh sách, không có nút ghi danh giúp khách.  
   Sửa: «Bấm “Buổi học & học viên” để xem buổi, sân, HLV và danh sách.» Bỏ «Lọc theo môn» và «Đăng ký giúp hội viên», trừ khi chức năng đó được thêm vào app rồi chụp lại. Trên điện thoại: «Thêm → Lớp học».

7. **High — S21. Ảnh không có đặt sân giúp, không có điểm danh.**  
   Bằng chứng: dòng 50; `S21-d.jpg`, `S21-m.jpg`. Nút thật: «Sửa hồ sơ», «Đặt lại mật khẩu», «Thu tiền», «Thanh toán online», «Bán thêm gói tập», «Hoàn tiền». Trong code còn «Đóng băng 7 ngày» / «Mở lại gói» và mục «Hôm nay» với «Vào cổng» (`desk.member.$id.tsx` dòng 207–353, 472–497). Tên gói toàn tiếng Anh, kể cả «All-access 30 days».  
   Sửa: liệt kê đúng các nút trên. «Vào cổng» là ghi nhận khách đã tới, không phải sổ điểm danh của HLV. Cuộn xuống để ảnh có mục «Hôm nay» và «Hoàn tiền».

8. **High — S22, S29, S31, S34. Ảnh trống, trong khi lời văn kể như màn đang có việc.**  
   - **S22** `S22-d.jpg`: «Chưa có gì ở đây». Tiêu đề app là «Cảnh báo», không phải «Thông báo». Câu gợi ý nói học viên vắng ba buổi — chữ của HLV, trong khi trang này chụp bằng tài khoản lễ tân (`alerts.tsx` dòng 33–37). Không thấy «chuyển khoản chờ đối soát».  
   - **S29** `S29-d.jpg`: tỉ lệ «—», có mặt 0, dòng «Không có buổi nào được điểm danh». Khoảng ngày kết thúc 10/04/2026, trong khi S24 điểm danh buổi 5 thg 10. Có tab «Sắp rời bỏ» không được nhắc.  
   - **S31** `S31-d.jpg`: «Chưa có mã khuyến mãi nào». Nút thật là «Mã mới», không phải «Tạo mã». Không thấy bật/tắt hay số lần đã dùng.  
   - **S34** `S34-d.jpg`: «Đang hiện 0», «Chưa có thao tác nào được ghi nhận». Ô ngày để placeholder tiếng Anh `mm/dd/yyyy`. Điện thoại cắt ô tìm («Tìm trong danh sách l») và cắt câu trống.  
   Sửa: tạo dữ liệu mẫu rồi chụp lại (một mã giảm giá, vài dòng nhật ký, một cảnh báo, một khoảng ngày có điểm danh). Với S22, nói đúng việc màn này làm: báo khi học viên vắng ba buổi liên tiếp.

9. **High — S17. Ảnh là ca chưa mở, không thu được tiền. «Đối soát» và «hoàn tiền» không hiện.**  
   Bằng chứng: `S17-d.jpg`. Dòng vàng «Chưa mở ca — hãy mở ca để thu tiền», nút «Mở ca trước». Có «Tiền mặt», «Trực tuyến», «Xóa», lọc biên lai. Phần kiểm tra chuyển khoản và duyệt hoàn chỉ hiện khi có khoản (`desk.payments.tsx` khoảng dòng 348–563) — ảnh này không có. Tên gói «Badminton 30 days». Nhãn «Đã chờ 21 ngày» trông như khoản bị kẹt.  
   Sửa: mở ca, chụp lúc nút thu tiền bấm được. Thêm một câu thường: «Đối soát nghĩa là kiểm tra tiền chuyển khoản đã vào sổ ngân hàng chưa, rồi bấm xác nhận.» Chụp riêng một khoản hoàn đang chờ quản lý.

10. **High — S35. Phần đầu lời văn là tên, địa chỉ, mã số thuế. Ảnh không có các ô đó.**  
   Bằng chứng: dòng 68; `S35-d.jpg` chỉ có công tắc «F4», «F5», «F6» và sân «Đang mở / Bảo trì / Đã đóng». Ô pháp lý nằm dưới danh sách sân (`manager.settings.tsx` dòng 125–187), kèm nút «Lưu». Điện thoại cắt chip «Bóng chuyền». «F6» còn chữ «Gemini».  
   Sửa: cuộn tới «Thông tin trung tâm» rồi chụp. Đổi «Ngừng một sân» thành ba trạng thái «Đang mở», «Bảo trì», «Đã đóng». Bỏ mã F4/F5/F6 trong lời kể, hoặc chú thích một dòng mỗi mã.

11. **Medium — S20. Lời văn nói «cho mượn». Màn hình nói «cho thuê».**  
   `S20-d.jpg`: nút «Cho thuê», mục «Đang cho thuê» đang trống («Hiện không có gì đang cho thuê») nên không thấy nút trả. Tên đồ tiếng Anh: «Badminton racket», «Shuttle tube», «Basketball», «Volleyball». Điện thoại cắt giá «30.00(» và ô tìm «mã h». Tab «Dụng cụ» trên điện thoại nằm trong «Thêm».  
   Sửa: dùng chữ «Cho thuê» và «Trả». Cho thuê một món rồi chụp, để thấy nút trả và kho tăng lại.

12. **Medium — S24 và S25. Cùng một học viên, hai con số điểm danh khác nhau, cộng tiếng Anh và chữ bị cắt.**  
   `S24-d.jpg`: Bùi Gia Bảo «Có mặt», cả lớp 10/10. `S25-d.jpg`: cùng người «0 có mặt · 0 đến muộn · 0 vắng». Ghi chú đỏ tiếng Anh «Minor — guardian consent on file»; S24 còn «Goal: lose weight. New to badminton». Điện thoại S24 cắt mã buổi «BAD-BEG-(» và nút «Vắng». S25 cắt «Cầu l» và «Cơ bơ». Nút lưu sổ là «Lưu điểm danh», không phải «Lưu kế hoạch». Phần giáo án / bài tập nằm dưới danh sách, không có trong ảnh. Khoá sổ («Đã khóa») có trong code nhưng ảnh không ở trạng thái đó.  
   Sửa: lưu điểm danh xong mới chụp hồ sơ học viên. Dịch ghi chú sức khoẻ. Cuộn S24 tới phần kế hoạch buổi sau. Viết «Sổ tự khoá sau giờ quy định; khi đó chỉ quản lý sửa được, và phải ghi lý do.»

13. **Medium — S27. Ảnh là form tạo lớp, không phải màn huỷ buổi / đổi HLV.**  
   `S27-d.jpg`: nút «Tạo và đăng», HLV «Coach Minh Quan». Huỷ buổi, dời buổi, huỷ lớp nằm sau «Buổi học & học viên» (`class-detail.tsx`). Điện thoại cắt form ở «Ngày đầu tiên», và «Thêm» đang sáng — không có tab «Lớp học» trên thanh dưới.  
   Sửa: chụp thêm màn sau khi bấm «Buổi học & học viên». Đường điện thoại: «Thêm → Lớp học».

14. **Medium — S30. «Ẩn gói» không phải chữ trên nút.**  
   `S30-d.jpg`: «Gói mới», «Chi tiết», «Ngừng bán», «Bán lại». Gói mẫu tên «Trial (hidden)», giá 0đ. Các thẻ dưới cùng bị cắt giữa chữ «Basketball». Tiêu đề màn là «Gói hội viên».  
   Sửa: «Thêm bằng “Gói mới”. Ngừng bán bằng “Ngừng bán”; bán tiếp bằng “Bán lại”. Gói đã bán cho hội viên vẫn giữ nguyên.» Đổi tên gói mẫu sang tiếng Việt. «Thêm» trên thanh menu đang sáng là đúng với câu «Tab Thêm → Gói tập», nhưng menu chưa được mở — chụp thêm menu đang xổ.

15. **Medium — S01, S02, S03, S04. Chữ điều hướng và bước xác nhận không khớp ảnh.**  
   - S01: nút thứ hai là «Xem sân & bảng giá». Bảng giá, lớp, HLV, gói nằm phía dưới hero; ảnh chỉ là phần đầu. Điện thoại chỉ có nút menu, không thấy «Đăng nhập» / «Tham gia».  
   - S02: ô là «Số điện thoại hoặc email». Link là «Tạo tài khoản» và «Quên mật khẩu?», không phải nút «Đăng ký». Chip demo còn tiếng Anh: «Front Desk», «Coach Khoa», «Arena3 Manager».  
   - S03: tiêu đề «Tạo tài khoản», nút «Gửi mã OTP». Ảnh chưa tới bước nhập mã. Có thêm email, nhập lại mật khẩu, ô đồng ý Nghị định 13.  
   - S04: hạn 5 phút là đúng (`forgot.tsx` dòng 147). Ảnh chỉ có ô số điện thoại và «Gửi mã», chưa có ô mã 6 số. Trang máy tính gần như trống quanh một thẻ nhỏ.  
   Sửa: chụp bước mã của đăng ký và quên mật khẩu. S01 điện thoại: mở menu rồi chụp. S02: «Nhập số điện thoại hoặc email».

16. **Medium — S08, S09, S11, S12. Đúng hướng, nhưng chữ nút hoặc ảnh không chứng minh hết câu.**  
   - S08: nút rời lớp là «Rời lớp này», không phải «Huỷ đăng ký». «Vào danh sách chờ» chỉ hiện khi lớp đầy; các lớp trong ảnh còn chỗ (8/10, 10/12).  
   - S09: bài tập đang trống («Hiện không có việc gì cần làm»). Mục tiêu là danh sách «Chưa đặt». Lịch sử buổi bị cắt dưới «Nhận xét của HLV».  
   - S11: có câu gợi ý đúng ý. Trong ảnh còn «Gemini» và «Gõ «ticket: …»». Nút trên thanh là «Trợ lý», không phải hình bong bóng chat.  
   - S12: bảy dòng cùng một câu «Đã xác nhận đặt sân». Nút là «Đánh dấu tất cả đã đọc».  
   Sửa: chụp một lớp đầy với nút «Vào danh sách chờ»; một bài tập có ô tick; một hộp thư có biên lai, đổi giờ và trả lời lễ tân. Thay câu ticket bằng «Gõ “ticket:” rồi nội dung để gửi ghi chú cho quầy».

17. **Low — S14, S15, S18, S23, S26, S28, S32, S33. Màn dùng được, còn lỗi nhỏ.**  
   - S14 khớp «Mở ca», tìm, ba bước hồ sơ → gói → thanh toán. Thêm «Thanh toán» (số 1) và «Sơ đồ sân». Ô tên đang điền sẵn «Alex Nguyen».  
   - S15 khớp quét mã và tab «Không có mã». Điện thoại cắt «…hội vié». Chưa nói mục «Mã tự vào cổng» và nút «Hiện» (mã đổi mỗi 30 giây). Danh sách «Đã qua cổng hôm nay» trống, và chưa có ảnh kết quả hợp lệ / từ chối.  
   - S18 khớp danh sách gọi. Nút thấy được là «Ghi nhận liên hệ». Điện thoại cắt ô tìm. Máy tính còn lọc «Vắng liên tiếp», «Không đến 14+ ngày», «Gói sắp hết hạn».  
   - S23 đúng việc. Tiêu đề app là «Lịch», không phải «Lịch dạy». Mã lớp `BAD-BEG-0001`.  
   - S26 khớp Hôm nay / 7 ngày / Tháng này / Tuỳ chọn và Xuất Excel, PDF, CSV. Điện thoại cắt «Mọi phương th».  
   - S28 có tìm, lọc, 1.051 hội viên. Chia trang có trong code (`manager.members.tsx` dòng 159) nhưng không lọt vào ảnh. Tên gói tiếng Anh.  
   - S32 khớp bảng giá theo ngày lễ / thường / cuối tuần và giờ thường / cao điểm. Nút lưu là «Lưu giá mới», nằm dưới cùng. Dòng «Chỉ sân DEMO-01» giá 2.000đ trông như dữ liệu hỏng cạnh giá 80.000đ. Ô nhập hiện `80000`, không có dấu chấm.  
   - S33 khớp thêm, đặt lại mật khẩu, «Khoá», «Đăng xuất mọi nơi». Điện thoại cắt nút «Khoá» và đường vào là «Thêm», không phải tab «Nhân viên». Tên «Arena3 Manager», «Coach Minh Quan», email `@arena3.local`. «46 phiên đang mở» là tiếng trong ngành — nên viết «46 lần đăng nhập còn hiệu lực».

18. **Low — Bản in. Khoảng trống, chữ nhỏ, đường dẫn kỹ thuật.**  
   Bằng chứng: PDF trang S01 và S06. Ảnh dính lên trên, phần chữ dính xuống dưới, giữa là một dải nền trống (khung trang cố định 297×210 mm, `overflow: hidden`, trong `index.html` dòng 6 và 26). Ảnh điện thoại cao khoảng một nửa trang, chữ trong ảnh điện thoại không đọc được khi in. Mỗi tiêu đề có dòng tiếng Anh («Home», «Book a court»…). Mục lục in đường dẫn `/desk/member/…`. Góc trang có mã route; với S01 chỉ còn một dấu `/`.  
   Sửa: kéo khối chữ lên sát ảnh. In ảnh điện thoại lớn hơn, hoặc cắt đúng vùng nội dung. Bỏ dòng tiếng Anh và đường dẫn, hoặc gom đường dẫn vào một phụ lục cho người làm phần mềm.

## Màn hình thiếu

So với `src/routes/*.tsx`, route có giao diện mà từ điển không có:

- **`/pay/return`** (`pay.return.tsx`). Màn hội viên thấy sau khi ngân hàng trả về: «Đang kiểm tra với ngân hàng», «Đã thanh toán», «Chưa xác nhận», «Đã huỷ thanh toán», «Không tìm thấy khoản này». Đây là màn dễ gây hoảng nếu tiền đã trừ mà trang không nói rõ.

`v1.$.ts` là cổng API, không phải màn hình.

Cùng một route nhưng là một màn khác, hoặc một bước khác, và sếp cần thấy:

- Bước nhập mã của **Đăng ký** và **Quên mật khẩu** (S03, S04 chỉ có bước 1).
- **Lưới giờ sân** trên Đặt sân (nằm dưới phần «Các sân sắp tới»).
- **Buổi học & học viên** — màn mở từ S19 và S27: danh sách, huỷ buổi, dời buổi, huỷ lớp. Lời văn S27 đang mô tả màn này dù không có ảnh.
- Tab **Bảo mật**, **Biên lai**, **Hỗ trợ** của tài khoản.
- Menu avatar đang mở, và menu **Thêm** đang mở (đường «Tab Thêm → …» được viết nhưng không được chỉ trên ảnh).
- Khối **tên pháp lý, địa chỉ, mã số thuế** ở cuối Cài đặt.
- Kết quả quét cổng: vào được / bị từ chối, và mã tự vào cổng sau khi bấm «Hiện».
- Hàng **chuyển khoản chờ kiểm tra** và **hoàn tiền chờ quản lý** trên Thanh toán. Quản lý cũng vào đúng màn `/desk/payments` từ tab «Thanh toán» (`shell.tsx` dòng 94–95); từ điển chỉ kể màn này cho lễ tân.

## Đề xuất cải thiện (top 8, theo thứ tự ưu tiên)

1. **Chụp lại đúng việc đang được kể.** Trước khi chụp: mở ca, lưu điểm danh, tạo một mã khuyến mãi, một dòng nhật ký, một cảnh báo, một lớp đầy (để có «Vào danh sách chờ»), một món đang cho thuê. Cuộn tới lưới sân, form pháp lý, và màn «Buổi học & học viên». Không giao trang nào mà ảnh là hộp «Chưa có gì ở đây» trong khi câu bên dưới kể năm việc.

2. **Sửa chữ cho khớp nút thật**, theo các lỗi 1–14. Quy tắc: chỉ viết chữ đang in trên nút. Câu «làm được gì» nào không thấy trên ảnh thì chuyển thành «cuộn xuống sẽ thấy…» hoặc bỏ.

3. **Một bảng chú giải một trang**, đặt sau mục lục. Ví dụ ngắn: ca thu ngân, giữ sân 5 phút, mã QR đổi mỗi phút, danh sách chờ, sắp rời bỏ, đối soát (tiền chuyển khoản đã vào sổ chưa), hoàn tiền, ngừng bán gói, phiên đăng nhập, mã OTP (mã 6 số gửi qua email). Bỏ «Mã thô».

4. **Năm sơ đồ một đường**, mỗi vai một trang: khách xem giá → đăng ký → hội viên mua gói → lễ tân mở ca và thu tiền → vào cổng; HLV điểm danh; quản lý xem báo cáo. Đánh số Sxx trên từng ô. Trong repo đã có ảnh luồng ở `docs/screens/` — đưa bản tiếng Việt đơn giản vào từ điển, không cần sơ đồ kỹ thuật.

5. **Chú thích trên ảnh.** Khoanh 3–5 chỗ mỗi màn: nút chính, tab đang đứng, chỗ nhập. Người đọc không phải đoán «Đổi giờ» nằm ở hàng nào. Với điện thoại, ghi một dòng khi nút không nằm trên thanh dưới mà nằm trong «Thêm»: Sân, Lớp học, Dụng cụ (lễ tân); Lớp học, Nhân viên, Gói tập, Khuyến mãi, Bảng giá, Nhật ký, Cài đặt (quản lý).

6. **Dịch dữ liệu mẫu trước khi chụp.** Tên gói, tên vợt, ghi chú sức khoẻ, chip đăng nhập demo, placeholder `mm/dd/yyyy`, chữ Gemini / ticket / Trial (hidden) / DEMO-01. Ảnh đang được giới thiệu là «chế độ tiếng Việt».

7. **Siết trang in.** Kéo phần chữ lên sát ảnh để hết dải trống. Cho ảnh điện thoại lớn hơn hoặc chỉ cắt phần thân màn hình. Bỏ phụ đề tiếng Anh. Đưa đường dẫn `/…` xuống phụ lục. Thêm trang `/pay/return` và trang chi tiết lớp.

8. **Một kịch bản mẫu xuyên suốt**, cùng một hội viên. Hiện Bùi Gia Bảo «chưa có gói» ở S05, lại «chưa thanh toán Badminton 30 days» ở S21, «có mặt» ở S24 và «0 có mặt» ở S25. Sếp sẽ tưởng app sai. Chọn một người, một gói đã trả tiền, một sân đã đặt, một buổi đã điểm danh, rồi dùng đúng người đó ở mọi ảnh.
