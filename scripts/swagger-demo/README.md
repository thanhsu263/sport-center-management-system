# Demo Swagger trước hội đồng

Hai script, đều mở Swagger UI (`/swagger/index.html`) và tự bấm **Try it out → Execute**.

| Lệnh | Làm gì | Thời gian |
|---|---|---|
| `npm run demo:swagger` | Chrome có cửa sổ, chạy chậm 2 luồng ngoại lệ: F1 đăng ký trùng số điện thoại (422, BR-01), F5 tắt cờ thì HLV gọi gợi ý bị 403 (BR-52), bật lại thì 200 | khoảng 1 phút |
| `npm run demo:swagger:all` | Chạy toàn bộ 210 API, chụp ảnh và viết lại `docs/testing/swagger-evidence/all-api/RESULTS.md` | 10–15 phút |

## Hôm bảo vệ

Cần Google Chrome đã cài trên máy (script mở Chrome thật, không phải Chromium).

Terminal 1, để chạy suốt buổi:

```powershell
npm install
npm run dev
```

Terminal 2, khi `npm run dev` đã báo sẵn sàng ở cổng 8080:

```powershell
npm run demo:swagger
```

Script tự mở cửa sổ Chrome vào `http://127.0.0.1:8080/swagger/index.html` và tự bấm từng bước. Không cần mở trang bằng tay.

`npm run dev` lưu dữ liệu vào thư mục `.pglite`, nên khởi động lại không làm mới seed. Demo F1/F5 không bị ảnh hưởng (cờ F5 được bật lại ở cuối). Riêng bản chạy 210 API cần seed mới, nên chạy server với dữ liệu trong bộ nhớ:

```powershell
$env:PGLITE_DATA_DIR="memory"; npm run dev
```

## Biến môi trường (PowerShell: `$env:TEN="giá trị"; npm run ...`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `BASE` | `http://127.0.0.1:8080` | Địa chỉ server |
| `SLOW` | 600 (demo) / 400 (all khi có cửa sổ) | Chờ mỗi thao tác, ms |
| `PAUSE` | 2500 | Dừng sau mỗi kết quả để hội đồng đọc (chỉ demo) |
| `HEADED=1` | tắt | Bản `all`: mở Chrome có cửa sổ |
| `HEADLESS=1` | tắt | Bản demo: chạy ẩn |
| `LIMIT` | hết | Bản `all`: chỉ chạy n API đầu |
| `OUT` | demo: thư mục tạm; all: `docs/testing/swagger-evidence/all-api` | Nơi lưu ảnh. Đặt `OUT` khi chạy `all` để không đè bằng chứng đã nộp |

Ví dụ xem 20 API đầu chạy có cửa sổ mà không đè bằng chứng:

```powershell
$env:HEADED="1"; $env:LIMIT="20"; $env:OUT="$env:TEMP\arena3-all"; npm run demo:swagger:all
```

## Phương án dự phòng

Nếu mạng hoặc máy hỏng lúc trình bày, mở ảnh đã chụp sẵn:
- F1/F5: `docs/testing/swagger-evidence/*.png`
- Toàn bộ: `docs/testing/swagger-evidence/all-api/RESULTS.md`

Tài khoản thử lấy từ `scripts/tests/test-helper.mjs`; không gõ mật khẩu thật trước hội đồng.
