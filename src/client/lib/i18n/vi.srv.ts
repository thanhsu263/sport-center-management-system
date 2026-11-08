/**
 * Server messages (errors, warnings, notification bodies) that reach the screen in English.
 *
 * The API answers in English; `tServer()` (src/lib/i18n.tsx) looks the message up here when the UI
 * is in Vietnamese. Exact messages first, then the patterns for messages that carry numbers or names.
 * Anything not listed is shown as it arrived. Sources: src/lib/arena3/{errors,validate,rules,promos,
 * pricing,checkin,helpers,ratelimit,session,flags,router}.ts and src/lib/arena3/handlers/*.ts.
 */
export const VI_SERVER_EXACT: Record<string, string> = {
  // ── errors.ts (defaults and database errors)
  "Please sign in.": "Vui lòng đăng nhập.",
  "You do not have permission.": "Bạn không có quyền thực hiện thao tác này.",
  "Not found.": "Không tìm thấy.",
  "That slot is already held.": "Khung giờ này đang được giữ.",
  "Your hold has expired.": "Thời gian giữ sân của bạn đã hết.",
  "That is not a valid state.": "Trạng thái này không hợp lệ.",
  "Too many attempts — try again later.": "Bạn thử quá nhiều lần, vui lòng thử lại sau.",
  "You are already enrolled in that class.": "Bạn đã đăng ký lớp này.",
  "That class is full.": "Lớp này đã đủ chỗ.",
  "That value is too long.": "Giá trị này quá dài.",
  "That number is out of range.": "Số này nằm ngoài phạm vi cho phép.",
  "That value is not in the right format.": "Giá trị này không đúng định dạng.",
  "A required value is missing.": "Thiếu một giá trị bắt buộc.",
  "That already exists.": "Mục này đã tồn tại.",
  "That value is not allowed.": "Giá trị này không được phép.",
  "Something went wrong on our side.": "Đã có lỗi phía chúng tôi. Vui lòng thử lại.",
  "Request failed": "Yêu cầu không thành công.",
  // Raised by the browser-side client, not the server: no answer at all, or the host's own error page.
  "Could not reach the server. Check your connection and try again.": "Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại.",
  "The server is busy or restarting. Try again in a moment.": "Máy chủ đang bận hoặc đang khởi động lại. Hãy thử lại sau ít phút.",

  // ── rules.ts / pricing.ts / helpers.ts / session.ts / router.ts
  "At least one price rule is required.": "Cần ít nhất một dòng giá.",
  "Metrics must be an object.": "Chỉ số không hợp lệ.",
  "Use a whole number.": "Vui lòng nhập số nguyên.",
  "There is no price for that slot yet — ask the desk.": "Khung giờ này chưa có giá, vui lòng hỏi lễ tân.",
  "center_settings is missing.": "Thiếu cấu hình của trung tâm.",
  "Idempotency-Key is required.": "Thiếu Idempotency-Key.",
  "Idempotency-Key was already used for a different request.": "Idempotency-Key này đã được dùng cho một yêu cầu khác.",
  "Invalid JSON body.": "Dữ liệu gửi lên không hợp lệ.",
  "That session is not valid.": "Phiên đăng nhập không hợp lệ.",
  "Your session has expired.": "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  "This account is not active.": "Tài khoản này không hoạt động.",
  "This account is locked.": "Tài khoản này đang bị khóa.",
  "Payments cannot be deleted — issue a refund instead.": "Không thể xóa thanh toán, hãy hoàn tiền.",
  "Unknown report.": "Báo cáo không hợp lệ.",

  // ── chat.ts
  "Conversation not found.": "Không tìm thấy cuộc trò chuyện.",
  "Message ID is required.": "Thiếu mã định danh tin nhắn.",
  "Message body cannot be empty.": "Nội dung tin nhắn không được để trống.",
  "Message exceeds maximum length of 2000 characters.": "Tin nhắn vượt quá giới hạn 2000 ký tự.",
  "You can only message coaches of classes you are currently enrolled in.": "Bạn chỉ có thể nhắn tin cho HLV của lớp bạn đang tham gia.",
  "Coaches can only message members enrolled in their active classes.": "HLV chỉ có thể nhắn tin cho học viên đang tham gia lớp học đang hoạt động.",
  "Recipient not found.": "Không tìm thấy người nhận.",
  "Room parameter is required.": "Thiếu tham số phòng.",
  "Peer parameter is required.": "Thiếu tham số peer.",
  "Peer ID mismatch.": "Mã peer không khớp.",
  "Not permitted in this chat room.": "Bạn không có quyền tham gia phòng chat này.",
  "Missing required signaling fields.": "Thiếu các trường tín hiệu bắt buộc.",
  "Sender ID mismatch.": "Mã người gửi không khớp.",

  // ── promos.ts (pricing of a code) and handlers/promos.ts
  "Enter a promo code.": "Vui lòng nhập mã khuyến mãi.",
  "That code is not valid.": "Mã này không hợp lệ.",
  "That code is not active yet.": "Mã này chưa có hiệu lực.",
  "That code has expired.": "Mã này đã hết hạn.",
  "That code does not apply to plans.": "Mã này không áp dụng cho gói tập.",
  "That code does not apply to courts.": "Mã này không áp dụng cho đặt sân.",
  "That code is for a different plan.": "Mã này dành cho gói tập khác.",
  "That code cannot be combined with your plan's court discount.": "Mã này không dùng chung được với ưu đãi sân của gói tập.",
  "That code has been fully used.": "Mã này đã hết lượt dùng.",
  "You have already used that code.": "Bạn đã dùng mã này rồi.",
  "Your plan's court discount is already better than that code, so it was not applied.": "Ưu đãi sân của gói tập đang tốt hơn mã này nên mã không được áp dụng.",
  "That code gives no discount on this order.": "Mã này không giảm giá cho đơn này.",
  "That promo code no longer exists.": "Mã khuyến mãi này không còn tồn tại.",
  "That date is not valid.": "Ngày không hợp lệ.",
  "Pick plans, courts or both.": "Chọn gói tập, sân hoặc cả hai.",
  "Use 3–24 letters, digits, - or _ (no spaces).": "Dùng 3-24 chữ cái, chữ số, - hoặc _ (không có dấu cách).",
  "Give the code a name.": "Vui lòng đặt tên cho mã.",
  "The name must be at most 120 characters.": "Tên tối đa 120 ký tự.",
  "Choose percent or fixed amount.": "Chọn phần trăm hoặc số tiền cố định.",
  "Pick a sport or leave it for all.": "Chọn một môn hoặc để trống cho tất cả.",
  "A percentage is at most 100.": "Phần trăm tối đa là 100.",
  "A fixed amount is a multiple of 1,000đ (BR-42).": "Số tiền cố định phải là bội số của 1.000đ.",
  "The end must be after the start.": "Thời điểm kết thúc phải sau thời điểm bắt đầu.",
  "That code already exists.": "Mã này đã tồn tại.",
  "No such code.": "Không có mã này.",
  "Status is active or paused.": "Trạng thái chỉ có thể là đang hoạt động hoặc tạm dừng.",
  "A code that has been used keeps its name — pause it and create a new one.": "Mã đã được dùng thì giữ nguyên tên, hãy tạm dừng và tạo mã mới.",
  "Nothing to change.": "Không có gì để thay đổi.",
  "scope must be plan or court.": "Phạm vi phải là gói tập hoặc sân.",

  // ── checkin.ts (QR token) and handlers/checkin.ts
  "That code has expired — ask the member to refresh it.": "Mã này đã hết hạn, hãy nhờ hội viên làm mới mã.",
  "That code was already used — ask the member to refresh it.": "Mã này đã được dùng, hãy nhờ hội viên làm mới mã.",
  "Type a name, phone number or member code.": "Nhập tên, số điện thoại hoặc mã hội viên.",
  "member_id is not valid.": "Mã hội viên không hợp lệ.",
  "More than one member matches — pick one.": "Có nhiều hội viên trùng khớp, vui lòng chọn một người.",
  "No member matches that.": "Không có hội viên nào khớp.",
  "No active membership.": "Chưa có gói tập đang hiệu lực.",
  "Choose why the code was not used.": "Vui lòng chọn lý do không dùng mã.",
  "Choose why this member may come in.": "Vui lòng chọn lý do cho hội viên này vào.",
  "That is the desk code — a member scans it, reception does not.": "Đây là mã của quầy, hội viên quét mã này, lễ tân không quét.",
  "That booking has no member to check in.": "Lượt đặt này không có hội viên để cho vào cổng.",
  "Only a confirmed booking has a check-in code.": "Chỉ lượt đặt đã xác nhận mới có mã vào cổng.",
  "Self check-in is not switched on — show your code to the front desk.": "Chưa bật tự vào cổng, vui lòng đưa mã cho lễ tân.",
  "That is not the desk code.": "Đây không phải mã của quầy.",
  "Please see the front desk — your membership needs attention.": "Vui lòng đến quầy lễ tân, gói tập của bạn cần được kiểm tra.",
  "Court not checked in: Only confirmed bookings can be checked in.": "Chưa vào sân: chỉ lượt đặt đã xác nhận mới vào cổng được.",
  "Court not checked in: Outside the check-in window of −15/+10 minutes.": "Chưa vào sân: ngoài khung giờ vào cổng (−15/+10 phút).",

  // ── auth.ts
  "Full name is required.": "Vui lòng nhập họ và tên.",
  "That phone number is not valid.": "Số điện thoại không hợp lệ.",
  "Password needs at least 8 characters, with letters and numbers.": "Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.",
  "You must accept the terms and the data-privacy notice.": "Bạn cần đồng ý điều khoản và thông báo bảo mật dữ liệu.",
  "A minor needs guardian details.": "Hội viên chưa đủ tuổi cần có thông tin người giám hộ.",
  "Date of birth is required.": "Vui lòng nhập ngày sinh.",
  "Use a date like 2010-05-31.": "Hãy nhập ngày theo dạng 2010-05-31.",
  "That date of birth is not possible.": "Ngày sinh này không hợp lệ.",
  "That phone or email already has an account.": "Số điện thoại hoặc email này đã có tài khoản.",
  "OTP (demo environment) — enter it to verify.": "Mã xác nhận (môi trường thử nghiệm), nhập mã để xác thực.",
  "We have sent you a verification code.": "Chúng tôi đã gửi mã xác thực cho bạn.",
  "Phone or OTP is missing.": "Thiếu số điện thoại hoặc mã xác nhận.",
  "No OTP request is pending.": "Chưa có yêu cầu mã xác nhận nào.",
  "Too many OTP attempts — locked for 15 minutes.": "Nhập sai mã xác nhận quá nhiều lần, khóa 15 phút.",
  "That OTP has expired.": "Mã xác nhận đã hết hạn.",
  "That OTP is not correct.": "Mã xác nhận không đúng.",
  "The new password is not valid.": "Mật khẩu mới không hợp lệ.",
  "That phone number already has an account.": "Số điện thoại này đã có tài khoản.",
  "Enter your login and password.": "Vui lòng nhập tên đăng nhập và mật khẩu.",
  "Wrong login or password.": "Sai tên đăng nhập hoặc mật khẩu.",
  "This account is locked for 15 minutes.": "Tài khoản bị khóa 15 phút.",
  "5 wrong passwords — locked for 15 minutes.": "Sai mật khẩu 5 lần, khóa 15 phút.",
  "That notification id is not valid.": "Mã thông báo không hợp lệ.",
  "Changing phone or email needs an OTP (slice 2).": "Đổi số điện thoại hoặc email cần mã xác nhận.",
  "current_password and new_password are required.": "Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.",
  "The two new passwords do not match.": "Hai mật khẩu mới không khớp.",
  "Use at least 8 characters with a letter and a number.": "Dùng ít nhất 8 ký tự, gồm chữ và số.",
  "Pick a password you have not used here before.": "Hãy chọn mật khẩu chưa dùng trước đây.",
  "That is not your current password.": "Đó không phải mật khẩu hiện tại của bạn.",

  // ── attendance.ts / reports.ts
  "The end date is before the start date.": "Ngày kết thúc trước ngày bắt đầu.",
  "Unknown sport.": "Môn thể thao không hợp lệ.",
  "class_id is not valid.": "Mã lớp không hợp lệ.",
  "Choose a member.": "Vui lòng chọn hội viên.",
  "Member not found.": "Không tìm thấy hội viên.",
  "That member is not in your classes.": "Hội viên này không thuộc lớp của bạn.",
  "Keep the note under 500 characters.": "Ghi chú tối đa 500 ký tự.",
  "Use xlsx or pdf.": "Chỉ dùng xlsx hoặc pdf.",

  // ── members.ts / staff.ts / plans.ts
  "No such member.": "Không có hội viên này.",
  "Coaches can only view members in their own classes.": "HLV chỉ xem được hội viên trong lớp của mình.",
  "Full name must be at most 120 characters.": "Họ và tên tối đa 120 ký tự.",
  "Date of birth must be a real date (YYYY-MM-DD).": "Ngày sinh phải là ngày hợp lệ (YYYY-MM-DD).",
  "Date of birth cannot be in the future.": "Ngày sinh không thể ở tương lai.",
  "Guardian name must be at most 120 characters.": "Tên người giám hộ tối đa 120 ký tự.",
  "That guardian phone number is not valid.": "Số điện thoại người giám hộ không hợp lệ.",
  "Unknown status.": "Trạng thái không hợp lệ.",
  "Unknown plan state.": "Trạng thái gói tập không hợp lệ.",
  "Choose receptionist or coach.": "Chọn lễ tân hoặc HLV.",
  "That account does not exist.": "Tài khoản này không tồn tại.",
  "You cannot change your own account here.": "Bạn không thể sửa tài khoản của chính mình tại đây.",
  "Only receptionist and coach accounts are managed from this screen.": "Màn hình này chỉ quản lý tài khoản lễ tân và HLV.",
  "Unknown role.": "Vai trò không hợp lệ.",
  "That email address is not valid.": "Địa chỉ email không hợp lệ.",
  "Pick at least one sport this coach can teach.": "Chọn ít nhất một môn HLV này có thể dạy.",
  "Use active or locked.": "Chỉ dùng đang hoạt động hoặc khóa.",
  "This coach still has classes running. Reassign them before changing the role.": "HLV này vẫn đang phụ trách lớp. Hãy chuyển lớp cho người khác trước khi đổi vai trò.",
  "A plan name is at most 80 characters.": "Tên gói tập tối đa 80 ký tự.",
  "A plan needs a name.": "Vui lòng đặt tên cho gói tập.",
  "Choose a sport.": "Vui lòng chọn môn thể thao.",
  "No such plan.": "Không có gói tập này.",
  "plan_id is required.": "Thiếu mã gói tập.",
  "That plan is no longer on sale.": "Gói tập này đã ngừng bán.",
  "Your plan is frozen — unfreeze it before buying more.": "Gói tập của bạn đang tạm khóa, hãy mở lại trước khi mua thêm.",
  "Pay to renew on your current contract.": "Thanh toán để gia hạn theo hợp đồng hiện tại.",

  // ── bookings.ts
  "No such court.": "Không có sân này.",
  "You cannot book a slot in the past.": "Bạn không thể đặt khung giờ đã qua.",
  "Walk-ins need at least 20 minutes left in the slot.": "Khách vãng lai cần còn ít nhất 20 phút trong khung giờ.",
  "That is outside opening hours.": "Khung giờ này nằm ngoài giờ mở cửa.",
  "date YYYY-MM-DD.": "Ngày phải có dạng YYYY-MM-DD.",
  "from must be YYYY-MM-DD.": "Ngày bắt đầu phải có dạng YYYY-MM-DD.",
  "days must be 1 to 62.": "Số ngày phải từ 1 đến 62.",
  "ref must be an id.": "Mã tham chiếu không hợp lệ.",
  "No such booking.": "Không có lượt đặt này.",
  "No such session.": "Không có buổi này.",
  "kind must be booking, hold, session or maintenance.": "Loại phải là đặt sân, giữ chỗ, buổi học hoặc bảo trì.",
  "court_id and start_at are required.": "Thiếu mã sân hoặc giờ bắt đầu.",
  "That court is not available.": "Sân này hiện không khả dụng.",
  "This slot clashes with a class you are in. Confirm to hold it anyway.": "Khung giờ này trùng với lớp bạn đang học. Hãy xác nhận nếu vẫn muốn giữ.",
  "Someone just took that slot.": "Vừa có người đặt khung giờ này.",
  "Pay online, or pay at the front desk — a booking cannot be marked paid from the app.": "Hãy thanh toán trực tuyến hoặc tại quầy lễ tân, không thể đánh dấu đã thanh toán ngay trong ứng dụng.",
  "That booking is no longer on hold.": "Lượt đặt này không còn được giữ.",
  "Reception is already checking the bank for this one.": "Lễ tân đang kiểm tra ngân hàng cho lượt đặt này.",
  "You have no court hours left on your plan.": "Gói tập của bạn đã hết giờ sân.",
  "No transfer was requested for this booking.": "Lượt đặt này chưa yêu cầu chuyển khoản.",
  "A booking in this state cannot be cancelled.": "Lượt đặt ở trạng thái này không thể hủy.",
  "Pick the new time.": "Vui lòng chọn giờ mới.",
  "That time is not valid.": "Giờ không hợp lệ.",
  "Only a confirmed booking that has not started can be moved.": "Chỉ lượt đặt đã xác nhận và chưa bắt đầu mới đổi được.",
  "A booking can only move to a court of the same sport.": "Chỉ được đổi sang sân cùng môn.",
  "That is the slot you already have.": "Đây chính là khung giờ bạn đang có.",
  "This slot clashes with a class you are in. Confirm to move it anyway.": "Khung giờ này trùng với lớp bạn đang học. Hãy xác nhận nếu vẫn muốn đổi.",
  "That slot is priced differently from the one you paid for. Cancel this booking and book the new slot instead.": "Khung giờ này có giá khác với khung giờ bạn đã thanh toán. Hãy hủy lượt đặt này và đặt khung giờ mới.",
  "Only confirmed bookings can be checked in.": "Chỉ lượt đặt đã xác nhận mới vào cổng được.",
  "Outside the check-in window of −15/+10 minutes.": "Ngoài khung giờ vào cổng (−15/+10 phút).",
  "Court, time, name or phone is missing.": "Thiếu sân, giờ, tên hoặc số điện thoại.",
  "Open a till shift before taking payment.": "Hãy mở ca thu ngân trước khi thu tiền.",

  // ── courts.ts
  "Cannot retire court with upcoming bookings or sessions.": "Không thể ngừng sân còn lượt đặt hoặc buổi học.",
  "Court is not retired.": "Sân chưa bị ngừng.",
  "Court code already exists.": "Mã sân này đã tồn tại.",
  "Invalid court code format. Use 2-4 uppercase letters, hyphen, 2 digits (e.g. CL-01).": "Định dạng mã sân không hợp lệ. Vui lòng dùng 2-4 chữ hoa, dấu gạch nối và 2 chữ số (ví dụ: CL-01).",
  "Cannot change court sport while it has upcoming bookings or classes.": "Không thể đổi môn thi đấu khi sân còn lượt đặt hoặc lớp học.",
  "Cannot retire the only court for a sport with active plans.": "Không thể ngừng sân duy nhất của môn đang có gói hội viên hoạt động.",

  // ── classes.ts / ops.ts (waitlist, gear, registers, support)
  "Class details are incomplete.": "Thông tin lớp chưa đầy đủ.",
  "That coach is not valid.": "HLV này không hợp lệ.",
  "That coach is not assigned to this sport.": "HLV này chưa được phân công môn này.",
  "That class is cancelled.": "Lớp này đã bị hủy.",
  "That class is not open yet.": "Lớp này chưa mở đăng ký.",
  "You need an active plan covering this sport.": "Bạn cần có gói tập đang hiệu lực áp dụng cho môn này.",
  "You have no sessions left.": "Bạn đã hết buổi tập.",
  "This clashes with another class you are in.": "Lịch này trùng với một lớp khác của bạn.",
  "Another class already uses this court on those days and hours.": "Sân này đã có lớp khác vào cùng ngày và giờ đó.",
  "This coach already teaches another class on those days and hours.": "HLV này đã dạy lớp khác vào cùng ngày và giờ đó.",
  "Every date of this class clashes with a court booking or the coach's other classes.": "Mọi buổi của lớp này đều trùng với lượt đặt sân hoặc lớp khác của HLV.",
  "You are already enrolled.": "Bạn đã đăng ký rồi.",
  "Cancel at least 4 hours before the next session.": "Vui lòng hủy trước buổi tiếp theo ít nhất 4 giờ.",
  "No such class.": "Không có lớp này.",
  "Give a reason for cancelling this session.": "Vui lòng nêu lý do hủy buổi này.",
  "Only a scheduled session can be cancelled.": "Chỉ buổi đã lên lịch mới hủy được.",
  "That session has already finished.": "Buổi này đã kết thúc.",
  "Pick the new start time.": "Vui lòng chọn giờ bắt đầu mới.",
  "The new time must be in the future.": "Giờ mới phải ở tương lai.",
  "Only a scheduled session can be moved.": "Chỉ buổi đã lên lịch mới dời được.",
  "That session has already started.": "Buổi này đã bắt đầu.",
  "That is the time it already has.": "Đây chính là giờ hiện tại của buổi.",
  "The court or the coach is busy at that time.": "Sân hoặc HLV bận vào giờ đó.",
  "Choose the new coach.": "Vui lòng chọn HLV mới.",
  "That coach already teaches this class.": "HLV này đã dạy lớp này.",
  "That coach is already the assistant.": "HLV này đã là trợ giảng.",
  "That coach is already teaching at some of this class's times (BR-26).": "HLV này đã có lịch dạy trùng với một số buổi của lớp.",
  "Status can be open, closed or cancelled.": "Trạng thái chỉ có thể là mở, đóng hoặc hủy.",
  "Publish the class before opening or closing it.": "Hãy đăng lớp trước khi mở hoặc đóng.",
  "Capacity must be a whole number from 1 to 200.": "Sức chứa phải là số nguyên từ 1 đến 200.",
  "Level is required (24 characters at most).": "Vui lòng nhập trình độ (tối đa 24 ký tự).",
  "Give a reason for cancelling this class.": "Vui lòng nêu lý do hủy lớp này.",
  "That offer has expired.": "Đề nghị này đã hết hạn.",
  "The class just filled up.": "Lớp vừa đủ chỗ.",
  "Freeze length must be 1–90 days.": "Thời gian tạm khóa phải từ 1 đến 90 ngày.",
  "Only an active plan can be frozen.": "Chỉ gói tập đang hiệu lực mới tạm khóa được.",
  "That plan is not frozen.": "Gói tập này không ở trạng thái tạm khóa.",
  "Choose the gear to rent out.": "Vui lòng chọn dụng cụ cho mượn.",
  "That member account was not found.": "Không tìm thấy tài khoản hội viên.",
  "That member account is not active.": "Tài khoản hội viên này không hoạt động.",
  "Enter the guest's phone number, or pick a member.": "Nhập số điện thoại khách hoặc chọn hội viên.",
  "That session was cancelled.": "Buổi này đã bị hủy.",
  "Nothing to save.": "Không có gì để lưu.",
  "This register closed 2 hours after the session. Ask a manager to correct it.": "Sổ điểm danh đã đóng sau buổi học 2 giờ. Hãy nhờ quản lý chỉnh sửa.",
  "Say why this closed register is being changed.": "Vui lòng nêu lý do sửa sổ điểm danh đã đóng.",
  "Type a question first.": "Vui lòng nhập câu hỏi trước.",
  "The message is empty.": "Tin nhắn đang trống.",
  "Write a reply first.": "Vui lòng viết phản hồi trước.",

  // ── desk.ts / online.ts
  "A till shift is already open.": "Đã có một ca thu ngân đang mở.",
  "No till shift is open.": "Chưa có ca thu ngân nào đang mở.",
  "cash_declared_vnd is required.": "Vui lòng nhập số tiền mặt kiểm đếm.",
  "That shift is already closed.": "Ca này đã đóng.",
  "ref_type, ref_id, method and amount_vnd are required.": "Thiếu loại, mã tham chiếu, phương thức hoặc số tiền.",
  "Enter an amount above zero, in whole đồng.": "Nhập số tiền lớn hơn 0, tính theo đồng.",
  "The front desk needs an open shift.": "Lễ tân cần mở ca trước.",
  "This plan is frozen — unfreeze it before taking payment.": "Gói tập này đang tạm khóa, hãy mở lại trước khi thu tiền.",
  "That plan is not waiting for payment.": "Gói tập này không ở trạng thái chờ thanh toán.",
  "This plan order is already paid for.": "Đơn gói tập này đã được thanh toán.",
  "amount_vnd must not be zero.": "Số tiền không được bằng 0.",
  "That row is already a refund.": "Dòng này đã là khoản hoàn tiền.",
  "This payment has already been refunded in full.": "Khoản thanh toán này đã được hoàn tiền đủ.",
  "That refund does not exist.": "Khoản hoàn tiền này không tồn tại.",
  "That refund is no longer waiting for a decision.": "Khoản hoàn tiền này không còn chờ duyệt.",
  "You raised this refund, so someone else has to sign it off.": "Bạn là người tạo khoản hoàn tiền này nên cần người khác duyệt.",
  "The note must be at most 500 characters.": "Ghi chú tối đa 500 ký tự.",
  "That order is no longer waiting for payment.": "Đơn này không còn chờ thanh toán.",
  "Money has already been taken against this order — refund it first.": "Đơn này đã thu tiền, hãy hoàn tiền trước.",
  "Use a date like 2026-03-31.": "Dùng ngày dạng 2026-03-31.",
  "Unknown payment method.": "Phương thức thanh toán không hợp lệ.",
  "items[] is required.": "Thiếu danh sách dòng giá.",
  "Unknown person.": "Người này không hợp lệ.",
  "That booking no longer exists.": "Lượt đặt này không còn tồn tại.",
  "That plan order no longer exists.": "Đơn gói tập này không còn tồn tại.",
  "Online payment is not switched on for this centre.": "Trung tâm chưa bật thanh toán trực tuyến.",
  "ref_id is required.": "Thiếu mã tham chiếu.",
  "That booking is not waiting for payment.": "Lượt đặt này không chờ thanh toán.",
  "Ask the front desk to take payment for a plan.": "Vui lòng nhờ lễ tân thu tiền gói tập.",
  "Online payment covers courts and plans.": "Thanh toán trực tuyến áp dụng cho sân và gói tập.",
  "There is nothing to pay.": "Không có gì cần thanh toán.",
  "Could not start the online payment. Take it at the desk instead.": "Không thể bắt đầu thanh toán trực tuyến. Vui lòng thanh toán tại quầy.",
  "That payment was not taken online.": "Khoản thanh toán này không phải thanh toán trực tuyến.",

  // ── training.ts
  "Class not found.": "Không tìm thấy lớp.",
  "That class is not yours.": "Lớp này không phải của bạn.",
  "Student not found.": "Không tìm thấy học viên.",
  "That student is not in your classes.": "Học viên này không thuộc lớp của bạn.",
  "Write something first.": "Vui lòng viết nội dung trước.",
  "Keep a note under 2000 characters.": "Ghi chú tối đa 2000 ký tự.",
  "A review covers 2 or 4 weeks.": "Đánh giá áp dụng cho 2 hoặc 4 tuần.",
  "Keep the comment under 2000 characters.": "Nhận xét tối đa 2000 ký tự.",
  "Give the homework a title.": "Vui lòng đặt tiêu đề cho bài tập.",
  "Keep the title under 120 characters.": "Tiêu đề tối đa 120 ký tự.",
  "Keep the description under 4000 characters.": "Mô tả tối đa 4000 ký tự.",
  "A checklist is up to 20 short items.": "Danh sách việc cần làm tối đa 20 mục ngắn.",
  "Use a date like 2026-10-12.": "Dùng ngày dạng 2026-10-12.",
  "Use a date like 2026-10-05.": "Dùng ngày dạng 2026-10-05.",
  "The due date is already past.": "Hạn nộp đã qua.",
  "Choose either a class or one student.": "Chọn một lớp hoặc một học viên.",
  "This class has no confirmed students yet.": "Lớp này chưa có học viên được xác nhận.",
  "That homework is not yours.": "Bài tập này không phải của bạn.",
  "A plan needs its blocks.": "Giáo án cần có các phần.",
  "Add at least one block to the plan.": "Thêm ít nhất một phần cho giáo án.",
  "A plan has at most 12 blocks.": "Giáo án tối đa 12 phần.",
  "A template is not tied to a class, student or session.": "Mẫu không gắn với lớp, học viên hay buổi học.",
  "Choose a class or a student for this plan.": "Chọn lớp hoặc học viên cho giáo án này.",
  "A session plan belongs to a class.": "Giáo án theo buổi thuộc về một lớp.",
  "That session is not in this class.": "Buổi này không thuộc lớp này.",
  "That plan is not yours.": "Giáo án này không phải của bạn.",
  "That session already has results, so its plan can no longer change. Copy it to a new session instead.": "Buổi này đã có kết quả nên không thể sửa giáo án nữa. Hãy sao chép sang một buổi mới.",
  "A template is not published to students.": "Mẫu không được đăng cho học viên.",
  "That template does not exist.": "Mẫu này không tồn tại.",
  "That session already has results — a plan can no longer be added.": "Buổi này đã có kết quả, không thể thêm giáo án nữa.",
  "That session already has results - a plan can no longer be added.": "Buổi này đã có kết quả, không thể thêm giáo án nữa.",
  // ── deposits, fixed bookings, points, commission, maintenance
  "None of those weeks is free.": "Không có tuần nào còn trống.",
  "A month can be closed only after it has ended.": "Chỉ chốt được tháng đã kết thúc.",
  "Close the month first.": "Hãy chốt tháng trước.",
  "That fixed booking is already cancelled.": "Lịch cố định này đã bị hủy.",
  "That month is already paid.": "Tháng này đã được trả.",
  "A later cancellation cannot be refunded more than an earlier one.": "Hủy muộn hơn không được hoàn nhiều hơn hủy sớm.",
  "A refund must be a whole percentage from 0 to 100.": "Mức hoàn phải là số nguyên từ 0 đến 100 (%).",
  "Add between 1 and 6 cancellation steps.": "Hãy thêm từ 1 đến 6 mức hủy.",
  "Hours must be a whole number from 0 to 720.": "Số giờ phải là số nguyên từ 0 đến 720.",
  "The last step must start at 0 hours, so every cancellation is covered.": "Mức cuối phải bắt đầu từ 0 giờ để bao phủ mọi trường hợp hủy.",
  "Two steps cannot start at the same number of hours.": "Hai mức không được có cùng số giờ.",
  "Enter the cost in whole đồng.": "Nhập chi phí bằng số đồng nguyên.",
  "Pick a court.": "Hãy chọn sân.",
  "Pick the first date.": "Hãy chọn ngày đầu tiên.",
  "Enter the customer's name.": "Nhập tên khách.",
  "Say why.": "Hãy ghi lý do.",
  "Pick a month.": "Hãy chọn tháng.",
  "Phone number is required.": "Cần nhập số điện thoại.",
  "Enter a whole number of points, not zero.": "Nhập số điểm nguyên, khác 0.",
  "You do not have that many points.": "Bạn không có nhiều điểm như vậy.",
  "Pick low, normal or urgent.": "Chọn mức thấp, bình thường hoặc khẩn cấp.",
  "Pick a start time like 19:00.": "Chọn giờ bắt đầu, ví dụ 19:00.",
  "Keep the title under 160 characters.": "Tiêu đề không quá 160 ký tự.",
  "Say what is broken.": "Hãy cho biết cái gì bị hỏng.",
  "Pick a date.": "Hãy chọn ngày.",
  "No such coach.": "Không có huấn luyện viên này.",
  "Pick a valid date range.": "Hãy chọn khoảng ngày hợp lệ.",
  "Pick cash, card or transfer.": "Chọn tiền mặt, thẻ hoặc chuyển khoản.",
  "period must be YYYY-MM.": "Tháng phải có dạng YYYY-MM.",
  "Nothing left to pay on this booking.": "Lượt đặt này không còn khoản nào cần trả.",
  "Only a confirmed booking has a balance to collect.": "Chỉ lượt đặt đã xác nhận mới có khoản còn lại để thu.",
  "The maximum cannot be below the minimum.": "Mức tối đa không được nhỏ hơn mức tối thiểu.",
};

/** For messages that carry numbers or names: [regex over the English, Vietnamese with $1, $2…]. */
const P: [RegExp, string][] = [
  [/^That pass is only valid on (\d{4}-\d{2}-\d{2})\.$/, "Vé này chỉ dùng được vào ngày $1."],
  [/^Redeem at least (\d+) points\.$/, "Hãy đổi ít nhất $1 điểm."],
  [/^A fixed booking runs (\d+)–(\d+) weeks\.$/, "Đặt cố định kéo dài từ $1 đến $2 tuần."],
  // ── rules.ts price rows (src/lib/arena3/rules.ts)
  [/^Row (\d+): unknown sport\.$/, "Dòng $1: môn thể thao không hợp lệ."],
  [/^Row (\d+): day kind must be weekday, weekend or holiday\.$/, "Dòng $1: loại ngày phải là ngày thường, cuối tuần hoặc ngày lễ."],
  [/^Row (\d+): times must be HH:MM\.$/, "Dòng $1: giờ phải có dạng HH:MM."],
  [/^Row (\d+): the end time must be after the start time\.$/, "Dòng $1: giờ kết thúc phải sau giờ bắt đầu."],
  [
    /^Row (\d+): price must be a whole amount above 0đ and at most ([\d,]+)đ per slot\.$/,
    "Dòng $1: giá phải là số nguyên lớn hơn 0đ và tối đa $2đ mỗi khung giờ.",
  ],
  [/^Row (\d+) overlaps row (\d+) for the same sport and day\.$/, "Dòng $1 trùng với dòng $2 (cùng môn và cùng ngày)."],
  // metrics (rules.ts), bare and prefixed with the register row (training.ts "Row N: …")
  [/^"(.+)" is not a metric we record\.$/, "\"$1\" không phải chỉ số được ghi nhận."],
  [/^Must be between 0 and (\d+)\.$/, "Phải nằm trong khoảng 0 đến $1."],
  [/^Row (\d+): "(.+)" is not a metric we record\.$/, "Dòng $1: \"$2\" không phải chỉ số được ghi nhận."],
  [/^Row (\d+): Use a whole number\.$/, "Dòng $1: vui lòng nhập số nguyên."],
  [/^Row (\d+): Must be between 0 and (\d+)\.$/, "Dòng $1: phải nằm trong khoảng 0 đến $2."],
  [/^Row (\d+): Metrics must be an object\.$/, "Dòng $1: chỉ số không hợp lệ."],

  // ── training.ts / ops.ts rows and blocks
  [/^Row (\d+): missing student\.$/, "Dòng $1: thiếu học viên."],
  [/^Row (\d+): result must be present, late, absent or excused\.$/, "Dòng $1: kết quả phải là có mặt, đến muộn, vắng hoặc có phép."],
  [/^Row (\d+): that student is not in this class\.$/, "Dòng $1: học viên này không thuộc lớp."],
  [/^Row (\d+): plan completion is a whole number from 0 to 100\.$/, "Dòng $1: mức hoàn thành giáo án là số nguyên từ 0 đến 100."],
  [/^Row (\d+): keep a note under (\d+) characters\.$/, "Dòng $1: ghi chú tối đa $2 ký tự."],
  [/^Block (\d+) needs a title\.$/, "Phần $1 cần có tiêu đề."],
  [/^Block (\d+): keep the title under (\d+) characters\.$/, "Phần $1: tiêu đề tối đa $2 ký tự."],
  [/^Block (\d+): minutes is a whole number from (\d+) to (\d+)\.$/, "Phần $1: số phút là số nguyên từ $2 đến $3."],
  [/^Block (\d+) needs a type \(warm-up, technique…\)\.$/, "Phần $1 cần có loại (khởi động, kỹ thuật…)."],
  [/^Block (\d+) needs an intensity\.$/, "Phần $1 cần có cường độ."],
  [/^Block (\d+) needs a short description of how it runs\.$/, "Phần $1 cần có mô tả ngắn về cách thực hiện."],
  [/^Block (\d+): keep (\w+) under (\d+) characters\.$/, "Phần $1: $2 tối đa $3 ký tự."],
  [/^The blocks add up to (\d+) min but the session is (\d+) min\.$/, "Các phần cộng lại là $1 phút nhưng buổi học dài $2 phút."],

  // ── bookings.ts / classes.ts / ops.ts / desk.ts / online.ts / promos.ts numbers and names
  [/^You can book at most (\d+) days ahead\.$/, "Bạn chỉ có thể đặt trước tối đa $1 ngày."],
  [/^You can hold at most (\d+) slots a day\.$/, "Bạn chỉ có thể giữ tối đa $1 khung giờ mỗi ngày."],
  [/^A booking can only be moved up to (\d+) hours before it starts\.$/, "Chỉ có thể đổi lượt đặt trước giờ bắt đầu tối đa $1 giờ."],
  [/^status must be one of (.+)\.$/, "Trạng thái phải là một trong: $1."],
  [/^This session starts in under (\d+) hours — give a reason to move it\.$/, "Buổi này bắt đầu trong chưa đầy $1 giờ, vui lòng nêu lý do dời buổi."],
  [/^(\d+) members are already enrolled — capacity cannot go below that\.$/, "Đã có $1 hội viên đăng ký, sức chứa không thể thấp hơn số này."],
  [/^Over the limit of (\d+) freeze days a year\.$/, "Vượt giới hạn $1 ngày tạm khóa mỗi năm."],
  [/^Only (\d+) (.+) left — you asked for (\d+)\.$/, "Chỉ còn $1 $2, bạn yêu cầu $3."],
  [/^A renewal is one full period: ([\d,]+)đ\.$/, "Gia hạn là một kỳ đầy đủ: $1đ."],
  [/^A plan is paid in full: ([\d,]+)đ\. Partial payments are not taken\.$/, "Gói tập thanh toán đủ một lần: $1đ. Không nhận thanh toán một phần."],
  [/^The refund is larger than the ([\d,]+)đ still refundable\.$/, "Số tiền hoàn lớn hơn $1đ còn có thể hoàn."],
  [/^Online payment does not cover (.+)\.$/, "Thanh toán trực tuyến không áp dụng cho $1."],
  [/^That code needs an order of at least ([\d,]+)đ\.$/, "Mã này cần đơn tối thiểu $1đ."],
  [/^Code (.+) was just fully used — price the order again\.$/, "Mã $1 vừa hết lượt dùng, hãy tính lại giá đơn."],
  [/^You have already used (.+)\.$/, "Bạn đã dùng $1 rồi."],
  [/^"(.+)" is not something a code can apply to\.$/, "Mã không áp dụng được cho \"$1\"."],
  [/^(.+) is not a sport we run\.$/, "$1 không phải môn thể thao của trung tâm."],
  [/^Pick a period of at most (\d+) days\.$/, "Vui lòng chọn khoảng thời gian tối đa $1 ngày."],
  [/^Feature (\w+) is switched off\.$/, "Tính năng $1 đang tắt."],
  [/^Order code (\d+) is outside the range the gateway accepts\.$/, "Mã đơn $1 nằm ngoài phạm vi cổng thanh toán chấp nhận."],
  [/^No route for (\S+) (.+)$/, "Không tìm thấy đường dẫn $1 $2."],
  [/^Court not checked in: (.+)$/, "Chưa vào sân: $1"],

  // ── generic field messages: the field name is the API's own (limit, offset, sport, …)
  [/^(\w+) must be one of: (.+)\.$/, "$1 phải là một trong: $2."],
  [/^(\w+) must be a whole number from (\d+) to (\d+)\.$/, "$1 phải là số nguyên từ $2 đến $3."],
  [/^(\w+) is a score from 1 to 5\.$/, "$1 là điểm từ 1 đến 5."],
  [/^(\w+) is required\.$/, "Thiếu $1."],

  // ── attendance.ts at-risk reasons and check-in warnings (handlers/checkin.ts)
  [/^Absent (\d+) sessions in a row without an excuse\.$/, "Vắng $1 buổi liên tiếp không phép."],
  [/^No visit or class in (\d+)\+ days\.$/, "Không đến tập hay học lớp nào trong $1+ ngày."],
  [/^Plan ends (\S+) and attendance is (\d+)%\.$/, "Gói tập hết hạn ngày $1 và tỷ lệ tham gia là $2%."],
  [/^(.+) is frozen\.$/, "$1 đang tạm khóa."],
  [/^(.+) ended (\d+) days? ago\.$/, "$1 đã hết hạn $2 ngày trước."],
  [/^(.+) starts on (\S+)\.$/, "$1 bắt đầu từ ngày $2."],
  [/^(.+) ends in (\d+) days?\.$/, "$1 sẽ hết hạn sau $2 ngày."],
  [/^(.+) has no sessions left\.$/, "$1 đã hết buổi."],
];

/* ── Generated patterns ─────────────────────────────────────────────────────
 * Validation messages start with a field label from a small fixed set (validate.ts SETTING_LABEL and
 * the labels passed to parseInteger by the plan / promo / gear / report handlers). A pattern's
 * replacement cannot translate a captured label, so one pattern is built per label here.
 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lower = (s: string) => s.charAt(0).toLocaleLowerCase("vi-VN") + s.slice(1);
const NUM = "[\\d,.]+";

const INT_LABELS: Record<string, string> = {
  "Hold length": "Thời gian giữ sân",
  "Book-ahead window": "Số ngày đặt trước",
  "Slots per day": "Số khung giờ mỗi ngày",
  "Court cancellation window": "Hạn hủy đặt sân",
  "Class cancellation window": "Hạn hủy lớp",
  "No-show grace": "Thời gian chờ khi vắng mặt",
  "Check-in window": "Khung giờ vào cổng",
  "Gate repeat window": "Khoảng chặn quẹt lặp",
  "At-risk idle days": "Số ngày vắng (sắp rời bỏ)",
  "Refund approval threshold": "Ngưỡng duyệt hoàn tiền",
  "Minor age": "Tuổi vị thành niên",
  "Freeze cap": "Số ngày tạm khóa tối đa",
  "Waitlist offer window": "Thời hạn nhận suất chờ",
  Price: "Giá",
  Duration: "Thời hạn",
  "Class sessions": "Số buổi lớp",
  "Court hours": "Số giờ sân",
  "Court discount": "Giảm giá sân",
  Value: "Giá trị",
  "Max discount": "Giảm tối đa",
  "Minimum order": "Đơn tối thiểu",
  "Total uses": "Tổng lượt dùng",
  "Uses per member": "Lượt dùng mỗi hội viên",
  Quantity: "Số lượng",
  "Page size": "Số dòng mỗi trang",
};
const TIME_LABELS: Record<string, string> = { "Opening time": "Giờ mở cửa", "Closing time": "Giờ đóng cửa" };
const TEXT_LABELS: Record<string, string> = { "Legal name": "Tên pháp lý", "Tax code": "Mã số thuế", Address: "Địa chỉ" };
const DEC_LABELS: Record<string, string> = { "VAT rate": "Thuế VAT" };
const BOOL_LABELS: Record<string, string> = { "Self check-in": "Tự vào cổng" };
const SPORT_VI: Record<string, string> = { badminton: "cầu lông", basketball: "bóng rổ", volleyball: "bóng chuyền" };
const WHAT_VI: Record<string, string> = {
  requests: "yêu cầu",
  "profile updates": "lần cập nhật hồ sơ",
  "password changes": "lần đổi mật khẩu",
  questions: "câu hỏi",
  "plan requests": "yêu cầu gói tập",
};

const G: [RegExp, string][] = [];
for (const [en, vi] of Object.entries(INT_LABELS)) {
  const e = esc(en);
  G.push([new RegExp(`^${e} is required\\.$`), `Vui lòng nhập ${lower(vi)}.`]);
  G.push([new RegExp(`^${e} must be a whole number\\.$`), `${vi} phải là số nguyên.`]);
  G.push([new RegExp(`^${e} must be between (${NUM}) and (${NUM})\\.$`), `${vi} phải nằm trong khoảng $1 đến $2.`]);
}
for (const [en, vi] of Object.entries(DEC_LABELS)) {
  const e = esc(en);
  G.push([new RegExp(`^${e} is required\\.$`), `Vui lòng nhập ${lower(vi)}.`]);
  G.push([new RegExp(`^${e} must be a number\\.$`), `${vi} phải là một số.`]);
  G.push([new RegExp(`^${e} must be between (${NUM}) and (${NUM})\\.$`), `${vi} phải nằm trong khoảng $1 đến $2.`]);
}
for (const [en, vi] of Object.entries(TIME_LABELS)) {
  G.push([new RegExp(`^${esc(en)} must be a time like 06:00\\.$`), `${vi} phải có dạng giờ như 06:00.`]);
}
for (const [en, vi] of Object.entries(BOOL_LABELS)) {
  G.push([new RegExp(`^${esc(en)} must be on or off\\.$`), `${vi} chỉ có thể bật hoặc tắt.`]);
}
for (const [en, vi] of Object.entries(TEXT_LABELS)) {
  const e = esc(en);
  G.push([new RegExp(`^${e} must be text\\.$`), `${vi} phải là văn bản.`]);
  G.push([new RegExp(`^${e} must be at most (\\d+) characters\\.$`), `${vi} tối đa $1 ký tự.`]);
}
G.push([/^Closing time must be after opening time\.$/, "Giờ đóng cửa phải sau giờ mở cửa."]);
for (const [en, vi] of Object.entries(SPORT_VI)) {
  G.push([new RegExp(`^That code is only for ${en}\\.$`), `Mã này chỉ dành cho môn ${vi}.`]);
}
// ratelimit.ts: "Too many {what} — try again in {n} seconds|minute(s)."
for (const [en, vi] of Object.entries(WHAT_VI)) {
  const e = esc(en);
  G.push([new RegExp(`^Too many ${e} — try again in (\\d+) seconds\\.$`), `Bạn gửi quá nhiều ${vi}, vui lòng thử lại sau $1 giây.`]);
  G.push([new RegExp(`^Too many ${e} — try again in (\\d+) minutes?\\.$`), `Bạn gửi quá nhiều ${vi}, vui lòng thử lại sau $1 phút.`]);
}

export const VI_SERVER_PATTERNS: [RegExp, string][] = [...G, ...P];
