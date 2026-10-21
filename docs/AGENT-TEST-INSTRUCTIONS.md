# HƯỚNG DẪN TEST ARENA 3 — DÀNH CHO AGENT

> File này dành cho một **agent QA** (AI chạy lệnh) để kiểm thử dự án Arena 3 trên **server test cục bộ** của chính dự án.
> Đọc **toàn bộ** file một lần, rồi làm **đúng thứ tự** các Phase. Không bỏ bước. Không tự sáng tạo ngoài phần được phép.
> Khi không chắc: đọc lại mục liên quan. Vẫn không chắc: ghi `NEEDS-HUMAN` rồi đi tiếp. Đừng đoán bừa.

Đây là kiểm thử chất lượng phần mềm (QA) trên bản build cục bộ của chính người dùng, không nhắm vào hệ thống thật của ai khác.

---

## MỤC LỤC

0. [Mục tiêu và đầu ra](#0-mục-tiêu-và-đầu-ra)
1. [Luật cứng](#1-luật-cứng)
2. [Khi nào phải DỪNG](#2-khi-nào-phải-dừng)
3. [Bối cảnh dự án](#3-bối-cảnh-dự-án)
4. [Thư mục đầu ra và file tiến độ](#4-thư-mục-đầu-ra-và-file-tiến-độ)
5. [Phase 0 — Chuẩn bị và server test](#5-phase-0--chuẩn-bị-và-server-test)
6. [Phase 1 — Static gates](#6-phase-1--static-gates)
7. [Phase 2 — Script có sẵn](#7-phase-2--script-có-sẵn)
8. [Phase 3 — Suite 01–05](#8-phase-3--suite-0105)
9. [Phase 4 — Suite 06](#9-phase-4--suite-06)
10. [Phân loại FAIL](#10-phân-loại-fail)
11. [Phase 5 — Tự viết suite 07–10](#11-phase-5--tự-viết-suite-0710)
12. [Phase 6 — Crawl giao diện (suite 11)](#12-phase-6--crawl-giao-diện-suite-11)
13. [Phase 7 — Checklist màn hình](#13-phase-7--checklist-màn-hình)
14. [Finding đã biết](#14-finding-đã-biết)
15. [Mức độ nghiêm trọng và mẫu báo bug](#15-mức-độ-nghiêm-trọng-và-mẫu-báo-bug)
16. [Phase 8 — Báo cáo cuối](#16-phase-8--báo-cáo-cuối)
17. [Phụ lục](#17-phụ-lục)

---

## 0. Mục tiêu và đầu ra

**Mục tiêu:** kiểm thử Arena 3 gần mức "exhaustive" trên server cục bộ: API (mọi route, mọi vai trò, mọi lỗi validation, mọi luật nghiệp vụ BR), kiểm soát truy cập, tranh chấp đồng thời (race), job nền, báo cáo, và giao diện (mọi vai trò × trang × desktop/mobile × tiếng Anh/Việt).

**Bạn KHÔNG sửa app.** Bạn chỉ **tìm lỗi, chứng minh lỗi, ghi lại lỗi**.

**Đầu ra bắt buộc khi xong:**

| File | Nội dung |
| --- | --- |
| `test-output/FINAL-REPORT.md` | Báo cáo cuối (mẫu mục 16) |
| `test-output/RESULTS-SUMMARY.md` | Bảng PASS/FAIL/WARN/BLOCKED mọi suite (script tự sinh) |
| `test-output/TRIAGE.md` | Phân loại từng FAIL/WARN/BLOCKED |
| `test-output/BUGS.md` | Mỗi bug mới một mục theo mẫu mục 15 |
| `test-output/PROGRESS.md` | Tiến độ (cập nhật sau MỖI bước) |
| `test-output/logs/*.log`, `test-output/results/*.jsonl` | Log và kết quả từng case |
| `test-output/ui/*.png`, `test-output/ui/ui-crawl.json` | Ảnh và kết quả crawl UI |
| `test-output/SCREENS-CHECKLIST.md` | Checklist màn hình |
| `scripts/tests/agent/07-*.mjs` … `11-*.mjs` | Các suite bạn tự viết |

---

## 1. Luật cứng

Không có ngoại lệ, kể cả khi bạn nghĩ "chỉ lần này thôi".

1. **Chỉ test server cục bộ `http://127.0.0.1:8090`** (server an toàn, DB trong RAM). KHÔNG gọi URL nào khác: không Neon, không production, không payOS, không SMTP, không domain thật.
2. **KHÔNG mở, in, copy hay grep nội dung** `.env`, `.env.local`, `.env.*` hay bất kỳ file chứa bí mật nào. Không in biến môi trường chứa khoá/token ra log.
3. **KHÔNG chạy** lệnh nào có chữ `check-integrations`, `check:integrations`, `deploy`, `release`, `publish`, `migrate`, `db:push`, `db:seed` (trừ khi nó chạy bên trong `start-safe-server.mjs`), `neon`. KHÔNG dùng công cụ/MCP Neon.
4. **KHÔNG sửa code app.** Không chạm `src/`, `db/`, `migrations/`, `public/`, `package.json`, file cấu hình, `docs/` (trừ một lệnh `git restore` ở Phase 2).
   - Chỉ được tạo/sửa file trong `scripts/tests/agent/` và `test-output/`.
   - `01-*`…`05-*` và `scripts/tests/agent-lib.mjs` là **baseline đã kiểm chứng: KHÔNG sửa**. `06-classes.mjs` chỉ sửa theo quy trình mục 10.
5. **KHÔNG cài package.** Không `npm install`, `npm i`, `pnpm/yarn add`, `pip install`, không `npx <package>` khi package chưa có. Luôn dùng `npx --no-install …`. Không cài browser cho Playwright, không cài axe-core.
6. **KHÔNG dùng git để thay đổi gì**, trừ đúng 1 lệnh: `git restore docs/interactive-tests-report.json` (Phase 2). Không `commit`, `push`, `reset`, `checkout`, `stash`, `clean`, `rebase`, `merge`.
7. **KHÔNG làm cho test PASS bằng cách đổi kỳ vọng.** Chỉ đổi kỳ vọng sau khi đã chứng minh script sai theo mục 10. Status 500 **không bao giờ** là kỳ vọng đúng.
8. **KHÔNG xoá** file nào ngoài `test-output/`, và chỉ xoá file do chính bạn tạo.
9. Mọi mật khẩu dùng trong test là mật khẩu **seed của DB test** (`ChangeMe!a3`, `Test1234a`). Không dùng tài khoản/mật khẩu thật nào khác. Không đăng nhập dịch vụ bên ngoài.
10. **Không gửi dữ liệu ra ngoài máy** (không upload log/ảnh/kết quả đi đâu).

---

## 2. Khi nào phải DỪNG

Dừng hẳn, ghi lý do vào `test-output/PROGRESS.md`, rồi báo người dùng khi:

| Tình huống | Làm gì |
| --- | --- |
| Server test không lên sau **2 lần** thử | DỪNG. Gửi 40 dòng cuối `server.log` (đã xem chắc chắn không chứa bí mật). |
| Port 8090 bị chương trình khác chiếm, không tắt được | DỪNG. |
| Có lệnh hỏi mật khẩu/token/khoá/đăng nhập | DỪNG, không nhập gì. |
| Dấu hiệu đang nói chuyện với DB/dịch vụ thật (log có `neon.tech`, `payos`, gửi email thật) | DỪNG ngay, tắt server (`run-suite.mjs --stop`). |
| Một suite crash trước khi in summary **3 lần liên tiếp** sau khi đã sửa script theo mục 10 | Ghi `NEEDS-HUMAN` cho suite đó, **đi tiếp** suite sau. |
| Ổ đĩa đầy / lỗi hệ thống | DỪNG. |

**KHÔNG** phải lý do để dừng: test FAIL, test BLOCKED, app trả 500, app chậm. Đó là **kết quả** — ghi lại và đi tiếp.

---

## 3. Bối cảnh dự án

### 3.1 App

- Arena 3 = phần mềm quản lý trung tâm thể thao (cầu lông, bóng rổ, bóng chuyền): đặt sân, gói hội viên, lớp học, điểm danh, thanh toán quầy, khuyến mãi, báo cáo.
- Công nghệ: TanStack Start (React 19), PWA. API REST ở tiền tố **`/v1`**.
- Danh sách route: `src/lib/arena3/router.ts`. Code xử lý: `src/lib/arena3/handlers/*.ts`. Luật dùng chung: `src/lib/arena3/rules.ts`. Khuyến mãi: `src/lib/arena3/promos.ts`.
- Đặc tả: `docs/SRS.md`. Màn hình: `docs/SCREENS.md`.
- **Chú ý:** số BR trong code (`br: "BR-xx"`) là cái đúng để so trong test. Số BR trong `docs/SRS.md` có thể lệch. Luôn so với code.

Vai trò: `anonymous` (chưa đăng nhập), `member` (hội viên), `coach` (HLV), `receptionist` (lễ tân), `manager` (quản lý — quyền cao nhất).

### 3.2 Server test an toàn

- Lệnh gốc: `node scripts/tests/start-safe-server.mjs` (bạn không gọi trực tiếp — dùng `run-suite.mjs`, mục 5).
- DB **PGLite trong RAM**, mỗi lần khởi động là DB mới có seed. Tắt server = mất hết dữ liệu (đó là điều tốt).
- Chạy ở `127.0.0.1:8090`. payOS, SMTP, AI **tắt**. `OTP_ECHO=1` nghĩa là API đăng ký trả luôn OTP trong response (để test).
- **Phải khởi động lại server trước MỖI suite**, vì:
  - dữ liệu suite trước làm bẩn suite sau (slot đã đặt, rate limit);
  - bug F-04: bộ đếm mã hội viên kẹt ở `A3-2026-0099` ⇒ mỗi lần server chạy chỉ tạo được **~45–48 hội viên mới**. Suite cần nhiều hơn phải tách 2 file (vd `10a-`, `10b-`).
- Feature flag **F4 (lớp học / huấn luyện) BẬT** trong DB mới.

### 3.3 Tài khoản seed

Định nghĩa trong `scripts/tests/agent-lib.mjs` (export `PHONES`). Mật khẩu chung: `PASS = "ChangeMe!a3"`.

| Key `PHONES` | Vai trò | Ghi chú |
| --- | --- | --- |
| `manager` | manager | |
| `receptionist`, `receptionist2` | receptionist | 2 lễ tân (test "két của người khác") |
| `coach` | coach | Khoa, cầu lông |
| `coachLan` | coach | Lan, cầu lông |
| `coachBasket` | coach | Đức Anh, bóng rổ |
| `coachVolley` | coach | Việt, bóng chuyền |
| `memberNoPlan` | member | Bảo, không gói |
| `memberNam`, `memberAllAccess`, `memberBadmintonSessions`, `memberBadminton30`, `memberBasketSessions` | member | |

Thành viên tạo bằng `newMember()` có mật khẩu `Test1234a`.

### 3.4 ID seed (`IDS` trong `agent-lib.mjs`)

| Key | Ý nghĩa |
| --- | --- |
| `planAllAccess30` (`20000000-…0001`), `planBadminton30` (`…0002`), `planBadminton10Sessions` (`…0003`), `planBasketball30` (`…0004`), `planVolleyball30` (`…0005`), `planAllAccess90` (`…0006`), `planBasketball8Sessions` (`…0007`), `hiddenTrialPlan` (`…0008`) | gói |
| `courtCL01`…`courtCL05`, `courtBR01`, `courtBC01` | sân |
| `nonexistent` = `99999999-9999-4999-8999-999999999999` | UUID hợp lệ nhưng không tồn tại (test 404) |

Sân seed: CL-01…CL-08 = `10000000-…-00000000000{1..8}` (cầu lông); CL-09 `…0009`, CL-10 `…0012`, CL-11 `…0013`, CL-12 `…0014` (cầu lông); BR-01 `…0010` (bóng rổ); BC-01 `…0011` (bóng chuyền).

Lớp seed `30000000-…0001` (HLV Khoa, trợ giảng Lan, có buổi `done` trong quá khứ). HLV seed `00000000-0000-0000-0000-000000000003` (cầu lông). Khoa bận giờ 8, 9, 10, 11, 18, 19, 20, 21.

### 3.5 Định dạng lỗi

Body lỗi **phẳng**: đọc `res.data.code`, `res.data.br`, `res.data.field`, `res.data.message`.

| Helper trong code | HTTP | `code` | Trường thêm |
| --- | --- | --- | --- |
| `err.validation(...)` | 422 | | |
| `err.field("x", ...)` | 400 | `VALIDATION` | `field: "x"` |
| `err.br("BR-nn", ...)` | 422 | `BR_VIOLATION` | `br: "BR-nn"` |
| `conflictState` | 409 | `CONFLICT_STATE` | |
| `conflictSlot` | 409 | `CONFLICT_SLOT` | |
| `forbidden` | 403 | | |
| `notFound` | 404 | | |
| `unauth` | 401 | | |
| Feature flag tắt | 403 | | `br: "BR-52"` |

Map lỗi Postgres: `22P02/22007/22008/22001` (sai định dạng, chuỗi quá dài) → 400; `23514` (CHECK) → 422; `23505` (UNIQUE) → 409; `23503` (FK) → **500 (không map — gặp là bug)**; mã khác → **500 (bug)**.

**Quy tắc vàng: mọi response 500 đều là bug** (tối thiểu MEDIUM), trừ khi chính test cố ý gây ra và đã nằm trong finding đã biết.

### 3.6 Bảng mã BR đã biết

| BR | Ý nghĩa (theo code) |
| --- | --- |
| BR-18 | Lớp không ở trạng thái `open` → không ghi danh |
| BR-19 | Không có gói còn hạn bao môn của lớp |
| BR-20 | Gói theo buổi hết buổi (`session_left <= 0`) |
| BR-21 | Lớp đầy / giảm sĩ số dưới số đã ghi danh |
| BR-22 | Đã ghi danh lớp này, hoặc trùng giờ lớp khác |
| BR-23 | Lời mời waitlist hết hạn (2 giờ) |
| BR-24 | Rời lớp khi buổi kế còn < 4 giờ |
| BR-25 | HLV không hợp lệ (không tồn tại / không phải coach / sai môn) |
| BR-27 | Dời buổi còn < 12 giờ mà không có lý do |
| BR-30 | Check-in bị từ chối (đọc handler check-in) |
| BR-35 | Điểm danh đã khoá (buổi `done` hoặc quá 2 giờ) |
| BR-40 | Mã khuyến mãi không dùng được (nhiều lý do, xem promos.ts) |
| BR-41 | Lượt mã hết đúng lúc thanh toán / mã bị xoá; hoàn toàn phần trả lại lượt, hoàn một phần thì không |
| BR-42 | Mã không cộng dồn với giảm giá sân của gói |
| BR-43 | Xem code: tìm `err.br("BR-43"` |
| BR-48 | Giáo án khoá vì buổi đã có kết quả |
| BR-50 | Mượn thiết bị (xem handler thiết bị) |
| BR-52 | Tính năng bị tắt (feature flag) |

BR khác: `Select-String -Path src\lib\arena3\*.ts,src\lib\arena3\handlers\*.ts -Pattern 'err\.br\("BR-'` (hoặc `grep -rn 'err.br("BR-' src/lib/arena3`). Đọc 3–5 dòng quanh mỗi kết quả.

### 3.7 Thư viện test `scripts/tests/agent-lib.mjs` (KHÔNG sửa)

| Hàm | Dùng | Trả về |
| --- | --- | --- |
| `api(path, opts)` | `path` KHÔNG kèm `/v1`. `opts`: `method`, `token`, `body` (object→JSON), `idem`/`idemKey`, `headers`, `rawBody` | `{ status, data, ms, headers, request }` |
| `login(phone, password=PASS)` | `await login(PHONES.manager)` | có `.token`, `.user` (`.user.id`) |
| `loginAll()` | đăng nhập mọi tài khoản seed | xem code |
| `newMember(extra)` | đăng ký hội viên mới (OTP tự lấy) | `{ token, user, phone, password }` |
| `memberWithPlan(managerToken, planId)` | hội viên mới + mua gói + trả tiền mặt | `{ ..., subscription }` |
| `check(id, title, res, expect)` | ghi 1 case | `true` nếu PASS |
| `blocked(id, title, reason)` | ghi case không chạy được | |
| `summary()` | in tổng kết — **luôn gọi cuối suite** | |
| `ictDate(n)`, `slot(n,h,m)`, `ictHour()`, `ictWeekday(d)`, `ictDateOf(iso)`, `isPeak(d,h)`, `sleep(ms)` | tiện ích thời gian | |
| `freeSlot(staffToken, opts)`, `freeSlotAnyDay(staffToken, opts, {fromDay,maxDays})`, `freshPhone()` | tìm slot trống / số mới — **đọc chữ ký trong agent-lib trước khi dùng** | |

`expect` của `check`: `status` (số hoặc mảng số), `notStatus`, `code`, `br`, `test:(res)=>boolean`, `why` (chuỗi khi FAIL), `advisory:true` (FAIL → WARN).

Lưu ý:
- `check` **không có** option `field`. Kiểm field bằng `test: r => r.data?.field === "ten_field"`.
- Kiểm giá trị tự tính (không phải response): bọc giả `const fake = d => ({ status: 200, data: d, ms: 0, request: "computed" })` rồi `check(id, title, fake(x), { test: () => … })`.
- Mỗi `check` ghi 1 dòng JSON vào file trong biến môi trường `RESULTS_FILE` (do `run-suite.mjs` đặt).

---

## 4. Thư mục đầu ra và file tiến độ

Ngay từ đầu, tạo `test-output/PROGRESS.md` theo mẫu dưới. **Sau mỗi bước, đánh dấu `[x]` và ghi 1 dòng kết quả.** Nếu bị ngắt (hết context, khởi động lại), đọc file này để biết làm tiếp từ đâu.

```markdown
# PROGRESS — Arena 3 agent test
Bắt đầu: <ngày giờ>

## Phase 0 — Chuẩn bị
- [ ] 0.1 Ghi môi trường → logs/p0-env.txt
- [ ] 0.2 Server test lên được (run-suite --server-only)
## Phase 1 — Static gates
- [ ] 1.1 Liệt kê npm scripts  - [ ] 1.2 Typecheck  - [ ] 1.3 Lint  - [ ] 1.4 Unit test  - [ ] 1.5 Build
## Phase 2 — Script có sẵn
- [ ] 2.1 test-public-auth  - [ ] 2.2 test-member-flows  - [ ] 2.3 test-coach-flows
- [ ] 2.4 test-desk-flows  - [ ] 2.5 test-manager-flows
- [ ] 2.6 run-all-interactive-tests (+copy +git restore)  - [ ] 2.7 check:auth  - [ ] 2.8 browser-smoke → SKIP
## Phase 3 — Suite 01–05
- [ ] 01  - [ ] 02  - [ ] 03  - [ ] 04  - [ ] 05
## Phase 4 — Suite 06
- [ ] chạy lần 1  - [ ] phân loại  - [ ] chạy lại sau sửa script (nếu có)
## Phase 5 — Tự viết suite
- [ ] 07 security  - [ ] 08 extras  - [ ] 09 settings/reports  - [ ] 10 jobs/race
## Phase 6 — UI crawl
- [ ] 11
## Phase 7 — Checklist màn hình
- [ ] SCREENS-CHECKLIST.md
## Phase 8 — Báo cáo
- [ ] summarize-results  - [ ] TRIAGE.md  - [ ] BUGS.md  - [ ] FINAL-REPORT.md

## Nhật ký
- <giờ> <việc> → <kết quả ngắn>
```

Tạo sẵn `test-output/TRIAGE.md` với tiêu đề bảng:

```markdown
| Suite | Case | Kết quả | Phân loại | Bằng chứng (log/dòng, repro) | Hành động |
| --- | --- | --- | --- | --- | --- |
```

Cột **Phân loại** chỉ được là: `APP-BUG`, `KNOWN F-xx`, `SCRIPT-BUG (đã sửa)`, `ENV`, `NEEDS-HUMAN`, `WARN-ACCEPTED`.

Tạo `test-output/BUGS.md` (rỗng, tiêu đề `# Bugs mới`).

---

## 5. Phase 0 — Chuẩn bị và server test

### 5.1 Ghi lại môi trường

PowerShell, tại gốc dự án `D:\learning material\Arena 3`:

```powershell
New-Item -ItemType Directory -Force test-output\logs, test-output\results, test-output\ui, test-output\scratch | Out-Null
node --version > test-output\logs\p0-env.txt
git rev-parse --short HEAD >> test-output\logs\p0-env.txt
git status --short >> test-output\logs\p0-env.txt
```

`git status` này là **ảnh chụp ban đầu**. Cuối cùng so lại để chắc không làm thay đổi file dự án.

### 5.2 Khởi động server bằng `run-suite.mjs`

`scripts/tests/agent/run-suite.mjs` là công cụ chính: (1) tắt mọi thứ nghe port 8090; (2) bật `start-safe-server.mjs` chạy nền, log vào `test-output/logs/server.log`; (3) đợi `GET /v1/classes` trả 200 (tối đa 180s); (4) nếu có tên suite thì chạy, ghi `logs/<tên>.log` và `results/<tên>.jsonl`.

```powershell
node scripts/tests/agent/run-suite.mjs --server-only       # chỉ khởi động lại server
node scripts/tests/agent/run-suite.mjs 06                   # khởi động lại server rồi chạy 06-*
node scripts/tests/agent/run-suite.mjs 06 --no-restart      # chạy trên server đang chạy
node scripts/tests/agent/run-suite.mjs scripts/tests/test-member-flows.mjs
node scripts/tests/agent/run-suite.mjs --stop               # tắt server
```

Bước làm:
1. Chạy `node scripts/tests/agent/run-suite.mjs --server-only`.
2. Kỳ vọng dòng `safe server ready on http://127.0.0.1:8090 after N s`.
3. Thấy `did not come up` → đọc 40 dòng cuối `server.log`, thử lại 1 lần. Lần 2 vẫn hỏng → mục 2 (DỪNG).
4. Nếu `run-suite.mjs` tự lỗi JavaScript (không phải lỗi server) → dùng **Cách thủ công** (5.3) cho phần còn lại, ghi vào PROGRESS.

> `run-suite.mjs` và `summarize-results.mjs` được viết nhưng **chưa chạy thử**. Nếu sai, đừng sửa app — dùng cách thủ công.

### 5.3 Cách thủ công (khi `run-suite.mjs` không dùng được)

Terminal A (để server chạy, không đóng):

```powershell
Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
node scripts/tests/start-safe-server.mjs
```

Terminal B:

```powershell
(Invoke-WebRequest http://127.0.0.1:8090/v1/classes -UseBasicParsing).StatusCode   # lặp đến khi 200
$env:BASE = "http://127.0.0.1:8090"
$env:RESULTS_FILE = "test-output/results/06-classes.jsonl"
Remove-Item $env:RESULTS_FILE -ErrorAction SilentlyContinue
cmd /c "node scripts\tests\agent\06-classes.mjs > test-output\logs\06-classes.log 2>&1"
Get-Content test-output\logs\06-classes.log -Tail 30
```

Khởi động lại server: Ctrl+C ở Terminal A, chạy lại 2 lệnh của Terminal A.

Git Bash thay cho PowerShell:

```bash
BASE=http://127.0.0.1:8090 RESULTS_FILE=test-output/results/06-classes.jsonl node scripts/tests/agent/06-classes.mjs > test-output/logs/06-classes.log 2>&1
tail -n 30 test-output/logs/06-classes.log
```

---

## 6. Phase 1 — Static gates

Phase này không cần server.

### 6.1 Liệt kê npm scripts

```powershell
node -e "const s=require('./package.json').scripts;for(const k in s)console.log(k.padEnd(28),s[k])" > test-output\logs\p1-npm-scripts.txt
Get-Content test-output\logs\p1-npm-scripts.txt
```

Đọc danh sách. **Chỉ chạy** những script ở bảng 6.2. Script có chữ ở mục 1.3 → không chạy.

### 6.2 Chạy từng gate

Mỗi gate: chạy, lưu log, ghi exit code (0 = PASS).

| Bước | Lệnh (dùng cái đầu tiên tồn tại) | Log |
| --- | --- | --- |
| 1.2 Typecheck | `npm run typecheck`, nếu không có: `npx --no-install tsc --noEmit` | `p1-typecheck.log` |
| 1.3 Lint | `npm run lint`, nếu không có: ghi `SKIP (không có script lint)` | `p1-lint.log` |
| 1.4 Unit test | `npm test` hoặc `npm run test`; nếu nó chạy watch (có chữ `watching`, không kết thúc): Ctrl+C rồi `npx --no-install vitest run` | `p1-unit.log` |
| 1.5 Build | `node scripts/with-app-env.mjs vite build` | `p1-build.log` |

Mẫu chạy có lưu log:

```powershell
cmd /c "npm run typecheck > test-output\logs\p1-typecheck.log 2>&1"; "exit=$LASTEXITCODE"
```

Sau mỗi gate:
- Exit 0 → PROGRESS `[x] 1.2 Typecheck — PASS`.
- Exit ≠ 0 → FAIL; copy **30 dòng lỗi đầu** vào TRIAGE (Suite `P1-typecheck`, Phân loại `APP-BUG`). **Không sửa.** Đi tiếp.
- Sau build: `git status --short` so với ảnh chụp 5.1. File đã-track bị build thay đổi → ghi FINAL-REPORT mục "Tác dụng phụ", **không tự restore**.

---

## 7. Phase 2 — Script có sẵn

Liệt kê: `Get-ChildItem scripts\tests -File | Select-Object Name`.

| Script | Chạy? | Ghi chú |
| --- | --- | --- |
| `test-helper.*`, `start-safe-server.*`, `agent-lib.mjs` | KHÔNG | thư viện/server |
| `test-public-auth.*`, `test-member-flows.*`, `test-coach-flows.*`, `test-desk-flows.*`, `test-manager-flows.*` | CÓ | |
| `run-all-interactive-tests.*` | CÓ | **ghi đè `docs/interactive-tests-report.json`** |
| `npm run check:auth` | CÓ | cần `--dev-url http://127.0.0.1:8090` |
| browser-smoke (nếu có) | **KHÔNG** | không chạy được trên Windows → ghi `SKIP (Windows)` |

### 7.1 Năm script flow

Với mỗi script (thay `<file>` bằng tên thật): `node scripts/tests/agent/run-suite.mjs scripts/tests/<file>`. `run-suite.mjs` tự khởi động lại server và đặt `BASE`. Log ở `logs/<tên>.log`. Các script này có thể **không** ghi JSONL — đọc kết quả từ log (dòng tổng kết, `FAIL`, `✗`, `Error`).

### 7.2 run-all-interactive-tests

```powershell
node scripts/tests/agent/run-suite.mjs scripts/tests/run-all-interactive-tests.mjs
Copy-Item docs\interactive-tests-report.json test-output\p2-interactive-tests-report.json
git restore docs/interactive-tests-report.json
git status --short docs
```

Lệnh cuối phải **không** còn hiện `docs/interactive-tests-report.json`.

### 7.3 check:auth

```powershell
node scripts/tests/agent/run-suite.mjs --server-only
cmd /c "npm run check:auth -- --dev-url http://127.0.0.1:8090 > test-output\logs\p2-check-auth.log 2>&1"; "exit=$LASTEXITCODE"
```

### 7.4 Ghi kết quả

Mỗi script: PASS/FAIL + số lỗi vào PROGRESS; mỗi lỗi → 1 dòng TRIAGE (Suite `P2-<tên>`). Các script này **không phải của bạn — không sửa**. Lỗi trùng finding đã biết → `KNOWN F-xx`.

---

## 8. Phase 3 — Suite 01–05

Các suite này đã chạy và sửa lỗi script. **Mọi FAIL/WARN còn lại là bug thật**, đã ghi thành F-01…F-22 (mục 14).

| Suite | File | Nội dung |
| --- | --- | --- |
| 01 | `01-authz-matrix.mjs` | Ma trận phân quyền theo vai trò |
| 02 | `02-auth.mjs` | Đăng ký, OTP, đăng nhập, khoá, đổi mật khẩu |
| 03 | `03-bookings.mjs` | Đặt sân, giữ chỗ, huỷ, giá, slot |
| 04 | `04-desk-payments.mjs` | Quầy, ca/két, thanh toán, hoàn tiền, walk-in |
| 05 | `05-plans-subscriptions.mjs` | Gói, mua gói, đóng băng, khuyến mãi khi mua gói |

Làm lần lượt 01 → 05: `node scripts/tests/agent/run-suite.mjs 01` …

Sau mỗi suite:
1. Xem cuối log có summary không. Không có → crash → mục 10.5.
2. `node scripts/tests/agent/summarize-results.mjs`, mở `test-output/RESULTS-SUMMARY.md`.
3. Mỗi FAIL/WARN: đọc title + chi tiết, so bảng mục 14.
   - Khớp → TRIAGE `KNOWN F-xx`.
   - Không khớp → **chạy lại suite đó 1 lần** (server mới). Vẫn FAIL → phân loại mục 10 (có thể regression mới — báo HIGH nếu là phân quyền/tiền).
4. BLOCKED → ghi lý do (thường do giờ chạy). Chạy lại 1 lần; vẫn BLOCKED → `ENV`.

---

## 9. Phase 4 — Suite 06

`scripts/tests/agent/06-classes.mjs` được viết từ việc đọc code nhưng **chưa từng chạy**. Một FAIL có thể là **lỗi của script**, không phải lỗi app. Phân loại từng FAIL theo mục 10.

### 9.1 Nội dung

| Tiền tố | Phạm vi |
| --- | --- |
| `CL-` | Tạo lớp, publish, danh sách, chi tiết, roster, sửa/đóng/huỷ lớp |
| `EN-` | Ghi danh, rời lớp, BR-18/19/20/22/24 |
| `WL-` | Danh sách chờ, lời mời, chấp nhận, chen hàng |
| `SS-` | Huỷ buổi, dời buổi, BR-27 |
| `CC-` | Đổi HLV, BR-25, trùng lịch |
| `AT-` | Điểm danh, khoá điểm danh BR-35 |
| `TR-` | Kết quả buổi, giáo án (BR-48), bài tập, hồ sơ học viên, đánh giá, mục tiêu, lịch HLV |

Suite tạo ~13 hội viên (dưới giới hạn F-04) và ~12 lớp.

### 9.2 Giờ chạy

Suite chọn giờ học theo giờ hiện tại VN. **Chạy trong 07:00–19:00 VN** để ít BLOCKED nhất. Ngoài giờ đó, các case cần "buổi sắp diễn ra trong 4 giờ" (EN-27/28, SS-21/22) có thể BLOCKED — chấp nhận, ghi `ENV`.

### 9.3 Chạy

```powershell
node scripts/tests/agent/run-suite.mjs 06
node scripts/tests/agent/summarize-results.mjs
```

Đầu log có `setup A: class … at 13h, 10 sessions` (lớp nào dựng ở giờ nào). Dòng `setup X @Nh: publish → …; trying the next hour` là bình thường (giờ bận, thử giờ khác). Nếu `SETUP-A` BLOCKED và suite dừng sớm → xem mục 10.5.

### 9.4 Case "ứng viên bug" trong suite 06

FAIL ở các case này nhiều khả năng là **bug thật** — nhưng vẫn phải tái hiện bằng 1 lệnh `api` riêng (mục 10.3) trước khi ghi BUGS.md:

| Case | Nghi ngờ | Kỳ vọng đúng | Nếu FAIL |
| --- | --- | --- | --- |
| EN-25 | HLV bất kỳ (kể cả môn khác) xoá được ghi danh của hội viên | 403 | F-23, HIGH (phân quyền) |
| CL-19 | Tạo lớp với `court_id` không tồn tại → 500 | 4xx | MEDIUM |
| CL-20 | Tạo lớp với `assistant_id` không tồn tại → 500 | 4xx | MEDIUM |
| CL-21…25 (advisory) | sĩ số 1000, `BYHOUR=25`, ngày bắt đầu > kết thúc, lớp cầu lông trên sân bóng rổ, hội viên làm trợ giảng | 400/409/422 | WARN → LOW/MEDIUM |
| CL-26/27 | rrule `FREQ=DAILY` làm crash | không 500 | MEDIUM |
| WL-19 | Người mới ghi danh chen lên khi đang có lời mời chờ | `waitlisted: true` | MEDIUM |
| SS-18/19/20 (advisory) | Dời buổi về 03:00, lệch lưới :17, sau ngày kết thúc lớp | bị từ chối | LOW/MEDIUM |
| AT-12 (advisory) | Điểm danh trước khi buổi bắt đầu | bị từ chối | LOW |
| TR-47 (advisory) | Tạo giáo án mới cho buổi đã có kết quả | BR-48 | LOW |

Ứng viên cần kiểm thêm bằng repro riêng: chấp nhận lời mời waitlist (`POST /waitlist/:offerId/accept`) **không trừ** `session_left` của gói theo buổi (ghi danh thường có trừ). Repro: hội viên gói `session_quota:2`, vào waitlist, nhận lời mời, chấp nhận, xem `/me` → `session_left` vẫn 2 ⇒ bug MEDIUM (mất tiền).

### 9.5 Sau khi phân loại

- Có sửa script → chạy lại `run-suite.mjs 06` (server mới), tối đa **3 vòng**.
- Ghi ngay trên dòng đã sửa: `// fixed by agent: <lý do ngắn, bằng chứng>`.
- Liệt kê sửa script vào FINAL-REPORT mục "Sửa script".

---

## 10. Phân loại FAIL

Quy trình **bắt buộc** cho mọi FAIL / WARN / BLOCKED từ suite 06 trở đi (và FAIL lạ ở 01–05).

### 10.1 Đọc case

Từ `RESULTS-SUMMARY.md` (hoặc log) lấy: **id**, **title**, **status kỳ vọng**, **status thực tế**, **body thực tế** (`code`, `br`, `field`, `message`), **request** đã gửi.

### 10.2 Tìm code xử lý

1. Lấy đường dẫn API của case (vd `POST /classes/:id/enroll`).
2. `Select-String -Path src\lib\arena3\router.ts -Pattern 'enroll'` → tên handler.
3. `Select-String -Path src\lib\arena3\handlers\*.ts -Pattern 'function enroll|enroll\s*[:=]'` → tìm hàm.
4. Đọc hàm từ đầu đến cuối, ghi **thứ tự**: kiểm vai trò → input (`err.field`) → tồn tại (`notFound`) → trạng thái (`conflictState`, `err.br`) → ghi DB.

### 10.3 Tái hiện bằng 1 lệnh

Tạo `test-output/scratch/repro-<case>.mjs`:

```js
import { api, login, PHONES, IDS, memberWithPlan } from "../../scripts/tests/agent-lib.mjs";
const mgr = await login(PHONES.manager);
// dựng điều kiện tối thiểu, rồi gọi đúng request của case:
const r = await api("/classes/<id>/enroll", { method: "POST", token: mgr.token, body: {} });
console.log(r.status, JSON.stringify(r.data, null, 2));
```

Chạy trên server mới: `node scripts/tests/agent/run-suite.mjs test-output/scratch/repro-EN-25.mjs`.

### 10.4 Quyết định

Đi từ trên xuống, dừng ở dòng đầu tiên đúng:

| # | Nếu… | Phân loại | Làm gì |
| --- | --- | --- | --- |
| 1 | Response là **500** | `APP-BUG` | Ghi BUGS.md. Không bao giờ sửa script để chấp nhận 500. |
| 2 | Lỗi khớp một finding mục 14 | `KNOWN F-xx` | Ghi TRIAGE, không ghi BUGS. |
| 3 | Script gửi sai: sai tên trường/id/method/path, quên token, đọc sai hình dạng response (vd đọc `r.data.items` nhưng API trả mảng) | `SCRIPT-BUG` | Sửa script, chạy lại. |
| 4 | Điều kiện trước không đúng: setup không tạo được lớp/buổi/hội viên như ý nên case test nhầm thứ khác (lớp chưa `open` → ra BR-18 thay vì BR-22) | `SCRIPT-BUG` | Sửa setup, hoặc đổi thành `blocked(...)` kèm lý do. |
| 5 | Thứ tự kiểm trong code khác script (code kiểm `notFound` trước vai trò → 404 thay vì 403) **và** cả hai kết quả đều an toàn (không lộ dữ liệu, không ghi DB) | `SCRIPT-BUG` | Đổi kỳ vọng thành mảng, vd `status:[403,404]`, kèm comment. Nếu là "validation trước kiểm vai trò" → `KNOWN F-10`. |
| 6 | App **cho phép** điều mà SRS/BR/lẽ thường cấm: người không quyền làm được, xem được dữ liệu người khác, tiền/buổi tính sai, dữ liệu vô lý được lưu | `APP-BUG` | Ghi BUGS.md. **Giữ nguyên** kỳ vọng. |
| 7 | App từ chối đúng nhưng mã khác (422 thay vì 400), không ảnh hưởng an toàn | `SCRIPT-BUG` nếu code rõ ràng cố ý mã đó; không chắc → `NEEDS-HUMAN` | |
| 8 | Case `advisory` (ra WARN) | `WARN-ACCEPTED` hoặc `APP-BUG` LOW | Ghi BUGS.md mục "Đề xuất" nếu nghiệp vụ rõ ràng sai. |
| 9 | Không xác định được | `NEEDS-HUMAN` | Ghi rõ đã thử gì. |

**Ví dụ:**
- EN-25: Đức Anh (HLV bóng rổ) gọi `DELETE /enrollments/:id` của hội viên lớp cầu lông → 200. Code chỉ kiểm "là coach hoặc receptionist". Dòng 6 → `APP-BUG`, HIGH.
- CL-37 FAIL vì `itemsOf(r)` rỗng, nhưng log cho thấy API trả `{ classes:[...] }`. Dòng 3 → `SCRIPT-BUG`. Sửa `itemsOf` đọc thêm `r.data?.classes`, kèm `// fixed by agent: list endpoint returns {classes}`.
- TR-63 kỳ vọng 403 nhưng ra 404 vì code tìm học viên trong lớp của HLV trước rồi trả "not found", không lộ gì. Dòng 5 → `status:[403,404]`.

### 10.5 Suite crash (không có summary)

1. Mở log, tìm `TypeError`, `ReferenceError`, `Cannot read properties of undefined`, `SyntaxError`, `ECONNREFUSED`.
2. `ECONNREFUSED` / `fetch failed` → server chết. Đọc `server.log` 50 dòng cuối. Nếu server chết vì 1 request (crash do input) → **APP-BUG HIGH** (DoS). Ghi request cuối trong log suite.
3. `Cannot read properties of undefined (reading 'id')` ở `xxx.user.id`/`xxx.token` → hình dạng response của `login`/`memberWithPlan` khác giả định. In thử: `console.log(JSON.stringify(await login(PHONES.manager), null, 2))` rồi sửa script (`SCRIPT-BUG`).
4. Lỗi khác trong script → sửa, chạy lại. Tối đa 3 vòng, rồi `NEEDS-HUMAN` và đi tiếp.

---

## 11. Phase 5 — Tự viết suite 07–10

Phần này **bạn tự viết script** — mỗi suite 1 file trong `scripts/tests/agent/`. Đây là kiểm thử QA bản cục bộ của chính dự án: mục tiêu là chắc chắn app **từ chối đúng** mọi truy cập/đầu vào không hợp lệ, và **không sập**. Mỗi dòng checklist thành ít nhất 1 `check(...)`.

### 11.0 Quy trình viết một suite

1. **Tìm route** liên quan: `Select-String -Path src\lib\arena3\router.ts -Pattern 'promo'`. Ghi vào đầu file (comment): `METHOD /path → handlerName`.
2. **Đọc handler** từng route (mục 10.2). Với mỗi route ghi ra: ai được gọi; mọi `err.field("…")` → case 400 field đó; mọi `err.br("BR-…")` → case 422 br đó; mọi `notFound`/`conflictState`/`conflictSlot` → 404/409; thành công trả gì.
3. **Viết kỳ vọng:**
   - Phân quyền, kiểm soát truy cập, tiền: theo **lẽ đúng** (SRS + an toàn), KHÔNG theo code. Code cho phép điều sai thì test phải FAIL.
   - Validation chi tiết (độ dài, field nào): theo code.
   - Thứ code **không kiểm** nhưng nên kiểm (số âm, ngày kết thúc trước bắt đầu, id người khác): viết case với kỳ vọng đúng; không chắc nghiệp vụ → thêm `advisory:true`.
4. **Đánh id** theo tiền tố suite (dưới), không trùng.
5. **Không quá 40 hội viên mới** trong một file (F-04). Cần hơn → tách `10a-`, `10b-`.
6. **Dọn trạng thái toàn cục** (setting, feature flag) về như cũ ở cuối suite.
7. Cuối file: `summary();`.
8. Chạy `run-suite.mjs 07`, phân loại theo mục 10 (suite của bạn cũng là "chưa kiểm chứng").

### 11.0.1 Template (copy rồi điền)

```js
/**
 * Suite 07 — kiểm soát truy cập & độ bền đầu vào (tokens, quyền chéo, injection, payload xấu).
 * Agent QA viết theo docs/AGENT-TEST-INSTRUCTIONS.md mục 11.1. Chỉ chạy trên 127.0.0.1:8090.
 *   node scripts/tests/agent/run-suite.mjs 07
 * Cần DB mới. Tạo ~N hội viên.
 * Routes (từ src/lib/arena3/router.ts):
 *   GET /me → me ; ...
 */
import { api, blocked, check, ictDate, IDS, login, memberWithPlan, newMember, PHONES, slot, summary } from "../agent-lib.mjs";

const mgr = await login(PHONES.manager);            // { token, user }
const rec = await login(PHONES.receptionist);
const khoa = await login(PHONES.coach);
const ducAnh = await login(PHONES.coachBasket);
const bao = await login(PHONES.memberNoPlan);
const memberA = await memberWithPlan(mgr.token, IDS.planBadminton30);  // { token, user, subscription, ... }
const memberB = await memberWithPlan(mgr.token, IDS.planBadminton30);

const N = IDS.nonexistent;
const fieldIs = (f) => (r) => r.data?.field === f;
const fake = (data) => ({ status: 200, data, ms: 0, request: "computed by the script" });
const itemsOf = (r) => (Array.isArray(r.data) ? r.data : r.data?.items ?? []);

// ───── 1. Token ─────
check("SEC-01", "không token vào /me → 401", await api("/me"), { status: 401 });
check("SEC-02", "token rác → 401", await api("/me", { token: "abc" }), { status: 401 });

// Mẫu kiểm giá trị tự tính:
// const left = (await api("/me", { token: memberA.token })).data?.subscriptions?.[0]?.session_left;
// check("X-01", "session_left là 9", fake({ left }), { test: () => left === 9, why: `left=${left}` });

// Mẫu case không chạy được:
// blocked("X-02", "trả thiết bị 2 lần", "tạo loan trả 403 — xem X-01");

summary();
```

Mẫu chạy song song (race):

```js
const members = [];
for (let i = 0; i < 8; i++) members.push(await memberWithPlan(mgr.token, IDS.planBadminton30));
const rs = await Promise.all(members.map((m) => api("/bookings", { method: "POST", token: m.token, body: { /* cùng 1 slot */ } })));
const ok = rs.filter((r) => r.status === 201 || r.status === 200).length;
check("RACE-01", "8 hội viên, 1 slot → đúng 1 thắng", fake({ statuses: rs.map((r) => r.status) }), {
  test: () => ok === 1 && rs.every((r) => r.status !== 500),
  why: `winners=${ok}, statuses=${rs.map((r) => r.status).join(",")}`,
});
```

Mẫu body sai định dạng:

```js
check("SEC-40", "JSON hỏng → 400", await api("/bookings", { method: "POST", token: memberA.token, rawBody: "{bad", headers: { "content-type": "application/json" } }), { status: 400 });
```

### 11.1 Suite 07 — Kiểm soát truy cập & độ bền đầu vào (`07-security.mjs`, tiền tố `SEC-`)

Mục tiêu QA: không vai trò nào làm/xem được thứ không thuộc về mình; đầu vào bất thường không làm sập hay rò rỉ. Đây là kiểm tra phòng thủ trên app cục bộ của chính dự án.

**A. Token (SEC-01…)**

| # | Case | Kỳ vọng |
| --- | --- | --- |
| A1 | Không token vào mọi route cần đăng nhập (lấy từ router: route không public) | 401 |
| A2 | Token rỗng (`Bearer `), chuỗi vô nghĩa, header `Basic …`, token có thêm khoảng trắng | 401 |
| A3 | Token thật đổi 1 ký tự cuối | 401 |
| A4 | Nếu token là JWT (3 phần ngăn bởi `.`): sửa payload sang role cao hơn, giữ chữ ký cũ | 401 |
| A5 | JWT header `{"alg":"none"}` chữ ký rỗng | 401 |
| A6 | Token không phải JWT → A4, A5 = `blocked(..., "token is not a JWT")` | |
| A7 | Nếu có route logout (tìm `logout`): logout rồi dùng lại token | 401 |
| A8 | Đổi mật khẩu rồi dùng token cũ | 401 (đã biết F-11 = WARN, `advisory:true`) |
| A9 | Token của hội viên bị manager vô hiệu (tìm `disable`/`deactivate`/`status` trong handler members) | 401/403 |

**B. Quyền chéo — truy cập tài nguyên người khác (SEC-20…)**

Cách làm: tạo tài nguyên **của memberB** (đặt sân, mua gói, thanh toán, ghi danh lớp, ticket, bài tập…), rồi gọi bằng **token memberA**. Liệt kê mọi route có tham số `:id` mà member được gọi, rồi:

| Hành động của memberA trên tài nguyên của memberB | Kỳ vọng |
| --- | --- |
| GET chi tiết (booking, payment, receipt, subscription, enrollment, ticket, bài tập, thông báo, điểm danh, QR check-in) | 403 hoặc 404, body **không chứa** SĐT/tên/id của B |
| PATCH/PUT/DELETE/POST hành động (huỷ, đổi, trả tiền, đóng băng, nhận lời mời) | 403/404, và sau đó đọc lại (token B/manager): tài nguyên **không đổi** |
| Route danh sách kèm `user_id=<B>`/`member_id=<B>` | không trả dữ liệu của B |
| Route `/me/...` gọi bằng token A | chỉ trả dữ liệu của A |

**C. Ma trận vai trò × route (SEC-60…)**

Từ router, với mỗi route gọi lần lượt bằng cả 5 vai trò, ghi status ra `test-output/07-role-matrix.csv` (cột: method, path, anonymous, member, coach, receptionist, manager). So với vai trò mong đợi suy ra từ handler. Mỗi ô "vai trò không nên được phép mà status 2xx" → 1 case FAIL (APP-BUG, HIGH nếu là ghi/xoá/tiền).

**D. Độ bền đầu vào (SEC-80…)**

Mục tiêu: trường văn bản tự do (tên, ghi chú, level, tên gói, bài tập, ticket, `?q=`) phải **không làm app trả 500**, phải được **lưu nguyên văn** (không bị diễn giải như lệnh/HTML), và **không tạo thêm bản ghi nào ngoài ý muốn**. Với mỗi trường, gửi vài chuỗi đại diện rồi kiểm:

| Loại chuỗi kiểm thử | Kiểm điều gì |
| --- | --- |
| Chuỗi chứa ký tự SQL điển hình (dấu nháy, `--`) | không 500; lưu nguyên văn; đếm số bản ghi trước/sau không đổi ngoài 1 bản ghi hợp lệ |
| Đánh dấu HTML/script (vd `<b>x</b>`, thẻ có thuộc tính sự kiện) | lưu nguyên văn, khi đọc lại ra đúng byte đã gửi (kiểm XSS lưu trữ ở suite 11) |
| Mẫu template `{{7*7}}`, `${7*7}` | đọc lại ra đúng chuỗi gốc, không phải `49` |
| Chuỗi rất dài (10k ký tự), emoji, chữ phải-sang-trái | 400/422 nếu vượt giới hạn, hoặc lưu đúng; không 500 |
| Ký tự điều khiển/NUL | 400/422, không 500 |

**E. Payload xấu (SEC-90…)**: body 1 MB, JSON không hợp lệ, `Content-Type: text/plain`, body là mảng, body `null` → 400/413/415, không 500.

**F. Mass assignment (SEC-95…)**: gửi kèm các trường nhạy cảm (`role`, `member_code`, `balance`, `price_vnd`) khi tạo/sửa hồ sơ bằng token member → các giá trị đó phải bị **bỏ qua** (đọc lại thấy không đổi). Nếu áp được → APP-BUG HIGH.

**G. Origin/CORS & header bảo mật (advisory)**: gửi `Origin` lạ; kiểm header phản hồi (`Access-Control-Allow-Origin` không phải `*` kèm credentials). Ghi `advisory:true`.

**H. Phạm vi liên hệ**: HLV chỉ thấy SĐT học viên **lớp của mình**, không thấy của lớp khác.

**I. Tái xác nhận**: F-01 (khoá đăng nhập không kích hoạt), F-02 (giới hạn OTP không kích hoạt) — chỉ xác nhận lại, đừng đào sâu.

**J. Rò rỉ nội bộ**: quét log suite tìm `at /`, `node_modules`, `select `, `postgres` lọt vào response body → WARN.

### 11.2 Suite 08 — Tính năng mở rộng (`08-extras.mjs`)

Tiền tố: `SER-` (series/lớp lặp), `LOY-` (điểm thưởng), `COM-` (hoa hồng), `WO-` (lệnh sửa chữa), `EQ-` (thiết bị), `PR-` (khuyến mãi), `TK-` (ticket), `AI-` (trợ lý AI), `FL-` (feature flag), `CI-` (check-in), `AR-` (báo cáo at-risk); tiền tố `RMV-` (tính năng đã gỡ — suite 15).

- **Series/loyalty:** số dư điểm không bao giờ âm; dùng điểm vượt số dư → bị từ chối.
- **Commission (COM-):** HLV chỉ xem hoa hồng của **chính mình**.
- **Work order (WO-):** sân đang có lệnh sửa chữa → không đặt được (kỳ vọng từ chối, không 500).
- **Equipment (EQ-):** mượn/trả thiết bị, BR-50; trả 2 lần; mượn quá số lượng.
- **Promotions (PR-):** CRUD mã; kiểm **mọi lý do BR-40** liệt kê trong `src/lib/arena3/promos.ts` (mã sai, tạm dừng, chưa bắt đầu, hết hạn, sai phạm vi, sai môn, sai gói, dưới đơn tối thiểu, hết lượt, hội viên đã dùng, giảm 0); **BR-42** (không cộng dồn với giảm giá sân); **BR-41** (hoàn toàn phần trả lại lượt, hoàn một phần thì không); mã nhập có khoảng trắng/chữ hoa phải được chuẩn hoá; mã seed `SUMMER50K`.
- **Tickets (TK-):** member không xem được ticket của người khác.
- **AI (AI-):** AI tắt → lỗi lịch sự (không 500); nếu có giới hạn tần suất → 429.
- **Feature flag (FL-):** tắt F4 → `/coach/classes` trả 403 `br:"BR-52"`, **rồi bật lại** (dọn dẹp). Tìm route bật/tắt flag trong router.
- **Check-in (CI-):** QR/scan/gate (BR-30); quét lại; QR hết hạn; không gói; check-in 2 lần; tự check-in.
- **At-risk (AR-):** báo cáo hội viên nguy cơ rời bỏ và vai trò được xem.

### 11.3 Suite 09 — Cấu hình & báo cáo (`09-settings-reports.mjs`)

Tiền tố: `ST-` (settings), `PRC-` (price rules), `RP-` (reports), `AU-` (audit), `MB-` (members list).

- **Settings (ST-):** biên giá trị, kiểu, số thập phân; chỉ manager sửa được; **khôi phục giá trị gốc cuối suite**.
- **Price rules (PRC-):** chồng khung giờ; giá âm; kết thúc trước bắt đầu; giờ cao điểm; `quote` phản ánh đúng rule.
- **Reports (RP-):** doanh thu (from > to, ngày sai, quá 1 năm); occupancy ngày sai (F-14); capacity/members/attendance; export CSV (F-15, công thức `=HYPERLINK`); tổng đối chiếu với các payment tạo ra trong lúc test.
- **Audit (AU-):** bộ lọc và vai trò; hành động nhạy cảm có xuất hiện trong audit log.
- **Members list (MB-):** `limit` = 0, 101, −1, "abc"; phân trang không trùng bản ghi.

### 11.4 Suite 10 — Job nền & tranh chấp đồng thời (`10-jobs-race.mjs`)

Tiền tố: `JOB-`, `RACE-`.

- **Hết hạn giữ chỗ (JOB-):** tìm cấu hình thời gian giữ chỗ và job trong source; nếu rút ngắn được thì rút, đợi, kiểm slot được giải phóng. Không chỉnh được → BLOCKED.
- **Hết hạn waitlist:** BLOCKED trừ khi timeout cấu hình được.
- **Race (RACE-):**
  - 10 request song song cùng 1 slot → đúng 1 cái 201, còn lại 409 `CONFLICT_SLOT`;
  - ghi danh song song vào lớp sĩ số 1;
  - chấp nhận lời mời song song;
  - 5 request cùng `Idempotency-Key` → đúng 1 payment;
  - race lượt cuối của mã khuyến mãi (BR-41);
  - đóng ca song song.
  Mọi case: **không có 500**.
- **F-04:** đăng ký ~60 hội viên liên tiếp, ghi lại chỗ gãy (429 là rate limit, **không phải** F-04; F-04 là lỗi trùng mã hội viên).

> Nếu một suite vượt ~40 hội viên, tách `10a-`, `10b-` và chạy mỗi file trên server mới.

---

## 12. Phase 6 — Crawl giao diện (suite 11)

File `scripts/tests/agent/11-ui-crawl.mjs` (tiền tố `UI-`). Mở từng trang bằng Playwright đã cài sẵn và kiểm lỗi hiển thị.

1. **Kiểm Playwright có sẵn:** thử `import('playwright')` hoặc `@playwright/test`. Thiếu → cả suite `blocked("UI-00", ..., "playwright chưa cài")`; **không cài** nó, không cài axe-core.
2. **Trình duyệt:** dùng `channel:"chrome"` trỏ `http://127.0.0.1:8090/`.
3. **Danh sách route UI:** lấy từ file trong `src/routes` (quy ước TanStack: `index` = `/`, `$param` cần id thật, `_layout` không thêm segment, `.` = `/`) và từ `docs/SCREENS.md`.
4. **Đăng nhập:** gọi API lấy token rồi nhét token vào localStorage (grep `localStorage.setItem` tìm key), hoặc qua form đăng nhập.
5. **Ngôn ngữ:** grep key locale i18n; kiểm cả `en` và `vi`.
6. **Viewport:** 1366×820 và 390×844.

Với mỗi (vai trò × route × viewport × locale) kiểm:

| Kiểm | FAIL khi |
| --- | --- |
| Console error / page error | có error |
| Request ≥ 500 | có |
| Tràn ngang: `scrollWidth > innerWidth + 1` | tràn |
| Rò i18n: key thô hiện ra, hoặc chữ tiếng Anh trên trang `vi` | có |
| Route cấm với vai trò → redirect về login/403 | không redirect |
| Ảnh vỡ (`naturalWidth === 0`) | có |
| Đánh dấu XSS: `window.__xss` phải `undefined` sau khi mở trang có dữ liệu test từ suite 07 | có giá trị |

Ảnh chụp → `test-output/ui/<role>-<route>-<viewport>-<locale>.png`; kết quả → `test-output/ui/ui-crawl.json`. Dùng tên route đã làm sạch (thay `/` bằng `_`).

---

## 13. Phase 7 — Checklist màn hình

Từ `docs/SCREENS.md`, tạo `test-output/SCREENS-CHECKLIST.md`, mỗi màn hình 1 dòng:

```markdown
| Màn hình | Vai trò | Thành phần hiển thị đủ? | Hành động chính chạy? | Ghi chú |
| --- | --- | --- | --- | --- |
```

Dùng kết quả Phase 6 (ảnh + ui-crawl.json) để điền. Màn hình nào Phase 6 không mở được → ghi `BLOCKED` kèm lý do.

---

## 14. Finding đã biết

Từ suite 01–05 (đã xác nhận). FAIL/WARN khớp các mục này → TRIAGE `KNOWN F-xx`, **không** ghi lại vào BUGS.md (chỉ xác nhận lại trong FINAL-REPORT: còn/đã hết).

| Id | Mức | Finding |
| --- | --- | --- |
| F-01 | HIGH | Khoá đăng nhập không bao giờ kích hoạt |
| F-02 | HIGH | Giới hạn số lần nhập OTP không kích hoạt |
| F-03 | HIGH | HLV đọc/quote/huỷ được booking bất kỳ |
| F-04 | HIGH | Bộ đếm mã hội viên kẹt ở A3-2026-0099 (đăng ký hỏng sau ~48) |
| F-05 | MEDIUM | `start_at` không hợp lệ → 500 |
| F-06 | MEDIUM | Đặt sân ngoài lưới / sau giờ đóng cửa vẫn nhận |
| F-07 | LOW | Idempotency key dùng chung toàn cục |
| F-08 | LOW | Đăng nhập bằng email phân biệt hoa thường |
| F-09 | LOW/MED | Lỗi walk-in |
| F-10 | LOW | Validation chạy trước kiểm vai trò |
| F-11 | WARN | Phiên không bị thu hồi sau đổi mật khẩu |
| F-12 | MEDIUM | Payment ảo; phương thức quota trên `/payments` |
| F-13 | MEDIUM | `shift_id` lạ → 500; ghi vào két người khác |
| F-14 | – | Ứng viên: báo cáo occupancy ngày sai → 500 |
| F-15 | WARN | CSV injection (công thức) |
| F-16 | MEDIUM | Hoàn tiền mặt không tính vào két |
| F-17 | LOW | Tiền mặt khai báo âm vẫn nhận |
| F-18 | MEDIUM | Đặt gói cho `user_id` lạ → 500 |
| F-19 | LOW | Đóng băng rồi mở vẫn giữ số ngày thêm |
| F-20 | LOW | Giá không khoá tại thời điểm đặt |
| F-21 | LOW | Bán được gói cho HLV |
| F-22 | LOW | Freeze `days` = "abc" thành 7 |

**Finding mới bắt đầu từ F-23.** Ứng viên suite 06 (xác nhận bằng repro trước khi gán số): HLV xoá được ghi danh bất kỳ (EN-25); court/assistant lạ khi tạo lớp → 500; sĩ số 1000 được nhận; BYHOUR/ngày/môn sân/vai trò trợ giảng không được kiểm; điểm danh trước buổi học; dời buổi bỏ qua giờ mở cửa/lưới/`end_on`; chen hàng waitlist; `waitlistAccept` không trừ `session_left`; tạo giáo án mới cho buổi đã có kết quả.

---

## 15. Mức độ nghiêm trọng và mẫu báo bug

| Mức | Nghĩa |
| --- | --- |
| CRITICAL | Mất dữ liệu, sai tiền, vượt quyền trên diện rộng |
| HIGH | Lỗi kiểm soát truy cập / phân quyền, lộ dữ liệu người khác, hỏng luồng lõi |
| MEDIUM | 500, nhận dữ liệu sai, biên lỗi tiền bạc |
| LOW | Lỗi nhỏ |
| WARN | Khuyến nghị / tư vấn |

Mỗi bug mới (F-23 trở đi) thêm 1 mục vào `test-output/BUGS.md`:

```markdown
### F-xx — <tiêu đề ngắn> — <MỨC>
- Suite/case: 06 / EN-25
- Endpoint: DELETE /v1/enrollments/:id
- Vai trò: coach (Đức Anh, bóng rổ)
- Repro: <các bước, hoặc đường dẫn test-output/scratch/repro-EN-25.mjs>
- Kỳ vọng: 403 (HLV không phụ trách không được xoá ghi danh)
- Thực tế: 200, ghi danh bị xoá
- Bằng chứng: test-output/logs/06-classes.log dòng <n>; repro in ra <...>
- Code liên quan: src/lib/arena3/handlers/<file>.ts:<dòng>
- Ghi chú: handler chỉ kiểm "là coach hoặc receptionist", không kiểm phụ trách lớp
```

---

## 16. Phase 8 — Báo cáo cuối

1. `node scripts/tests/agent/summarize-results.mjs` → sinh `test-output/RESULTS-SUMMARY.md`.
2. Hoàn tất `TRIAGE.md` (mọi FAIL/WARN/BLOCKED đã phân loại) và `BUGS.md`.
3. `git status --short` so với ảnh chụp 5.1 — xác nhận không file dự án nào thay đổi (ngoài `test-output/` và các file test bạn được phép tạo trong `scripts/tests/agent/`).
4. Viết `test-output/FINAL-REPORT.md`:

```markdown
# Arena 3 — Báo cáo kiểm thử
Môi trường: <node, commit, ngày giờ, khoảng giờ chạy VN>

## 1. Tổng quan
Bảng đếm PASS/FAIL/WARN/BLOCKED theo từng phase/suite (dán từ RESULTS-SUMMARY).

## 2. CRITICAL & HIGH (đặt lên đầu)
Liệt kê trước, mỗi mục dẫn tới BUGS.md.

## 3. Finding mới (F-23+)
Bảng id / mức / một dòng mô tả.

## 4. Finding đã biết — tái xác nhận
F-01…F-22: còn / đã hết / không kiểm được.

## 5. Sửa script
Mỗi lần sửa 06/07/08/09/10/11: file, dòng, lý do (khớp comment `// fixed by agent:`).

## 6. BLOCKED
Danh sách + lý do (giờ chạy, playwright thiếu, timeout không chỉnh được…).

## 7. Khoảng trống phủ (coverage gaps)
Route/màn hình chưa test được và vì sao.

## 8. Tác dụng phụ
File dự án bị build/script thay đổi (nếu có) và trạng thái đã restore hay chưa.
```

5. Gửi `FINAL-REPORT.md` cho người dùng.

---

## 17. Phụ lục

### 17.1 Lệnh hay dùng

```powershell
# Liệt kê route
Select-String -Path src\lib\arena3\router.ts -Pattern '"/'
# Lỗi của một handler
Select-String -Path src\lib\arena3\handlers\*.ts -Pattern 'err\.|forbidden|notFound|conflict'
# Mọi mã BR
Select-String -Path src\lib\arena3\*.ts,src\lib\arena3\handlers\*.ts -Pattern 'err\.br\("BR-'
# 30 dòng cuối một log
Get-Content test-output\logs\06-classes.log -Tail 30
```

Git Bash: `grep -rn '"/' src/lib/arena3/router.ts`, `grep -rn 'err.br("BR-' src/lib/arena3`, `tail -n 30 test-output/logs/06-classes.log`.

### 17.2 Lỗi thường gặp

| Triệu chứng | Nguyên nhân | Xử lý |
| --- | --- | --- |
| `ECONNREFUSED` / `fetch failed` ngay đầu suite | server chưa lên / đã chết | `run-suite.mjs --server-only`; nếu chết giữa chừng vì 1 request → APP-BUG (mục 10.5) |
| `Cannot read properties of undefined (reading 'id')` | đọc sai hình dạng response của `login`/`memberWithPlan` | in JSON ra, sửa script |
| Hàng loạt đăng ký FAIL sau ~48 lần | F-04 | tách suite, chạy server mới |
| Nhiều case BLOCKED ở 06 ngoài giờ hành chính | giờ chạy | chạy lại 07:00–19:00 VN |
| `docs/interactive-tests-report.json` hiện trong `git status` sau Phase 2 | script ghi đè | `git restore docs/interactive-tests-report.json` |
| Suite treo không kết thúc | thiếu `summary()` / vòng lặp / watch mode | kiểm có `summary()`; unit test dùng `vitest run` |

### 17.3 Nhắc lại ba điều dễ quên nhất

1. **Khởi động lại server trước mỗi suite.** DB trong RAM + F-04.
2. **500 luôn là bug** — không bao giờ sửa test để chấp nhận 500.
3. **Không đổi kỳ vọng để lấy PASS** trừ khi đã chứng minh script sai (mục 10).
