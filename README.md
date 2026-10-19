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

## Script

| Lệnh | Việc |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build + migrate |
| `npm run typecheck` | TypeScript |
