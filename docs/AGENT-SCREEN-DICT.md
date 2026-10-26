# AGENT-SCREEN-DICT — Làm lại Screen Dictionary (chụp mọi trang, theme xanh mạ + nâu)

Đọc hết file này trước khi làm. Làm tuần tự mục 1 → 6. Xong thì báo cáo theo mục 6 rồi DỪNG.

## 0. Bối cảnh

- Repo đã có sẵn script `scripts/screen-dictionary.mjs`. Script này chụp từng màn hình, sinh `docs/screen-dictionary/index.html` và `docs/Arena3-Screen-Dictionary.pdf`. Đọc kỹ phần đầu file (dòng 1–60) và phần dưới cùng (khoảng dòng 270–611) để hiểu cách nó đăng nhập, chụp và dựng PDF.
- Bản PDF cũ chụp nhánh `arena3-ui-ux` ngày 12/10, theme xanh dương, và vẫn còn màn Vé ngày (S21). Từ đó đến nay app đã đổi:
  - Vé ngày (day pass) **đã bị xoá**: không còn route `/desk/day-passes`.
  - Theme mới xanh mạ + nâu (`docs/AGENT-UI-THEME.md`).
  - Thêm C1–C10 (phân trang, VietQR, «Ngay lúc này», «Giờ còn trống», …).
- Mục tiêu: một bản Screen Dictionary **mới, đúng với code hiện tại**. Mỗi route trong `src/routes/` phải có ít nhất 1 màn (trừ file layout và route kỹ thuật).

## 1. Ràng buộc cứng

- Chỉ được sửa: `scripts/screen-dictionary.mjs`, và sinh mới mọi thứ trong `docs/screen-dictionary/**` cùng `docs/Arena3-Screen-Dictionary.pdf`.
- **CẤM** sửa bất kỳ file nào trong `src/**`, `migrations/**`, `scripts/tests/**`, `eslint.config.mjs`, `package.json`, `.env*`, `agent/`, `.agents/`, `graft/`. Thấy lỗi giao diện thì **ghi vào báo cáo**, không tự sửa.
- Git: chỉ `status` và `diff`. **KHÔNG** `commit`, `push`, `stash`, `reset`, `checkout`. Không `npm install` (Playwright đã có sẵn, dùng `npx --no-install` nếu cần).
- Chỉ chạy trên **safe server 127.0.0.1:8090** với fake clock như các vòng trước (`BASE=http://127.0.0.1:8090`). Không Neon, payOS hay SMTP thật. Không build, deploy hay `db:migrate`.
- Script chỉ được **ĐỌC**: không bấm nút ghi dữ liệu (đặt sân, thanh toán, mở ca, tạo khuyến mãi…). Giữ nguyên nguyên tắc đang ghi ở đầu script.

## 2. Cập nhật danh sách màn hình trong script

1. Liệt kê `src/routes/*.tsx`. Bỏ qua:
   - các file layout `__root.tsx`, `app.tsx`, `coach.tsx`, `desk.tsx`, `manager.tsx`;
   - route kỹ thuật `v1.$.ts`.
2. So sánh với danh sách màn trong script (các dòng `["role", "/route", ...]`):
   - **Xoá** mọi màn Vé ngày (`/desk/day-passes`) và mọi chữ «Vé ngày» trong mô tả.
   - **Thêm** màn cho route nào chưa có. Route có tham số (`desk.member.$id`, `coach.student.$id`): lấy 1 id thật từ API danh sách tương ứng trên safe server.
   - `pay.return.tsx`: chụp trạng thái không có tham số (hoặc tham số giả kiểu `?status=CANCELLED`), không gọi payOS.
3. Cập nhật mô tả (purpose / actions / note) cho đúng giao diện hiện tại. Mô tả viết bằng **tiếng Việt dễ hiểu cho người không biết code**. Ghi chú ở những màn có thay đổi C1–C10, ví dụ «C9: khối Ngay lúc này».
4. Kiểm tra tài khoản theo vai trò (biến `ROLES`) có đăng nhập được trên safe server không. Mật khẩu demo đang là `ChangeMe!a3`. Nếu số điện thoại khác với dữ liệu seed của safe server, lấy số đúng từ file seed/fixture của repo. **Không** đọc `.env*`.
5. Đổi màu vai trò trong `ROLES` (đang dùng xanh dương, đỏ…) sang các màu hợp với theme mới. Ví dụ: member `#3f7d20`, receptionist `#7a4a24`, coach `#356b1b`, manager `#4a2f17`, public `#5f6857`. Đổi luôn mọi màu xanh dương cứng trong phần HTML/CSS mà script sinh ra (bìa, tiêu đề, khung) sang tông xanh mạ + nâu.

## 3. Chụp ảnh

- Mỗi màn chụp **2 ảnh**: máy tính 1440px và điện thoại 390px, ở **chế độ sáng**, ngôn ngữ **VI**.
- Thêm bản **chế độ tối** (`colorScheme: "dark"`) cho 6 màn tiêu biểu: trang chủ, đăng nhập, đặt sân, thẻ hội viên, quầy lễ tân, bảng điều khiển quản lý. Đặt các ảnh này vào một mục riêng ở cuối tài liệu: «Phụ lục: chế độ tối».
- Giữ tính năng đánh số vòng tròn lên nút (`mark`) như script đang làm.
- Mỗi màn: không lỗi console, không request 4xx/5xx bất thường, không còn chuỗi tiếng Anh lọt ra ở chế độ VI. Màn nào lỗi thì vẫn chụp, rồi ghi vào báo cáo.

## 4. Dựng tài liệu

```
BASE=http://127.0.0.1:8090 node scripts/screen-dictionary.mjs
```

- Ra `docs/screen-dictionary/index.html` + `docs/screen-dictionary/img/*` và `docs/Arena3-Screen-Dictionary.pdf`.
- Trang bìa ghi:
  - ngày chụp 15/10/2026;
  - nhánh `working`;
  - «Theme xanh mạ + nâu»;
  - tổng số màn.
- Bỏ mục C11 khỏi danh sách thay đổi (chưa có code).
- Nếu cần chạy lại mà không chụp: `--no-shoot`.

## 5. Tự kiểm tra

1. Mở `docs/screen-dictionary/index.html` trên trình duyệt. Xem lướt: ảnh không trắng, không bị cắt, chú thích khớp ảnh.
2. Đếm: số route hợp lệ ở mục 2.1 = số màn có trong tài liệu (một route có thể có nhiều màn). Route nào thiếu → ghi lý do.
3. `grep -n "Vé ngày\|day-passes\|day_pass" docs/screen-dictionary/index.html` → phải rỗng.
4. `git diff --stat -- src migrations scripts/tests` → phải rỗng.

## 6. Báo cáo (ngắn) rồi DỪNG

- Tổng số màn, tổng số ảnh, dung lượng file PDF.
- Bảng route → mã màn S-xx (route nào thiếu thì ghi lý do).
- Kết quả mục 5.3 và 5.4.
- Danh sách lỗi giao diện thấy được trong lúc chụp, mỗi lỗi một dòng kèm S-xx (không tự sửa).
- Không commit. DỪNG.
