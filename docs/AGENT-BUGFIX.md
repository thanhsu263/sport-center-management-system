# AGENT-BUGFIX — Sửa 27 bug đã biết, từng nhóm một

Tài liệu này giao cho agent QA sửa các bug trong `test-output/final/BUGS-FINAL.md`.

Nhiệm vụ dọn công nợ và vé ngày (`docs/AGENT-CLEANUP-DEBT-DAYPASS.md`) đã xong ở R4. Không làm lại phần đó.

Mỗi vòng chỉ sửa **một nhóm**. Hết vòng, agent trả báo cáo, người duyệt đọc rồi mới giao nhóm tiếp theo.

---

## 0. Luật cứng (giữ nguyên từ mục 0 của file cleanup, có bổ sung)

1. Chỉ test trên `http://127.0.0.1:8090`, tức safe server do `scripts/tests/start-safe-server.mjs` khởi động. Đây là PGlite in-memory; payOS, SMTP và AI đều tắt.
2. **Không** mở, in, copy hay grep `.env`, `.env.local`, `.env.*`. Không in biến môi trường bí mật.
3. **Không** đụng Neon thật, payOS thật, SMTP thật.
   - Không chạy `check-integrations`, `check:integrations`, `deploy`, `migrate`, `db:push`, `db:seed`, `neon`.
   - Không dùng tool MCP Neon.
4. Không `npm install`. Chỉ dùng `npx --no-install`.
5. Không `git commit`, `push`, `stash`, `reset`, `checkout -- <file>`. Chỉ được `git diff` và `git status`.
6. Được sửa `src/`, `scripts/tests/`, `docs/`, và được **thêm** migration mới.
   - Không sửa migration cũ.
   - Không sửa `attachments/`, `graft/`, `.agents/`, `agent/`.
7. **Không bao giờ đổi expected value của test để có PASS.**
   - Nếu test sai đặc tả, ghi vào `NEEDS-HUMAN.md` và giữ nguyên.
   - HTTP 500 luôn là bug.
8. Không Mermaid. Sơ đồ, nếu có, chỉ là draw.io XML.
9. Mọi con số trong báo cáo phải lấy từ output lệnh chạy **trong vòng này**, dán nguyên văn. Không tóm tắt, không dán lại output cũ.
10. Sửa đúng gốc bug, sửa ít nhất có thể.
    - Không refactor lan rộng.
    - Không đổi tên hàm hay API công khai, trừ khi bug buộc phải làm vậy.
    - Viết code giống phong cách xung quanh: comment ít và nói *tại sao*, không nói *cái gì*.

Thư mục output: `test-output/bugfix/`, gồm `PROGRESS.md`, `FIXES.md`, `FIXTURE-DIFF.md`, `NEEDS-HUMAN.md`. Mỗi vòng ghi dưới `## <tên nhóm>`.

---

## 1. Bước 0 — Đóng băng baseline (làm MỘT lần, trước mọi sửa code)

Ở R4 ta mất baseline JSONL, vì `run-suite.mjs` dùng `rmSync` xoá kết quả cũ. Không được để mất lần nữa.

1. Chạy sạch toàn bộ bằng `node scripts/tests/agent/run-all-clean.mjs`. Lúc này chưa sửa code nào.
2. Copy **toàn bộ** `test-output/results/*.jsonl` sang `test-output/baseline-v2.4/` và không bao giờ ghi đè thư mục này.
3. Sửa `status-transitions.mjs` để nhận hai tham số đường dẫn:
   ```
   node scripts/tests/agent/status-transitions.mjs <dirTruoc> <dirSau>
   ```
   Script đọc JSONL thật ở cả hai thư mục, lấy dòng cuối mỗi id, rồi in:
   - id chỉ có ở trước;
   - id chỉ có ở sau;
   - mọi id đổi trạng thái;
   - bảng đếm.

   **Không** được nhúng sẵn lý do hay con số trong script. Phần "lý do" viết riêng trong `FIXES.md`.
4. Từ baseline, sinh ra bằng script (không gõ tay) các file:
   - `test-output/baseline-v2.4/FAIL-IDS.txt`: mỗi dòng gồm `suite | id | bug` nếu có;
   - `WARN-IDS.txt`;
   - `BLOCKED-IDS.txt`.

   Báo cáo R4 liệt kê WARN bằng tay và bị lệch: "PS-14..20 [5]" là 7 id; suite 02 có 3 WARN nhưng danh sách chỉ có 2. Lần này phải đúng.
5. Kỳ vọng: 2,943 case, gồm 2,830 PASS, 86 FAIL, 21 WARN, 6 BLOCKED. Nếu lệch, dừng lại, báo cáo id lệch, chưa sửa bug.

### 1.1 Bổ sung sau lần chạy baseline đêm 14/10 (lệch 4 case vì giờ chạy)

Lần chạy lúc 20:33 ICT ra 2,942 case: 2,826 PASS / 88 FAIL / 21 WARN / 7 BLOCKED. Bốn case bị lệch đều do fixture phụ thuộc giờ chạy, không phải do code app. Agent đã dừng đúng luật.

Sửa **chỉ fixture**. Expected giữ nguyên.

1. **SS-21 / SS-22** (`scripts/tests/agent/06-classes.mjs:625-627`).
   - Khi buổi học `L12.soon` bắt đầu từ 20:00 ICT trở đi, code đang lùi 1 giờ. Ở 20:34 thì 20:00 đã là quá khứ, nên server trả 400 "must be in the future" trước khi kịp kiểm BR-27.
   - Sửa: chọn `newAt` là mốc **tương lai** đầu tiên trong danh sách `[start − 1h, start + 1h, start + 24h]` thoả hai điều kiện:
     - `newAt > now + 30 phút`;
     - giờ ICT nằm trong giờ mở cửa (06–21, dùng `ictHourOf`).
   - Mục đích của SS-21 là kiểm "buổi **gốc** bắt đầu trong vòng 12 giờ", nên dời sang ngày mai vẫn đúng nghĩa.
   - Vòng lặp xử lý `CONFLICT_SLOT` của SS-22 giữ nguyên.
2. **BK-98 / BK-99** (`scripts/tests/agent/03-bookings.mjs:411-419`).
   - Không còn ô sân 0.6–3.5 giờ tới là đúng thực tế khi trung tâm sắp đóng cửa. BLOCKED trong trường hợp này là hợp lệ.
   - Lỗi thật của fixture là BK-99 **biến mất** khỏi kết quả. Sửa nhánh `else` để ghi BLOCKED cho **cả** BK-98 và BK-99, cùng lý do.
   - **Không** sửa `cancel_court_hours` hay setting nào khác để ép ra slot. Đổi setting giữa suite sẽ làm sai các case khác. Phương án này đã bị bác.
3. **Khung giờ chạy.**
   - Baseline và mọi lần chạy sạch dùng để so sánh phải bắt đầu trong khoảng **07:00–18:30 ICT**, để cả suite xong trước 20:00.
   - Trước khi chạy, in giờ ICT hiện tại ra. Nếu ngoài khung thì **không chạy**: ghi vào `PROGRESS.md` và dừng, chờ người dùng.
   - Ghi giờ bắt đầu và giờ kết thúc vào `PROGRESS.md`.
4. Ghi 2 thay đổi fixture vào `test-output/bugfix/FIXTURE-DIFF.md` theo dạng trước/sau, kèm lý do. Sau đó chạy riêng suite 03 và 06 một lần để chứng minh các case vẫn chạy.
5. Chạy lại Bước 0 đầy đủ, trong khung giờ.
   - Kỳ vọng vẫn là 2,943 case: 2,830 PASS / 86 FAIL / 21 WARN / 6 BLOCKED.
   - Đạt thì copy sang `baseline-v2.4/`. Lệch thì dừng và báo id.

### 1.2 Đồng hồ giả (thay cho khung giờ 07:00–18:30 ở 1.1.3)

Người dùng quyết định không chờ tới sáng. Mọi lần chạy sạch (baseline và sau mỗi vòng sửa) đều chạy dưới **cùng một giờ giả cố định**: **Thứ Năm 2026-10-15, 09:00 ICT**.

Lợi ích: kết quả không phụ thuộc giờ thật, và các lần chạy so được với nhau tuyệt đối.

**Luật riêng cho đồng hồ giả:**
- Chỉ được giả giờ **bên trong các process Node của test**.
- **Không** đổi đồng hồ Windows và không đụng cài đặt hệ thống. Đây là việc bị cấm.
- **Không** sửa `src/`: code app không được biết là đang có đồng hồ giả.

**Cách làm:**

1. Tạo `scripts/tests/fake-clock.mjs`. Đây là file preload, nạp qua `--import`, và vá **global `Date`**:
   - Đọc `FAKE_CLOCK_OFFSET_MS` từ env. Nếu không có hoặc bằng 0 thì không làm gì.
   - Thay `globalThis.Date` bằng một subclass:
     - `Date.now()` trả `realNow + OFFSET`;
     - `new Date()` không có tham số cũng dùng `realNow + OFFSET`;
     - `new Date(x)` có tham số thì giữ nguyên;
     - `Date.UTC`, `Date.parse` giữ nguyên.

     Đồng hồ vẫn chạy bình thường, chỉ bị dịch đi một khoảng cố định.
   - In ra stderr đúng một dòng: `[fake-clock] offset=<ms> now=<ISO>`.
2. **OFFSET phải là một hằng số chung** cho mọi process.
   - Không tính offset riêng trong từng process. Server và các suite khởi động ở những thời điểm thật khác nhau, nên mỗi process tự tính sẽ ra giờ lệch nhau.
   - Tạo `scripts/tests/agent/run-fake-clock.mjs <lệnh...>`. Script này tính **một lần** `OFFSET = Date.parse("2026-10-15T02:00:00Z") − Date.now()` (09:00 ICT là 02:00 UTC), rồi `spawnSync` lệnh được truyền vào với env:
     - `FAKE_CLOCK_OFFSET_MS=<OFFSET>`;
     - `NODE_OPTIONS="--import <đường dẫn file:// tuyệt đối tới fake-clock.mjs> " + NODE_OPTIONS cũ`.
   - `run-all-clean.mjs`, `run-suite.mjs` và `start-safe-server.mjs` đều truyền `process.env` xuống process con (`run-all-clean.mjs:66`, `run-suite.mjs:97,135`, `start-safe-server.mjs:52-58`). Nhờ vậy server `npm run dev`, các suite và `execSync("npx tsx …")` đều nhận cùng offset.
   - Ví dụ chạy:
     ```
     node scripts/tests/agent/run-fake-clock.mjs node scripts/tests/agent/run-all-clean.mjs
     ```
3. **Kiểm chứng đồng hồ giả trước khi chạy baseline (bắt buộc).** Ghi output nguyên văn vào `PROGRESS.md`.
   - **(a) Phía test:** trong một process chạy qua `run-fake-clock.mjs`, in `new Date().toISOString()`. Kết quả phải là khoảng `2026-10-15T02:00Z`.
   - **(b) PGlite:** trong process có fake clock, mở PGlite in-memory và chạy `select now()`. Kết quả phải là khoảng `2026-10-15 02:00Z`.
     - Nếu PGlite **không** theo đồng hồ giả, **dừng lại và báo**. Không tự sửa SQL trong `src/` để thay `now()`. Lý do: app dùng `now()` của Postgres ở nhiều nơi (khoá tài khoản, hạn OTP, …), nên nếu JS và DB lệch giờ thì kết quả vô nghĩa.
   - **(c) App thật:** khởi động safe server qua `run-fake-clock.mjs`.
     - Login bằng tài khoản seed và gọi một API trả về mốc thời gian do server tạo. Ví dụ: tạo booking hold rồi đọc `created_at` / `hold_expires_at`, hoặc mở ca rồi đọc `opened_at`.
     - Mốc đó phải là 15/10, khoảng 09:00 ICT.
     - Ghi rõ đã dùng endpoint nào.
   - **(d)** Header HTTP `Date` của Node có thể vẫn là giờ thật, vì Node dùng `Date` nội bộ. Điều này chấp nhận được. Chỉ ghi nhận, không sửa.
4. **Mọi lần chạy sạch từ giờ** (baseline, sau G-1, sau mọi vòng sau) đều phải chạy qua `run-fake-clock.mjs`, với **đúng cùng mốc** 2026-10-15T02:00:00Z. Như vậy không còn phải kiểm khung giờ thật ở 1.1.3.
5. **Baseline dưới đồng hồ giả có thể khác 2,830 / 86 / 21 / 6**, vì 09:00 sáng thứ Năm là một bối cảnh khác.
   - Điều kiện bắt buộc: **tổng phải đúng 2,943 case** và **không có id MISSING**.
   - Nếu PASS/FAIL/WARN/BLOCKED khác bộ số cũ, chạy `status-transitions.mjs` so với kết quả lần chạy thật gần nhất (nếu còn), rồi liệt kê từng id đổi trạng thái và lý do.
     - Lý do chấp nhận được: phụ thuộc giờ hoặc thứ trong tuần, ví dụ giá giờ cao điểm hay ô sân còn trống.
     - **FAIL mới không giải thích được bằng giờ thì dừng và báo.**
   - Nếu bị lệch, chạy baseline giả **hai lần**. Hai lần phải ra **cùng** bộ số. Nếu khác nhau thì có test chập chờn: dừng và báo id.
6. Đạt điều kiện thì copy sang `test-output/baseline-v2.4/` và ghi `FAKE-CLOCK.txt`, gồm mốc giờ, offset và lệnh đã chạy.

---

## 2. Quy trình chung cho mỗi nhóm bug

1. **Tái hiện trước khi sửa.**
   - Chạy `node scripts/tests/agent/regression.mjs F-xx` cho từng bug trong nhóm.
   - Kết quả phải FAIL. Dán output.
2. **Sửa code.**
   - Ghi `file:dòng` trước và sau.
   - Dán `git diff` của đúng các file đã sửa.
3. **Kiểm tra tĩnh.**
   - `npx --no-install tsc --noEmit`: 0 lỗi.
   - `npx --no-install eslint src`: không thêm lỗi mới so với 1 lỗi có sẵn ở `src/routes/index.tsx:84`.
   - `npm test`: 114 test cũ vẫn PASS, cộng các test mới nếu có.
4. **Regression.** Chạy `regression.mjs F-xx`, kết quả phải PASS.
5. **Chạy sạch toàn bộ**, rồi chạy `status-transitions.mjs test-output/baseline-v2.4 test-output/results`.
   - Chỉ các case thuộc bug vừa sửa được phép đổi từ FAIL sang PASS.
   - **Mọi** chuyển trạng thái khác, nhất là PASS sang FAIL, phải được giải thích từng id trong `FIXES.md`.
   - Nếu là hồi quy thật thì sửa lại trước khi báo cáo.
6. **Copy kết quả vòng này** sang `test-output/bugfix/<nhóm>/results/` để vòng sau so được.
7. **Cập nhật tài liệu.**
   - Trong `test-output/final/BUGS-FINAL.md`, đánh dấu bug là `FIXED (<nhóm>, <ngày>)`. Không xoá mục bug.
   - Trong `regression.mjs`, không đổi case.

---

## 3. Vòng G-1 — `withTx` rollback mất bộ đếm (F-01, F-02)

### 3.1 Bản chất bug (đã đọc code, không cần tìm lại)

- `src/lib/arena3/router.ts:52-60`: `register`, `otp/verify` và `login` đều chạy trong `withTx(...)`.
- `src/lib/arena3/tx.ts:37-76`: `withTx` sẽ ROLLBACK khi handler ném lỗi.
  - Nhánh PGlite dùng `pg.transaction` (dòng 38-46).
  - Nhánh pg/Neon dùng BEGIN/COMMIT/ROLLBACK (dòng 47-76).
- **F-01**, `src/lib/arena3/handlers/auth.ts:222-232` (`login`):
  - Khi sai mật khẩu, handler chạy `update users set failed_logins = ...` (khi đủ 5 lần thì set luôn `locked_until`) rồi `throw err.unauth(...)` hoặc `throw err.rateLimited(...)`.
  - Lệnh throw làm rollback, nên `failed_logins` không bao giờ tăng và tài khoản không bao giờ bị khoá.
- **F-02**, `auth.ts:161-163` (`verifyOtp`):
  - Handler chạy `update otp_challenges set attempts = attempts + 1` rồi `throw err.validation(...)`.
  - Cũng bị rollback, nên chặn `attempts >= 5` ở dòng 159 không bao giờ kích hoạt.

### 3.2 Cách sửa bắt buộc (chọn đúng cách này, không tự nghĩ cách khác)

Cho phép handler báo: "giữ lại các lệnh ghi đã chạy, rồi trả lỗi này".

1. Trong `src/lib/arena3/tx.ts`, thêm và export:
   ```ts
   /**
    * Throw this when the writes made so far must survive the error — a wrong
    * password still has to count toward the lockout. `withTx` commits, then
    * rethrows `inner`.
    */
   export class KeepWrites extends Error {
     constructor(public readonly inner: unknown) {
       super("keep writes");
     }
   }
   ```
2. Sửa `withTx` cho **cả hai nhánh**:
   - **Nhánh PGlite:** bọc `fn(...)` bên trong callback của `pg.transaction` bằng `try/catch`.
     - Nếu `e instanceof KeepWrites`, lưu `e.inner` vào biến ngoài rồi `return undefined`. Callback trả về bình thường thì PGlite sẽ COMMIT.
     - Sau khi `await pg.transaction(...)` xong, nếu có lỗi đã lưu thì `throw` nó.
     - Lỗi khác vẫn ném như cũ để rollback.
   - **Nhánh pg/Neon:** trong `catch (e)`, nếu `e instanceof KeepWrites` thì chạy `COMMIT` thay cho `ROLLBACK`, rồi `throw e.inner`.
     - Giữ đúng hành vi `client.release(hasError)`. Commit thành công nghĩa là connection vẫn tốt, nên đặt `hasError = false` trong trường hợp này.
     - Nếu chính lệnh COMMIT lỗi thì ROLLBACK và ném lỗi COMMIT.
3. Trong `auth.ts`, import `KeepWrites` từ `"../tx"`, rồi chỉ đổi đúng 3 chỗ throw ngay sau lệnh update bộ đếm:
   - dòng 229: `throw new KeepWrites(err.rateLimited("5 wrong passwords — locked for 15 minutes."));`
   - dòng 232: `throw new KeepWrites(err.unauth("Wrong login or password."));`
   - dòng 163: `throw new KeepWrites(err.validation("That OTP is not correct.", { field: "otp" }));`

   Các throw khác **giữ nguyên**, vì chúng không có lệnh ghi nào cần giữ.
4. Kiểm tra rằng mọi nơi bắt lỗi ở tầng ngoài (router, `withIdempotency`, chỗ chuyển `ApiError` thành response) **không** bao giờ thấy `KeepWrites`, vì `withTx` đã gỡ nó ra.
   - Grep `KeepWrites` toàn `src/` và liệt kê.
   - Nếu có handler nào có thể ném `KeepWrites` ra ngoài `withTx` (ví dụ gọi trực tiếp không qua `withTx`), ghi lại.

### 3.3 Không được làm

- Không chuyển bộ đếm sang bộ nhớ RAM. Không dùng `limit()` hay `RULES` thay cho cột DB.
- Không mở connection hay transaction thứ hai bên trong handler.
- Không bỏ `withTx` khỏi `login`, `otp/verify` hay `register`.
- Không đổi ngưỡng 5 lần, không đổi thời gian khoá 15 phút, không đổi mã lỗi.

### 3.4 Kỳ vọng hành vi sau khi sửa

**Login sai mật khẩu liên tiếp trên cùng một tài khoản:**
- lần 1 đến 4: 401, và `failed_logins` lần lượt là 1, 2, 3, 4;
- lần 5: 429 RATE_LIMITED, `locked_until` khoảng bây giờ + 15 phút;
- lần 6 trở đi, kể cả nhập **đúng** mật khẩu: 429.

**Login đúng khi chưa bị khoá:** 200, và `failed_logins` về 0.

**OTP sai liên tiếp:**
- lần 1 đến 5: 422, và `attempts` lần lượt là 1 đến 5;
- lần 6: 429, kể cả nhập **đúng** OTP.

**Login với số điện thoại không tồn tại:** 401 như cũ, không ghi gì.

### 3.5 Test mới

1. **Unit test.** Thêm vào file test đã có trong `src/lib/arena3/`, theo đúng cách file đó khởi tạo DB. Nếu file đó không dùng DB, tạo `src/lib/arena3/tx.test.ts` dùng PGlite in-memory, giống cách `rmv-legacy-daypass.mjs` áp migration. Các test cần có:
   - `withTx` + `KeepWrites`: ghi một dòng, ném `KeepWrites(new Error("x"))`. Kỳ vọng: lỗi ném ra là `"x"` (không phải `KeepWrites`) và dòng **vẫn còn**.
   - `withTx` + lỗi thường: ghi một dòng rồi ném lỗi. Kỳ vọng: dòng **không còn** (rollback vẫn hoạt động).
   - Nếu import được handler `login` / `verifyOtp` với `Request` giả: 5 lần sai thì lần thứ 5 nhận 429 và `locked_until` khác null.
2. **Kiểm chứng ngược (bắt buộc).**
   - Tạm đổi một chỗ `throw new KeepWrites(...)` ở `auth.ts` về `throw err...` như cũ.
   - Chạy unit test và `regression.mjs F-01`: phải FAIL.
   - Trả lại y nguyên, chứng minh bằng `git diff src/lib/arena3/handlers/auth.ts`.

### 3.6 Tác động phụ cần kiểm: tài khoản seed bị khoá

Trước đây khoá không bao giờ kích hoạt. Sau khi sửa, suite nào sai mật khẩu nhiều lần trên **tài khoản seed dùng chung** (ví dụ `0900000001`) sẽ khoá tài khoản đó 15 phút, và các case sau trong cùng suite sẽ đăng nhập thất bại.

1. Grep các suite tìm chỗ login sai mật khẩu, rồi liệt kê `file:dòng` và tài khoản đang dùng.
2. Nếu sau khi sửa có case PASS chuyển sang FAIL hoặc BLOCKED vì lý do này, **sửa fixture**, không sửa expected:
   - case thử sai mật khẩu phải dùng tài khoản **tạo riêng** (register mới, hoặc tài khoản seed không được case nào khác dùng);
   - hoặc chạy nó cuối suite.

   Ghi từng thay đổi vào `test-output/bugfix/FIXTURE-DIFF.md` theo dạng trước/sau, kèm lý do.
3. Mỗi suite tự khởi động safe server mới (in-memory), nên khoá **không** lan sang suite khác. Xác nhận điều này bằng log pid server.

### 3.7 Kỳ vọng số liệu sau G-1

- Các case của F-01 (`LK-05`, `LK-06`, `LK-07`, `LIM-02a`) và F-02 (`RG-21`, `LIM-02b`) chuyển từ FAIL sang PASS.
- Nếu suite 07 hoặc 14x có case khác cũng liên quan bộ đếm, liệt kê chúng; `status-transitions.mjs` sẽ cho thấy.
- Không có case PASS nào chuyển sang FAIL. Nếu có, xem 3.6.
- Tổng số case vẫn là 2,943, cộng thêm unit test mới (đếm riêng).

### 3.8 Báo cáo vòng G-1

Viết ngắn, theo thứ tự:
1. Bước 0: lệnh, đường dẫn baseline, số đếm, ba file danh sách id.
2. Tái hiện F-01/F-02 trước khi sửa: output `regression.mjs`.
3. `git diff` của `tx.ts` và `auth.ts`.
4. Danh sách grep `KeepWrites` (3.2 bước 4).
5. Kết quả `tsc`, `eslint`, `npm test`: số test trước và sau.
6. Kiểm chứng ngược: output FAIL, rồi `git diff` chứng minh đã trả lại.
7. Kết quả `regression.mjs F-01 F-02` sau khi sửa.
8. Output nguyên văn của `status-transitions.mjs baseline → sau` và `reconcile.mjs`.
9. Tác động phụ 3.6: fixture nào đã đổi, hoặc "không có".
10. Câu hỏi mới cho `NEEDS-HUMAN`, nếu có.

Không commit. Dừng sau G-1 và chờ duyệt. **Không** tự làm G-2.

---

## 4. Vòng 2 — Đầu vào xấu (G-5: F-27, F-28; lẻ: F-05, F-22)

G-1 đã duyệt (gồm fix-up). Mốc so sánh của vòng này là **kết quả sạch cuối của G-1 fix-up** (2,837 / 80 / 21 / 6 = 2,944), không phải baseline-v2.4. Trước khi sửa, copy `test-output/results/` sang `test-output/bugfix/G-1/final/` nếu chưa có, rồi dùng thư mục đó làm `<dirTruoc>`.

Số dòng trong BUGS-FINAL.md đã cũ. Dùng số dòng ở dưới (đã đọc trên code hiện tại).

### 4.1 F-28 — body `null` gây 500 (`helpers.ts:317` `readJson`)
- Bản chất: `JSON.parse("null")` trả `null`, handler đọc `b.x` thì TypeError.
- Sửa **trong `readJson` duy nhất**: sau khi parse, nếu kết quả là `null` hoặc kiểu nguyên thuỷ (string/number/boolean) thì `throw err.validation("Request body must be a JSON object.")`.
- **Mảng phải được giữ nguyên.** `desk.ts:1068` cố ý nhận body là mảng (`Array.isArray(b) ? b : …`). Không chặn mảng.
- Body rỗng vẫn trả `{}` như cũ.
- `online.ts:459` dùng `request.json()` trực tiếp, không qua `readJson`. Đọc đoạn đó: nếu body `null` làm nó 500 thì sửa cùng kiểu; nếu không thì ghi "không ảnh hưởng" kèm lý do.

### 4.2 F-27 — NUL byte (`\u0000`) gây 500
- Bản chất: Postgres không nhận ký tự NUL trong text.
- Sửa **trong `readJson`**, không phải trong `str()`. Lý do: nhiều handler đọc text bằng `String(...)` hoặc truyền thẳng, sửa `str()` sẽ sót. Sau khi parse, duyệt đệ quy toàn bộ giá trị (object, mảng, cả **key** lẫn value). Gặp chuỗi chứa `\u0000` thì `throw err.validation("Text must not contain NUL characters.")`.
- Không âm thầm xoá ký tự NUL. Phải từ chối.
- Không thêm map mã lỗi Postgres trong `errors.ts` để che 500. Sửa ở đầu vào.
- Query string: grep các case NUL trong 14a/07 xem có case nào gửi NUL qua query/path không. Nếu có và đang FAIL thì báo, chưa sửa (ghi NEEDS-HUMAN).

### 4.3 F-05 — `start_at` sai định dạng gây 500 (`bookings.ts`)
- Mẫu đúng đã có sẵn ở `bookings.ts:986-989` (đổi lịch): `new Date(startAt)` rồi `if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.")`.
- Áp đúng mẫu đó cho:
  - `bookings.ts:405-408` (đặt sân online, case BK-04)
  - `bookings.ts:1109` trở đi (walk-in, case WI-09)
- Kiểm thêm `classes.ts:576` và `promos.ts:270`. Nếu chúng `new Date()` từ chuỗi người dùng mà không kiểm NaN thì sửa cùng mẫu, ghi vào FIXES.md, kèm một lệnh curl chứng minh trước 500 / sau 400. Nếu đã kiểm thì ghi "đã có".
- Không tự viết regex ISO mới.

### 4.4 F-22 — `days: "abc"` thành 7 ngày (`ops.ts:52`)
- Hiện tại: `num(...) ?? 7` → `num("abc")` là `undefined` → 7.
- Sửa: lấy `raw = body.days`. Nếu `raw` là `undefined`, `null` hoặc `""` thì `days = 7`. Ngược lại `days = parseInteger("days", "Freeze length", raw, 1, 90)` (`validate.ts:101`). Xoá dòng kiểm 1–90 cũ nếu đã thừa.
- `desk.ts:570` (`Number(...) || 7` của query `days`) **không** thuộc bug này. Không sửa, chỉ ghi nhận vào FIXES.md mục "để sau".

### 4.5 Kỳ vọng mã lỗi
- `err.validation` trả **422**, `err.field` trả **400** (`errors.ts:44-52`).
- Trước khi sửa, đọc expected của từng case trong regression map (BK-04, WI-09, PS-20, SEC-85, SEC-92, mọi `FZ-*-nul_byte`, `FZ-*-body_null`). Nếu case yêu cầu đúng 400 mà sửa trả 422, hoặc ngược lại, thì chọn helper lỗi cho khớp expected (validation hay field). **Không** sửa expected.
- Nếu expected mâu thuẫn với nhau (case này đòi 400, case kia đòi 422 cho cùng một lỗi) thì DỪNG, ghi NEEDS-HUMAN.

### 4.6 Unit test (thêm vào file test hiện có của arena3, chạy theo cách `npm test` đang chạy)
- `readJson`: `"null"`, `"5"`, `"\"x\""`, `"true"` → ném lỗi; `"[]"` và `"[{\"a\":1}]"` → trả mảng; `""` → `{}`; `{"a":"x\u0000y"}`, `{"a":["\u0000"]}`, key chứa NUL → ném lỗi; object bình thường → trả nguyên.
- Freeze days: `"abc"` → lỗi, `"7"` → 7, thiếu → 7, `0` / `91` → lỗi. Nếu khó gọi handler trong unit test thì thay bằng curl trong báo cáo.
- Kiểm chứng ngược bắt buộc: tạm bỏ nhánh chặn `null` trong `readJson` → unit test và `regression.mjs F-28` phải FAIL → khôi phục → git diff chứng minh đã khôi phục.

### 4.7 Kỳ vọng số liệu
- Chạy `regression.mjs F-05 F-22 F-27 F-28` trước và sau sửa.
- Chạy sạch qua `run-fake-clock.mjs` (cùng mốc), rồi `status-transitions.mjs test-output/bugfix/G-1/final test-output/results`.
- Chỉ được có FAIL→PASS, và mọi id đổi trạng thái phải nằm trong danh sách case của 4 bug này (lấy bằng script, không đếm tay: case trong regression map của F-05/F-22/F-27/F-28, cộng mọi id khớp `/^FZ-.*-nul_byte$/` hoặc `/^FZ-.*-body_null$/` đang FAIL trong `G-1/final`; regression map chỉ ghi vài case mẫu, BUGS-FINAL nói F-27 có 11 case và F-28 có 20 case). In ra: số case kỳ vọng đổi, số thực đổi, id kỳ vọng mà không đổi (kèm lý do), id đổi ngoài danh sách (phải bằng 0).
- Bất kỳ PASS→FAIL/WARN nào (nhất là suite 04 vì body mảng, và suite 14a) thì DỪNG và báo.

### 4.8 Báo cáo vòng 2
1. Expected của từng case (4.5) và helper lỗi đã chọn.
2. Regression trước sửa (nguyên văn).
3. `git diff src/`.
4. Kết luận cho `online.ts:459`, `classes.ts:576`, `promos.ts:270`, query-string NUL.
5. tsc / eslint / npm test (số test trước → sau).
6. Kiểm chứng ngược 4.6.
7. Regression sau sửa.
8. Output nguyên văn status-transitions và bảng reconcile, cùng phép đối chiếu 4.7.
9. NEEDS-HUMAN mới, nếu có.

Copy kết quả sang `test-output/bugfix/G-5/results/`, cập nhật BUGS-FINAL.md / FIXES.md / PROGRESS.md (`## Vòng 2`). Không commit. DỪNG, không làm vòng 3.

---

## 5. Vòng 3 — Khoá ngoại không tồn tại và người nhận gói sai vai trò (G-2: F-18, F-24, F-25; lẻ: F-21)

Vòng 2 đã duyệt. Mốc so sánh của vòng này là **kết quả sạch cuối của Vòng 2** (2,873 / 45 / 20 / 6 = 2,944). Trước khi sửa, copy `test-output/results/` sang `test-output/bugfix/G-5/final/` và dùng thư mục đó làm `<dirTruoc>`.

Nguyên tắc chung: **kiểm tra tồn tại tường minh trong handler**, trả lỗi có `field`. **Không** thêm map mã `23503` trong `errors.ts` để che 500.

### 5.1 F-24, F-25 — `POST /classes` (`classes.ts:32` `classesCreate`)
- Hiện tại handler đã kiểm `coach_id` (dòng ~50) nhưng chưa kiểm `court_id` và `assistant_id`, nên insert ở dòng ~60 nổ khoá ngoại.
- Thêm ngay sau đoạn kiểm coach:
  - `court_id`: `select 1 from courts where id = $1`. Không có thì lỗi `field: "court_id"`.
  - `assistant_id`: chỉ kiểm khi có giá trị (`str(b.assistant_id)`). Phải tồn tại trong `users` và `role = 'coach'`. Không đạt thì lỗi `field: "assistant_id"`.
- Không thêm kiểm sport của trợ giảng hay sport của sân. Ngoài phạm vi bug này.
- Nếu kiểm role của trợ giảng làm bất kỳ case nào đang PASS chuyển FAIL (fixture dùng trợ giảng không phải coach) thì DỪNG, ghi NEEDS-HUMAN, không nới điều kiện.

### 5.2 F-18 + F-21 — `POST /subscriptions` (`plans.ts:143` `subscriptionsCreate`)
Hai bug cùng một chỗ, sửa cùng lúc:
- Khi người gọi là `receptionist` / `manager`, sau khi xác định `userId`:
  - `select role, status from users where id = $1`. Không có thì lỗi `field: "user_id"` (F-18).
  - Có nhưng `role <> 'member'` thì từ chối (F-21). Chọn helper lỗi theo expected của test (5.4).
- Chú ý dòng `userId = str(b.user_id) ?? user.id`: nhân viên không gửi `user_id` thì gói được bán **cho chính nhân viên đó**. Sau khi sửa, trường hợp này sẽ bị chặn vì nhân viên không phải `member`. Đó là hành vi đúng. Nhưng trước khi sửa phải grep mọi fixture trong `scripts/tests/agent/` gọi `POST /subscriptions` bằng token nhân viên mà không có `user_id`, rồi liệt kê ra. Nếu có case PASS dựa vào hành vi cũ thì DỪNG và báo, không tự sửa fixture.
- Không kiểm `status` của hội viên (đã khoá hay chưa) trong vòng này. Chỉ đọc ra để in vào báo cáo nếu muốn.

### 5.3 Không được làm
- Không bắt `23503` / `22P02` chung trong `errors.ts` hoặc router.
- Không đổi thứ tự `requireRole` / rate-limit hiện có.
- Không sửa expected.

### 5.4 Expected và helper lỗi
- Đọc expected thật của: `SB-22`, `FZ-POST_subscriptions-user_id-nonexistent_uuid`, `CL-19`, `CL-20`, `FZ-POST_classes-court_id-nonexistent_uuid`, `FZ-POST_classes-assistant_id-nonexistent_uuid`, `AZ-123`, `RM-POST-/subscriptions-receptionist`, `RM-POST-/subscriptions-manager`.
- Nhắc lại: `err.field` trả 400, `err.validation` trả 422, `err.notFound` trả 404, `err.forbidden` trả 403, `err.br` theo định nghĩa trong `errors.ts`.
- Chọn helper khớp expected. Nếu hai case cùng một lỗi đòi mã khác nhau thì DỪNG, ghi NEEDS-HUMAN.
- Riêng F-21: in rõ AZ-123 và hai case RM gửi gì (role người gọi, role người nhận) và chờ mã gì.

### 5.5 Test
- Unit test hoặc curl (nếu khó gọi handler) cho: sân không tồn tại, trợ giảng không tồn tại, trợ giảng là member, trợ giảng hợp lệ (vẫn tạo được), `user_id` không tồn tại, `user_id` là coach, `user_id` là member (vẫn bán được), nhân viên không gửi `user_id`.
- Kiểm chứng ngược bắt buộc: tạm bỏ kiểm `court_id` → `regression.mjs F-24` phải STILL_FAIL → khôi phục → git diff chứng minh.

### 5.6 Kỳ vọng số liệu
- `regression.mjs F-18 F-21 F-24 F-25` trước và sau sửa.
- Chạy sạch qua `run-fake-clock.mjs` cùng mốc, rồi `status-transitions.mjs test-output/bugfix/G-5/final test-output/results`.
- Danh sách kỳ vọng sinh bằng script: case trong regression map của 4 bug này, cộng mọi id `FZ-*-nonexistent_uuid` liên quan `/subscriptions` hoặc `/classes` đang FAIL trong `G-5/final`. In: số kỳ vọng, số thực đổi, kỳ vọng mà không đổi (kèm lý do), đổi ngoài danh sách (phải bằng 0, nếu khác 0 thì giải thích từng id như FZ-11 ở vòng 2).
- Bất kỳ PASS→FAIL/WARN nào thì DỪNG.

### 5.7 Báo cáo vòng 3
1. Bảng expected 5.4 và helper đã chọn.
2. Kết quả grep fixture nhân viên không gửi `user_id` (5.2).
3. Regression trước sửa.
4. `git diff` các file đã sửa trong vòng này (chỉ phần mới).
5. tsc / eslint / npm test (trước → sau).
6. Kiểm chứng ngược 5.5.
7. Regression sau sửa.
8. Output nguyên văn status-transitions, bảng reconcile, đối chiếu 5.6.
9. NEEDS-HUMAN mới, nếu có.

Copy kết quả sang `test-output/bugfix/G-2/results/`, cập nhật BUGS-FINAL.md / FIXES.md / PROGRESS.md (`## Vòng 3`). Không commit. DỪNG, không làm vòng 4.

---

## 6. Vòng 4 — Phân quyền (G-3: F-10; lẻ: F-03, F-23)

Vòng 3 đã duyệt. Mốc so sánh của vòng này là **kết quả sạch cuối của Vòng 3** (2,885 / 36 / 17 / 6 = 2,944). Trước khi sửa, copy `test-output/results/` sang `test-output/bugfix/G-2/final/` và dùng thư mục đó làm `<dirTruoc>`.

### 6.0 Quy tắc phân quyền (chốt, áp cho mọi chỗ sửa trong vòng này)
1. Chưa đăng nhập → **401**, trước mọi thứ khác.
2. Sai **vai trò** (biết ngay từ token, không cần đọc DB) → **403**, trước khi đọc body, validate hay query DB. Nghĩa là `requireRole(...)` là dòng đầu tiên của handler.
3. Đúng vai trò nhưng tài nguyên **không tồn tại** → **404**.
4. Tài nguyên tồn tại nhưng **không thuộc người gọi** (hội viên khác, lớp của HLV khác) → **403**.

Hệ quả: với id không tồn tại, HLV "khác lớp" nhận **404** là đúng, vì server không thể biết lớp đó của ai. Muốn kiểm 403 thì fixture phải dùng tài nguyên **có thật** của người khác.

### 6.1 Sửa fixture trước (đã đọc kết quả, không phải bug code)
- 4 case `RM-{GET,POST}-/sessions/:id/attendance-coach_other` và `RM-{GET,PUT}-/sessions/:id/results-coach_other` (14f) đang gửi id **không tồn tại** `99999999-9999-4999-8999-999999999999`, nhận 404 và chờ 403. Theo 6.0, 404 là đúng với id đó.
- Code đã đúng: `sessionScope` (`training.ts:75`) trả 404 khi không có buổi, rồi `assertClassStaff` (`training.ts:65`) trả 403 khi không phải lớp của mình.
- Sửa fixture: với vai `coach_other`, dùng id một **buổi có thật** thuộc lớp mà HLV đó không phụ trách (tạo lớp và buổi trong setup của 14f nếu chưa có). Giữ expected 403.
- Grep thêm trong 14f mọi case `*-coach_other` hoặc `*-member_other` dùng id `9999…` mà chờ 403. Liệt kê và sửa cùng kiểu. Ghi tất cả vào FIXTURE-DIFF.md.
- Chạy riêng suite 14f sau khi sửa fixture, **trước** khi sửa code. In trạng thái mới của các case này. Nếu case nào vẫn FAIL với buổi có thật thì đó mới là bug code, báo lại.

### 6.2 F-10 — kiểm vai trò sau validate / query
- Lấy danh sách case bằng script: case trong regression map của F-10, cộng các id F-10 trong BUGS-FINAL.md (`SEC-06`, `RM-DELETE-/payments-anon`, `RM-POST-/payments/online-coach`, `RM-POST-/members/:id/reset-password-receptionist`, `RM-GET-/invoices/:id.xml-receptionist`, `RM-POST-/subscriptions/:id/decline-receptionist`, `RM-POST-/waitlist/:id/accept-member`, `RM-POST-/waitlist/:id/accept-coach`). Lọc những case **đang FAIL** trong `G-2/final`, trừ 4 case sessions đã xử lý ở 6.1.
- Với mỗi case: in request, expected, actual. Tìm handler qua `router.ts`. Đưa `requireRole` lên dòng đầu, trước `readJson`, validate, `UUID_RE` / `pathId` và mọi query.
- `RM-DELETE-/payments-anon`: người chưa đăng nhập nhận 403 thay vì 401. Đọc `router.ts` quanh route `DELETE /payments` (BUGS-FINAL ghi `router.ts:614`, số dòng có thể đã lệch) và sửa để kiểm đăng nhập trước.
- `SEC-06`: người chưa đăng nhập nhận **200**. In request của case. Nếu endpoint đó **cố ý công khai** (bảng giá, lịch sân công khai, health…) thì KHÔNG sửa code, ghi NEEDS-HUMAN kèm lý do. Nếu không cố ý công khai thì bọc bằng `authed` / `authedRead` như các route cùng nhóm.
- Không đổi danh sách vai trò được phép của bất kỳ route nào. Chỉ đổi **thứ tự** kiểm. Nếu thấy cần đổi danh sách vai trò thì DỪNG, ghi NEEDS-HUMAN.

### 6.3 F-03 — HLV xem / báo giá huỷ / huỷ booking của người khác (`bookings.ts`)
- Ba hàm: `bookingGet`, `bookingsCancelQuote`, `bookingsCancel` (grep tên; số dòng trong BUGS-FINAL đã cũ).
- Dòng đầu mỗi hàm: `requireRole(user, ["member", "receptionist", "manager"])`. Giữ nguyên kiểm chủ sở hữu cho `member` (sau khi tải booking).
- Grep xem còn hàm nào trong `bookings.ts` có dạng `if (user.role === "member" && … !== user.id) throw err.forbidden()` mà không có `requireRole` đứng trước. Liệt kê. Chỉ sửa những hàm có case FAIL trong vòng này; các hàm còn lại ghi vào FIXES.md mục "để sau" kèm lý do.

### 6.4 F-23 — HLV môn khác xoá ghi danh (`classes.ts` `enrollmentDelete`)
- Sau khi tải enrollment (404 nếu không có), nếu `user.role === "coach"` thì tải lớp theo `enr.class_id` và gọi `assertClassStaff(cl, user)` (import từ `training.ts`).
- Giữ nguyên quyền hiện có của member (chỉ xoá ghi danh của mình), receptionist và manager.
- Không tự quyết HLV có được xoá ghi danh lớp **mình** hay không. Giữ như hiện tại.

### 6.5 Test
- Unit test hoặc curl cho từng nhóm: HLV gọi `GET /bookings/:id` của hội viên → 403; hội viên khác → 403; chủ booking → 200; HLV khác lớp xoá ghi danh → 403; HLV đúng lớp → như cũ; một route F-10 với body sai và vai trò sai → 403 (không phải 422).
- Kiểm chứng ngược bắt buộc: tạm bỏ `requireRole` vừa thêm ở `bookingGet` → `regression.mjs F-03` phải STILL_FAIL → khôi phục → git diff chứng minh.

### 6.6 Kỳ vọng số liệu
- `regression.mjs F-03 F-10 F-23` trước và sau sửa.
- Chạy sạch qua `run-fake-clock.mjs` cùng mốc, rồi `status-transitions.mjs test-output/bugfix/G-2/final test-output/results`.
- Danh sách kỳ vọng sinh bằng script: case F-03, F-10, F-23 (regression map + BUGS-FINAL) cộng 4 case sessions ở 6.1 và các case fixture khác đã sửa ở 6.1. In: số kỳ vọng, số thực đổi, kỳ vọng mà không đổi (kèm lý do), đổi ngoài danh sách (giải thích từng id).
- **Rủi ro chính của vòng này:** đưa `requireRole` lên trước có thể đổi 404/422 thành 403 ở case khác đang PASS. Bất kỳ PASS→FAIL/WARN nào thì DỪNG, in request / expected / actual của case đó, không sửa expected.

### 6.7 Báo cáo vòng 4
1. Kết quả 6.1: fixture đã đổi, trạng thái 14f sau khi chỉ sửa fixture.
2. Bảng case F-10 đang FAIL: request, expected, actual, handler, cách sửa. Kết luận cho SEC-06.
3. Regression trước sửa.
4. `git diff` phần mới của vòng này (src và fixture).
5. tsc / eslint / npm test (trước → sau).
6. Kiểm chứng ngược 6.5.
7. Regression sau sửa.
8. Output nguyên văn status-transitions, bảng reconcile, đối chiếu 6.6.
9. Danh sách "để sau" ở 6.3 và NEEDS-HUMAN mới, nếu có.

Copy kết quả sang `test-output/bugfix/G-3/results/`, cập nhật BUGS-FINAL.md / FIXES.md / PROGRESS.md (`## Vòng 4`). Không commit. DỪNG, không làm vòng 5.

---

## 7. Vòng 4b — Dọn phần còn lại của Vòng 4

Vòng 4 đã duyệt (2,899 / 22 / 17 / 6). Mốc so sánh: copy `test-output/results/` sang `test-output/bugfix/G-3/final/`.

Reviewer đã đọc nguồn và **quyết thay** cho các mục NEEDS-HUMAN của Vòng 4. Làm đúng theo các quyết định dưới đây, không hỏi lại.

### 7.1 Fixture 14f đoán sai vai trò (sửa fixture, KHÔNG sửa code)
SRS không quy định vai trò cho các route này, nên danh sách `requireRole` hiện có trong code là nguồn đúng. Comment trong 14f trỏ sai dòng và sai hàm (ví dụ `members.ts:317` là `membersDirectory`, không phải reset-password).
| Route | `allowed` trong 14f hiện tại | Sửa thành (theo code) |
|---|---|---|
| `POST /members/:id/reset-password` | `["manager"]` | `["receptionist","manager"]` (`members.ts` `memberResetPassword`) |
| `POST /subscriptions/:id/decline` | `["manager"]` | `["receptionist","manager"]` (`desk.ts` `subscriptionDecline`) |
| `GET /invoices/:id.xml` | `["manager"]` | `["manager","receptionist"]` (`extras.ts` `invoiceXmlOne`) |
| `POST /waitlist/:id/accept` | `["receptionist","manager"]` | `["member"]` (chỉ hội viên chủ offer mới nhận được, xem 7.2) |
- Sửa luôn comment trỏ dòng cho đúng hàm.
- Vai trò được phép mà gọi với id không tồn tại thì expected là 404, theo quy tắc 6.0.
- Ghi FIXTURE-DIFF.md: mỗi dòng ghi route, allowed cũ → mới, và lý do "khớp requireRole của handler, SRS không quy định".

### 7.2 `waitlistAccept` (`ops.ts`): thêm requireRole
- Dòng đầu hàm: `requireRole(user, ["member"])`.
- Kết quả hành vi không đổi: hiện nay mọi vai trò khác vẫn bị chặn bởi `enr.user_id !== user.id`, chỉ là chặn sau khi đọc DB. Thêm dòng này chỉ đưa 403 lên trước 404, đúng quy tắc 6.0.
- Trước khi sửa, grep UI (`src/routes/`) xem lễ tân hoặc quản lý có gọi `/waitlist/:id/accept` không. Nếu CÓ thì DỪNG và báo lại.

### 7.3 `bookingsReschedule` (`bookings.ts`): KHÔNG để sau
Đây cùng loại lỗ hổng với F-03 (HIGH): HLV dời lịch booking của hội viên. Sửa ngay:
- Dòng đầu hàm: `requireRole(user, ["member", "receptionist", "manager"])`.
- Thêm unit test: HLV dời lịch booking của hội viên → 403; chủ booking → không phải 403.
- Ghi vào FIXES.md như một phần của F-03.

### 7.4 `DELETE /payments/:id` cho người chưa đăng nhập vẫn nhận 403
`router.ts` hiện tách hai nhánh, và nhánh có `p1` vẫn ném 403 trước khi kiểm đăng nhập. Gộp lại thành một nhánh:
```ts
if (method === "DELETE" && p0 === "payments") {
  return authed(async () => {
    throw err.forbidden("Payments cannot be deleted — issue a refund instead.");
  });
}
```
Curl xác nhận 4 trường hợp: anon `DELETE /payments` → 401; anon `DELETE /payments/<id>` → 401; manager `DELETE /payments` → 403; manager `DELETE /payments/<id>` → 403.

### 7.5 SEC-06: sửa fixture, có lý do
- Fixture gửi `Bearer  <token> ` (hai dấu cách ở giữa, một ở cuối). Fetch/undici cắt khoảng trắng đầu và cuối của header theo RFC 9110 (OWS), còn `\s+` chấp nhận nhiều dấu cách sau `Bearer`. Server thật sự nhận đúng token hợp lệ, nên 200 là đúng. Đây không phải lỗ hổng.
- Sửa `07-security.mjs`:
  - SEC-06 đổi mô tả thành "khoảng trắng đệm quanh token hợp lệ được chấp nhận (RFC 9110 OWS)", expected `{ status: 200 }`.
  - Thêm **SEC-06b**: token bị thêm 1 ký tự (`${memberA.token}x`) → expected 401.
  - Thêm **SEC-06c**: header `Bearer` không có token → expected 401.
- Ghi FIXTURE-DIFF.md kèm câu "reviewer duyệt, lý do RFC 9110 OWS". Không sửa `session.ts`.
- Tổng case tăng thêm 2 (2,944 → 2,946). Ghi rõ điều này trong reconcile.

### 7.6 Kiểm và báo cáo
- tsc, eslint, npm test (trước → sau).
- Kiểm chứng ngược: tạm bỏ `requireRole` trong `bookingsReschedule` → unit test mới phải FAIL → khôi phục.
- Chạy sạch qua `run-fake-clock.mjs`, rồi `status-transitions.mjs test-output/bugfix/G-3/final test-output/results`.
- Danh sách kỳ vọng:
  - các case 14f của 4 route ở 7.1 (mọi vai trò);
  - SEC-06;
  - các case mới SEC-06b/06c (nằm ở mục "chỉ có ở SAU");
  - mọi case `/bookings/:id/reschedule` và `/waitlist/:id/accept`.
- In: kỳ vọng, thực đổi, đổi ngoài danh sách (giải thích từng id). Có PASS→FAIL/WARN thì DỪNG.
- Báo cáo:
  1. diff fixture
  2. diff src
  3. kết quả grep UI ở 7.2
  4. curl 7.4
  5. test trước → sau
  6. kiểm chứng ngược
  7. status-transitions nguyên văn và reconcile
  8. đối chiếu kỳ vọng
- Copy kết quả sang `test-output/bugfix/G-3b/results/`, cập nhật BUGS-FINAL / FIXES / PROGRESS (`## Vòng 4b`; F-10 → FIXED nếu hết FAIL). Không commit. DỪNG.

### 7.7 Bổ sung sau báo cáo 4b (reviewer duyệt)
Có 4 case PASS→FAIL trong `01-authz-matrix`. Nguyên nhân là fixture này còn mô tả hành vi cũ của 2 route đã đổi theo quyết định ở 7.2 và 7.4. Code không sai, sửa fixture như sau:
- `01-authz-matrix.mjs` dòng ~149: `["POST", \`/waitlist/${X}/accept\`, ALL, { probe: true }]` → đổi `ALL` thành `[U]` (chỉ hội viên). Manager, lễ tân, HLV khi đó sẽ chờ 403.
- Nhánh `allowed === "nobody"` (~dòng 220): người chưa đăng nhập (`role === undefined`) chờ `{ status: 401, code: "UNAUTHENTICATED" }` và mô tả `anonymous → 401`. Các vai trò đã đăng nhập vẫn chờ 403. Sửa comment dòng ~100 thành "Refused for every signed-in role; anonymous gets 401 first (rule 6.0)."
- Ghi FIXTURE-DIFF.md, lý do "đồng bộ với quyết định 7.2/7.4, quy tắc 6.0".
- Ghi nhận: `bookingsReschedule` vốn đã có `requireRole(user, ["member"])`, nên mục "để sau" ở Vòng 4 là sai. Không cần sửa code, giữ 2 unit test mới.
- Chạy lại suite 01 rồi chạy sạch toàn bộ. status-transitions so với `G-3/final`. Kỳ vọng: 10 case ở báo cáo 4b, trong đó AZ-254, AZ-431, AZ-432, AZ-433 phải là PASS→PASS, nghĩa là không còn xuất hiện trong danh sách đổi. Cộng thêm SEC-06b/06c.

---

## 8. Xoá hẳn `day_passes` / `day_pass_vnd` (chủ dự án đã quyết)

Làm **sau** Vòng 4b. Mốc so sánh là kết quả sạch của 4b (`test-output/bugfix/G-3b/results/`).

Quyết định này thay cho dòng "Không xoá bảng `day_passes` … cột `day_pass_vnd`" trong `docs/AGENT-CLEANUP-DEBT-DAYPASS.md`. Thêm một dòng ghi chú ở đầu file đó: "2026-10-15: chủ dự án quyết xoá hẳn, xem AGENT-BUGFIX mục 8".

### 8.1 Xoá
Tạo migration mới `migrations/0029_drop_day_passes.sql`. **Không sửa 0024.**
```sql
DROP TABLE IF EXISTS day_passes;
ALTER TABLE center_settings DROP COLUMN IF EXISTS day_pass_vnd;
```
- Trước khi viết, grep mọi migration xem có FK hoặc view nào trỏ **tới** `day_passes` hoặc dùng `day_pass_vnd` không. Nếu có thì DỪNG và báo lại.
- Không dùng `CASCADE` (bảng này chỉ có FK trỏ đi, không có FK trỏ tới).

### 8.2 Giữ (lịch sử)
Các mục sau phải còn nguyên:
- payment `ref_type = 'day_pass'` và dòng `extras.ts` ~384 tính chúng vào điểm thưởng;
- label `day_pass` trong `labels.ts`;
- 3 action audit trong `manager.audit.tsx`.
- Không xoá hay sửa dòng payment hoặc audit cũ nào.

### 8.3 Dọn code
- `desk.ts` ~1001–1003: bỏ comment và dòng `delete row.day_pass_vnd` (cột không còn).
- Grep `day_passes|day_pass_vnd|dayPass` trong `src/`. Sau khi sửa phải còn **0**. Riêng `day_pass` số ít thì chỉ được còn ở các chỗ thuộc mục 8.2.
- Grep `scripts/tests/` và sửa mọi script còn `INSERT`/`SELECT` vào `day_passes` hoặc `day_pass_vnd`.
- `verify-rmv12-till.mjs` đã SUPERSEDED, có thể xoá hẳn. Ghi lại nếu xoá.

### 8.4 Test
- Unit test PGlite, chạy toàn bộ migration:
  - `select to_regclass('day_passes')` ra `null`;
  - `information_schema.columns` không có `center_settings.day_pass_vnd`;
  - insert payment `ref_type='day_pass', method='cash', status='posted'` vào một ca thì tổng ca tăng đúng số tiền (lịch sử vẫn được tính).
- Kiểm chứng ngược: tạm đổi migration thành no-op → hai test đầu phải FAIL → khôi phục.
- `15-removed-features`: thêm một case `GET` settings không có khoá `day_pass_vnd` (nếu chưa có).
- Chạy sạch qua `run-fake-clock.mjs` rồi status-transitions so với G-3b. Kỳ vọng chỉ có case mới. Có PASS→FAIL/WARN thì DỪNG.

### 8.5 Tài liệu và sơ đồ
- `scripts/srs_diagrams/erd_logical.py`: bỏ `day_passes` khỏi danh sách nhóm payments (~dòng 40) và nhánh `«legacy»` (~214).
- Sinh lại `docs/diagrams/srs/33-erd-logical-3-payments.drawio` bằng đúng lệnh generator mà repo đang dùng (tìm trong `scripts/build-srs-iii.py` hoặc README của `srs_diagrams`). Không sửa tay XML.
- Kiểm theo CLAUDE.md:
  - không còn cell `day_passes` hay edge `fk9_day_passes_payment_id`;
  - mọi edge có source/target tồn tại, id không trùng, không có XML comment.
- Grep `day_pass` trong `docs/SRS.md`, `docs/SDD.md`, `docs/SRS-diagrams.md`. Nếu có chỗ mô tả bảng thì sửa thành "đã xoá ở 0029, lịch sử payment giữ nguyên".

### 8.6 TUYỆT ĐỐI
- KHÔNG chạy `npm run build`, `db:migrate` hay `scripts/migrate.mjs`, và không kết nối Neon.
- Lưu ý: script `build` trong `package.json` tự chạy `db:migrate`, nên migration 0029 sẽ tự áp lên production ở lần deploy tiếp theo. Việc deploy là của chủ dự án, không phải của agent.

### 8.7 Báo cáo
1. Kết quả grep FK/view ở 8.1.
2. Nội dung 0029.
3. `git diff` src, tests, scripts và docs.
4. Grep 8.3 trước → sau.
5. Unit test và kiểm chứng ngược.
6. status-transitions và reconcile.
7. Kiểm drawio 8.5.

Copy kết quả sang `test-output/bugfix/DROP-DP/results/`, cập nhật FIXES/PROGRESS (`## Xoá day_passes`). Không commit. DỪNG.

---

## 9. Vòng 5 — Tiền và ca thu ngân (F-09, F-12, F-13, F-16, F-17)

Mục 7.7 và mục 8 đã duyệt (2,907 / 16 / 17 / 6 = 2,946). Mốc so sánh: `test-output/bugfix/DROP-DP/results/`.

Số dòng trong BUGS-FINAL đã cũ, tìm hàm bằng grep.

### 9.0 Dọn sót từ mục 8 (làm trước)
- `desk.ts`: `publicSettings` hiện chỉ `return row`, tức là hàm thừa. Xoá hàm này, trả `row` trực tiếp như trước. Giữ phần đã bỏ `day_pass_vnd` khỏi câu select của `settingsPatch`.
- `tx.test.ts` test thứ 3 của "Section 8" tự query bảng `payments`, không qua handler, nên không chứng minh được gì (cùng lỗi với script `verify-rmv12-till` đã bỏ).
  - Viết lại để gọi handler tính tổng ca thật (`shiftCurrent` hoặc tên tương ứng trong `desk.ts`), đúng như RMV-12 ở `15-removed-features`.
  - Nếu không gọi được handler trong unit test thì xoá test đó, vì RMV-12 đã phủ.

### 9.1 Pha A — chỉ đọc, chưa sửa
Với mỗi bug, in: case FAIL (request / expected / actual), hàm handler hiện tại, và đoạn code liên quan (≤ 25 dòng). Riêng:
- **F-12:** grep mọi chỗ tạo payment `method = 'quota'` (trừ lượt của gói khi đặt sân). Xác nhận những chỗ đó **không** đi qua `paymentsCreate`. Nếu có chỗ đi qua thì DỪNG F-12 và báo lại.
- **F-13:** in cách `paymentsCreate` chọn `shift_id` hiện nay (lấy từ body hay tự tìm ca đang mở của người gọi).
- **F-16:** in cả luồng hoàn tiền:
  - refund lưu ở đâu (bảng, cột, dấu âm hay dương, status);
  - đường cần quản lý duyệt (`approve-refund`) chạy thế nào;
  - câu SQL tổng két trong ca đang tính những gì.
- **F-09:** in hàm walk-in thật sự đang được route gọi (có thể ở `bookings.ts` `walkIn`), và cách nó chuẩn hoá SĐT và kiểm tra trùng slot so với `bookingsHold`.

### 9.2 Quy tắc sửa (reviewer chốt)
- **F-17:** `cash_declared_vnd` (và mọi số tiền khai báo khi mở hoặc đóng ca) dùng `parseInteger` với min 0. Số âm hoặc không phải số nguyên → lỗi validation. Theo đúng mã lỗi mà `parseInteger` đang trả ở các chỗ khác, không tự chọn mã khác.
- **F-12:** `paymentsCreate` chỉ nhận các method thu tiền thật. Lấy danh sách hiện có rồi bỏ `quota`, không thêm method mới. Gửi `quota` → lỗi validation trên field `method`. Đường trừ lượt gói nội bộ giữ nguyên.
- **F-13:** ca để ghi tiền do **server** xác định: là ca `open` của chính người gọi.
  - Body không có `shift_id` → dùng ca của mình (nếu đó là hành vi hiện tại thì giữ nguyên).
  - Body có `shift_id` nhưng không tồn tại → 404.
  - Body có `shift_id` tồn tại nhưng không phải ca `open` của người gọi → 403.
  - Tuyệt đối không còn 500.
  - Quản lý thu tiền mà không có ca: giữ đúng hành vi hiện tại. Nếu hiện tại là 500 thì báo NEEDS-HUMAN, đừng tự chọn.
- **F-16:** chỉ áp cho hoàn tiền **mặt**. Tiền mặt rời két của ca đang mở của **người thực hiện chi trả**, tại thời điểm chi.
  - Bản ghi refund mang `shift_id` của ca đó.
  - Tổng két tiền mặt của ca phải trừ số đã hoàn.
  - Báo cáo doanh thu theo kỳ không được đếm hai lần.
  - Nếu Pha A cho thấy hoàn tiền phải qua quản lý duyệt, và người bấm duyệt hay chi có thể không có ca mở: DỪNG riêng F-16, in luồng và hỏi reviewer. Các bug khác vẫn làm tiếp.
- **F-09:** walk-in dùng **cùng** hàm chuẩn hoá SĐT và **cùng** cách kiểm tra trùng slot hoặc khoá như `bookingsHold` (gọi lại hàm có sẵn, không viết logic mới).
  - SĐT sai → lỗi validation trên field phone.
  - Slot trùng → 409 với đúng code mà `bookingsHold` trả khi trùng.

### 9.3 Test
- Unit test cho mỗi bug:
  - F-17: số âm → lỗi; 0 → ok.
  - F-12: `quota` → lỗi; `cash` → ok.
  - F-13: ca lạ → 404; ca người khác → 403; ca mình → ok.
  - F-16: mở ca, thu 100.000 đ, hoàn mặt 40.000 đ → tiền mặt của ca giảm đúng 40.000 đ. Kiểm qua handler tổng ca, **không** tự viết SQL tổng.
  - F-09: SĐT rác → lỗi; slot đã hold → 409.
- Kiểm chứng ngược: tạm bỏ phần sửa của F-16 → test F-16 FAIL → khôi phục.

### 9.4 Kỳ vọng
- `regression.mjs F-09 F-12 F-13 F-16 F-17` trước và sau.
- Chạy sạch qua `run-fake-clock.mjs`, rồi status-transitions so với `DROP-DP/results`. Danh sách kỳ vọng sinh từ regression map và BUGS-FINAL của 5 bug (WI-19, WI-17, PY-25..28, JOB-04b, RF-13, INV-04-gear, INV-05-invariant-f16, SH-24, …).
- Rủi ro chính:
  - F-13 và F-16 đổi số tiền trong ca, nên có thể làm lệch các case két, đóng ca hay báo cáo đang PASS.
  - F-12 có thể làm hỏng fixture nào đang dùng `quota` qua `/payments` để setup.
  - Có PASS→FAIL/WARN thì DỪNG, in request / expected / actual, không sửa expected.

### 9.5 Báo cáo
1. 9.0 diff.
2. Pha A cho 5 bug.
3. Regression trước.
4. `git diff` src và tests.
5. tsc, eslint, npm test (trước → sau).
6. Kiểm chứng ngược.
7. Regression sau.
8. status-transitions nguyên văn, reconcile, đối chiếu kỳ vọng.
9. NEEDS-HUMAN nếu có.

Copy kết quả sang `test-output/bugfix/G-MONEY/results/`, cập nhật BUGS-FINAL / FIXES / PROGRESS (`## Vòng 5`). Không commit. DỪNG.

### 9.6 Quyết định sau Pha A (reviewer chốt)

**F-16 — ai chi và trừ két nào:**
- **Lễ tân hoàn trực tiếp** (không cần duyệt): bản ghi refund mang `shift_id` của ca `open` của lễ tân đó. Dòng âm sẽ tự trừ khỏi tổng két trong `shiftCurrent`.
  - Hoàn **tiền mặt** mà lễ tân không có ca mở → từ chối bằng đúng BR và mã lỗi mà `paymentsCreate` đang dùng khi lễ tân thu tiền mặt không có ca (grep `BR-44`, quy tắc mở ca).
  - Không mở thêm luồng nào khác.
- **Quản lý hoàn trực tiếp**, hoặc **khoản lớn quản lý duyệt** (`approve-refund`): giữ `shift_id = NULL`.
  - Lý do: quản lý không có két. Tiền đi từ quỹ trung tâm, nhất quán với việc quản lý thu tiền cũng có `shift_id = NULL` (9.2 F-13).
  - Khoản `refund_pending` do lễ tân tạo cũng **không** gắn ca của lễ tân, kể cả sau khi được duyệt.
- Báo cáo doanh thu theo kỳ không đổi, vì dòng âm đã tồn tại sẵn và chỉ thêm `shift_id`. Phải chứng minh bằng một case báo cáo trước → sau.
- Unit test F-16 gồm ba trường hợp:
  - lễ tân thu 100.000 đ mặt, hoàn 40.000 đ mặt → `shiftCurrent` tiền mặt = 60.000 đ;
  - quản lý duyệt hoàn → tổng ca lễ tân không đổi;
  - lễ tân không có ca mà hoàn mặt → lỗi BR.
- Kiểm chứng ngược như 9.3.
- Ghi vào FIXES.md nguyên văn quy tắc trên. Nếu `INV-04-gear` vẫn FAIL sau khi sửa thì in request / expected / actual và giải thích, không sửa expected.

**F-09 — đã đổi khá sâu, cần chứng minh:**
- In định nghĩa SQL của `booking_replace_hold` và `occupancy_attach` (tìm trong migrations), đặt cạnh nhau. Chứng minh `occupancy_attach` vẫn chặn trùng slot (exclusion constraint hoặc lock).
- Unit test: walk-in vào slot đã có hold của **người khác** → 409 cùng code mà `bookingsHold` trả khi trùng. Walk-in cho hội viên đang có hold ở ngày khác → hold đó **còn nguyên**.
- Nếu `booking_replace_hold` còn làm việc gì khác ngoài thay hold (ghi audit, khoá…) thì báo lại trước khi giữ thay đổi.

**F-12 — phạm vi:** agent đã thêm chặn `ref_type` lạ và kiểm tra booking tồn tại, việc này ngoài yêu cầu.
- Với từng phần thêm, chỉ ra case FAIL nào nó sửa. Ví dụ booking không tồn tại trước đây ra 500 (FK) thì được giữ.
- Phần nào không gắn với case nào thì hoàn tác.

**F-17:** chấp nhận số âm → 400 (`parseInteger`), còn rỗng hoặc không phải số giữ 422 cho SH-22/23. Ghi chú sự không đồng nhất này vào FIXES.md mục "để sau", không sửa thêm.

Sau đó làm tiếp 9.3 → 9.5 cho cả 5 bug: chạy sạch toàn bộ qua `run-fake-clock.mjs` và status-transitions so với `DROP-DP/results`. Báo cáo bổ sung:
- bảng F-12 (phần thêm → case);
- so sánh SQL của F-09;
- báo cáo doanh thu trước → sau cho F-16.

---

## 10. Vòng 6 — Vá sót Vòng 5 + 7 FAIL cuối (F-06, F-07, F-26, F-04)

Mốc so sánh: `test-output/bugfix/G-MONEY/results/` (2,917 PASS / 7 FAIL / 16 WARN / 6 BLOCKED = 2,946).
Mục tiêu vòng này: **FAIL = 0**, không case nào PASS→FAIL/WARN.

7 FAIL còn lại và bug tương ứng (reviewer đã đối chiếu):

| Case | Suite | Bug |
| --- | --- | --- |
| BK-14 (giờ lẻ hh:17), BK-15 (21:30 kết thúc sau 22:00) | 03-bookings | F-06 |
| BK-32 (hội viên khác dùng lại Idempotency-Key), RACE-04 (2 request đồng thời cùng key) | 03-bookings, 12-jobs-races | F-07 |
| WL-19 (người mới chen lên ghế đang offer), WL-20 (người được offer accept bị 422 BR-21) | 06-classes | F-26 |
| LIM-01 (đăng ký vượt mốc A3-2026-0099 va unique) | 12-jobs-races | F-04 |

### 10.0. Vá sót Vòng 5 (reviewer đọc diff phát hiện)

1. **`walkIn` (bookings.ts ~1191):** nhánh manager vẫn lấy `str(b.shift_id)` từ body, chưa kiểm gì — đúng lỗ F-13 (uuid lạ → 500 FK; manager ghi vào két lễ tân). Sửa: **walk-in không bao giờ đọc `b.shift_id`**. Lễ tân → ca mở của chính họ (`_shift` server gán, giữ nguyên); manager → `shift_id = NULL`.
   - Unit test: manager walk-in kèm `shift_id` bịa → 201, payment có `shift_id` NULL; manager walk-in kèm `shift_id` của ca lễ tân đang mở → 201, `shiftCurrent` của lễ tân không đổi.
2. **`paymentsCreate` (desk.ts):** `shift_id` hoặc `ref_id` không phải UUID (vd `"abc"`) → Postgres 22P02 → 500. Sửa: kiểm UUID trước khi query; không phải UUID → `notFound` (404), giống "không tồn tại".
   - Không tạo thêm bản sao regex thứ 6: `export` `UUID_RE` (hoặc hàm `isUuid`) từ `helpers.ts:89` rồi dùng lại. Không bắt buộc đổi các file khác đang có bản sao riêng (để sau, ghi FIXES).
   - Unit test: `shift_id: "abc"` → 404; `ref_id: "abc"` với `ref_type: "booking"` → 404.

### 10.1. Pha A — chỉ đọc (chưa sửa)

Với mỗi bug, in ra: handler + dòng, đoạn code liên quan, case FAIL nguyên văn (request/expected/actual). Riêng:
- F-06: hàm nào đang kiểm cửa sổ đặt (`assertBookWindow`, `slotBounds`…) và **những handler nào gọi nó** (hold, walk-in, reschedule, series nếu có). `graft callers` trước khi sửa.
- F-07: bảng lưu idempotency (tên, cột, unique index hiện tại — đọc migration, không sửa migration cũ), luồng đọc/ghi key trong `bookingsHold`.
- F-26: cách đếm chỗ trống khi ghi danh và khi accept; offer đang chờ (chưa hết hạn) có được tính là ghế đã giữ không.
- F-04: hàm sinh `member_code`, vì sao kẹt ở 0099 (sắp xếp chuỗi? cắt số chữ số? max sai?).

### 10.2. Quy tắc sửa (reviewer quyết)

**F-06 — lưới giờ và giờ đóng cửa**
- `start_at` phải nằm đúng lưới: tính theo giờ địa phương trung tâm (Asia/Ho_Chi_Minh, +07:00), `(phút kể từ open_time) % slot_minutes == 0`, giây = 0. Sai → `err.field("start_at", …)` (4xx, case nhận [400,422]).
- `end = start + slot_minutes` phải `<= close_time`; `start >= open_time`. Sai → `err.field("start_at", …)`.
- Đặt kiểm tra trong **một helper dùng chung** và gọi ở mọi đường tạo/dời booking sân của hội viên và lễ tân (hold, walk-in, reschedule, series). Không đụng occupancy của lớp học (lớp có giờ riêng).
- Unit test: 10:17 → 4xx; 21:30 (kết thúc 22:30) → 4xx; 21:00 → 201; walk-in 10:17 → 4xx.

**F-07 — Idempotency-Key theo từng người dùng**
- Khoá idempotency là cặp `(user_id, key)`, không phải `key` toàn cục. Nếu unique index hiện chỉ trên `key` → tạo **migration mới `0030_…sql`** đổi thành unique `(user_id, key)` (không sửa migration cũ; không chạy `db:migrate`/build — server test tự áp như các vòng trước; nếu không tự áp thì NEEDS-HUMAN).
- Hội viên B dùng lại key của A → coi như request mới của B: 201 với booking **của B** (không trả booking của A, không 409).
- Cùng người, cùng key, 2 request đồng thời (RACE-04): cả hai 201, **cùng booking id**, chỉ 1 booking/1 occupancy được tạo. Cách làm gợi ý: ghi dòng "claim" key **trong cùng transaction** với booking bằng `insert … on conflict do nothing`; bên thua chờ unique index rồi đọc lại response đã lưu và trả y nguyên. Không dùng sleep/retry vòng lặp. Bên thua không được 409/500.
- Unit test: A và B cùng key → 2 booking khác nhau, mỗi người thấy booking của mình; A gửi lại key → cùng booking id, số booking không tăng.

**F-26 — không chen hàng waitlist**
- Ghế đang được offer cho người trong hàng chờ (offer chưa hết hạn) **tính là ghế đã giữ** khi người mới ghi danh → người mới vào waitlist (giữ status 201 như case WL-19 mong đợi), không lấy ghế.
- Người được offer accept trong hạn → 200, nhận ghế (WL-20), không được báo BR-21 "class just filled up".
- Offer hết hạn → không còn giữ ghế (giữ nguyên hành vi job hết hạn hiện có).
- Thử cả 2 thứ tự (theo AGENT-TEST-ROUND2.md:52): người mới ghi danh **trước** và **sau** khi người được offer accept. Sau accept mà lớp đầy → người mới vào waitlist.
- Không đổi luật `session_left` của Vòng trước.
- Unit test cho 3 tình huống: offer đang chờ + người mới; accept trong hạn; offer hết hạn rồi người mới lấy được ghế.

**F-04 — mã hội viên**
- Sinh mã kế tiếp theo **giá trị số**, không theo thứ tự chuỗi; vượt 0099 → 0100, 1000… không va `users_member_code_key`. Nếu cần sequence/bảng đếm → migration mới (0030/0031), không sửa migration cũ.
- Giữ định dạng hiện có `A3-YYYY-NNNN` cho mã ≤ 9999 (không đổi mã cũ).
- Unit test: seed sẵn `A3-2026-0099` và `A3-2026-0100` → mã kế tiếp `A3-2026-0101`; đăng ký liên tiếp 150 lần không lỗi.
- LIM-01: **không đổi expected/điều kiện của case**. Nếu sau khi sửa LIM-01 vẫn FAIL vì logic case ngược (tên điều kiện ghi "F-04 active"), dừng và ghi NEEDS-HUMAN kèm đoạn code case, không tự sửa fixture.

### 10.3. Kiểm chứng

1. `regression.mjs F-04 F-06 F-07 F-26` trước sửa (kỳ vọng STILL_FAIL) và sau sửa (kỳ vọng FIXED).
2. tsc, eslint, `npm test` (151 → 151 + test mới, tất cả PASS).
3. Kiểm chứng ngược 1 lần cho F-07 và F-26: tạm bỏ dòng sửa chính → unit test tương ứng FAIL → khôi phục.
4. Chạy sạch toàn bộ dưới fake clock + `status-transitions.mjs test-output/bugfix/G-MONEY/results test-output/results`.
   - Kỳ vọng đổi đúng 7 case FAIL→PASS ở trên (có thể thêm WARN→PASS; liệt kê và giải thích từng cái).
   - Bất kỳ PASS→FAIL/WARN nào → sửa trước khi báo cáo; nếu do fixture cũ thì ghi FIXTURE-DIFF.md và nêu rõ trong báo cáo để reviewer duyệt.
5. Lưu kết quả sang `test-output/bugfix/G-6/results/`.

### 10.4. Báo cáo

- 10.0 và 4 bug: Pha A → diff → test → regression trước/sau → kiểm chứng ngược.
- Output nguyên văn `status-transitions.mjs`.
- **Danh sách 16 WARN còn lại**: mỗi dòng `suite:id — title — bug F-xx nếu khớp (F-08, F-11, F-15, F-19, F-20…) hoặc "chưa gán"`. Không sửa WARN ở vòng này; đây là đầu vào cho Vòng 7.
- Cập nhật PROGRESS.md, FIXES.md, BUGS-FINAL (nếu có) dưới `## Vòng 6`. Không commit. DỪNG.

---

## 11. Vòng 7 — 15 WARN còn lại (F-08, F-11, F-15, F-19, F-20 + nhóm lớp học)

Mốc so sánh: `test-output/bugfix/G-6/results/` (2,925 PASS / 0 FAIL / 15 WARN / 6 BLOCKED = 2,946).
Mục tiêu: 15 WARN → PASS, FAIL vẫn 0, không case nào PASS→FAIL/WARN. Đây là vòng sửa cuối; sau vòng này chỉ còn chạy chốt tài liệu.

Làm tuần tự 3 nhóm, mỗi nhóm xong thì chạy unit test + regression của nhóm đó rồi mới sang nhóm sau. Chỉ chạy sạch toàn bộ **một lần** ở cuối.

### 11.0. Việc tồn từ Vòng 6

1. `scripts/tests/agent/regression.mjs` dòng ~491–497: WL-19, WL-20 đang là placeholder `return false`. Thay bằng kiểm tra thật, mô phỏng đúng request/điều kiện của WL-19/WL-20 trong `06-classes.mjs` (không hardcode `true`). Ghi FIXTURE-DIFF.md. Sau đó `regression.mjs F-26` phải báo FIXED dựa trên kết quả thật.
2. F-07 (`helpers.ts` `withIdempotency`): cơ chế chống trùng đồng thời là `Map` trong bộ nhớ → chỉ đúng khi chạy 1 tiến trình. Không sửa ở vòng này; ghi vào FIXES.md mục "để sau": "Nhiều instance (serverless) cần claim key trong DB trong cùng transaction với booking".

### 11.1. Nhóm A — Đăng nhập & phiên (F-08, F-11)

Case: 02-auth AU-06, FG-08, PW-09; 07-security SEC-11. Migration nếu cần: `migrations/0031_session_revoke.sql`.
- **AU-06 (F-08):** email không phân biệt hoa thường. Chuẩn hoá email (trim + lowercase) ở đăng ký, đăng nhập, quên mật khẩu, đổi email; truy vấn `lower(email) = lower($1)`. Không migration dữ liệu.
- **PW-09, SEC-11 (F-11):** sau đổi mật khẩu, mọi token/phiên phát ra TRƯỚC thời điểm đổi → 401. Phiên đang đổi mật khẩu: đọc case xem response có cấp token mới không và làm đúng theo case.
- **FG-08 (F-11):** sau reset mật khẩu qua quên mật khẩu/OTP, mọi phiên cũ → 401.
- Đọc cơ chế token/phiên hiện tại trước. Có bảng sessions → thu hồi trong đó. Token stateless → thêm `users.password_changed_at` (hoặc `token_version`) bằng migration 0031 và kiểm trong chỗ xác thực token, không thêm query mới nếu đã có query lấy user.
- Unit test: 2 phiên → đổi mật khẩu ở phiên 1 → phiên 2 bị 401; "Abc@X.com" đăng nhập được tài khoản "abc@x.com".

### 11.2. Nhóm B — CSV, giá gói, đóng băng (F-15, F-20, F-19)

Không migration (buộc phải cần → NEEDS-HUMAN).
- **IV-21 (F-15, 04-desk-payments):** ô CSV bắt đầu bằng `=` `+` `-` `@` hoặc tab/CR → thêm tiền tố `'`. Sửa ở helper tạo CSV dùng chung (grep `text/csv`) để áp mọi export. Ô là số thuần (cột tiền âm) — đọc case, nếu case chỉ yêu cầu ô chữ thì không đụng ô số.
- **SB-31 (F-20, 05-plans-subscriptions):** đặt gói giá 500,000, quản lý tăng lên 600,000, thanh toán 500,000 → 201. Kiểm số tiền theo giá đã lưu trên subscription/đơn lúc đặt, không theo giá hiện tại của plan. Subscription chưa lưu giá lúc đặt → NEEDS-HUMAN.
- **FZ-21 (F-19, 05):** đóng băng rồi mở trong cùng ngày → `end_on` chỉ cộng số ngày thực sự đóng băng (cùng ngày → về trong vòng 1 ngày so với `end_on` gốc).
- Unit test: mỗi case 1 test + 1 negative (thanh toán 400,000 vẫn bị từ chối; ô "Nguyễn" không bị thêm `'`).

### 11.3. Nhóm C — Lớp học, buổi học, điểm danh, giáo án (8 case, 06-classes)

Expected 4xx [400,409,422], riêng TR-47 = 422. Không migration. Không đụng waitlist/ghi danh trong classes.ts (F-26 vừa sửa).
- **CL-21:** tạo lớp sức chứa 1000 → từ chối; tối đa 200, dùng chung một hằng số với chỗ sửa lớp.
- **CL-22:** BYHOUR=25 → từ chối (0..23, và trong giờ mở cửa nếu code đã có kiểm tra đó).
- **CL-23:** `start_on` sau `end_on` → từ chối.
- **CL-24:** lớp môn cầu lông trên sân bóng rổ → từ chối (môn lớp phải khớp môn sân).
- **SS-18:** dời buổi sang 03:00 → từ chối. **SS-20:** dời buổi qua sau `end_on` của lớp → từ chối. Tái dùng `assertSlotGrid` (Vòng 6, đã làm SS-19 PASS), không viết bản sao.
- **AT-12:** điểm danh buổi chưa bắt đầu → từ chối (dùng now() server; không viết code fake clock trong src/).
- **TR-47:** tạo giáo án mới cho buổi đã có kết quả → `err.br("BR-48", …)` 422.
- Dùng `err.field(<field>, …)` cho lỗi dữ liệu. Unit test: mỗi case 1 test từ chối + 1 test hợp lệ vẫn qua.

### 11.4. Kiểm chứng & báo cáo

1. Mỗi nhóm: unit test (thêm vào tx.test.ts hoặc file test mới đã thêm vào script `npm test`), kiểm chứng ngược 1 lần cho mỗi bug (bỏ dòng sửa chính → FAIL → khôi phục).
2. tsc, eslint, `npm test` toàn bộ PASS.
3. Chạy sạch toàn bộ dưới fake clock + `status-transitions.mjs test-output/bugfix/G-6/results test-output/results`. Kỳ vọng đúng 15 WARN→PASS, FAIL 0, không PASS→FAIL/WARN. Case nào không chuyển được → giải thích, không đổi expected.
4. Lưu sang `test-output/bugfix/G-7/results/`. Cập nhật PROGRESS.md, FIXES.md, BUGS-FINAL.md dưới `## Vòng 7`. Không commit.
5. Báo cáo: mỗi bug Pha A → diff → test → kiểm chứng ngược; output nguyên văn status-transitions; NEEDS-HUMAN; danh sách 6 BLOCKED kèm lý do. DỪNG.

## 12. Vòng 8 — Sửa lại AT-12, chốt SB-31, chạy cuối và đóng hồ sơ

Kết quả Vòng 7 đã nhận: 2,939 PASS / 0 FAIL / 1 WARN / 6 BLOCKED. Vòng này sửa 1 chỗ sai luật, làm SB-31, rồi chạy sạch lần cuối và chốt tài liệu. Mọi ràng buộc cứng ở các mục trước vẫn giữ nguyên.

### 12.1. AT-12 làm lại (luật hiện tại SAI)

Code hiện tại ở `ops.ts` (~dòng 400) từ chối điểm danh nếu **có buổi trước đó vẫn `scheduled`**. Như vậy là sai:
- Chặn nhầm: buổi hôm nay đã diễn ra nhưng một buổi tuần trước quên điểm danh → không điểm danh được buổi hôm nay.
- Lọt: buổi tương lai vẫn điểm danh được khi các buổi trước đã xong.

Luật đúng: **từ chối khi buổi này chưa bắt đầu**, tức `start_at > now`.
- Bỏ hẳn truy vấn `earlier`. So sánh bằng JS: `if (new Date(session.start_at).getTime() > Date.now()) throw err.field("session_id", "Cannot mark attendance for a session that has not started.")`. Dùng `Date.now()` của Node (đã bị fake clock điều khiển trong tiến trình test), KHÔNG dùng `now()` của Postgres/PGlite, KHÔNG viết code fake clock trong `src/`.
- Rà mọi case điểm danh trong suite (06-classes, ATT-*, AT-*) và test UI nếu có: case nào đang PASS nhờ điểm danh buổi tương lai → báo cáo cụ thể (id case, start_at buổi, giờ fake clock), KHÔNG đổi expected, KHÔNG nới luật. Nếu fixture tạo buổi trong tương lai rồi điểm danh, sửa fixture cho dùng buổi đã bắt đầu và ghi vào FIXTURE-DIFF kèm lý do.
- Unit test: buổi tương lai → 400; buổi đã bắt đầu (kể cả khi có buổi trước chưa điểm danh) → 200.

### 12.2. SB-31 / F-20 — khóa giá gói khi đặt (đã duyệt migration 0032)

- Tạo `migrations/0032_subscription_price_lock.sql`:
  - `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS price_vnd INTEGER;`
  - Backfill: `UPDATE subscriptions s SET price_vnd = p.price_vnd FROM membership_plans p WHERE s.plan_id = p.id AND s.price_vnd IS NULL;` (kiểm tra đúng tên cột FK trong schema trước khi viết).
  - Không xóa/sửa migration cũ. Không có comment kiểu XML; comment SQL `--` bình thường được.
- Mọi chỗ tạo subscription (online, quầy, gia hạn): ghi `price_vnd` = giá gói tại thời điểm đặt (sau khuyến mãi nếu code đang tính khuyến mãi ở bước đó; nếu không, giá gốc — ghi rõ chọn cách nào).
- Thanh toán/đối soát subscription so với `subscriptions.price_vnd`, fallback giá gói hiện tại chỉ khi cột NULL.
- Manager đổi giá gói sau khi đặt → thanh toán vẫn theo giá cũ (đây chính là SB-31).
- Unit test + kiểm chứng ngược. Chạy migrate CHỈ trên PGlite của safe server (qua cách khởi động server test hiện có); KHÔNG `npm run build`, KHÔNG db:migrate thật.

### 12.3. Xác nhận nốt (chỉ đọc + chạy test có sẵn, báo kết quả)

1. F-11: đặt lại mật khẩu qua OTP thu hồi TẤT CẢ phiên của user (auth.ts:173 dùng `revoked_at is null`, không lọc token) — viết 1 test: đăng nhập 2 phiên → reset OTP → cả 2 token cũ nhận 401.
2. F-19: bỏ đóng băng khi KHÔNG có audit `freeze_sub` → không 500, xử lý hợp lý (báo cách xử lý); bỏ đóng băng sau khi đã hết toàn bộ thời gian đóng băng → `end_on` cộng đúng số ngày thực tế.
3. csvCell: liệt kê mọi endpoint trả `text/csv` (hiện thấy 1: `/invoices/export-list`); nếu có export khác thì dùng chung `csvCell`.
4. 11.0: ghi chú giới hạn F-07 (Map trong bộ nhớ, chỉ một tiến trình) đã có trong FIXES "để sau" chưa — chưa thì thêm.
5. Các unit test mới của Vòng 7 + 8 có thật sự chạy trong `npm test` không (dán số test trước/sau).

### 12.4. Chạy cuối

1. tsc, eslint, `npm test` toàn bộ PASS.
2. Chạy sạch toàn bộ dưới fake clock; `status-transitions.mjs test-output/bugfix/G-7/results test-output/results`. Kỳ vọng: SB-31 WARN→PASS, FAIL 0, KHÔNG có PASS→FAIL/WARN. Tổng vẫn 2,946.
3. `regression.mjs` toàn bộ F-xx PASS.
4. Lưu sang `test-output/bugfix/G-8/results/`.

### 12.5. Đóng hồ sơ

- BUGS-FINAL.md, FIXES.md, PROGRESS.md: thêm `## Vòng 8`; bảng tổng kết toàn bộ F-xx (trạng thái cuối, vòng sửa, case kiểm chứng).
- 6 BLOCKED ghi là **N/A có lý do**, không tính là lỗi:
  - SEC-07, SEC-08: hệ thống dùng opaque session token, không phải JWT.
  - EQ-01, EQ-02, EQ-09: không có API tạo thiết bị (ngoài phạm vi SRS FR-D09).
  - JOB-03: cần dịch thời gian trong tiến trình job; ghi "để sau, có thể làm bằng fake clock".
- Danh sách "để sau" (known limitations): F-07 Map một tiến trình; phí lớp/thuê thiết bị không tạo payment row (SRS G-07).
- Ghi chú triển khai: migration 0029–0032 sẽ tự chạy khi build/deploy. KHÔNG tự deploy.
- Không commit. Báo cáo: diff từng mục, output nguyên văn status-transitions + regression, số liệu cuối. DỪNG.

## 13. Vòng 9 — Vá sót SB-31 trên luồng online + regression thật

Vòng 8 đã nhận (2,940 / 0 / 0 / 6). Còn 2 chỗ hở, sửa nhỏ, rồi chạy lại một lần.

### 13.1. SB-31 chưa áp dụng cho luồng thanh toán online

`online.ts` ~dòng 249–254 (tạo link payOS cho subscription) vẫn đọc `membership_plans.price_vnd` hiện tại → manager đổi giá sau khi đặt thì link online thu theo giá mới. Sửa: lấy `s.price_vnd` của subscription, fallback giá gói chỉ khi NULL, rồi trừ `promo_discount_vnd` như cũ.
- Rà mọi chỗ khác tính số tiền cho subscription từ `membership_plans.price_vnd` (`grep -n "from membership_plans where id"` trong handlers: online.ts, desk.ts, plans.ts, ops.ts, extras.ts…). Chỗ nào là **số tiền phải thu** của một subscription đã tạo → dùng `subscriptions.price_vnd`. Chỗ chỉ hiển thị tên gói / tạo đơn mới thì giữ nguyên. Liệt kê từng chỗ trong báo cáo.
- `plans.ts` ~dòng 215/220: xác nhận `amountDue` và `price_vnd` ghi vào subscription nhất quán (price_vnd = giá gốc trước khuyến mãi; khuyến mãi nằm ở `promo_discount_vnd`).
- Unit test: tạo subscription → manager đổi giá gói → tạo link online → số tiền = giá cũ − khuyến mãi. Kiểm chứng ngược.
- KHÔNG gọi payOS thật; dùng đường test/mock hiện có của suite.

### 13.2. Regression runner phải phản ánh kết quả thật

`scripts/tests/agent/regression.mjs` còn stub `return false; // Confirmed F-15/F-19/F-20` (dòng ~432, 554, 587) và F-07, F-10 cũng báo STILL_FAIL. Các bug này đã sửa, nên stub không còn ý nghĩa. Thay bằng kiểm tra API thật, mỗi cái tái hiện đúng kịch bản bug:
- F-07: 2 request song song cùng Idempotency-Key cùng user → cùng booking id, chỉ 1 booking; 2 user khác nhau cùng key → không dính nhau.
- F-10: một route đại diện trả đúng thứ tự 401 → 403 → 404 (rule 6.0).
- F-15: tạo dữ liệu có tên bắt đầu `=` → export CSV → ô bắt đầu bằng `'`.
- F-19: đóng băng → tiến fake clock không được; thay vào đó kiểm tra unfreeze ngay sau freeze → `end_on` không bị cộng thừa (actualDays = 0 → end_on giữ nguyên gốc).
- F-20: đặt gói → đổi giá → thanh toán quầy theo giá cũ được 201, theo giá mới bị 422.
Ghi FIXTURE-DIFF. Kỳ vọng regression **27/27 FIXED**. Không case nào được "ép" bằng cách bỏ kiểm tra.

### 13.3. Kiểm chứng & báo cáo

1. tsc, eslint, `npm test` PASS.
2. Chạy sạch toàn bộ dưới fake clock; `status-transitions.mjs test-output/bugfix/G-8/results test-output/results`: kỳ vọng 0 biến động (2,940 / 0 / 0 / 6). Lưu sang `test-output/bugfix/G-9/results/`.
3. `regression.mjs`: dán output nguyên văn, kỳ vọng 27/27 FIXED.
4. BUGS-FINAL.md (test-output/final/): bảng phải có đủ mỗi F-xx đúng 1 dòng, không trùng (bản báo cáo Vòng 8 bị lặp F-12, F-14 và thiếu dòng F-13, F-16). Cập nhật FIXES/PROGRESS dưới `## Vòng 9`.
5. Không commit. Báo cáo ngắn: diff, danh sách chỗ dùng giá ở 13.1, 2 output nguyên văn. DỪNG.
