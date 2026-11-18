# Arena3

Hệ thống quản lý trung tâm thể thao: sân, lớp, gói, quầy, báo cáo.

PWA React (TanStack Start) + PostgreSQL 16 / PGLite. API `/v1`.

## Chạy local

```bash
npm install
cp .env.example .env   # điền GEMINI_API_KEY nếu dùng trợ lý
npm run dev            # http://localhost:8080
```

Không có `DATABASE_URL` thì app dùng PGLite (Postgres WASM) và tự chạy migration + seed.

## Tài khoản demo

Mật khẩu: `ChangeMe!a3`

| Vai trò | SĐT |
| --- | --- |
| Quản lý | `0900000001` |
| Lễ tân | `0900000002` |
| HLV | `0901110011` |
| Hội viên Nam | `0901230101` |

## Trợ lý Gemini

Đặt `GEMINI_API_KEY` (Google AI Studio) trên server. Hội viên: **Hỏi AI** trên trang chủ. Key không commit.

| Biến | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `GEMINI_API_KEY` | Có, để dùng AI | Không có thì trợ lý trả lời theo luật dựng sẵn |
| `ASSISTANT_SECRET` | **Có, ở production** | Ký câu trả lời để giữ ngữ cảnh hội thoại. Mọi instance phải dùng **cùng một giá trị**; thiếu thì khởi động lại server là mất ngữ cảnh |
| `GEMINI_MODELS` | Không | Danh sách model thử lần lượt, cách nhau bởi dấu phẩy |

## Script

| Lệnh | Việc |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build + migrate |
| `npm run typecheck` | TypeScript |
