# Arena3: đánh giá file thừa, file rác

Ngày: 2026-11-01 · Người rà soát: Claude (chỉ đọc) · Commit: `a5aff0b` trên `main`

Bản rà soát này không xóa, không di chuyển và không sửa file nào. File này là file duy nhất được tạo ra.

## 1. Tóm tắt

| Nhãn | Số mục | Dung lượng ước tính |
|---|---|---|
| XÓA AN TOÀN | 6 | ~11 MB |
| NÊN BỎ KHỎI GIT / THÊM VÀO .gitignore | 12 | ~27 MB ở thư mục làm việc |
| GỘP HOẶC CẬP NHẬT | 5 nhóm tài liệu | ~25 MB nếu bỏ bản SRS cũ |
| CẦN CHỦ DỰ ÁN QUYẾT ĐỊNH | 9 | ~200 MB, phần lớn là `docs/ui-review` (126 MB) |
| GIỮ | 9 | |

Các con số đáng chú ý:
- `docs/` nặng 263 MB, `.git` nặng 374 MB.
- Riêng `docs/ui-review` (126 MB, đã track) và `docs/FPT template` (31 MB) chiếm hơn một nửa `docs/`.
- Xóa khỏi cây làm việc **không** làm `.git` nhỏ lại, vì lịch sử vẫn giữ file. Muốn giảm `.git` phải viết lại lịch sử (`git filter-repo`). Việc đó có rủi ro cao và chỉ nên làm nếu thật cần.

## 2. Bảng chi tiết

### 2.1 XÓA AN TOÀN

| Đường dẫn | Tracked? | Bằng chứng | Rủi ro nếu xóa |
|---|---|---|---|
| `{}` (thư mục gốc) | không | File 0 byte, tạo 2026-10-26 14:58. Rất có thể do một lệnh shell gõ sai, kiểu `> {}` | Không |
| `${env` (thư mục gốc) | **có** | File 0 byte, vào repo ở commit `c7936b3` "tao commit het". Tên là mảnh của `${env:...}` bị shell hiểu sai. Không có chỗ nào tham chiếu tới | Không |
| `agent/` | không | `diff -rq .agents agent` cho kết quả **0 khác biệt** (316 file, 11 MB), tức là bản sao y hệt của `.agents/`. Không có chỗ nào tham chiếu `agent/skills` | Không |
| `docs/Arena3-SRS.docx.bak` | **có** | File backup của Word. `Arena3-SRS.docx` vẫn còn. Không có chỗ nào tham chiếu | Không |
| `attachments/x` | **có** | Thư mục rỗng tên `x` (`ls -la` không có file nào), đi vào repo ở commit `17900a8` | Không |
| `outbox/` | không | Thư mục rỗng (0 byte) ở thư mục gốc | Không. Code dùng bảng `outbox` trong DB, không dùng thư mục này |

### 2.2 NÊN BỎ KHỎI GIT / THÊM VÀO .gitignore

Đây là file cấu hình hoặc cache của từng tool trên máy, không phải mã của dự án.

| Đường dẫn | Tracked? | Kích thước | Bằng chứng |
|---|---|---|---|
| `.agents/` | không | 11 MB | Skill `archify` và `graft` do trình cài skill tải về, được ghi lại trong `skills-lock.json` |
| `.archify/` | không | 14 MB | Kết quả xuất của skill archify (sơ đồ kiến trúc ngày 2026-10-11 đến 2026-10-26), có thể tạo lại |
| `.playwright-mcp/` | không | 1.5 MB | Ảnh chụp và log của Playwright MCP |
| `.superpowers/` | không | 466 KB | Kế hoạch tạm của plugin superpowers (`sdd/2026-10-26-remove-plans`) |
| `.grok/` | không | 325 KB | Skill của Grok |
| `.cursor/`, `.cursorrules` | không | 21 KB | Cấu hình Cursor |
| `.gemini/`, `GEMINI.md` | không | 5 KB | Cấu hình Gemini CLI |
| `.kiro/` | không | 5 KB | Cấu hình Kiro |
| `.windsurf/` | không | 4 KB | Cấu hình Windsurf |
| `.adal/` | không | 12 KB | Cấu hình tool AdaL |
| `.claude/helpers/`, `.claude/settings.json` | không | 8 KB | Thiết lập Claude Code trên máy |
| `.mcp.json` | không | 1 KB | Danh sách MCP server trên máy, có thể chứa đường dẫn riêng của máy |

> Nếu nhóm dùng chung quy tắc agent (`.cursorrules`, `GEMINI.md` chép theo `CLAUDE.md`), có thể commit có chủ đích thay vì ignore. Mục 3 chỉ đề xuất ignore phần cache và kết quả xuất.

### 2.3 GỘP HOẶC CẬP NHẬT (tài liệu)

| Đường dẫn | Tracked? | Bằng chứng | Đề xuất |
|---|---|---|---|
| `docs/Arena3-SRS-v1.1.docx`, `-v1.4.docx`, `-v1.7.pdf`, `-v2.0.pdf`, `-v2.1.pdf` | có | Năm bản SRS cũ, khoảng 17 MB. Bản mới nhất là `v2.2.pdf`, cộng `HANDOFF-SRS-v2.3.md` | Giữ bản mới nhất, cộng `Arena3-SRS.docx` nếu đó là bản gốc. Lịch sử đã nằm trong git |
| `docs/Arena3-Screens.docx`, `-v2.docx`, `-v3.docx` | có | Ba phiên bản của cùng một tài liệu | Chỉ giữ `v3` |
| `docs/AGENT-*.md` (20 file, 5 file chưa track) | 15 có, 5 không | Brief giao việc cho agent, đã xong việc. Không file mã nào tham chiếu | Gom vào `docs/archive/agent-briefs/` hoặc xóa |
| `docs/UI-REDESIGN.md` | có | `CLAUDE.md` ghi rõ: khi file này mâu thuẫn với `PRODUCT.md`/`DESIGN.md` thì hai file kia thắng | Chuyển sang archive, hoặc ghi chú "đã thay bằng DESIGN.md" ở đầu file |
| `docs/FLOW-1-COVERAGE.md`, `docs/Arena3-Grading-Report.md`, `docs/Arena3-Evidence-And-UI-Grade.md` | 1 không, 2 có | Viết trước khi gói thành viên bị xóa rồi khôi phục (`6b23876`). Không có chỗ nào tham chiếu | Cập nhật hoặc thay bằng `docs/audit/BA-ASSESSMENT-v2.md` |

### 2.4 CẦN CHỦ DỰ ÁN QUYẾT ĐỊNH

| Đường dẫn | Tracked? | Kích thước | Vì sao chưa chắc |
|---|---|---|---|
| `docs/ui-review/` (v6, v6vi, v7, v7vi, redesign, before, after…) | có | **126 MB** | Ảnh chụp trước và sau qua các vòng thiết kế, không chỗ nào tham chiếu. Có thể là minh chứng nộp bài. Nếu không nộp, đây là mục giảm dung lượng nhiều nhất |
| `docs/FPT template/` | có | 31 MB | Mẫu tài liệu của FPT. Chỉ được nhắc trong `scripts/srs_pipeline/doc-nb.txt` (ghi chú, không phải mã). Cần nếu còn xuất SRS theo mẫu |
| `docs/screen-dictionary/` + `Arena3-Screen-Dictionary.pdf` | có | 15 + 18 MB | Ảnh nguồn và bản PDF đã xuất. Nếu PDF là bản nộp cuối thì thư mục ảnh có thể bỏ |
| `docs/*.pdf` tài liệu nhóm (`Phan-cong-*`, `Lich-hoc-2-tuan`, `Phan-chia-File-Thanh-vien`, `So-tay-Kiem-thu`) | phần lớn có | ~8 MB | Tài liệu phân công và nghiệm thu của nhóm, có thể nằm trong yêu cầu nộp |
| `arena3-ui-v2/` | không | 192 KB | Bản thử UI (README, design-review, preview), không chỗ nào tham chiếu. Có thể xóa nếu đã gộp vào `src/` |
| `docs/design-compare/` | không | 452 KB | Ảnh so sánh thiết kế, không chỗ nào tham chiếu |
| `attachments/` (`A3-SDD-001-v0.4.md`, `A3-SRS-001-v1.4*.md`) | có | 292 KB | Bản SRS/SDD cũ dạng Markdown. Có thể trùng `docs/SRS.md`, `docs/SDD.md` |
| `startup.sh`, `neon.ts`, `server/`, `skills-lock.json` | có | nhỏ | Thuộc nền tảng chạy (`AGENTS.md` nhắc `startup.sh` và `server/`, `server/middleware/grok-pwa.ts` đang dùng). **Không nên xóa** khi chưa hỏi người dựng nền tảng |
| Dependency không thấy import (mục 2.6) | | | Có thể là phần còn lại của bộ khung shadcn |

### 2.5 GIỮ

| Đường dẫn | Lý do |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, `README.md` | Nguồn sự thật, theo `CLAUDE.md` |
| `src/**/fx.tsx`, `gl.tsx`, `motion.tsx` | Effect library, theo quy tắc 2 trong `CLAUDE.md` |
| `migrations/` (thư mục gốc, 404 KB) | Migration và seed, theo quy tắc 7 |
| `docs/mermaid.min.js` (3.2 MB) | `scripts/auto-grade.mjs` có tham chiếu. Lệ "không dùng Mermaid" áp dụng cho sơ đồ mới, không phải script chấm điểm |
| `docs/grading-report.json`, `docs/interactive-tests-report.json` | Do `scripts/auto-grade.mjs` và `scripts/tests/run-all-interactive-tests.mjs` ghi ra |
| `docs/diagrams/`, `docs/drawio/` | Nơi đặt sơ đồ `.drawio` theo `CLAUDE.md` |
| `public/__grok/` | `server/middleware/grok-pwa.ts`, `src/routes/__root.tsx` và `src/lib/auth/server.ts` có tham chiếu |
| `public/media/` (71 MB) | Ảnh của site. Chỉ `CREDITS.md` không được tham chiếu, nhưng đó là file ghi bản quyền ảnh nên phải giữ |
| `src/lib/arena3/flows.test.ts` | **Bị quên đưa vào test**, không phải thừa: script `test` trong `package.json` có `arena3`, `tx`, `ratelimit` nhưng thiếu `flows`. Nên thêm vào, không xóa |

### 2.6 Dependency không thấy import (chỉ liệt kê, không gỡ)

Tìm từng tên package trên toàn repo, trừ `node_modules`, `docs`, `package*.json` và các thư mục tool. Không có chỗ nào tham chiếu tới:

- **Có thể gỡ, sau khi `tsc` và build qua:** toàn bộ 21 gói `@radix-ui/react-*`, `@hookform/resolvers`, `react-hook-form`, `@tanstack/react-query`, `@tanstack/react-table`, `class-variance-authority`, `cmdk`, `date-fns`, `react-day-picker`, `react-resizable-panels`, `vaul`, `@neon/env`, `eslint-plugin-prettier`. `src/components/ui/` hiện chỉ còn `index.tsx` tự viết, nên đây có thể là phần còn lại của bộ khung shadcn.
- **Giữ:** gói `@types/*` (dùng ngầm qua tsc). `@tanstack/router-plugin` và `lightningcss` có thể được Vite hoặc Tailwind nạp gián tiếp, nên cần thử build trước khi gỡ.

## 3. Đề xuất thêm vào `.gitignore`

```gitignore
# Cache và kết quả xuất của các tool AI trên máy
.agents/
.archify/
.playwright-mcp/
.superpowers/
.grok/
.adal/
.kiro/
.windsurf/
.cursor/
.gemini/
.claude/settings.local.json
.claude/helpers/
.mcp.json
# Rác của Office
*.bak
~$*
```

## 4. Lệnh xóa đề xuất (chủ dự án tự chạy; bản rà soát KHÔNG chạy)

Chạy trong Git Bash, đứng ở thư mục gốc dự án.

**Nhóm 1: XÓA AN TOÀN**

```bash
rm -f '{}'
git rm -q -- '${env' 'docs/Arena3-SRS.docx.bak'
rm -rf agent outbox attachments/x
```

**Nhóm 2: bỏ khỏi cây làm việc phần tạo lại được** (sau khi đã thêm `.gitignore` ở mục 3)

```bash
rm -rf .archify .playwright-mcp .superpowers
```

**Nhóm 3: tài liệu cũ** (chỉ chạy sau khi xác nhận)

```bash
mkdir -p docs/archive/agent-briefs && git mv docs/AGENT-*.md docs/archive/agent-briefs/
```

```bash
git rm -q docs/Arena3-SRS-v1.1.docx docs/Arena3-SRS-v1.4.docx docs/Arena3-SRS-v1.7.pdf docs/Arena3-SRS-v2.0.pdf docs/Arena3-SRS-v2.1.pdf docs/Arena3-Screens.docx docs/Arena3-Screens-v2.docx
```

**Nhóm 4: cần quyết định** (chỉ chạy khi chắc chắn không cần nộp)

```bash
git rm -rq docs/ui-review
```

```bash
rm -rf arena3-ui-v2 docs/design-compare
```

Lưu ý: `git mv docs/AGENT-*.md` báo lỗi với 5 file chưa track (`AGENT-FIX-AND-AVATAR`, `-FULL-AUDIT`, `-PROFILE-SETTINGS`, `-WAITLIST-PLANS-FIXUP`, `-WAITLIST-PLANS-PROFILE`). Năm file này dùng `mv` thường.

## 5. Giới hạn

- **Build: không xác minh được.** `npm run build` chạy thêm `db:migrate` sau bước build. Nếu `.env` hoặc `.env.local` có `DATABASE_URL` thì lệnh này ghi vào DB thật, nên bản rà soát không chạy build. `npx tsc --noEmit` qua ở commit trước.
- Kiểm tra dependency bằng cách tìm theo tên, nên không bắt được package nạp động hoặc nạp qua plugin. Phải thử build trước khi gỡ.
- Chưa rà từng component, helper hay khóa i18n chết bên trong `src/`, vì graft MCP mất kết nối trong phiên này. Cần một vòng riêng với `npx graft grep`.
- Chưa xem `.vercel/`, `.tanstack/`, `.pglite*`, `screenshots/` vì `.gitignore` đã che, chỉ là rác trên máy.
- Không đọc nội dung từng PDF/docx để xác nhận bản nào là bản nộp cuối.
