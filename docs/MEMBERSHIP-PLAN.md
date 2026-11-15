# Kế hoạch: một gói hội viên, khóa học, đặt sân

Trạng thái: đã duyệt và đã làm trên cây làm việc, chưa commit. Không commit khi chưa được yêu cầu. Không sửa `vi.srv.ts`, `vi.public.ts`.

## Quy tắc đã chốt

- Mỗi tài khoản một gói. Các gói chỉ khác thời hạn. Gia hạn cộng tiếp; đã hết hạn thì tính từ ngày kích hoạt mới.
- Khóa học thu học phí riêng. Hạn hội viên phải phủ tới ngày kết thúc khóa; thiếu thì thu theo đơn giá ngày.
- Có gói còn hạn vào ngày chơi: 30.000đ/sân/giờ, mọi khung giờ. Không có: giá niêm yết.
- Không giữ sân chồng lấn thời gian. Trả trước. Khách hủy hoặc không đến thì mất tiền. Trung tâm hủy thì hoàn tiền hoặc đổi lịch nếu khách đồng ý.
- 5 cách vá: tính phí khi có khoảng trống trước khóa; hoàn phần gia hạn khi trung tâm hủy khóa; dời ngày kết thúc thì gia hạn miễn phí; gợi ý gói nếu mua lẻ đắt hơn; khách tự hủy khóa không hoàn tiền.

## Giai đoạn 1: Dữ liệu (cần duyệt migration và seed)

`migrations/0051_single_membership.sql`:

1. Tạo 4 gói mới, thời hạn tính theo ngày dương lịch của tháng; ngừng bán các gói cũ nhưng giữ lịch sử.
2. Thêm cài đặt `member_court_fee_vnd = 30000`, `member_day_rate_vnd = 16667`.
3. Tạo bảng `membership_extensions`: `subscription_id`, `enrollment_id`, `from_on`, `to_on`, `amount_vnd`, `status`. Đây là phần gia hạn tách riêng, dùng để tính hoàn tiền.
4. Gộp mỗi người còn một gói live (xem "Việc cần quyết" mục 1).
5. Thay `one_live_sub_per_scope`, `one_pending_sub_per_scope` bằng index duy nhất theo `user_id`.
6. Không xóa cột `sport_scope`, `session_left`, `court_discount_pct`: code ngừng dùng, dữ liệu cũ vẫn đọc được.

Chạy thử trên bản sao dữ liệu trước. `.pglite.bak-20261104/` là bản sao lưu cũ, không đụng vào.

## Giai đoạn 2: Gói hội viên

- Tạo `src/lib/arena3/membership.ts`: `coverageOn(date)`, `quoteExtension(targetEnd)`, `applyExtension()`, `rollbackExtension()`, kèm test đơn vị.
- `plans.ts`: `subscriptionsCreate` bỏ phân biệt theo môn; form quản lý chỉ còn tên, thời hạn, giá, trạng thái bán.
- `desk.ts`: `activateSubscription` chỉ còn hai nhánh (còn hạn thì cộng tiếp, hết hạn thì tính lại từ ngày kích hoạt). Bỏ nhánh đổi gói, số buổi, giờ sân.
- `ops.ts`: không cho đóng băng khi hội viên có khóa đang diễn ra hoặc sắp diễn ra.
- Trợ lý (`ops.ts`), `auth.ts`, `members.ts`, `labels.ts`: bỏ hiển thị số buổi và theo môn.

## Giai đoạn 3: Khóa học

- `classes.ts`, `classesEnroll`: trả về báo giá gồm học phí, phí gia hạn, hạn mới. Tính lại lúc thanh toán, kể cả khi đến lượt từ danh sách chờ.
- `desk.ts` và luồng thanh toán online: số tiền phải thu = học phí + phí gia hạn, với hai dòng riêng trên hóa đơn.
- `settleEnrollment`: áp phần gia hạn cùng transaction với việc xác nhận chỗ.
- `enrollmentDelete`: khách tự hủy thì không hoàn tiền; bỏ `returnPrepaidSession` và `prepaid_sessions` khỏi luồng mới.
- `classesPatch`: trung tâm hủy khóa thì hoàn học phí và phần gia hạn chưa dùng, không cắt phần khóa khác còn cần. Dời `end_on` thì tự gia hạn miễn phí.

## Giai đoạn 4: Đặt sân

Mỗi lượt đặt là một ô giờ, nên giá xét theo từng ô; phí tính theo `slot_minutes / 60`.

- `bookings.ts`, `bookingsHold` và `walkIn`: dùng phí hội viên nếu gói phủ ngày chơi, không thì giá niêm yết. Sửa chỗ đang ghi mọi lượt đều tính giá ô.
- Gói không phủ ngày chơi: trả về cả hai lựa chọn, gia hạn hoặc trả giá thường.
- Thêm kiểm tra chống chồng lấn trong transaction, có khóa theo user để chống hai lần bấm cùng lúc.
- `bookingsCancel` và `bookingsCancelQuote`: khách hủy thì hoàn 0đ; trung tâm hủy dùng cờ `waive`, hoàn 100%.
- Tắt đặt cọc cho lượt đặt của khách, vì phải trả trước toàn bộ.
- `bookingsReschedule`: tính lại giá theo ngày mới.

## Giai đoạn 5: Giao diện và tài liệu

- `app.plans.tsx`, `app.book.tsx`, `app.index.tsx`, trang khóa học: một gói, một ngày hết hạn, danh sách khóa; báo giá trước khi trả tiền; cảnh báo không hoàn tiền.
- `manager.plans.tsx`, `manager.prices.tsx`, `manager.members.tsx`, `desk.gate.tsx`, `desk.index.tsx`, `desk.member.$id.tsx`, `desk.payments.tsx`: bỏ theo môn, số buổi; thêm hai cài đặt mới.
- Chuỗi mới vào `vi.member.ts`, `vi.core.ts`, `vi.desk.ts`.
- `docs/SRS.md`: sửa FR-C02, FR-C03, BR-19, BR-20.

## Kiểm tra

- `npx tsc --noEmit`, `npm test`, `npm run build`; sửa `tx.test.ts` theo quy tắc mới.
- Test bắt buộc: ví dụ 30/11 → 31/01 rồi khóa 15/01 không thu thêm; hai khóa trùng không cộng trùng; khoảng trống trước khóa; hoàn phần gia hạn khi còn khóa khác; hai lần bấm đặt sân chồng lấn; hết hạn trước ngày chơi; thanh toán trùng.
- Chạy thử trên trình duyệt với vai trò hội viên, lễ tân, quản lý; chụp màn hình; Impeccable `detect --json` một lần.

## Việc cần quyết

1. **Khách đang có gói cũ** (đề xuất): quy phần tiền còn lại thành ngày hội viên, cộng dồn vào một gói: `đã trả × ngày còn lại ÷ tổng ngày ÷ 16.667`. Ai muốn thì hoàn tiền mặt tại quầy. Gói theo buổi tính theo số buổi chưa dùng.
2. **Giá 4 gói** đang là giá minh họa: 500.000đ, 1.350.000đ, 2.400.000đ, 4.200.000đ.
3. **Mã khuyến mãi** (đề xuất): dùng cho gói và học phí, không dùng cho mức 30.000đ.

## Chưa đọc kỹ, phải đọc trước khi sửa

Luồng tạo link thanh toán online cho khóa học; cách `bookingsReschedule` xử lý chênh lệch tiền; các kiểm tra ở `desk.gate.tsx`.

## Thay đổi sau khi duyệt (06/11/2026)

Chỉ được đăng ký khóa học nếu gói đang hoạt động kết thúc sau ngày kết thúc khóa. Bỏ thu tiền gia hạn theo ngày khi đăng ký; phần nói về đơn giá ngày ở trên không còn áp dụng cho đăng ký mới.
