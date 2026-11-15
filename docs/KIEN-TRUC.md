# Kiến trúc Arena3 — đi theo một thao tác từ màn hình tới database

Tài liệu dành cho sinh viên mới học web, đối chiếu với mã nguồn trong repo ngày 10/11/2026. Arena3 là tên dùng trong mã nguồn; giao diện hiện dùng tên Lê Long Sport. Tài liệu mô tả cách code được nối với nhau, không khẳng định các dịch vụ bên ngoài đã được cấu hình hay đang hoạt động.

Các đoạn code là trích đoạn ngắn, cần đọc cùng hàm chứa chúng. Đường dẫn `file:dòng` tính từ gốc repo; số dòng có thể thay đổi khi code được sửa. Phần schema chi tiết nằm trong [DATABASE.md](DATABASE.md).

## Mục lục

1. [Client, server và request là gì?](#1-khai-niem)
2. [Các tầng của dự án](#2-cac-tang)
3. [Hai router và đường đi của request](#3-router)
4. [Xác thực, session và phân quyền](#4-auth)
5. [Transaction, savepoint và chống xử lý lặp](#5-transaction)
6. [Lỗi nghiệp vụ và mã BR](#6-loi)
7. [Luồng mẫu: đặt sân](#7-dat-san)
8. [Luồng mẫu: đăng ký lớp và hàng chờ](#8-lop)
9. [Luồng mẫu: thanh toán](#9-thanh-toan)
10. [Jobs nền và thông báo](#10-jobs)
11. [Các tích hợp bên ngoài](#11-tich-hop)
12. [i18n: giao diện tiếng Anh và tiếng Việt](#12-i18n)
13. [Đọc và chạy test nghiệp vụ](#13-test)

<a id="1-khai-niem"></a>
## 1. Client, server và request là gì?

**Là gì?** Client là phần người dùng tương tác trong trình duyệt. Server là phần nhận yêu cầu và xử lý dữ liệu. Một **request** là yêu cầu gửi tới server, gồm phương thức như `GET`/`POST`, đường dẫn, header và có thể có body. **Response** là câu trả lời, gồm mã trạng thái và dữ liệu.

Ví dụ: khi bấm giữ sân, trình duyệt gửi `POST /v1/bookings`. `POST` đề nghị tạo hoặc thực hiện một thao tác; `GET` thường dùng để đọc dữ liệu. Body JSON mang sân và giờ đã chọn. Server kiểm tra người gửi, quy tắc đặt sân và chỗ trống rồi mới ghi database.

**Database là gì?** Đó là nơi lưu dữ liệu có cấu trúc. Một bảng giống danh sách có cột và hàng: bảng `users` lưu người dùng, `court_bookings` lưu lượt đặt. **Khóa chính** nhận diện một hàng; **khóa ngoại** nối hàng đó với hàng của bảng khác. Ví dụ `court_bookings.court_id` trỏ tới `courts.id` trong `migrations/0002_arena3.sql:258`.

**Tại sao cần nhiều lớp kiểm tra?** Người dùng có thể gửi HTTP mà không bấm nút trên giao diện. Do đó nút bị ẩn hoặc trang bị chặn chưa đủ bảo vệ dữ liệu. Handler phía server phải kiểm tra quyền; database còn kiểm tra khóa, trạng thái và ràng buộc dữ liệu.

<a id="2-cac-tang"></a>
## 2. Các tầng của dự án

**Là gì?** Một tầng gom những phần có cùng trách nhiệm. Đây là cách tổ chức trong cùng ứng dụng; không có nghĩa mỗi thư mục là một máy chủ riêng hay một microservice.

| Thư mục | Trách nhiệm | Ví dụ để mở đọc |
| --- | --- | --- |
| `src/routes/` | Khai báo trang, bố cục theo URL và đầu vào HTTP | `src/routes/app.tsx:4`, `src/routes/v1.$.ts:4` |
| `src/client/components/` | Component dùng lại, shell, biểu mẫu, thông báo | `src/client/components/shell.tsx:932` có `Guard` |
| `src/client/lib/pages/` | Hook điều khiển state và thao tác của trang | `src/client/lib/pages/app.book.ts:54` có `useCourtBooking` |
| `src/client/arena3/` | Gọi API, lưu bản sao session trong trình duyệt, tiện ích giao diện | `src/client/arena3/client.ts:207` |
| `src/server/controllers/` | Chọn endpoint, xác thực, transaction, lỗi, validate và các hàm hỗ trợ request | `src/server/controllers/router.ts:40`, `session.ts:87`, `tx.ts:64` trong cùng thư mục |
| `src/server/controllers/handlers/` | Xử lý từng thao tác: giữ sân, đăng ký lớp, thu tiền… | `src/server/controllers/handlers/bookings.ts:611`, `classes.ts:402` |
| `src/server/services/` | Quy tắc và phép tính dùng lại: giá, membership, lịch lặp, khuyến mãi | `src/server/services/membership.ts:97`, `rrule.ts` |
| `src/server/integrations/` | Nối payOS, email, mô hình AI, tạo PDF | `src/server/integrations/payos.ts:100`, `gemini.ts:106` |
| `src/server/data/` | Kết nối SQL, khởi tạo DB, jobs và dữ liệu xuất file | `src/server/data/db.ts:230`, `jobs.ts:352` |
| `src/shared/` | Kiểu dữ liệu và tiện ích có thể dùng chung | `src/shared/arena3/contracts.ts:26`, `time.ts`, `src/shared/ui-config.ts` |
| `migrations/` | Lịch sử thay đổi schema và dữ liệu bằng SQL | `migrations/0002_arena3.sql:21`, `0051_single_membership.sql:94` |

**Điểm dễ hiểu nhầm:** repo không có một lớp repository bắt buộc đứng giữa mọi handler và DB. Handler và một số service gọi `sql.query()` trực tiếp. Không phải request nào cũng đi qua đủ cả `services` và `integrations`.

**Ví dụ — `src/shared/arena3/contracts.ts:26`:**

```ts
export type Role = "manager" | "coach" | "receptionist" | "member";
```

Kiểu dùng chung giúp client và server gọi tên vai trò thống nhất. TypeScript giúp kiểm tra lúc phát triển; dữ liệu HTTP vẫn cần được kiểm tra khi chương trình chạy.

<a id="3-router"></a>
## 3. Hai router và đường đi của request

**Router là gì?** Router chọn đoạn code tương ứng với một đường dẫn. Trong repo có hai việc khác nhau cùng mang tên này.

| File | Chọn cái gì? |
| --- | --- |
| `src/router.tsx:5` | Khởi tạo TanStack Router từ `routeTree.gen.ts`, chọn trang và component lỗi |
| `src/server/controllers/router.ts:40` | Chọn handler API dựa trên phương thức HTTP và các phần của đường dẫn |

Người dùng nhắc `router.ts` thường là router API ở `controllers`; file khởi tạo router trang thực tế có đuôi `.tsx`.

**Ví dụ — `src/router.tsx:7`:**

```ts
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    defaultNotFoundComponent: AppNotFoundComponent,
```

Trang `src/routes/app.book.tsx` dùng hook đặt sân; thao tác `holdSlot()` ở `src/client/lib/pages/app.book.ts:201` gọi `apiPost`. Bộ gọi API thêm token rồi gửi HTTP. Route server `src/routes/v1.$.ts:4` chuyển các phương thức tới `handleApi()`.

**Ví dụ — `src/routes/v1.$.ts:7`:**

```ts
      GET: ({ request }) => handleApi(request),
      POST: ({ request }) => handleApi(request),
```

Trong router API, `pathOf()` bỏ tiền tố `/v1` hoặc `/api`, tách đường dẫn và chuẩn hóa phương thức (`src/server/controllers/router.ts:33`). `dispatch()` chọn nhánh; `handleApi()` đổi kết quả `{ status, body }` thành `Response`, xử lý riêng `204`, hoặc trả lỗi (`src/server/controllers/router.ts:850`).

**Một request ghi dữ liệu đi theo thứ tự:**

1. Trang và hook nhận thao tác.
2. `src/client/arena3/client.ts:207` dựng header, gửi request và đọc JSON.
3. `src/routes/v1.$.ts:4` chuyển tới `handleApi()`.
4. `dispatch()` chọn endpoint trong router API.
5. `authed()` mở transaction rồi gọi `authFromRequest()` để lấy người dùng từ DB.
6. Handler đọc input, kiểm tra quyền, gọi service/SQL khi cần.
7. `withTx()` commit khi thành công; lỗi thông thường làm rollback.
8. `handleApi()` trả JSON; client cập nhật state hoặc hiển thị lỗi.

**Ví dụ — `src/server/controllers/router.ts:215`:**

```ts
  const authed = async (fn: (sql: Awaited<ReturnType<typeof getSql>>, user: PublicUser) => Promise<Result | Response>) => {
    return withTx(async (sql) => {
      const user = await authFromRequest(sql, request);
      return fn(sql, user);
    });
  };
```

**Request đọc có khác không?** Có. `authedRead()` lấy `getSql()` và xác thực nhưng không bọc `BEGIN`/`COMMIT` (`src/server/controllers/router.ts:228`). Ví dụ `GET /me` dùng đường này. Một số endpoint công khai lấy SQL mà không cần session; webhook payOS dùng chữ ký của nhà cung cấp. Không nên gọi mọi endpoint là “API cần đăng nhập”.

<a id="4-auth"></a>
## 4. Xác thực, session và phân quyền

### 4.1. Xác thực trả lời “bạn là ai?”

**Session là gì?** Là một bản ghi phía server cho biết token nào đang đại diện người dùng nào và còn hạn tới khi nào. Token là chuỗi bí mật client gửi lại ở những request sau.

Luồng đăng nhập nghiệp vụ nằm trong `src/server/controllers/handlers/auth.ts:245`. `issueSession()` tạo token ngẫu nhiên, lưu **SHA-256 của token** vào `sessions_auth`, trả token gốc cho client. Member có hạn phiên 7 ngày; vai trò còn lại 12 giờ (`src/server/controllers/session.ts:64`). Đây không phải session JWT tự chứa toàn bộ quyền.

**Ví dụ — `src/server/controllers/session.ts:68`:**

```ts
  await sql.query(
    `insert into sessions_auth (user_id, token_hash, expires_at) values ($1,$2,$3)`,
    [user.id, sha256(token), expires.toISOString()],
  );
```

Client lưu token và thông tin người dùng ở `localStorage` với khóa `arena3.token`, `arena3.user` (`src/client/arena3/client.ts:5`, `:36`). Bản sao user giúp vẽ giao diện sớm; quyền thật vẫn lấy từ server.

**Ví dụ — `src/client/arena3/client.ts:215`:**

```ts
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.idempotent) headers.set("idempotency-key", newIdem());
```

`authFromRequest()` hash token, join `sessions_auth` với `users`, kiểm tra tồn tại, `revoked_at`, hạn phiên, trạng thái tài khoản và `locked_until` (`src/server/controllers/session.ts:87`). Ngoại lệ token qua query string chỉ dành cho `GET /v1/live` hoặc `/api/live`, vì `EventSource` không gửi được header tùy ý (`:80`).

Đăng xuất xử lý session trong `auth.ts:287`; đổi mật khẩu và đăng xuất các thiết bị khác ở `auth.ts:575`, `:598`. Cột thu hồi phiên được thêm bởi `migrations/0031_session_revoke.sql:2`.

Repo còn có `src/server/auth/` phục vụ hạ tầng Better Auth/Grok. Khi giải thích luồng `/v1` của Arena3 cần theo `sessions_auth` và `controllers/session.ts`, không lấy sự hiện diện của thư viện auth làm bằng chứng mọi API dùng cookie Better Auth.

### 4.2. Phân quyền trả lời “bạn được làm gì?”

| Vai trò lưu trong code/DB | Khu vực giao diện | Quyền được thấy trong code |
| --- | --- | --- |
| `member` | `/app` | Tự giữ sân; đăng ký lớp cho chính mình |
| `coach` | `/coach` | Xem danh sách lớp mình dạy hoặc hỗ trợ; nghiệp vụ huấn luyện |
| `receptionist` | `/desk` | Lễ tân: thao tác tại quầy, thu tiền, xử lý hội viên theo quyền endpoint |
| `manager` | `/manager`; cũng được vào `/coach`, `/desk` | Quản lý cấu hình, nhân sự, lớp và các chức năng quản lý |

**`desk` không phải giá trị của enum vai trò.** Nó là tên khu vực giao diện. Bốn giá trị vai trò được khai báo ở `migrations/0002_arena3.sql:4` và `src/shared/arena3/contracts.ts:26`.

`Guard` phía client (`src/client/components/shell.tsx:932`) và các route `app.tsx:6`, `coach.tsx:6`, `desk.tsx:6`, `manager.tsx:6` kiểm soát việc vào trang. Server dùng `requireRole()` để kiểm tra quyền thật.

**Ví dụ — `src/server/controllers/session.ts:144`:**

```ts
export function requireRole(user: PublicUser, roles: Role[]) {
  if (!roles.includes(user.role)) throw err.forbidden();
}
```

Ngoài vai trò còn có **quyền trên bản ghi**. `classRoster()` cho coach, manager, receptionist truy cập nhưng coach phải là `coach_id` hoặc `assistant_id` của lớp (`src/server/controllers/handlers/classes.ts:883`). `classesEnroll()` cấm member gửi `user_id` của người khác (`:402`). `onlineVerify()` chỉ cho chủ payment hoặc staff xem (`src/server/controllers/handlers/online.ts:350`).

Không có quy tắc chung “manager tự động qua mọi endpoint”: chẳng hạn `bookingsHold()` chỉ nhận `member` (`src/server/controllers/handlers/bookings.ts:612`); thao tác đặt tại quầy có handler khác.

<a id="5-transaction"></a>
## 5. Transaction, savepoint và chống xử lý lặp

### 5.1. Transaction: nhiều bước ghi thành một đơn vị

**Là gì?** Transaction gom nhiều câu SQL. **Commit** giữ các thay đổi; **rollback** hủy chúng nếu một bước thất bại. Giữ sân cần tạo occupancy và booking cùng nhau; không được để sân bị chiếm mà không có booking tương ứng.

**Nằm ở đâu?** `src/server/controllers/tx.ts:64`.

| Backend | `withTx()` thực hiện |
| --- | --- |
| PGlite | `pg.transaction()` và dùng `tx.query()` của transaction đó |
| Postgres/Neon | Lấy một client từ pool; `BEGIN`; chạy callback bằng chính client; `COMMIT` hoặc `ROLLBACK`; trả kết nối về pool |

**Ví dụ — `src/server/controllers/tx.ts:98`:**

```ts
    await client.query("BEGIN");
    const run: Run = async <R>(text: string, params: unknown[]) => {
      const result = await client.query(text, params ?? []);
      return result.rows as R[];
    };
    const out = await fn(wrap(run));
    await client.query("COMMIT");
```

Điểm cần nhớ là dùng `sql` được truyền vào callback. Dùng các query rời qua pool không bảo đảm chúng cùng một transaction.

**Ngoại lệ `KeepWrites`:** có lỗi vẫn cần giữ thay đổi, ví dụ đăng nhập sai phải tăng bộ đếm thất bại. `KeepWrites` yêu cầu `withTx()` commit rồi ném lại lỗi bên trong (`src/server/controllers/tx.ts:42`, `:64`). Nó không phải cơ chế bỏ qua mọi lỗi SQL; transaction đã bị lỗi SQL vẫn cần được phục hồi đúng cách.

### 5.2. Savepoint: quay lại một mốc nhỏ

**Là gì?** Savepoint là mốc trong transaction. `ROLLBACK TO SAVEPOINT` hủy những bước sau mốc đó, giữ transaction ngoài để tiếp tục xử lý.

Trong `classesEnroll()`, code thử giữ ghế. Nếu SQL báo `CLASS_FULL`, handler muốn ghi hàng chờ thay vì hủy toàn bộ request. Vì lỗi SQL khiến transaction không thể tiếp tục truy vấn bình thường, code tạo `sp_enroll` trước khi thử và rollback về mốc này trong `catch` (`src/server/controllers/handlers/classes.ts:432`, `:471`).

**Trích hai vị trí trong cùng hàm:**

```ts
await sql.query("savepoint sp_enroll");
```

```ts
await sql.query("rollback to savepoint sp_enroll");
```

Sau đó nhánh `CLASS_FULL` gọi `enrollment_waitlist()` (`:478`). Bắt lỗi bằng `try/catch` JavaScript đơn thuần chưa đủ để phục hồi trạng thái transaction SQL.

### 5.3. Idempotency: gửi lại vẫn là một thao tác

**Là gì?** Khi mạng chậm, một request có thể được gửi lại. Idempotency key giúp server nhận ra cùng yêu cầu để trả kết quả cũ thay vì tạo thêm booking/payment.

`POST /bookings` bọc `withIdempotency()` trong transaction đã xác thực (`src/server/controllers/router.ts:359`). Hàm hỗ trợ lưu hash request và response (`src/server/controllers/helpers.ts:294`). Migration `0030_idempotency_member_code.sql:5` đổi tính duy nhất thành `(user_id, key)`, nên hai người không dùng chung một phạm vi key.

Client hiện tạo key khi một lời gọi có `idempotent: true` (`src/client/arena3/client.ts:217`). Một lời gọi mới tạo key mới; không nên hiểu việc bấm hai lần luôn tự động được gộp chỉ vì endpoint có idempotency. Khóa hàng và unique index còn bảo vệ dữ liệu khi có request đồng thời; xem [DATABASE.md](DATABASE.md#12-khoa).

<a id="6-loi"></a>
## 6. Lỗi nghiệp vụ và mã BR

**Là gì?** Lỗi nghiệp vụ có nghĩa request đọc được nhưng vi phạm quy tắc của trung tâm. `BR` là nhãn dùng trong code để nhận diện quy tắc; không phải mã HTTP hay SQLSTATE.

**Ví dụ — `src/server/controllers/errors.ts:44`:**

```ts
  br: (br: string, message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(422, "BR_VIOLATION", message, { br, ...extra }),
```

Response có các trường `code`, `message`, có thể thêm `br`, `field`, `requires_confirm`… `ApiError.body()` ghép chúng tại `errors.ts:28`. `err.br()` nhận chuỗi nên không phải mọi nhãn đều bắt đầu bằng `BR-`; chẳng hạn lỗi tạo link thanh toán dùng `C-09` (`src/server/controllers/handlers/online.ts:337`).

| Ví dụ trong code | Ý nghĩa tại điểm kiểm tra | Nguồn |
| --- | --- | --- |
| `BR-06` | Sân không ở trạng thái sẵn sàng | `src/server/controllers/handlers/bookings.ts:623` |
| `BR-09` | Trùng lịch lớp; yêu cầu người dùng xác nhận trước khi giữ sân | `src/server/controllers/handlers/bookings.ts:627` |
| `BR-18` | Lớp chưa mở | `src/server/controllers/handlers/classes.ts:421` |
| `BR-19` | Membership phải kết thúc sau ngày kết thúc lớp | `src/server/services/membership.ts:97` |
| `BR-22` | Đã đăng ký/giữ ghế lớp này | `src/server/controllers/handlers/classes.ts:487` |
| `BR-23` | Lời mời hàng chờ hết hạn | `src/server/controllers/handlers/ops.ts:165` |
| `BR-53` | Lớp chưa có giá bán | `src/server/controllers/handlers/classes.ts:422` |
| `BR-63` | Đã đạt giới hạn lớp hold/confirmed chưa kết thúc | `src/server/controllers/helpers.ts:469` |

Các mã khác: chưa xác thực trả `401`, thiếu quyền `403`, không có bản ghi `404`, xung đột slot/trạng thái `409`, quá nhiều lần thử `429`. `err.field()` trả `400` để gắn lỗi với ô nhập; `err.validation()` trả `422` (`src/server/controllers/errors.ts:33`). `mapDbError()` chuyển một số lỗi DB thành lỗi API (`:90`), tránh bắt client hiểu trực tiếp lỗi PostgreSQL.

<a id="7-dat-san"></a>
## 7. Luồng mẫu: đặt sân

**Mục tiêu:** giữ một slot có thời hạn, sau đó xác nhận khi thanh toán. Lịch trên màn hình là thông tin tại thời điểm đọc; server vẫn kiểm tra lại khi giữ.

| Bước | Code thực hiện | Dữ liệu/kết quả |
| --- | --- | --- |
| 1. Chọn sân, giờ | `src/routes/app.book.tsx`; `src/client/lib/pages/app.book.ts:201` | `holdSlot()` tạo `start_at` có `+07:00`, gọi `apiPost("/bookings", …, true)` |
| 2. Gửi HTTP | `src/client/arena3/client.ts:207` | JSON, bearer token, idempotency key |
| 3. Chọn handler | `src/routes/v1.$.ts:4`; `src/server/controllers/router.ts:359` | `authed()` → `withIdempotency()` → `bookingsHold()` |
| 4. Kiểm tra | `src/server/controllers/handlers/bookings.ts:611` | Vai trò member; dữ liệu, khung giờ đặt, sân ready, lịch sân/lớp của người dùng |
| 5. Tính giá | Cùng hàm, `:631` | Giá niêm yết; phí member nếu membership phủ ngày chơi; mã giảm giá cho nhánh phù hợp |
| 6. Giữ chỗ trong DB | Cùng hàm, `:655`; `migrations/0002_arena3.sql:534` | `booking_replace_hold()` khóa sân, giải phóng hold cũ, tạo occupancy mới |
| 7. Ghi booking | `src/server/controllers/handlers/bookings.ts:666` | `court_bookings.status = 'hold'`, `hold_until`, giá, `occupancy_id` |
| 8. Trả kết quả | Cùng hàm, `:689`; hook `app.book.ts:215` | HTTP `201`; client lưu hold vào state, vẽ thời gian và số tiền cần trả |
| 9. Kết thúc giữ | `bookings.ts:847`, `:935`; `src/server/data/jobs.ts:4` | Thanh toán được xác nhận thì chuyển booking; quá hạn thì job giải phóng occupancy |

**Ví dụ — `src/server/controllers/handlers/bookings.ts:648`:**

```ts
  // Courts are paid in full up front.
  const deposit = 0;
```

Schema còn cột deposit/quota để giữ lịch sử, nhưng luồng tạo hold hiện tại trả `due_now_vnd = price` và không cấp giờ quota. `memberCourtFee()` là chính sách phí theo membership, không phải trừ giờ gói cũ (`src/server/services/membership.ts:76`).

`bookingsConfirm()` có nhánh yêu cầu chuyển khoản; lời yêu cầu này chưa chứng minh đã nhận tiền. Lễ tân đối soát qua `bookingsTransferConfirm()` hoặc cổng thanh toán xác nhận qua luồng ở mục 9. `settleHeldBooking()` dùng chung phần chuyển hold và lập chứng từ (`src/server/controllers/handlers/bookings.ts:736`).

<a id="8-lop"></a>
## 8. Luồng mẫu: đăng ký lớp và hàng chờ

**Lớp và buổi học khác nhau thế nào?** `classes` là lớp có lịch lặp, sức chứa và người dạy. `sessions` là từng buổi cụ thể có thời điểm bắt đầu/kết thúc. Một `enrollment` nối hội viên với lớp; nó không phải từng lần điểm danh.

### 8.1. Từ màn hình tới ghế giữ hoặc hàng chờ

1. Trang `src/routes/app.classes.tsx` dùng `useMemberClasses()`; `enrol()` trong `src/client/lib/pages/app.classes.ts:130` gửi `POST /v1/classes/{id}/enroll` qua bộ gọi API.
2. Router API chọn nhánh đăng ký ở `src/server/controllers/router.ts:415`, bọc `authed()` rồi chuyển tới `classesEnroll()` (`src/server/controllers/handlers/classes.ts:402`). Member chỉ đăng ký cho mình; receptionist/manager có nhánh chỉ định người học.
3. Handler yêu cầu lớp `open`, có `price_vnd`, không trùng lịch lớp, chưa vượt giới hạn lớp đang tham gia và membership kết thúc **sau** ngày kết thúc lớp (`:421`). Giới hạn cấu hình nằm ở `migrations/0054_max_active_classes.sql:2`.
4. Handler đặt savepoint rồi gọi SQL `enrollment_hold()` (`classes.ts:432`). Hàm SQL ở `migrations/0045_sell_classes.sql:12` khóa hàng lớp, tăng `enrolled_count` có điều kiện và ghi enrollment `hold` cùng hạn/giá.
5. Tổng bằng 0 thì đổi ngay sang `confirmed`; có tiền cần thu thì trả ghế `hold` và báo giá (`classes.ts:446`). Giá được chốt trên enrollment, không chỉ đọc lại giá lớp khi thanh toán.
6. Nếu SQL báo `CLASS_FULL`, rollback về savepoint, gọi `enrollment_waitlist()` rồi trả `waitlisted: true` (`classes.ts:471`). Người vào hàng chờ chưa chiếm một ghế trong `enrolled_count`.

**Ví dụ — `migrations/0045_sell_classes.sql:22`:**

```sql
  update classes set enrolled_count = enrolled_count + 1
   where id = p_class and enrolled_count < capacity and status = 'open';
  if not found then
    raise exception 'CLASS_FULL';
  end if;
```

**Điểm dễ nhầm khi đọc test cũ:** một số tên test còn ghi “no plan needed”. Điều kiện thực thi hiện tại nằm ở `assertMembershipOutlastsClass()`; `outlastsClass()` dùng dấu `>` chứ không phải `>=` (`src/server/services/membership.ts:30`, `:97`). Membership hết cùng ngày kết thúc lớp cũng không đủ điều kiện theo code này.

### 8.2. Khi có ghế trống

`enrollmentDelete()` hoặc job hết hạn giữ ghế có thể giải phóng chỗ rồi gọi `inviteWaitlist()` (`src/server/controllers/handlers/classes.ts:685`, `src/server/data/jobs.ts:206`).

| Thao tác | Cách xử lý thật |
| --- | --- |
| Mời người chờ | `inviteWaitlist()` khóa lớp, tính số ghế trống trừ lời mời còn hiệu lực, chọn theo `waitlist_pos`, tạo `waitlist_offers` và thông báo in-app (`src/server/controllers/handlers/ops.ts:213`) |
| Hội viên nhận lời | `waitlistAccept()` kiểm tra offer còn hạn/đúng chủ, khóa lớp rồi enrollment, kiểm tra lại sức chứa, lịch và membership (`ops.ts:154`) |
| Nhận lớp có phí | Chuyển enrollment thành `hold`, chốt giá và hạn giữ; offer thành `accepted` (`ops.ts:186`) |
| Nhận lớp miễn phí | Chuyển ngay thành `confirmed` (`ops.ts:190`) |
| Dọn thứ tự hàng chờ | `waitlist_compact()` đánh lại vị trí; bản sửa hai bước ở `migrations/0052_waitlist_compact_two_step.sql:6` tránh va unique index |
| Thanh toán ghế giữ | `settleEnrollment()` khóa lớp và enrollment; chuyển `hold` thành `confirmed`, xử lý các kết quả tiền tới muộn (`classes.ts:587`) |

Lời mời không đồng nghĩa enrollment đã `confirmed`, cũng không tự tăng sĩ số. `waitlistAccept()` vẫn kiểm tra ghế: nếu lớp vừa đầy, trả `BR-21` (`ops.ts:183`). Không nên suy từ tên migration hay tên test rằng mọi ghế được khóa độc quyền cho người nhận offer; nhánh đăng ký và nhánh nhận lời phải được đọc cùng nhau.

<a id="9-thanh-toan"></a>
## 9. Luồng mẫu: thanh toán

**Payment và invoice khác nhau thế nào?** `payments` ghi giao dịch tiền, phương thức, trạng thái và đối tượng được thanh toán. `invoices` lưu chứng từ gắn với payment, còn `invoice_lines` là các dòng hàng/dịch vụ. Một hold chưa chắc đã có payment; một payment `pending` chưa phải doanh thu đã nhận.

### 9.1. Thanh toán online qua payOS

1. `PayOnlineButton.raise()` gửi `POST /v1/payments/online` với `ref_type`, `ref_id` (`src/client/components/pay-online.tsx:74`). Router bọc `authed()` rồi gọi `onlineCreate()` (`src/server/controllers/router.ts:457`); handler kiểm tra quyền và đọc số tiền từ đơn booking/subscription/enrollment phía server (`src/server/controllers/handlers/online.ts:149`).
2. `issueOnlineLink()` cấp mã chứng từ và `provider_order_code`, tạo payment chờ rồi gọi payOS (`:286`, `:505`). Integration ở `src/server/integrations/payos.ts:100` trả URL/QR.
3. Người dùng quét QR. Việc quay lại `returnUrl` **không** là bằng chứng đã thanh toán; comment và cách xử lý thể hiện tại `online.ts:32`.
4. Server xác minh bằng một trong hai đường: client gửi `POST /v1/payments/online/{id}/verify`, tới `onlineVerify()` để gọi API payOS đọc trạng thái (`:350`); hoặc payOS gửi `POST /v1/payments/online/webhook`, tới `payosWebhook()` để kiểm tra chữ ký (`:407`). Cả hai khóa hàng payment bằng `FOR UPDATE`; nhánh webhook dùng transaction riêng và không yêu cầu session của người dùng (`src/server/controllers/router.ts:163`).
5. Hai đường cùng gọi `settleOnline()`: nếu đã `posted` thì trả lại; nếu chưa đủ tiền thì chưa post; đủ tiền thì ghi `posted`, `capture_mode = 'auto'`, mã giao dịch và `paid_at` (`:72`).
6. Tùy `ref_type`, code gọi `settleOnlineBooking()`, `settleOnlineSubscription()` hoặc `settleOnlineEnrollment()` (`:544`, `:571`, `:619`). Chúng chuyển trạng thái nghiệp vụ, lập invoice/receipt theo từng nhánh.
7. Client kiểm tra bằng polling và khi có tín hiệu SSE; nhận `posted` thì dừng polling, đổi giao diện sang đã trả tiền và gọi `onPaid()` để tải lại dữ liệu (`src/client/components/pay-online.tsx:100`). Thông báo/biên nhận được ghi vào outbox để gửi tiếp.

**Ví dụ — `src/server/controllers/handlers/online.ts:101`:**

```ts
  if (pay.ref_type === "booking") return settleOnlineBooking(sql, pay);

  if (pay.ref_type === "subscription") return settleOnlineSubscription(sql, pay);

  if (pay.ref_type === "enrollment") return settleOnlineEnrollment(sql, pay, wasReleased);
```

DB có unique index cho mã đơn nhà cung cấp và `(provider, provider_txn_id)` (`migrations/0015_payment_capture.sql:64`). `invoices.payment_id` cũng unique (`migrations/0002_arena3.sql:326`). Những ràng buộc này cùng khóa hàng và nhánh “đã posted” giúp poll/webhook lặp không tạo thêm chứng từ tùy tiện.

**Tiền tới sau khi ghế hết hạn thì sao?** `settleEnrollment()` có kết quả `late_confirmed`, `late_no_seat`, `released`, `class_cancelled`, `duplicate`… Ghế còn trống có thể được nhận lại; nếu chỗ đã mất hoặc người dùng đã chủ động thả ghế, code gắn cờ để staff xử lý (`src/server/controllers/handlers/classes.ts:491`, `:514`, `:587`). Tiền đã tới và quyền có ghế là hai việc phải đối chiếu riêng.

### 9.2. Thu tại quầy và chuyển khoản thủ công

`paymentsCreate()` và các thao tác quầy nằm trong `src/server/controllers/handlers/desk.ts`; `bookingsTransferConfirm()` ở `bookings.ts:935` xử lý xác nhận chuyển khoản sân. `capture_mode = 'manual'` biểu thị người ở quầy xác nhận đã thu, khác `auto` của cổng thanh toán (`migrations/0015_payment_capture.sql:46`).

Yêu cầu chuyển khoản sân chỉ đặt `transfer_requested_at` và kéo dài hold; không ghi payment đã nhận tiền ngay (`migrations/0012_transfer_reconcile.sql:19`). Lớp cũng có `enrollmentTransfer()` (`src/server/controllers/handlers/classes.ts:650`). Ca thu ngân và quyền hoàn tiền được kiểm tra riêng; không thể coi nút “đã chuyển khoản” của member là xác nhận từ ngân hàng.

<a id="10-jobs"></a>
## 10. Jobs nền và thông báo

**Là gì?** Job là công việc hệ thống tự làm theo thời gian, như hủy giữ chỗ hết hạn. Không cần người dùng mở đúng trang rồi bấm “hủy”.

**Nằm ở đâu?** `src/server/data/jobs.ts`. `dispatch()` gọi `startJobLoop()` (`src/server/controllers/router.ts:41`); cờ trên `globalThis` giúp không tạo thêm vòng lặp trong cùng process. Vòng lặp chạy ngay một lần rồi dùng `setInterval` 15 giây (`jobs.ts:382`).

| Nhóm việc | Hàm và tác dụng |
| --- | --- |
| Lượt đặt sân | `expireHolds()` (`:4`), `markNoshow()` (`:20`), `completeBookings()` (`:40`) giải phóng occupancy theo trạng thái/thời gian |
| Membership | `subscriptionStatus()` (`:60`), `expiryReminders()` (`:73`) cập nhật hết hạn và nhắc sắp hết |
| Thanh toán | `expireGatewayLinks()` (`:167`) xử lý link không còn hợp lệ |
| Lớp/hàng chờ | `waitlistExpire()` (`:176`), `expireEnrollmentHolds()` (`:206`) xử lý hết hạn, trả ghế và mời tiếp |
| Buổi học | `lockAttendance()` (`:231`), `generateSessions()` (`:248`) xử lý buổi cũ/sinh buổi mới |
| Thông báo | `notifyFlush()` (`:117`) đọc outbox chưa gửi, gọi integration, ghi lần thử và kết quả |
| Dữ liệu demo | `demoFill()` (`:275`) gọi SQL `demo_fill_calendar()`; cần feature flag `DEMO_FILL`, không phải phát sinh giao dịch khách thật |

`runDueJobs()` dùng một truy vấn `exists(...)` để xem nhóm nào có việc rồi mới chạy (`jobs.ts:305`, `:352`). Sinh sessions được canh mỗi 10 phút, bổ sung demo mỗi giờ (`:282`). Các job thay đổi dữ liệu dùng transaction ở từng hàm; riêng `notifyFlush()` gọi dịch vụ gửi bên ngoài rồi cập nhật từng bản ghi, không phải một transaction bao cả việc gửi mail (`:117`).

**Outbox là gì?** Handler ghi “cần gửi thông báo” vào DB trước; job gửi sau. `enqueue()` nằm ở `src/server/controllers/helpers.ts:181`; `outbox.dedupe_key` unique giúp không xếp cùng thông báo nhiều lần. `inbox` là view lọc thông báo in-app đã gửi, không phải bảng `notifications` riêng (`migrations/0002_arena3.sql:443`, `migrations/0019_fixlist_phase1.sql:45`).

`notifyFlush()` lấy tối đa 50 hàng, chỉ thử khi `attempts < 5` (`jobs.ts:129`). Cách này có lưu kết quả thử gửi, nhưng code không chứng minh giao nhận “đúng một lần” giữa DB và nhà cung cấp email.

**Giới hạn cần hiểu:** đây là timer trong process ứng dụng, không phải một dịch vụ cron độc lập bảo đảm chạy liên tục khi process bị dừng. Không có căn cứ từ `setInterval` để khẳng định job vẫn chạy khi không còn instance hoạt động.

<a id="11-tich-hop"></a>
## 11. Các tích hợp bên ngoài

**Integration là gì?** Là lớp nối ứng dụng với dịch vụ hoặc định dạng bên ngoài. Handler quyết định nghiệp vụ; integration đóng gói cách gọi dịch vụ.

| Tích hợp | Nằm ở đâu? | Vai trò và điều kiện |
| --- | --- | --- |
| payOS | `src/server/integrations/payos.ts:25`, `:100`, `:234` | Đọc credential phía server, tạo/đọc/hủy link, xác minh webhook; luồng nghiệp vụ ở `handlers/online.ts` |
| Gemini, dự phòng xAI | `src/server/integrations/gemini.ts:40`, `:76`, `:106` | Gọi mô hình; `generateAssistantReply()` thử Gemini rồi xAI, trả `null` khi không có kết quả; handler quyết định phản hồi tiếp |
| Google sign-in/liên kết | `src/server/controllers/handlers/google.ts:36` | Dùng `jose` kiểm tra ID token với khóa Google, issuer, audience, email đã xác minh và subject |
| Google Calendar | `src/client/arena3/gcal.ts:20` | Tạo URL biểu mẫu sự kiện đã điền sẵn; người dùng tự lưu ở Google |
| Email | `src/server/integrations/notify.ts` | Gửi OTP, receipt, nhắc hạn theo transport cấu hình; log/demo không chứng minh mail đã tới hộp thư |
| PDF | `src/server/integrations/pdf.ts` | Tạo file chứng từ; không có nghĩa đã tích hợp hóa đơn điện tử ký số |

### Gemini và phản hồi dự phòng

**Ví dụ — `src/server/integrations/gemini.ts:112`:**

```ts
    const gemini = await callGemini(system, turns, opts);
    if (gemini) return { text: gemini, source: "gemini" };
```

Nếu nhánh này không có kết quả, hàm thử xAI rồi trả `null` (`:117`). File đặt timeout 12 giây, mặc định tối đa 512 output token (`:8`). Chat/training handler còn có xử lý theo quy tắc và kiểm tra đầu ra (`src/server/controllers/handlers/ops.ts:553`, `:656`, `:854`). Câu trả lời AI không thay cho kiểm tra quyền hay xác nhận thanh toán của handler.

### Hai việc khác nhau có tên Google

Đăng nhập Google chỉ thành công với tài khoản Arena3 đã liên kết `google_sub`. `googleLogin()` tra theo subject đã xác minh, không tự ghép tài khoản vì email trùng (`src/server/controllers/handlers/google.ts:54`). Người dùng đang đăng nhập có thể liên kết/hủy liên kết qua `googleLink()`/`googleUnlink()` (`:76`, `:89`); migration `0053_google_link.sql:4` tạo cột và unique index.

Ngược lại, `googleCalendarUrl()` chỉ dựng URL `calendar/render?action=TEMPLATE...` (`src/client/arena3/gcal.ts:20`). Đó không phải đồng bộ Google Calendar API hai chiều và không cần coi việc mở link lịch là liên kết tài khoản.

<a id="12-i18n"></a>
## 12. i18n: giao diện tiếng Anh và tiếng Việt

**Là gì?** i18n là cách chuẩn bị ứng dụng để hiển thị nhiều ngôn ngữ. Dịch chữ, định dạng ngày/tiền và chọn múi giờ là những việc có liên quan nhưng không giống nhau.

**Nằm ở đâu?** `src/client/lib/i18n.tsx:21`, các từ điển `src/client/lib/i18n/vi.*.ts`, tiện ích thời gian `src/shared/arena3/time.ts`.

**Ví dụ — `src/client/lib/i18n.tsx:34`:**

```ts
export function t(en: string, vars?: Vars): string {
  return fill(current === "vi" ? (VI[en] ?? en) : en, vars);
}
```

| Hàm/thành phần | Dùng khi nào? |
| --- | --- |
| `t()` (`:34`) | Dịch chuỗi tiếng Anh khi render, thay biến như `{name}` |
| `tk()` (`:41`) | Đánh dấu chuỗi ở hằng số để công cụ kiểm tra nhận ra; chưa dịch lúc khai báo |
| `tServer()` (`:48`) | Dịch thông báo server bằng khớp chính xác rồi pattern |
| `tData()` (`:60`) | Dịch một số nội dung seed có từ điển; không phải dịch tự động mọi dữ liệu DB |
| `locale()` (`:66`) | Chọn `vi-VN` hoặc `en-GB` cho định dạng |
| `LangProvider` (`:96`) | Đọc lựa chọn lưu sau mount, remount cây con khi đổi ngôn ngữ |

Ngôn ngữ mặc định/SSR là tiếng Anh. Lựa chọn lưu dưới `arena3.lang`; đổi ngôn ngữ cập nhật cả thuộc tính `lang` của HTML (`i18n.tsx:24`, `:68`). SSR và lần render client đầu đều dùng tiếng Anh để tránh hydration lệch; sau mount mới áp dụng lựa chọn đã lưu (`:93`). Thiếu bản dịch thì trả lại tiếng Anh.

Múi giờ nghiệp vụ Việt Nam còn xuất hiện trong SQL và hàm thời gian; đổi giao diện sang tiếng Anh không tự biến lịch sân thành giờ của một nước khác.

<a id="13-test"></a>
## 13. Đọc và chạy test nghiệp vụ

**Test là gì?** Là code dựng điều kiện, gọi hàm cần kiểm tra và so sánh kết quả với điều mong đợi. Test transaction phải kiểm tra cả dữ liệu còn lại sau thành công/thất bại, không chỉ xem HTTP status.

**Nằm ở đâu?** `src/server/controllers/tx.test.ts`, script `test` ở `package.json:19`.

`tx.test.ts:114` mở một PGlite riêng, đọc các file SQL cấp đầu trong `migrations/` theo thứ tự, thực thi rồi dùng `setOverridePglite(db)` để `withTx()` trỏ vào DB test. `after()` bỏ override (`:126`). Đây là test với SQL/constraint thật trên PGlite, không phải toàn bộ DB là object mock, cũng chưa phải bằng chứng chạy đồng thời trên nhiều connection Postgres thật.

**Ví dụ — `src/server/controllers/tx.test.ts:137`:**

```ts
        await withTx(async (sql) => {
          await sql.query("insert into _tx_test (note) values ($1)", ["survived_keep_writes"]);
          throw new KeepWrites(inner);
        });
```

Test sau đó kiểm tra hàng vẫn còn. Test kế tiếp ném lỗi thường rồi kiểm tra không còn hàng `should_be_rolled_back` (`:153`). Đó là cách chứng minh khác biệt giữa rollback thông thường và `KeepWrites`.

| Nhóm nên đọc | Điểm bắt đầu trong `tx.test.ts` |
| --- | --- |
| Commit, rollback, bộ đếm đăng nhập sai | `:130` |
| Idempotency theo người dùng | `:1105` |
| Giới hạn lớp và dọn thứ tự hàng chờ | `:1247`, `:1276` |
| Đổi mật khẩu thu hồi phiên khác | `:1405` |
| Membership phải phủ hết lớp | `:3591` |
| Hold lớp, chuyển khoản/quầy, số tiền sai | `:3636`, `:3768` |
| Online thanh toán lặp/đến muộn | `:3913` |
| Nhận offer, thả ghế, job hết hạn | `:4038` |
| Hủy lớp, hoàn tiền và link bị rút | `:4267` |

Script của repo chạy nhiều nhóm test. Để tập trung file này, lệnh tương ứng trong script là:

```sh
npx tsx --test src/server/controllers/tx.test.ts
```

Đây là hướng dẫn đọc/chạy, không phải tuyên bố test đã pass trong lần viết tài liệu này. Một số tiêu đề test còn giữ tên của giai đoạn trước; khi mô tả hành vi hiện tại phải đọc cả assertion và handler. Kiểm tra giao diện bằng browser smoke cũng khác test nghiệp vụ: một nhóm kiểm dữ liệu/quyền, nhóm kia kiểm trang có render và có lỗi trình duyệt hay không.

Khi học, có thể bắt đầu bằng một slot sân: đọc `holdSlot()` → nhánh router → `bookingsHold()` → `booking_replace_hold()` → các bảng liên quan. Sau đó quay lại test để xem tình huống thất bại đã được kiểm tra như thế nào.
