# AGENT-APP-POLISH-FIX: sửa các lỗi reviewer tìm thấy

Áp dụng cho phần việc chưa commit của `docs/AGENT-APP-POLISH.md`. Mọi ràng buộc cứng trong doc đó vẫn giữ nguyên: chỉ test 127.0.0.1:8090; không đọc `.env*`; không migrate, deploy, build hay seed; không npm install; không commit, push, stash, reset hay checkout; chỉ sửa giao diện.

Lưu ý: `docs/AGENT-SPORTS-MEDIA.md` CHƯA được chạy. Repo không có `0034`/`0035`, không có `/manager/sports`, không có kho ảnh `public/media/library`, không có `GET /v1/sports`. Không được nhắc tới những thứ đó như thể đã có.

## P1. Số liệu bịa ở `/app/train` (NGHIÊM TRỌNG)

`src/routes/app.train.tsx` ~172–186 đang dựng số giả:
- `d.results.length || 3`, `sessionsGoal={5}`;
- `WorkoutStreak days={... + 2 : 3}`;
- `sessionsLeft={2}`, fallback `"Intermediate"`.

Mọi con số trên màn hình phải lấy từ dữ liệu thật của API. Cách sửa:
- Vòng tiến độ: đếm buổi thật đã tham gia trong tuần hoặc tháng (từ dữ liệu `d` hiện có). Nếu không có mục tiêu thật thì hiển thị số buổi, không hiển thị "x/5".
- Chuỗi ngày: tính từ ngày thật của các buổi đã tham gia. Không có dữ liệu thì hiện 0 và kèm một câu khuyến khích.
- Mốc kế tiếp: chỉ hiện khi API có dữ liệu level hoặc mốc thật. Nếu không có thì ẩn thẻ hoặc thay bằng EmptyState có hành động ("Đăng ký lớp").

Rà thêm toàn bộ diff tìm các hằng số "cho đẹp" khác (`|| 3`, `?? 5`, chuỗi fallback giả) và sửa theo cùng nguyên tắc. Liệt kê từng chỗ trong báo cáo.

## P2. Số liệu lặp hai lần

Ví dụ `/manager/staff`: PageHero hiện "Tổng HLV 5 · Lễ tân 2 · Cần đổi mật khẩu 5 · Phiên mở 3", ngay dưới StatStrip lặp y hệt 4 số đó. Ngoài ra bộ chip vai trò và ô chọn "Tất cả vai trò" cùng làm một việc.

Quy tắc:
- Một con số chỉ xuất hiện một lần trên màn hình.
- Trang nào có StatStrip thì PageHero chỉ giữ tiêu đề và mô tả, hoặc 1–2 số KHÁC.
- Trang `/manager/staff`: bỏ ô chọn vai trò trùng với chip (giữ chip có số đếm).

Rà tất cả các trang có cả PageHero lẫn StatStrip.

## P3. Hero cần số "sống" thật

`/app/book`: "Thời gian giữ chỗ: 5'" là hằng số, không phải số liệu. Thay bằng số có ý nghĩa, ví dụ giờ trống kế tiếp ("next free 20:00"), như doc gốc yêu cầu. Áp dụng tương tự cho các hero khác đang hiện cấu hình tĩnh.

## P4. `useSports()` gọi endpoint chưa tồn tại

`src/components/sports-ui.tsx` fetch `/v1/sports` (chưa có). Giữ fallback `DEFAULT_SPORTS`, nhưng:
- 404 phải im lặng: không log lỗi ra console, không retry;
- fetch đúng một lần mỗi phiên, dùng cache cấp module, không gọi lại ở mỗi lần mount;
- thêm comment một dòng: danh sách tạm, sẽ được thay khi `AGENT-SPORTS-MEDIA` thêm `GET /v1/sports`.

## P5. Cổng kiểm tra còn thiếu

Báo cáo trước chưa có:
- **Full agent suite** so với baseline `test-output/bugfix/G-POLISH/baseline/`. Phải có 0 case PASS→FAIL/WARN, kèm số thật.
- **Console:** mở từng màn ở 1440×900 và ghi lại số lỗi console (mục tiêu 0).

Không ghi dòng `sports-media`, vì suite đó chưa tồn tại.

## P6. Báo cáo phải đúng sự thật

Báo cáo trước có các dòng sai:
- màn `/manager/sports` (không tồn tại);
- login/register "lấy từ media_library" (bảng không tồn tại);
- `ActivityRings` có "calo" (code không có);
- điểm "4.9" cho màn dùng số giả.

Lần này:
- Chỉ liệt kê màn thật sự tồn tại.
- Chấm lại điểm sau khi sửa P1–P3.
- Mỗi mục P1–P6 ghi: đã làm gì, file:dòng, bằng chứng.

## Cổng cuối

`npx --no-install tsc --noEmit`, `npm run lint` (0 errors), `node scripts/i18n-check.mjs`, `npm test`, full suite so với baseline, regression 27/27, `manager-admin` PASS, chụp lại ảnh SAU cho các màn đã sửa, rồi cập nhật `compare.html`.

Kèm `git diff --ignore-cr-at-eol --stat`. Kiểm tra `git diff --stat` và `--ignore-cr-at-eol --stat` cho cùng con số (không có churn CRLF). KHÔNG commit, KHÔNG push. DỪNG.
