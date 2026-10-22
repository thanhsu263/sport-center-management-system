# AGENT-APP-POLISH: các trang trong app đầy đặn và có hồn như landing

Chạy SAU khi `AGENT-SPORTS-MEDIA` đã được review và push, vì doc này dùng kho ảnh `media_library`, các slot `banner.*` và hook `useSports()`.

Đọc `DESIGN.md` (hướng "Floodlit Hall", các token, mục "Effect library") và `PRODUCT.md` trước. Hai file đó thắng nếu có mâu thuẫn với doc này.

## Ràng buộc cứng

- Giữ nguyên các ràng buộc của `docs/AGENT-SPORTS-MEDIA.md`: chỉ test 127.0.0.1:8090; không đọc `.env*`; không migrate, deploy, build hay seed; không npm install; không commit hay push; không sửa migration cũ.
- Đây là task **giao diện**. Không đổi hành vi API ghi. Chỉ được thêm field chỉ-đọc vào endpoint GET nếu màn hình thật sự cần, và phải có test.
- Không đổi luồng nghiệp vụ, không bỏ hay đổi tên nút và nhãn mà test agent đang dựa vào. Nếu bắt buộc phải đổi, ghi vào báo cáo.
- Hiệu ứng: chỉ dùng thư viện có sẵn (`src/components/fx.tsx`, `gl.tsx`, `motion.tsx`).
  - Trong app dùng `motion`. GSAP chỉ ở `landing/*` và `moments/*`.
  - Mọi hiệu ứng tôn trọng `prefers-reduced-motion` và đọc qua `useReducedMotionAfterMount`.
  - **Không có hiệu ứng nào đè lên ô lưới sân** (court grid) hoặc lên bảng dữ liệu.
  - Mỗi hiệu ứng phải gắn với một ý nghĩa thật: giờ trống, đếm ngược giữ chỗ, thanh toán xác nhận, buổi kế tiếp, số liệu đang sống. Không có hiệu ứng trang trí vô nghĩa.
- Không tạo ảnh hay minh hoạ mới bằng tay. Chỉ dùng kho `media_library`, các slot asset và `illustrations.tsx`. Không hardcode đường dẫn `/media/`.
- Mọi chuỗi mới có bản tiếng Việt. Tương phản chữ đạt WCAG AA ở cả light và dark.

## Chẩn đoán hiện trạng (reviewer đã xem ảnh chụp)

- **S07 `/app/book`:** lưới chỉ chiếm khoảng 2/3 chiều ngang, nửa dưới màn hình trống trơn (lúc tối chỉ còn 3 giờ). Không có ảnh, không có thông tin ngữ cảnh. Không gợi ý ngày mai khi hôm nay sắp hết giờ.
- **S17 `/desk`:** cột trái trống từ dưới form "New member" trở xuống. Cột phải dài, cột trái ngắn, mất cân đối.
- **`/manager/staff`:** mỗi dòng có 4 nút; nút đỏ "Khóa" lặp ở mọi dòng làm trang gắt và đơn điệu. Avatar nhỏ, không có số liệu tổng.
- **Chung:** header trang chỉ là chữ trên nền phẳng. Các slot `banner.book/classes/train/coach/gate/manager` có sẵn nhưng gần như không thấy. Card nào cũng giống nhau, thiếu điểm nhấn, thiếu ảnh môn.

## Phase 0. Baseline và tham khảo

1. Chụp TRƯỚC mọi màn hình liệt kê ở Phase 2, ở 1440×900 và 390×844, light và dark. Lưu vào `test-output/app-polish/before/`.
2. Chạy full agent suite và regression. Lưu vào `test-output/bugfix/G-POLISH/baseline/`.
3. Nghiên cứu tham khảo bằng Agent Reach (chỉ đọc; không đăng nhập; không tải tài sản thiết kế của người khác về repo). Mỗi nguồn ghi 3–5 ý cụ thể sẽ mượn vào `test-output/app-polish/references.md`:
   - **Playtomic, CourtReserve:** cách gợi ý giờ trống, thẻ sân có ảnh, luồng giữ chỗ.
   - **ClassPass, Mindbody:** thẻ lớp có ảnh, avatar HLV, số chỗ còn lại.
   - **Strava, Apple Fitness:** tiến độ tập (vòng, chuỗi ngày, mốc).
   - **Linear, Stripe Dashboard:** dashboard quản lý gọn mà giàu thông tin, dải số liệu, menu "…" cho thao tác phụ.
   - **Toast POS, Square:** màn quầy lễ tân.

   Chỉ mượn nguyên tắc bố cục và tương tác. Không chép logo, ảnh, màu thương hiệu hay chữ.

## Phase 1. Bộ khung dùng chung

Viết hoặc nâng cấp trong `src/components/ui/` hoặc `src/components/shell.tsx`, rồi áp dụng cho mọi trang:

1. **`PageHero`** (header trang):
   - Dải ảnh từ slot `banner.<khu>` qua `useAsset`. Lớp phủ gradient theo token để chữ đạt AA.
   - Gồm tiêu đề, mô tả, và 2–3 **số liệu sống** (dùng `CountUp`). Ví dụ trang Đặt sân: "40 free hours today · next free 20:00".
   - Cao 168px trên desktop, 112px trên mobile. Ảnh có thể chuyển động parallax nhẹ (tắt khi reduced motion).
   - Thêm `DotGrid` hoặc `Aurora` ở độ mờ thấp chỉ trong dải header này.
   - Nếu slot bị tắt: dùng nền token kèm minh hoạ từ `illustrations.tsx`.
2. **Bố cục 2 cột** ở ≥1280px: cột chính cộng **cột ngữ cảnh** (rộng 320–360px) cho các thứ như lịch sắp tới, tóm tắt, mẹo, việc cần làm. Dưới 1280px thì cột ngữ cảnh xuống dưới.
   - Tiêu chí: ở 1440×900, phần nằm trên mép gấp không có vùng trống liền khối nào lớn hơn 25% diện tích nội dung. Đo trên ảnh chụp.
3. **`StatStrip`:** dải 3–4 số liệu, có xu hướng so với tuần trước (mũi tên kèm %), dùng chung cho manager, desk và coach.
4. **`EmptyState` có hành động:** kèm ảnh từ kho (chọn theo category) hoặc minh hoạ, một câu giải thích, và MỘT nút hành động kế tiếp.
5. **`RowActions`:** mỗi dòng chỉ hiện 1 thao tác chính. Các thao tác còn lại vào menu "…". Thao tác phá huỷ (Khóa, Huỷ…) nằm trong menu, có xác nhận, chữ màu danger; không dùng nút đỏ đặc trên từng dòng.
6. **Ảnh môn:** thumbnail ảnh `sport.<code>` hoặc chấm màu `--color-sport-<color_key>` trong danh sách sân, lớp, gói tập và booking.
7. **Chuyển động trong app:** `PageIn` cho trang; `Stagger` cho 12 phần tử đầu của danh sách; `Lift` khi hover card chính; nhịp chấm "live" cho giờ hiện tại và buổi đang diễn ra; vòng đếm ngược cho giữ chỗ 5 phút. Tất cả tắt khi reduced motion.

## Phase 2. Từng màn hình (bắt buộc)

**Hội viên**

- **`/app/book`:**
  - Dùng PageHero.
  - Lưới chiếm hết chiều ngang khả dụng.
  - Cột ngữ cảnh có: booking sắp tới của tôi; "Best free hours this week" (3–5 thẻ có ảnh môn, bấm vào thì nhảy tới đúng ngày và giờ); quota gói còn lại.
  - Khi hôm nay còn dưới 4 giờ khả dụng: hiện banner "Tomorrow has {n} free hours" kèm nút chuyển sang ngày mai.
- **`/app/classes`:** thẻ lớp có ảnh (slot hoặc kho), avatar HLV, số chỗ còn lại dạng thanh. Lọc theo môn từ `useSports()`.
- **`/app/plans`:** thẻ gói có ảnh và lợi ích rõ ràng. Gói đang dùng nổi bật bằng `StarBorder` hoặc `SpotlightCard`. Có so sánh nhanh giữa các gói.
- **`/app/train` (Progress):** vòng tiến độ, chuỗi ngày tập, mốc kế tiếp; buổi kế tiếp có đếm ngược.
- **`/app/pass`, `/app/points`:** thẻ hội viên dùng `Tilt` cộng ánh sáng `GlareHover` (đã có trong thư viện). Lịch sử điểm dạng timeline.

**Quầy**

- **`/desk`:** cân lại 2 cột.
  - Cột trái, dưới form: "Arriving next 2 hours" (timeline kèm nút check-in) và "Recent check-ins".
  - Cột phải giữ "Right now" cùng các yêu cầu.
- **`/desk/gate`, `/desk/courts`, `/desk/payments`:** dùng PageHero và StatStrip (ca hiện tại, tiền mặt trong két, số chờ thanh toán). Trạng thái rỗng có hành động.

**HLV**

- **`/coach`:** buổi kế tiếp to và rõ (đếm ngược, sân, số học viên), lịch tuần dạng dải, danh sách học viên có avatar.

**Manager**

- **`/manager` (dashboard):** StatStrip có xu hướng; 3 thẻ hành động nhanh có icon và ảnh; heatmap (đã sửa ở doc trước); doanh thu theo nguồn.
- **`/manager/staff`:** lưới thẻ ở ≥1280px (avatar to 56px, vai trò, môn, trạng thái); `RowActions`; StatStrip (tổng HLV, lễ tân, tài khoản phải đổi mật khẩu, phiên đang mở); lọc vai trò dạng chip có số đếm.
- **`/manager/members`, `/manager/classes`, `/manager/courts`, `/manager/sports`, `/manager/media`, `/manager/prices`, `/manager/plans`, `/manager/promos`, `/manager/settings`:** PageHero, StatStrip nếu có số liệu ý nghĩa, `RowActions`, ảnh môn, EmptyState có hành động.

**Xác thực:** `/login` và `/register` đã ổn, chỉ kiểm tra ảnh lấy từ slot.

## Phase 3. Kiểm tra

1. `npx --no-install tsc --noEmit` 0 lỗi; `npm run lint` 0 errors; `node scripts/i18n-check.mjs` 0 missing; `npm test` pass.
2. Full agent suite so với baseline G-POLISH: 0 case PASS→FAIL/WARN. Regression 27/27. `manager-admin` và `sports-media` đều PASS.
3. Chụp SAU cùng bộ màn hình, cùng kích thước, vào `test-output/app-polish/after/`. Tạo `test-output/app-polish/compare.html` đặt trước/sau cạnh nhau.
4. Tự chấm từng màn theo thang 1–5 cho: độ đầy (vùng trống), thứ bậc thị giác, ảnh và màu môn, chuyển động có ý nghĩa, tương phản. Màn nào dưới 4 thì sửa tiếp.
5. Bật giả lập reduced motion (Playwright `reducedMotion: 'reduce'`): không còn chuyển động nào, bố cục không vỡ.
6. Ở 390px không có cuộn ngang toàn trang. Riêng lưới sân và bảng được phép cuộn ngang trong khung của chúng.

## Phase 4. Báo cáo

Viết bằng tiếng Việt:
- bảng màn hình: điểm trước/sau và những gì đã đổi;
- tóm tắt `references.md` (mượn gì từ đâu);
- danh sách component mới;
- kết quả các cổng (số thật);
- `git diff --ignore-cr-at-eol --stat`, danh sách file mới;
- đường dẫn `compare.html`.

KHÔNG commit, KHÔNG push. DỪNG.
