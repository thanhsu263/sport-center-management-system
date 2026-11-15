# Công nghệ nền tảng của Arena3 — từ những khái niệm đầu tiên

Tài liệu dành cho sinh viên mới học web, được đối chiếu với mã nguồn Arena3 trong lần rà soát ngày 10/11/2026. Tên hiển thị hiện tại trong `src/routes/__root.tsx` là **Lê Long Sport**; nhiều tên module, khóa lưu trữ và tài liệu vẫn dùng **Arena3**.

Các đoạn code bên dưới là những trích đoạn ngắn từ repo, không phải chương trình độc lập để chép chạy ngay. Khi một đoạn chỉ trích một vài dòng trong hàm, cần mở file nguồn để xem các biến và bước xử lý xung quanh. Đường dẫn tính từ thư mục gốc dự án.

**Phạm vi đối chiếu:** `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.mjs`, `src/`, `server/`, `migrations/`, `scripts/`, `AGENTS.md` và các thẻ mã nguồn trong `graft/`. Không tìm thấy file tên chính xác `DESIGN.md` trong cây dự án đã kiểm tra, nên không gán quy tắc thiết kế cho một file không tồn tại. Các token giao diện được đọc từ `src/styles.css`. `AGENTS.md` có cả hợp đồng môi trường App Builder; mô tả môi trường Linux trong đó không có nghĩa mọi bản checkout đều đang chạy trên Linux.

## Mục lục

1. [Bản đồ dự án và luồng request](#1-ban-do)
2. [JavaScript và module](#2-javascript)
3. [TypeScript và tsconfig.json](#3-typescript)
4. [Node.js](#4-node)
5. [npm, package.json và package-lock.json](#5-npm)
6. [HTML, CSS, DOM và JSX](#6-jsx)
7. [React, component và props](#7-react)
8. [Hook, state và effect](#8-hook)
9. [Context, Provider và localStorage](#9-context)
10. [TanStack Router và file-based routing](#10-router)
11. [routeTree.gen.ts](#11-route-tree)
12. [TanStack Start, server function, SSR và hydration](#12-start)
13. [HTTP, API, JSON và fetch](#13-http)
14. [Client, server, shared và hợp đồng kiểu dữ liệu](#14-layers)
15. [Vite, plugin, build và HMR](#15-vite)
16. [Nitro, Vercel và biến môi trường](#16-deploy)
17. [Tailwind CSS, token và font](#17-tailwind)
18. [Component UI, clsx và tailwind-merge](#18-ui)
19. [Lucide, Sonner và Recharts](#19-ui-libraries)
20. [PostgreSQL, PGlite, Neon và pg](#20-db)
21. [SQL, schema, khóa và truy vấn có tham số](#21-sql)
22. [Migration và seed](#22-migration)
23. [SQL transaction và connection pool](#23-transaction)
24. [Validation và Zod](#24-validation)
25. [Session, bearer token và cookie](#25-session)
26. [Phân quyền theo vai trò](#26-role)
27. [Hash mật khẩu, token và OTP](#27-crypto)
28. [Rate limit và idempotency](#28-rate-limit)
29. [Google sign-in, OAuth và ID token](#29-google)
30. [payOS, QR và webhook](#30-payos)
31. [i18n, locale và múi giờ](#31-i18n)
32. [SSE, live update và polling](#32-live)
33. [WebRTC và P2P](#33-p2p)
34. [GSAP và ScrollTrigger](#34-gsap)
35. [Motion và reduced motion](#35-motion)
36. [Canvas, WebGL, OGL và shader](#36-webgl)
37. [PWA và web app manifest](#37-pwa)
38. [Email, SMTP và Nodemailer](#38-mail)
39. [Trợ lý AI qua Gemini và xAI](#39-ai)
40. [Xuất PDF và Excel](#40-export)
41. [Liên kết Google Calendar](#41-calendar)
42. [node --test, tsx và Playwright](#42-test)
43. [ESLint và Prettier](#43-lint)
44. [tree-sitter, graft và hướng dẫn cho agent](#44-graft)
45. [Phân biệt dependency được cài với công nghệ đang dùng](#45-dependencies)

<a id="1-ban-do"></a>
## 1. Bản đồ dự án và luồng request

**Là gì?** Một ứng dụng web có phần chạy trong trình duyệt và phần chạy trên máy chủ. Trình duyệt vẽ màn hình, nhận thao tác; máy chủ kiểm tra quyền và xử lý dữ liệu. Database là nơi lưu các bản ghi như người dùng, sân, lượt đặt và thanh toán.

**Tại sao Arena3 tổ chức như vậy?** Giao diện đặt sân và giao diện quản lý có thể dùng chung nghiệp vụ mà không đưa mật khẩu, khóa thanh toán hoặc kết nối database xuống trình duyệt.

**Nằm ở đâu?**

```text
package.json             Lệnh chạy và các thư viện
tsconfig.json            Quy tắc kiểm tra TypeScript
vite.config.ts           Cấu hình phát triển và đóng gói
src/
  router.tsx             Khởi tạo router
  routeTree.gen.ts       Cây route tự sinh
  routes/                Trang giao diện và đầu vào HTTP
  client/
    components/          Các mảnh giao diện
    lib/                 Hook, i18n, hiệu ứng, logic trang
    arena3/              Bộ gọi API và dữ liệu phiên phía trình duyệt
  server/
    controllers/         Điều phối request, xác thực, validate, handler
    services/            Quy tắc giá, gói tập, sức chứa, mật mã...
    data/                Database, công việc bảo trì dữ liệu, xuất báo cáo
    integrations/        payOS, email, PDF, AI...
    auth/                Hạ tầng Better Auth/Grok
  shared/                Kiểu dữ liệu và tiện ích dùng chung
migrations/              Các bước thay đổi schema và dữ liệu SQL
scripts/                 Công cụ chạy, migration, kiểm tra, dựng tài liệu
server/middleware/       Middleware hạ tầng, gồm PWA
graft/                   Bản đồ mã nguồn cho việc tra cứu
```

**Ví dụ từ repo — `src/server/controllers/router.ts`:**

```ts
if (method === "POST" && p0 === "bookings" && !p1) {
  return authed((sql, user) =>
    withIdempotency(sql, request, user.id, true, () => bookH.bookingsHold(sql, request, user)),
  );
}
```

Đọc đoạn này: khi có yêu cầu POST đến danh sách đặt sân, phải xác thực; bước giữ sân được bọc thêm cơ chế chống xử lý lặp.

### Luồng chữ: một lần bấm giữ sân đi tới database

```text
Người dùng chọn sân và giờ trong trình duyệt
  |
  v
src/routes/app.book.tsx: trang dùng hook useCourtBooking
  |
  v
src/client/lib/pages/app.book.ts: holdSlot()
  apiPost<HoldResponse>("/bookings", dữ liệu, true)
  |
  v
src/client/arena3/client.ts
  JSON hóa body; thêm Authorization: Bearer ... và idempotency-key
  fetch("/v1/bookings", ...)
  |
  | HTTP POST
  v
src/routes/v1.$.ts: chuyển request cho handleApi()
  |
  v
src/server/controllers/router.ts: dispatch()
  chọn nhánh POST /bookings
  |
  v
authed() -> withTx() -> authFromRequest()
  tra sessions_auth + users; kiểm tra hạn phiên/trạng thái tài khoản
  |
  v
withIdempotency() -> handlers/bookings.ts: bookingsHold()
  đọc JSON; kiểm tra dữ liệu, giờ mở cửa, quyền đặt và chỗ trống
  gọi quy tắc nghiệp vụ trong src/server/services/ khi cần
  |
  v
SQL có tham số chạy qua src/server/controllers/tx.ts
  +-- PGlite: transaction trên database nhúng
  +-- Neon/Postgres: BEGIN trên một kết nối pg trong pool
  |
  v
Đọc/ghi các bảng theo schema từ migrations/
  |
  +-- thành công -> hoàn tất transaction
  +-- lỗi thông thường -> rollback -> phản hồi lỗi
  |
  v
handleApi(): chuyển kết quả thành HTTP Response/JSON
  |
  v
apiPost() nhận dữ liệu -> setHold() -> React vẽ lại -> hiện thông báo
```

Đây là luồng ghi dữ liệu cụ thể. Các nhánh đọc dùng `authedRead()` có thể chỉ lấy `getSql()` và xác thực, không mở transaction riêng. `KeepWrites` trong `tx.ts` là ngoại lệ chủ động giữ các thay đổi rồi mới báo lỗi; không nên hiểu mọi lỗi đều rollback vô điều kiện. `/api/*` cũng đi qua `handleApi()` bằng `src/routes/api.$.ts`.

<a id="2-javascript"></a>
## 2. JavaScript và module

**Là gì?** JavaScript là ngôn ngữ viết lệnh, hàm, điều kiện và thao tác dữ liệu. Module chia chương trình thành các file có `export` để cung cấp và `import` để sử dụng. `async`/`await` giúp chờ tác vụ như đọc file hoặc gọi mạng mà không viết chuỗi callback khó đọc.

**Tại sao dùng?** Trình duyệt chạy JavaScript; các script của Arena3 cũng dùng JavaScript trên Node.js. Nhờ vậy nhóm không cần một ngôn ngữ khác chỉ để viết công cụ phát triển.

**Nằm ở đâu?** `scripts/migration-plan.mjs`, `scripts/migrate.mjs`; `package.json` có `"type": "module"`. Đuôi `.mjs` chỉ rõ file là JavaScript module.

**Ví dụ — `scripts/migration-plan.mjs`:**

```js
export function migrationName(path) {
  return path.split("/").pop() ?? path;
}
```

Hàm lấy tên file cuối đường dẫn; `??` dùng giá trị bên phải nếu kết quả bên trái là `null` hoặc `undefined`.

<a id="3-typescript"></a>
## 3. TypeScript và tsconfig.json

**Là gì?** TypeScript thêm thông tin kiểu vào JavaScript: biến là chuỗi hay số, object có trường nào, hàm trả về gì. Nó giúp phát hiện nhiều lỗi trước khi chạy. `.ts` là TypeScript; `.tsx` là TypeScript có JSX. Kiểu dữ liệu không tự kiểm tra dữ liệu lạ từ mạng khi chương trình đang chạy.

**Tại sao dùng?** Đặt sân và thanh toán có nhiều trạng thái, vai trò, số tiền. Kiểu dùng chung giúp frontend và backend thống nhất cách hiểu dữ liệu.

**Nằm ở đâu?** `tsconfig.json`, `src/shared/arena3/contracts.ts`. Cấu hình bật `strict`, dùng `jsx: "react-jsx"`, `noEmit`; alias `@/*` trỏ vào `src/*`. `allowJs` và `checkJs` còn cho phép kiểm tra JavaScript được đưa vào chương trình TypeScript.

**Ví dụ — `src/shared/arena3/contracts.ts`:**

```ts
export type Role = "manager" | "coach" | "receptionist" | "member";
```

`Role` chỉ cho phép bốn chuỗi. Cùng file có kiểu generic `Reply<T>`: `T` là tham số kiểu, giúp một cấu trúc phản hồi bọc được nhiều loại body. `npm run typecheck` chạy `tsc --noEmit`, kiểm tra mà không xuất file JavaScript.

<a id="4-node"></a>
## 4. Node.js

**Là gì?** Node.js là môi trường chạy JavaScript ngoài trình duyệt. Nó cung cấp API cho file, tiến trình, mật mã và kết nối máy chủ. Node.js không phải ngôn ngữ khác với JavaScript.

**Tại sao dùng?** Arena3 cần chạy server, đóng gói ứng dụng, áp migration và chạy test. Những việc này không thuộc màn hình trình duyệt.

**Nằm ở đâu?** `scripts/migrate.mjs`, `scripts/with-app-env.mjs`, `src/server/services/crypto.ts`. `AGENTS.md` mô tả môi trường App Builder với Node 22; đó là yêu cầu môi trường trong hướng dẫn, không phải phiên bản được khóa bằng `engines` trong `package.json` hiện tại.

**Ví dụ — `scripts/migrate.mjs`:**

```js
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
```

Tiền tố `node:` chỉ module có sẵn của Node.js, không cần cài riêng từ npm.

<a id="5-npm"></a>
## 5. npm, package.json và package-lock.json

**Là gì?** npm quản lý các gói thư viện và chạy lệnh đặt tên sẵn. `package.json` khai báo dự án cần gì và có những lệnh nào. `package-lock.json` ghi cây phiên bản đã giải quyết cụ thể, gồm cả thư viện mà một thư viện khác kéo theo.

**Tại sao dùng?** Thành viên nhóm dùng cùng bộ công cụ; các lệnh dev, build, test được thống nhất. `dependencies` khai báo thư viện ứng dụng; `devDependencies` khai báo công cụ phát triển. Có tên trong danh sách chưa đủ để kết luận tính năng đó đang được ứng dụng gọi.

**Nằm ở đâu?** `package.json`, `package-lock.json`, `scripts/with-app-env.mjs`.

**Ví dụ — trích các khóa trong `package.json` → `scripts`:**

```json
"dev": "node scripts/with-app-env.mjs vite dev --host 0.0.0.0 --port 8080",
"build": "node scripts/with-app-env.mjs vite build && npm run db:migrate",
"db:migrate": "node scripts/migrate.mjs",
```

`npm run build` trong repo này **còn có thể áp migration lên database có cấu hình**, không chỉ tạo file giao diện. Wrapper `with-app-env.mjs` tham gia chuẩn bị biến môi trường, nên đọc đúng lệnh trong repo thay vì thay bằng lệnh Vite tùy ý.

<a id="6-jsx"></a>
## 6. HTML, CSS, DOM và JSX

**Là gì?** HTML mô tả cấu trúc trang; CSS mô tả cách hiển thị. DOM là cây phần tử mà trình duyệt quản lý. JSX là cú pháp trông giống HTML bên trong JavaScript/TypeScript, được công cụ biên dịch chuyển thành lời gọi tạo giao diện. Trong JSX, `{...}` chèn biểu thức, `className` đặt lớp CSS.

**Tại sao dùng?** Nhóm viết cấu trúc giao diện gần với những gì người dùng thấy, đồng thời chèn dữ liệu và hàm dịch ngay tại vị trí cần hiển thị.

**Nằm ở đâu?** `src/routes/__root.tsx`, các file `.tsx`, `src/styles.css`.

**Ví dụ — `src/routes/__root.tsx`:**

```tsx
function SkipLink() {
  return (
    <a href="#main-content" className="skip-link">
      {t("Skip to main content")}
    </a>
  );
}
```

Thẻ `a` tạo liên kết; hàm `t()` quyết định chuỗi theo ngôn ngữ hiện tại. Đây cũng là lối tắt giúp người dùng bàn phím đi đến nội dung chính.

<a id="7-react"></a>
## 7. React, component và props

**Là gì?** React là thư viện xây giao diện từ các component: những mảnh có tên như nút, thẻ, trang hoặc cả khung ứng dụng. Component thường là hàm trả về JSX. Props là dữ liệu truyền từ component cha xuống component con; `children` là nội dung đặt giữa hai thẻ component.

**Tại sao dùng?** Nút bấm, ô nhập, khung trang và thẻ trạng thái xuất hiện ở nhiều màn hình. Dùng component giúp thay đổi nhất quán thay vì sao chép HTML khắp nơi. Repo khai báo React và React DOM dòng 19.

**Nằm ở đâu?** `src/client/components/ui/index.tsx`, `src/client/components/shell.tsx`, `src/routes/__root.tsx`.

**Ví dụ — `src/routes/__root.tsx`:**

```tsx
<LangProvider>
  <SkipLink />
  {/* Click feedback on the public pages only; it parks its rAF loop whenever there is
      nothing left to draw. */}
  <PublicClickSpark />
  <RetryOutlet />
</LangProvider>
```

Các tên viết hoa là component. `RetryOutlet` xác định nơi hiển thị nội dung route bên trong khung chung.

<a id="8-hook"></a>
## 8. Hook, state và effect

**Là gì?** Hook là các hàm React có quy tắc sử dụng, thường bắt đầu bằng `use`. `useState` giữ dữ liệu của giao diện qua các lần render; gọi hàm cập nhật state khiến React tính lại giao diện. `useEffect` đồng bộ với việc bên ngoài render như tải dữ liệu, timer hoặc sự kiện. Custom hook ghép những việc đó thành logic tái sử dụng.

**Tại sao dùng?** Trang cần nhớ ngày đang chọn, dữ liệu đã tải, lỗi và trạng thái giữ sân. Hook tách logic đó khỏi JSX dài.

**Nằm ở đâu?** `src/client/lib/use-read.ts`, `src/client/lib/pages/app.book.ts`, `src/client/lib/use-live.tsx`.

**Ví dụ — `src/client/lib/use-read.ts`:**

```ts
const [answer, setAnswer] = useState<Answer<T> | null>(null);
// The last good answer, for whichever path it was; only handed out when `keepPrevious` asks.
const [held, setHeld] = useState<T | null>(null);
const [round, setRound] = useState(0);
```

Trong cùng hook, effect gọi `apiGet()` khi `path` hoặc `round` đổi và dùng cờ `live` để bỏ kết quả không còn phù hợp sau cleanup. Không gọi hook tùy tiện trong vòng lặp hoặc nhánh điều kiện.

<a id="9-context"></a>
## 9. Context, Provider và localStorage

**Là gì?** Context/Provider cung cấp dữ liệu hoặc hành vi cho một cây component mà không phải truyền props qua mọi tầng. `localStorage` là kho chuỗi dữ liệu thuộc origin của trang trong trình duyệt, còn sau khi tải lại trang; nó khác database trên server và không tự đồng bộ sang máy khác.

**Tại sao dùng?** Root cần cung cấp hạ tầng auth và tài nguyên chung. Trình duyệt cần nhớ lựa chọn ngôn ngữ và thông tin phiên Arena3 để khôi phục giao diện.

**Nằm ở đâu?** `src/client/auth/provider.tsx`, `src/routes/__root.tsx`, `src/client/arena3/client.ts`, `src/client/lib/i18n.tsx`. Provider ngôn ngữ ở đây dùng một external store và khóa cây theo ngôn ngữ; không phải mọi component tên Provider đều dùng React Context bên trong.

**Ví dụ — `src/client/arena3/client.ts`:**

```ts
export function setSession(token: string, user: SessionUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
```

Bản user lưu tại máy giúp hiện tên sớm; server vẫn phải xác thực token. Sửa `role` trong localStorage không tạo quyền quản lý trên server.

<a id="10-router"></a>
## 10. TanStack Router và file-based routing

**Là gì?** Router nối địa chỉ URL với trang và dữ liệu tương ứng. File-based routing dùng tên file để biểu diễn đường dẫn: dấu chấm chia đoạn, `$id` là tham số, `$` cuối route là phần đường dẫn còn lại. Route lồng nhau cho phép dùng chung layout.

**Tại sao dùng?** Arena3 có nhiều khu vực member, desk, coach, manager. Router giúp điều hướng, giữ layout và đọc tham số URL có kiểu rõ ràng.

**Nằm ở đâu?** `src/router.tsx`, `src/routes/app.book.tsx`, `src/routes/desk.member.$id.tsx`, `src/routes/v1.$.ts`. `__root.tsx` là khung gốc; `manager.index.tsx` là trang chỉ mục của nhánh manager.

**Ví dụ — `src/routes/app.book.tsx`:**

```tsx
export const Route = createFileRoute("/app/book")({
  validateSearch: (s: Record<string, unknown>): { sport?: string } => ({
    sport: typeof s.sport === "string" && s.sport.trim() ? s.sport.trim() : undefined,
  }),
  component: Page,
});
```

`validateSearch` đọc tham số truy vấn như `?sport=badminton`. URL của trang và URL API là hai loại route khác nhau dù cùng nằm trong `src/routes/`.

<a id="11-route-tree"></a>
## 11. routeTree.gen.ts

**Là gì?** Đây là cây route do TanStack Router tự sinh từ các file route. Có thể hình dung nó là mục lục máy đọc được: trang nào nằm dưới layout nào, địa chỉ và tham số của trang là gì.

**Tại sao dùng?** Tránh tự đăng ký thủ công hàng chục trang và hỗ trợ kiểm tra kiểu khi điều hướng.

**Nằm ở đâu?** `src/routeTree.gen.ts`, nơi sử dụng là `src/router.tsx`. File sinh có chú thích không sửa tay vì sẽ bị ghi đè; `eslint.config.mjs` cũng bỏ qua file này.

**Ví dụ — `src/router.tsx`:**

```tsx
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createRouter({ //find rounter to make sure things alright!!
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    defaultNotFoundComponent: AppNotFoundComponent,
  });
}
```

Muốn thêm trang thì xem cách tạo file trong `src/routes/`, không chèn mục mới trực tiếp vào file `.gen.ts`.

<a id="12-start"></a>
## 12. TanStack Start, server function, SSR và hydration

**Là gì?** TanStack Start kết hợp React, router và khả năng chạy phía server. Server function là hàm được framework cho gọi qua ranh giới mạng, nhưng thân xử lý chạy trên server. SSR tạo HTML từ server; hydration là bước React phía trình duyệt gắn hành vi tương tác vào HTML đó.

**Tại sao dùng?** Trang có thể có nội dung ngay từ HTML đầu tiên và tải dữ liệu nhạy cảm qua server. Arena3 dùng cả server function lẫn route API HTTP thông thường, không phải mọi thao tác database đều là server function.

**Nằm ở đâu?** `vite.config.ts` gọi `tanstackStart()`, `src/routes/__root.tsx` chứa `getRootAssets` và loader.

**Ví dụ — đầu handler trong `src/routes/__root.tsx`:**

```tsx
export const getRootAssets = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { getSql } = await import("@/server/data/db");
    const sql = await getSql();
```

Hàm này tải tài nguyên website từ database. `LangProvider` đọc lựa chọn đã lưu sau mount để lần render đầu của client vẫn khớp tiếng Anh từ server; đây là một ví dụ tránh hydration mismatch.

<a id="13-http"></a>
## 13. HTTP, API, JSON và fetch

**Là gì?** HTTP là giao thức request/response giữa trình duyệt và máy chủ. API là giao diện chương trình cung cấp cho chương trình khác. JSON biểu diễn dữ liệu bằng object, mảng, chuỗi, số… `fetch()` gửi request; GET thường đọc, POST tạo hoặc thực hiện hành động, PATCH sửa một phần, DELETE xóa/hủy tùy nghiệp vụ.

**Tại sao dùng?** Các màn hình cần tải lịch, giữ sân, thanh toán và báo lỗi theo một định dạng chung. Mã HTTP như 401, 403 hoặc 400 cho biết loại kết quả, còn JSON cung cấp nội dung cụ thể.

**Nằm ở đâu?** `src/client/arena3/client.ts`, `src/routes/v1.$.ts`, `src/routes/api.$.ts`, `src/server/controllers/router.ts`.

**Ví dụ — `src/client/arena3/client.ts`:**

```ts
const headers = new Headers(init.headers);
if (!headers.has("content-type") && init.body && !(init.body instanceof FormData)) {
  headers.set("content-type", "application/json");
}
const token = getToken();
if (token) headers.set("authorization", `Bearer ${token}`);
```

Hàm `send()` trong cùng file gọi `fetch(`/v1${path}`, init)`. Client tự phân biệt JSON với PDF và xử lý phiên hết hạn; trang không cần lặp toàn bộ mã này.

<a id="14-layers"></a>
## 14. Client, server, shared và hợp đồng kiểu dữ liệu

**Là gì?** Đây là cách phân trách nhiệm. Client phục vụ trải nghiệm người dùng; server quyết định nghiệp vụ và quyền truy cập; shared chứa phần hai bên cùng hiểu. Controller điều phối đầu vào/đầu ra; service chứa quy tắc như tính giá, kiểm tra gói hoặc sức chứa.

**Tại sao dùng?** Giữ thống nhất cấu trúc dữ liệu và tránh vô tình kéo code database hay secret vào bundle trình duyệt. Kiểu API phải mô tả dữ liệu sau khi chuyển JSON, không chỉ đối tượng mà driver database trả về.

**Nằm ở đâu?** `src/shared/arena3/contracts.ts`, `src/server/controllers/handlers/bookings.ts`, `src/server/services/pricing.ts`, `src/client/lib/pages/app.book.ts`.

**Ví dụ — `src/shared/arena3/contracts.ts`:**

```ts
/** ISO 8601 text of a `timestamptz`. */
export type Iso = string;
/** A Postgres `numeric`, which arrives as text. */
export type Numeric = string;
```

Một thời điểm qua JSON là chuỗi, không còn là instance `Date`. Trường số tiền/thuế kiểu `numeric` cũng có thể cần `Number(...)` tại nơi sử dụng. TypeScript giúp ghi rõ điều đó, nhưng vẫn cần validate đầu vào.

<a id="15-vite"></a>
## 15. Vite, plugin, build và HMR

**Là gì?** Vite là công cụ phục vụ ứng dụng lúc phát triển và đóng gói khi build. Plugin thêm bước xử lý như JSX, Tailwind hoặc route. HMR (Hot Module Replacement) cập nhật module vừa đổi khi đang phát triển, thường không phải tải lại toàn bộ trang.

**Tại sao dùng?** Nhóm thấy thay đổi giao diện nhanh; quy trình build gom và xử lý code, CSS, font cho môi trường triển khai. HMR cũng khiến module server có thể được nạp lại, nên database có cơ chế dùng lại instance qua `globalThis`.

**Nằm ở đâu?** `vite.config.ts`, `src/server/data/db.ts`, `scripts/with-app-env.mjs`.

**Ví dụ — các plugin trong `vite.config.ts`:**

```ts
grokPwaPlugin(),
tailwindcss(),
tanstackStart(),
```

Cùng cấu hình còn có `viteReact()`, bootstrap PGlite và middleware popup auth. `resolve: { tsconfigPaths: true }` giúp Vite hiểu alias `@/` đã khai báo trong TypeScript.

<a id="16-deploy"></a>
## 16. Nitro, Vercel và biến môi trường

**Là gì?** Nitro đóng gói phần server theo môi trường đích; Vercel là nền tảng triển khai được cấu hình trong repo. Biến môi trường là cấu hình truyền vào tiến trình, ví dụ địa chỉ database hoặc khóa dịch vụ. Nó không phải dữ liệu phải viết cứng vào source.

**Tại sao dùng?** Cùng code cần chạy ở phát triển và triển khai nhưng với thông tin kết nối khác nhau. Secret payOS/email phải nằm phía server. Theo hợp đồng Vite của dự án, biến có tiền tố `VITE_` có thể được đưa vào code client, nên không đặt secret dưới tiền tố này.

**Nằm ở đâu?** `vite.config.ts`, `src/server/env.server.ts`, `scripts/with-app-env.mjs`, `scripts/app-env-plugin.mjs`, `src/server/integrations/payos.ts`.

**Ví dụ — trong cấu hình Nitro ở `vite.config.ts`:**

```ts
preset: "vercel",
// Auto-registers server/middleware/* (the PWA install page +
// manifest + head-tag middleware). Nitro v3 defaults serverDir to
// false, so removing this silently unwires /?install=1 on deploys.
serverDir: "./server",
```

Nitro chỉ được thêm trong nhánh build hoặc preview của cấu hình. Không suy ra một bản deploy đang hoạt động chỉ từ việc repo có preset Vercel.

<a id="17-tailwind"></a>
## 17. Tailwind CSS, token và font

**Là gì?** Tailwind cung cấp lớp CSS nhỏ để ghép trong JSX. Token là biến được đặt tên theo vai trò, như màu nền, màu chữ, bo góc. Đổi token có thể đổi nhiều component đồng thời. Font là bộ hình dạng chữ; font variable có thể chứa trục điều chỉnh như độ rộng.

**Tại sao dùng?** Arena3 cần giao diện nhất quán giữa trang giới thiệu và màn hình quản lý, có chữ tiếng Việt và nhiều trạng thái sân. Token tránh lặp mã màu rải rác.

**Nằm ở đâu?** `src/styles.css`, plugin `@tailwindcss/vite` trong `vite.config.ts`. CSS nhập Be Vietnam Pro, Archivo Variable và `tw-animate-css`; font được phục vụ cùng app qua các gói Fontsource.

**Ví dụ — `src/styles.css`:**

```css
@import "tailwindcss";
@import "tw-animate-css";
```

```css
--color-bg: #1b2220;
--color-fg: #f5f8f2;
--color-surface: #252d2a;
```

Các biến màu nằm trong `@theme`; root sử dụng lớp `bg-bg text-fg`. Trong CSS hiện tại có chú thích Court Night là bảng màu duy nhất; có file theme không đồng nghĩa mọi chế độ sáng/tối đều đang được bật cho sản phẩm.

<a id="18-ui"></a>
## 18. Component UI, clsx và tailwind-merge

**Là gì?** Bộ component UI gom nút, input, modal, phân trang… thành những phần dùng lại. `clsx` ghép tên lớp có điều kiện; `tailwind-merge` giải quyết nhiều xung đột utility Tailwind khi ghép lớp.

**Tại sao dùng?** Một nút ở quầy và một nút ở trang hội viên cần có trạng thái disabled, kích thước và tương tác nhất quán. Hàm ghép lớp giúp tùy biến mà giảm lỗi class chồng chéo.

**Nằm ở đâu?** `src/client/components/ui/index.tsx`, `src/client/lib/cn.ts`. Bộ UI hiện có nhiều component tự viết, gồm `Button`, `MoneyInput`, `DateField`, `Modal`, `Pagination`.

**Ví dụ — `src/client/lib/cn.ts`:**

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Không nên gọi toàn bộ UI là Radix hoặc shadcn chỉ vì `package.json` chứa nhiều gói Radix; phải xem import và cách component được cài đặt.

<a id="19-ui-libraries"></a>
## 19. Lucide, Sonner và Recharts

**Là gì?** Lucide React cung cấp icon dạng component SVG. Sonner hiển thị toast, tức thông báo ngắn sau thao tác. Recharts dựng biểu đồ từ dữ liệu bằng component React.

**Tại sao dùng?** Arena3 cần icon dễ nhận biết, phản hồi khi giữ sân/thanh toán và biểu đồ báo cáo cho quản lý. Các công cụ này giảm việc tự vẽ lại những thành phần phổ biến.

**Nằm ở đâu?** Icon và toast ở `src/routes/app.book.tsx`, vùng toast gốc tại `src/routes/__root.tsx`; biểu đồ ở `src/routes/manager.index.tsx`, `src/client/components/report-panels.tsx`.

**Ví dụ — các import trong `src/routes/manager.index.tsx`:**

```tsx
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
```

**Ví dụ — các import trong `src/routes/app.book.tsx`:**

```tsx
import { Landmark, Sparkles } from "lucide-react";
```

```tsx
import { toast } from "sonner";
```

Đây là ba thư viện độc lập: icon không quyết định nghiệp vụ, toast không lưu dữ liệu, biểu đồ chỉ trình bày số liệu mà ứng dụng cung cấp.

<a id="20-db"></a>
## 20. PostgreSQL, PGlite, Neon và pg

**Là gì?** PostgreSQL là hệ quản trị database quan hệ, tổ chức dữ liệu thành bảng và dùng SQL để truy vấn. PGlite đưa Postgres vào dạng nhúng chạy bằng WebAssembly. Neon cung cấp dịch vụ Postgres; `pg` (node-postgres) là driver để code Node kết nối Postgres qua mạng.

**Tại sao dùng?** Quan hệ giữa hội viên, sân, lớp, hóa đơn phù hợp với bảng, khóa và transaction. PGlite giúp phát triển mà không phải có server Postgres riêng; nhánh Postgres dùng chung giao diện SQL.

**Nằm ở đâu?** `src/server/data/db.ts`, `src/server/controllers/tx.ts`, `migrations/`.

**Ví dụ — điều kiện thực sự trong `src/server/data/db.ts`:**

```ts
const isDeploy = typeof process !== "undefined" && (Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production");
export const dbSource: DbSource = databaseUrl && isDeploy ? "neon" : "pglite";
```

Điểm cần đọc kỹ: ở lớp database nghiệp vụ này, **có `DATABASE_URL` và đang deploy/production** mới chọn nhánh `neon`; chỉ có URL trong dev vẫn chọn PGlite. Tên nhánh `neon` không chứng minh URL bắt buộc thuộc Neon: code thực hiện kết nối bằng `pg.Pool`.

PGlite ở đây chạy **phía server**, mặc định lưu tại `.pglite`; `PGLITE_DATA_DIR=memory` đổi sang bộ nhớ tạm. Nó không phải database tự động nằm trong trình duyệt. Chú thích cũ nói “in-memory” không chính xác bằng logic chọn `dataDir` hiện tại.

<a id="21-sql"></a>
## 21. SQL, schema, khóa và truy vấn có tham số

**Là gì?** SQL là ngôn ngữ đọc/ghi dữ liệu. Schema mô tả các bảng, cột và ràng buộc. Primary key định danh bản ghi; foreign key ràng buộc liên hệ với bảng khác; UNIQUE ngăn trùng; CHECK giới hạn giá trị. Truy vấn có tham số tách dữ liệu người dùng khỏi câu lệnh SQL.

**Tại sao dùng?** Hệ thống cần ngăn số điện thoại trùng, giữ quan hệ đúng và tránh ghép chuỗi đầu vào trực tiếp vào SQL. Kiểm tra ở database bổ sung cho kiểm tra trong TypeScript.

**Nằm ở đâu?** `migrations/0002_arena3.sql`, các migration tiếp theo, `src/server/controllers/session.ts`, `src/server/controllers/handlers/bookings.ts`.

**Ví dụ — `migrations/0002_arena3.sql`:**

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_code VARCHAR(16) UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  name_normalized VARCHAR(120) NOT NULL,
  phone VARCHAR(16) NOT NULL UNIQUE,
```

**Ví dụ truy vấn có tham số — `src/server/controllers/session.ts`:**

```ts
await sql.query(
  `insert into sessions_auth (user_id, token_hash, expires_at) values ($1,$2,$3)`,
  [user.id, sha256(token), expires.toISOString()],
);
```

`$1`, `$2`, `$3` nhận giá trị từ mảng theo thứ tự; chúng không phải nối chuỗi SQL. Ngoài bảng, schema Arena3 còn dùng enum và trigger để biểu diễn trạng thái và kiểm tra nghiệp vụ ở database.

<a id="22-migration"></a>
## 22. Migration và seed

**Là gì?** Migration là một bước thay đổi cấu trúc hoặc dữ liệu database được lưu bằng file có thứ tự. Seed là dữ liệu ban đầu hoặc dữ liệu demo. Migration khác với bản sao lưu: nó mô tả thay đổi cần áp dụng, không chứa toàn bộ trạng thái database hiện tại.

**Tại sao dùng?** Các máy và môi trường cần cùng schema. Bảng `_migrations` ghi file đã chạy để không áp lại vô tình. Repo dùng cả migration tạo cấu trúc và migration thêm/sửa dữ liệu mẫu.

**Nằm ở đâu?** `migrations/0002_arena3.sql`, `migrations/0003_seed.sql`, `migrations/0053_google_link.sql`, `scripts/migration-plan.mjs`, `scripts/migrate.mjs`, `src/server/data/db.ts`.

**Ví dụ — `scripts/migration-plan.mjs`:**

```js
const done = new Set(applied);
return [...paths]
  .filter(isMigrationFile)
  .map((path) => ({ name: migrationName(path), path }))
  .sort((a, b) => a.name.localeCompare(b.name))
  .filter(({ name }) => !done.has(name));
```

Thứ tự thực tế dựa vào tên đầy đủ; có tiền tố số trùng như `0014_*` và `0015_*`, nên không nên coi riêng số đầu là khóa duy nhất. Hai bộ áp dụng migration chỉ đọc trực tiếp `migrations/*.sql`, không tự đi vào `migrations/auth/`.

<a id="23-transaction"></a>
## 23. SQL transaction và connection pool

**Là gì?** Transaction gom nhiều câu lệnh thành một đơn vị: thành công thì COMMIT, lỗi thông thường thì ROLLBACK. Connection pool giữ nhóm kết nối dùng lại để tránh mở kết nối mới cho từng truy vấn. Các câu lệnh thuộc cùng transaction phải chạy trên cùng kết nối.

**Tại sao dùng?** Giữ sân hoặc thanh toán có thể cập nhật nhiều bảng. Không thể để ghi nhận thanh toán thành công nhưng mất bước liên quan vì một câu lệnh sau bị lỗi.

**Nằm ở đâu?** `src/server/controllers/tx.ts`, `src/server/data/db.ts`, `scripts/migrate.mjs`.

**Ví dụ — các dòng liên tiếp trong nhánh Postgres của `src/server/controllers/tx.ts`:**

```ts
await client.query("BEGIN");
const run: Run = async <R>(text: string, params: unknown[]) => {
  const result = await client.query(text, params ?? []);
  return result.rows as R[];
};
const out = await fn(wrap(run));
await client.query("COMMIT");
```

Nhánh PGlite dùng `pg.transaction(...)`. `withTx()` còn có `KeepWrites` để một số lỗi nghiệp vụ giữ lại thay đổi có chủ ý; đọc nhánh xử lý đó trước khi giả định tất cả exception đều rollback.

<a id="24-validation"></a>
## 24. Validation và Zod

**Là gì?** Validation kiểm tra giá trị khi chương trình chạy: có phải số nguyên, có nằm trong khoảng, có đủ trường không. Zod là thư viện khai báo schema dữ liệu và kiểm tra theo schema đó. Kiểu TypeScript đã bị xóa khi chạy nên không thay thế bước này.

**Tại sao dùng?** Người dùng hoặc một client tự viết có thể gửi dữ liệu sai. Arena3 dùng bộ parse/validate tự viết cho nhiều đầu vào nghiệp vụ, còn Zod có chỗ dùng cụ thể trong cầu nối preview.

**Nằm ở đâu?** `src/server/controllers/validate.ts`, `src/server/controllers/helpers.ts`; Zod ở `src/client/lib/preview-host-bridge.ts`.

**Ví dụ Zod — `src/client/lib/preview-host-bridge.ts`:**

```ts
const EnvelopeSchema = z.object({
  channel: z.literal(PREVIEW_BRIDGE_CHANNEL),
  version: z.number().int().positive(),
  type: z.string().min(1),
});
```

**Ví dụ validate nghiệp vụ — `src/server/controllers/validate.ts`:**

```ts
if (!Number.isFinite(n) || !Number.isInteger(n)) {
  throw err.field(field, `${label} must be a whole number.`);
}
```

Không mô tả toàn bộ API Arena3 là “validate bằng Zod”: dữ liệu nhắn giữa iframe và host preview khác dữ liệu đặt sân hay chỉnh giá.

<a id="25-session"></a>
## 25. Session, bearer token và cookie

**Là gì?** Session ghi nhớ rằng một lần đăng nhập đã được xác thực. Token là chuỗi chứng minh người gửi đang giữ phiên. Bearer token được client gửi trong header `Authorization`. Cookie là dữ liệu gắn với website mà trình duyệt có thể tự gửi theo request phù hợp; cookie không đồng nghĩa với localStorage.

**Tại sao dùng?** Mỗi lần đặt sân không thể nhập lại mật khẩu. Server vẫn cần tra phiên để kiểm tra hết hạn, thu hồi và trạng thái người dùng.

**Nằm ở đâu?** Phiên nghiệp vụ: `src/server/controllers/session.ts`, `src/client/arena3/client.ts`, bảng `sessions_auth`. Hạ tầng riêng: `src/server/auth/server.ts`, `src/client/auth/`, `src/server/auth/pglite-dialect.ts`, schema mẫu `migrations/auth/0001_auth.sql`.

**Ví dụ phiên Arena3 — `src/server/controllers/session.ts`:**

```ts
const token = randomToken();
const hours = user.role === "member" ? 24 * 7 : 12;
const expires = new Date(Date.now() + hours * 3600 * 1000);
```

Token gốc được trả cho client; database lưu `sha256(token)`. `authFromRequest()` đọc bearer token và tra `sessions_auth` nối `users`, kiểm tra `expires_at`, `revoked_at`, trạng thái tài khoản.

**Ví dụ cookie ở lớp Better Auth — `src/server/auth/server.ts`:**

```ts
export function readSessionToken(): string | null {
  return getCookie(SESSION_TOKEN_COOKIE) ?? null;
}
```

Repo giữ hạ tầng Better Auth/Grok cho môi trường nền tảng, có plugin bearer, cookie và adapter PGlite dựa trên Kysely. **Không gộp nó với phiên nghiệp vụ Arena3**: luồng `/v1/*` được minh họa dùng `sessions_auth` và token lưu tại `arena3.token`. Hạ tầng có sẵn, cờ bật/tắt và route thực sự được nối phải được xem riêng; không thể suy từ dependency `better-auth` rằng mọi đăng nhập Arena3 đều do Better Auth xử lý.

<a id="26-role"></a>
## 26. Phân quyền theo vai trò

**Là gì?** Xác thực trả lời “bạn là ai”; phân quyền trả lời “bạn được làm gì”. Role-based access control phân quyền theo vai trò như hội viên hoặc quản lý.

**Tại sao dùng?** Hội viên không được sửa giá hoặc duyệt hoàn tiền chỉ vì biết URL. Ẩn menu trên giao diện chỉ hỗ trợ trải nghiệm; quyền phải được kiểm tra phía server.

**Nằm ở đâu?** `src/shared/arena3/contracts.ts`, `src/server/controllers/session.ts`, các handler trong `src/server/controllers/handlers/`; `homeFor()` trong `src/client/arena3/client.ts` chọn trang đầu theo vai trò.

**Ví dụ — `src/server/controllers/session.ts`:**

```ts
export function requireRole(user: PublicUser, roles: Role[]) {
  if (!roles.includes(user.role)) throw err.forbidden();
}
```

Role phải đến từ user đã xác thực, không phải một trường tùy ý trong JSON người gọi gửi lên.

<a id="27-crypto"></a>
## 27. Hash mật khẩu, token và OTP

**Là gì?** Hash biến dữ liệu thành giá trị đối chiếu; hash mật khẩu phải dùng thuật toán phù hợp như scrypt, không lưu mật khẩu rõ. Salt ngẫu nhiên giúp hai mật khẩu giống nhau có bản lưu khác nhau. OTP là mã dùng một lần; HMAC là phép hash có khóa bí mật.

**Tại sao dùng?** Arena3 cần kiểm tra mật khẩu, phát token khó đoán và bảo vệ mã xác thực. Các việc này dùng module mật mã Node, không dùng `Math.random()` để tạo bí mật.

**Nằm ở đâu?** `src/server/services/crypto.ts`, `src/server/controllers/session.ts`, `src/server/controllers/handlers/auth.ts`.

**Ví dụ — `src/server/services/crypto.ts`:**

```ts
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
```

Cùng file dùng `scryptSync`, `timingSafeEqual`, SHA-256 cho token và HMAC cho OTP. Hash không phải mã hóa để giải ngược lấy mật khẩu. File cũng có xử lý cấu hình `OTP_SECRET`; khi đánh giá độ an toàn phải đọc cấu hình thực tế, không chỉ tên thuật toán.

<a id="28-rate-limit"></a>
## 28. Rate limit và idempotency

**Là gì?** Rate limit giới hạn số lần gọi trong một khoảng thời gian. Idempotency giúp cùng một yêu cầu có khóa định danh không tạo hiệu ứng nghiệp vụ lặp khi gửi lại. Hai cơ chế giải quyết hai vấn đề khác nhau: quá nhiều request và xử lý trùng một request.

**Tại sao dùng?** Bấm liên tục có thể tạo nhiều yêu cầu mua gói hoặc gọi AI tốn chi phí. Mất mạng rồi gửi lại thanh toán không được tự động ghi hai lần.

**Nằm ở đâu?** `src/server/controllers/ratelimit.ts`, `src/server/controllers/helpers.ts` → `withIdempotency`, `src/client/arena3/client.ts`, `migrations/0030_idempotency_member_code.sql`.

**Ví dụ rate limit — `src/server/controllers/ratelimit.ts`:**

```ts
planRequest: { limit: 3, windowMs: 60_000 },
```

**Ví dụ gửi khóa — `src/client/arena3/client.ts`:**

```ts
if (init.idempotent) headers.set("idempotency-key", newIdem());
```

Bộ rate limit hiện giữ bucket trong `Map` của từng tiến trình, không phải giới hạn phân tán dùng chung cho mọi instance. Khóa mới chỉ định danh một lần gọi; hai lần bấm tạo hai khóa mới không tự trở thành “cùng một yêu cầu”. Cần đọc thêm các ràng buộc nghiệp vụ ở server.

<a id="29-google"></a>
## 29. Google sign-in, OAuth và ID token

**Là gì?** OAuth là cơ chế ủy quyền truy cập; xác nhận danh tính thường dùng lớp OpenID Connect và ID token. ID token của Google là dữ liệu có chữ ký, chứa định danh tài khoản và đối tượng ứng dụng nhận token. Không được tin token chỉ vì đọc được JSON bên trong.

**Tại sao dùng?** Người dùng có thể liên kết Google rồi đăng nhập tiện hơn. Arena3 xác minh chữ ký bằng khóa công khai Google, kiểm tra issuer/audience và email đã xác minh.

**Nằm ở đâu?** `src/client/components/google-sign-in.tsx`, `src/server/controllers/handlers/google.ts`, `migrations/0053_google_link.sql`. Luồng OAuth qua broker nền tảng còn tồn tại riêng trong `src/server/auth/server.ts`.

**Ví dụ — `src/server/controllers/handlers/google.ts`:**

```ts
const { payload } = await jwtVerify(credential, googleKeys, {
  issuer: ["https://accounts.google.com", "accounts.google.com"],
  audience: clientId,
});
```

Luồng nghiệp vụ này dùng Google Identity Services gửi ID token đến server; nó không đổi authorization code lấy access token và không cần client secret trong handler này. Chỉ tài khoản đã liên kết theo `google_sub` mới được đăng nhập; trùng email không tự tạo liên kết hay tài khoản mới. Có code không có nghĩa Google sign-in đã được cấu hình: handler còn kiểm tra `GOOGLE_CLIENT_ID`.

<a id="30-payos"></a>
## 30. payOS, QR và webhook

**Là gì?** payOS là cổng tích hợp tạo liên kết thanh toán và nhận thông tin trạng thái. QR mã hóa nội dung để máy khác quét. Webhook là request dịch vụ bên ngoài gửi về ứng dụng khi có sự kiện; ứng dụng phải kiểm tra tính xác thực của nó.

**Tại sao dùng?** Hội viên có thể mở trang thanh toán/quét mã, còn Arena3 đối chiếu giao dịch và cập nhật nghiệp vụ. Không thể coi việc trình duyệt quay về trang return là bằng chứng tiền đã vào.

**Nằm ở đâu?** `src/server/integrations/payos.ts`, `src/server/controllers/handlers/online.ts`, `src/client/components/pay-online.tsx`, `src/routes/pay.return.tsx`. Các phần chuyển khoản/QR còn có `src/shared/vietqr.ts`, `src/client/components/transfer-qr-modal.tsx`, `src/server/integrations/bank.ts`.

**Ví dụ — đầu hàm xác minh webhook trong `src/server/integrations/payos.ts`:**

```ts
export async function verifyWebhook(body: unknown): Promise<VerifiedWebhook> {
  const data = await payos().webhooks.verify(body as never);
```

SDK `@payos/node` được bọc lại để phần còn lại không gọi cổng trực tiếp. `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` được đọc phía server. payOS là tích hợp có điều kiện: thiếu cấu hình không có nghĩa mọi kênh thu tại quầy đều ngừng hoạt động. QR chuyển khoản và trạng thái đã thanh toán là hai chuyện khác nhau.

Gói `qrcode` chuyển payload thành hình QR. Ví dụ trong `src/client/components/transfer-qr-modal.tsx`:

```ts
void QRCode.toDataURL(payload, QR_STYLE).then((url) => live && setSrc(url));
```

<a id="31-i18n"></a>
## 31. i18n, locale và múi giờ

**Là gì?** i18n viết tắt của internationalization, chuẩn bị ứng dụng cho nhiều ngôn ngữ. Locale quyết định cách trình bày ngày/số, ví dụ `vi-VN`. Múi giờ quyết định một thời điểm tương ứng giờ địa phương nào; đổi ngôn ngữ không đồng nghĩa đổi múi giờ.

**Tại sao dùng?** Arena3 có tiếng Anh và tiếng Việt, cần hiển thị đúng tiền VND và giờ hoạt động tại Việt Nam dù máy chủ hoặc trình duyệt ở nơi khác.

**Nằm ở đâu?** `src/client/lib/i18n.tsx`, `src/client/lib/i18n/vi.*.ts`, `src/shared/arena3/translator.ts`, `src/shared/arena3/time.ts`, `scripts/i18n-check.mjs`.

**Ví dụ — `src/client/lib/i18n.tsx`:**

```ts
export function t(en: string, vars?: Vars): string {
  return fill(current === "vi" ? (VI[en] ?? en) : en, vars);
}
```

**Ví dụ giờ Việt Nam — `src/shared/arena3/time.ts`:**

```ts
export function ictDateTime(date: string, hm: string): Date {
  const time = hm.length === 5 ? `${hm}:00` : hm;
  return new Date(`${date}T${time}+07:00`);
}
```

Đây là hệ dịch tự viết dựa trên từ điển, không có bằng chứng phải dùng i18next. Chỗ hiển thị còn dùng `Intl` và locale; không nên tự thay tất cả bằng múi giờ máy đang chạy.

<a id="32-live"></a>
## 32. SSE, live update và polling

**Là gì?** SSE (Server-Sent Events) giữ một kết nối HTTP để server gửi sự kiện một chiều đến trình duyệt. Client dùng `EventSource`; server trả `text/event-stream`. Polling là hỏi lại theo chu kỳ. SSE không phải WebSocket hai chiều.

**Tại sao dùng?** Lịch sân, lớp, thanh toán và thông báo cần được làm mới khi có thay đổi. Nhiều màn hình dùng chung một hub để tránh mở kết nối riêng cho từng component.

**Nằm ở đâu?** `src/client/lib/use-live.tsx`, `src/server/controllers/handlers/live.ts`, nhánh `/api/live` qua router chung.

**Ví dụ — `src/client/lib/use-live.tsx`:**

```ts
const es = new EventSource(`/api/live?${params.toString()}`);
this.eventSource = es;
```

Server hiện kiểm tra phiên bản topic mỗi 2 giây, gửi heartbeat và đóng stream sau khoảng 25 giây. Client có polling dự phòng mỗi 4 giây khi không dùng được SSE. Đây không phải database tự đẩy từng bản ghi qua logical replication. Native `EventSource` không nhận header tùy ý như `fetch`, nên repo hỗ trợ token trong query riêng cho route live; không suy rộng cách đó sang mọi API.

<a id="33-p2p"></a>
## 33. WebRTC và P2P

**Là gì?** WebRTC là API trình duyệt để thiết lập kết nối giữa các peer; DataChannel truyền dữ liệu. P2P nghĩa là các đầu cuối trao đổi trực tiếp khi mạng cho phép. Signaling trao đổi thông tin bắt tay như offer, answer, ICE candidate qua một kênh hỗ trợ.

**Tại sao có trong repo?** Arena3 có module hạ tầng room/multiplayer tái sử dụng, xử lý kết nối, gửi dữ liệu và phục hồi. Sự tồn tại module không chứng minh mọi tính năng chat hiện tại đều chạy P2P; chat nghiệp vụ còn có handler server và SSE riêng.

**Nằm ở đâu?** `src/client/lib/multiplayer/p2p.ts`, `src/client/lib/multiplayer/index.ts`, `src/client/lib/multiplayer/p2p.test.ts`; rate limit signaling trong `src/server/controllers/ratelimit.ts`.

**Ví dụ — `src/client/lib/multiplayer/p2p.ts`:**

```ts
const pc = new RTCPeerConnection({
  iceServers: this.opts.iceServers ?? defaultIceServers(),
});
```

Kết nối trực tiếp phụ thuộc NAT/firewall và cấu hình ICE; không nên mô tả nó là bảo đảm mọi cặp máy luôn nối trực tiếp được.

<a id="34-gsap"></a>
## 34. GSAP và ScrollTrigger

**Là gì?** GSAP là thư viện điều khiển animation bằng JavaScript. ScrollTrigger gắn tiến độ animation với cuộn trang; CustomEase định nghĩa đường cong chuyển động. `useGSAP` giúp gắn vòng đời animation với React.

**Tại sao dùng?** Trang giới thiệu có các cảnh cuộn và chuyển động phối hợp nhiều phần; các khoảnh khắc như giữ sân hết hạn hoặc thanh toán cũng có animation được biên đạo.

**Nằm ở đâu?** `src/client/lib/gsap.ts`, `src/client/components/landing/`, `src/client/components/moments/`.

**Ví dụ — `src/client/lib/gsap.ts`:**

```ts
registerGsap(useGSAP, ScrollTrigger, CustomEase);
```

Wrapper `useScene()` dùng `gsap.matchMedia`, nhận tùy chọn giảm chuyển động từ `useCalm()` và gọi `mm.revert()` khi dọn dẹp. Animation không nên để lại listener hoặc hiệu ứng cũ sau khi đổi trang.

<a id="35-motion"></a>
## 35. Motion và reduced motion

**Là gì?** Gói `motion`, nhập qua `motion/react`, cho phép khai báo chuyển động cùng component React: xuất hiện, biến mất, hover, thay đổi layout. Reduced motion là lựa chọn giảm chuyển động của người dùng/thiết bị để giao diện dễ chịu hơn.

**Tại sao dùng?** Các chuyển cảnh ngắn trong app cần tích hợp với state React; không phải hiệu ứng nào cũng cần timeline GSAP. Repo dùng hai công cụ với nhiệm vụ khác nhau.

**Nằm ở đâu?** `src/client/components/motion.tsx`, `src/routes/app.book.tsx`, `src/client/lib/calm.ts`.

**Ví dụ — `src/client/components/motion.tsx`:**

```tsx
<MotionConfig reducedMotion={calm ? "always" : "user"} transition={{ duration: 0.5, ease: EASE_SMOOTH }}>
  {children}
</MotionConfig>
```

`AnimatePresence` giúp xử lý phần tử rời cây React; các wrapper như `Reveal`, `Stagger`, `Lift` chuẩn hóa hiệu ứng. Dù gói thường được liên hệ với tên Framer Motion, import thực tế ở repo là `motion/react`.

<a id="36-webgl"></a>
## 36. Canvas, WebGL, OGL và shader

**Là gì?** Canvas là vùng vẽ bằng code. WebGL sử dụng GPU để vẽ trong trình duyệt. Shader là chương trình nhỏ tính vị trí/màu điểm ảnh trên GPU. OGL cung cấp lớp tiện ích như renderer, mesh, program để làm việc với WebGL ít mã lặp hơn.

**Tại sao dùng?** Arena3 có nền sáng, sợi, bề mặt sân và cảnh cầu lông phục vụ trang giới thiệu. Các hiệu ứng đồ họa khác với component HTML thông thường và không phải nghiệp vụ đặt sân.

**Nằm ở đâu?** `src/client/components/gl.tsx`, `src/client/components/landing/shuttle3d-gl.ts`, `src/client/components/landing/shuttle3d-scene.ts`, `src/client/components/fx.tsx`.

**Ví dụ — `src/client/components/gl.tsx`:**

```ts
const canvas = document.createElement("canvas");
const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
if (!context) return; // Keep the media fallback when GPU rendering is unavailable.
```

Trong cùng hook, `Program`, `Mesh`, `Triangle` tạo chương trình vẽ; uniform như `uTime` và `uResolution` cung cấp thời gian/kích thước. Repo có fallback và giới hạn độ phân giải; không nên suy từ chữ “3D” rằng dự án dùng Three.js.

<a id="37-pwa"></a>
## 37. PWA và web app manifest

**Là gì?** PWA là nhóm khả năng giúp website có trải nghiệm gần ứng dụng, chẳng hạn thêm biểu tượng ra màn hình chính và mở trong cửa sổ riêng. Manifest là JSON mô tả tên, icon, URL bắt đầu và chế độ hiển thị. Offline thường cần thêm chiến lược cache/service worker; manifest một mình không bảo đảm dùng được ngoại tuyến.

**Tại sao dùng?** Người dùng có thể mở Arena3 từ màn hình điện thoại, có màu giao diện và hướng dẫn cài đặt phù hợp.

**Nằm ở đâu?** `scripts/grok-pwa-plugin.mjs`, `scripts/grok-pwa-shared.mjs`, `scripts/install-page.html`, `server/middleware/grok-pwa.ts`, `public/__grok/`, `src/routes/__root.tsx`.

**Ví dụ — một phần object manifest trong `scripts/grok-pwa-shared.mjs`:**

```js
start_url: "/",
scope: "/",
display: "standalone",
```

Root liên kết `/__grok/manifest.webmanifest`; plugin và middleware xử lý tài nguyên cài đặt. Phần PWA được xác nhận ở đây là manifest, icon, head và hướng dẫn cài; không khẳng định thao tác đặt sân/thanh toán chạy được khi mất mạng.

<a id="38-mail"></a>
## 38. Email, SMTP và Nodemailer

**Là gì?** SMTP là giao thức gửi email giữa ứng dụng và máy chủ thư. Nodemailer là thư viện Node hỗ trợ tạo kết nối và gửi thư. Template ghép dữ liệu như mã OTP thành tiêu đề/nội dung dễ đọc.

**Tại sao dùng?** Arena3 có email OTP, biên nhận và nhắc gói sắp hết hạn. Gửi thư được tách thành integration để nghiệp vụ không phụ thuộc trực tiếp một máy chủ mail.

**Nằm ở đâu?** `src/server/integrations/notify.ts`; cấu hình `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, tùy chọn `MAIL_TRANSPORT`.

**Ví dụ — `src/server/integrations/notify.ts`:**

```ts
const settings = smtpSettings();
if (settings) {
  mailer = nodemailer.createTransport(settings);
  return mailer;
}
```

Repo có chế độ Ethereal cho thư thử và transport ghi log. Báo đã xử lý ở transport log không chứng minh thư đã đến hộp thư ngoài đời; phải phân biệt cấu hình gửi thật với môi trường demo.

<a id="39-ai"></a>
## 39. Trợ lý AI qua Gemini và xAI

**Là gì?** Mô hình ngôn ngữ nhận chỉ dẫn và lịch sử hội thoại, trả lời bằng văn bản. API cho phép server gọi dịch vụ mô hình qua HTTP. Token trong ngữ cảnh mô hình là đơn vị văn bản, khác session token đăng nhập.

**Tại sao dùng?** Arena3 có trang/trình hỗ trợ hội thoại. Lớp integration giữ khóa phía server, giới hạn thời gian gọi và độ dài đầu ra; các handler nghiệp vụ vẫn phải tự kiểm tra quyền/dữ liệu.

**Nằm ở đâu?** `src/server/integrations/gemini.ts`, `src/routes/app.assistant.tsx`, `src/client/components/assistant-widget.tsx`, `src/server/controllers/handlers/extras.ts`.

**Ví dụ — các hằng số trong `src/server/integrations/gemini.ts`:**

```ts
const GEMINI_MODEL = "gemini-2.5-flash";
const XAI_MODEL = "grok-4.5";
const TIMEOUT_MS = 12_000;
const MAX_OUT = 512;
```

Đây là tên model **được ghi trong code lúc rà soát**, không phải tuyên bố model mới nhất hoặc trạng thái tài khoản dịch vụ. File gọi API bằng `fetch`, đọc `GEMINI_API_KEY`/`GOOGLE_API_KEY` và `XAI_API_KEY`, có nhánh trả `null` khi thiếu cấu hình hoặc không có phản hồi hợp lệ để lớp gọi xử lý tiếp. Không kết luận hệ thống AI đang hoạt động chỉ từ việc có file này.

<a id="40-export"></a>
## 40. Xuất PDF và Excel

**Là gì?** PDF giữ bố cục trang để xem/in; XLSX là gói các file XML nén ZIP mô tả bảng tính. `pdf-lib` tạo PDF bằng code; `fontkit` hỗ trợ nhúng font; `fflate` xử lý nén ZIP.

**Tại sao dùng?** Arena3 cần hóa đơn/biên nhận và báo cáo tải về, với tiếng Việt có dấu, số liệu có thể cộng trong Excel.

**Nằm ở đâu?** `src/server/integrations/pdf.ts`, `src/server/data/report-files.ts`, font tại `src/server/integrations/fonts/`.

**Ví dụ — `src/server/integrations/pdf.ts`:**

```ts
const pdf = await PDFDocument.create();
pdf.registerFontkit(fontkit);
const bytes = fontBytes();
```

**Ví dụ — `src/server/data/report-files.ts`:**

```ts
import { zipSync, strToU8 } from "fflate";
```

`buildXlsx()` tự dựng các phần XML rồi nén; không nên mô tả repo là dùng SheetJS hay ExcelJS. Font PDF được import bằng `?inline` để đi cùng bundle, tránh phụ thuộc file font bị thiếu lúc deploy. Chú thích nguồn cũng nói bản PDF hóa đơn này chưa phải hệ thống hóa đơn điện tử có chữ ký số/cơ quan thuế.

<a id="41-calendar"></a>
## 41. Liên kết Google Calendar

**Là gì?** Đây là liên kết mở biểu mẫu tạo sự kiện đã điền sẵn trên Google Calendar. URL chứa tiêu đề, khoảng thời gian và có thể có vị trí/mô tả.

**Tại sao dùng?** Hội viên lưu lịch tập hoặc lịch sân vào lịch cá nhân thuận tiện mà không cần app đọc toàn bộ lịch Google.

**Nằm ở đâu?** `src/client/arena3/gcal.ts`, `src/client/components/class-extras.tsx`.

**Ví dụ — `src/client/arena3/gcal.ts`:**

```ts
const q = new URLSearchParams({
  action: "TEMPLATE",
  text: e.title,
  dates: `${utcStamp(e.start)}/${utcStamp(e.end)}`,
});
```

Hàm trả URL `https://calendar.google.com/calendar/render?...`; người dùng vẫn tự lưu tại Google. Đây không phải đồng bộ Calendar API hai chiều và không phải luồng Google sign-in ở mục 29.

<a id="42-test"></a>
## 42. node --test, tsx và Playwright

**Là gì?** Test tự động gọi code hoặc điều khiển trình duyệt rồi đối chiếu kết quả. `node --test` là test runner có sẵn trong Node. `--experimental-strip-types` loại cú pháp kiểu TypeScript trên những phần được hỗ trợ; không thay thế kiểm tra kiểu. `tsx` giúp thực thi TypeScript thuận tiện. Playwright điều khiển trình duyệt thật cho kiểm tra render và tương tác.

**Tại sao dùng?** Arena3 có quy tắc transaction, giá, quyền và phiên dễ sai. Test nghiệp vụ giúp phát hiện lỗi dữ liệu; smoke test trình duyệt phát hiện trang trắng và lỗi console mà typecheck không bắt được.

**Nằm ở đâu?** Lệnh `test` trong `package.json`; `src/server/controllers/tx.test.ts`, `src/server/controllers/ratelimit.test.ts`, `src/client/lib/multiplayer/p2p.test.ts`, `scripts/*.test.mjs`, `scripts/browser-smoke.mjs`.

**Ví dụ — `src/server/controllers/tx.test.ts`:**

```ts
import assert from "node:assert/strict";
import { SHORTEST_PLAN_ID } from "../services/membership";
import { describe, it, before, after } from "node:test";
```

**Ví dụ — `scripts/browser-smoke.mjs`:**

```js
import { chromium } from "playwright";
```

Lệnh test hiện phối hợp test `.mjs`, nhóm test TypeScript qua Node strip-types và nhóm qua `npx tsx --test ...`. `tsx` được gọi trong script nhưng không được khai báo trực tiếp trong dependencies/devDependencies của `package.json` hiện tại. Không nhầm `tsx` — công cụ chạy — với đuôi file `.tsx` chứa JSX. Việc viết tài liệu này không đồng nghĩa các test đã được chạy hoặc đều đang pass.

<a id="43-lint"></a>
## 43. ESLint và Prettier

**Là gì?** ESLint phân tích code theo quy tắc như cách dùng hook hoặc biến thừa. Prettier định dạng khoảng trắng, xuống dòng và dấu câu theo quy tắc thống nhất. Typecheck, lint, format và test là các việc khác nhau.

**Tại sao dùng?** Nhóm giảm lỗi thường gặp và giảm tranh luận về cách xuống dòng. Repo kết hợp cấu hình TypeScript, React Hooks, React Refresh và cấu hình tránh xung đột với Prettier.

**Nằm ở đâu?** `eslint.config.mjs`, các lệnh `lint` và `format` trong `package.json`. ESLint bỏ qua `docs/`, `scripts/` và file route tự sinh theo cấu hình hiện tại.

**Ví dụ — `eslint.config.mjs`:**

```js
plugins: {
  "react-hooks": reactHooks,
  "react-refresh": reactRefresh,
},
```

`npm run format` dùng `prettier --write .`, tức có khả năng sửa nhiều file. Không cần chạy lệnh đó chỉ để đọc hoặc viết một tài liệu Markdown.

<a id="44-graft"></a>
## 44. tree-sitter, graft và hướng dẫn cho agent

**Là gì?** tree-sitter phân tích cú pháp thành cây cấu trúc để công cụ hiểu hàm/lớp thay vì chỉ tìm chữ. graft dùng chỉ mục/đồ thị mã nguồn để tra cứu định nghĩa và quan hệ; các thẻ Markdown trỏ đến đường dẫn và khoảng dòng. `AGENTS.md` là hướng dẫn cho trợ lý phát triển, không phải code chạy của website.

**Tại sao có trong dự án?** Repo lớn có nhiều handler và route; bản đồ mã giúp tìm đúng nơi đọc/sửa. Công cụ phát triển không phải tính năng mà hội viên tải về sử dụng.

**Nằm ở đâu?** `graft/INDEX.md`, `graft/src/`, `AGENTS.md`, `package.json` → `devDependencies`, `package-lock.json` → `node_modules/@nanonets/graft`.

**Ví dụ — trích dependency của graft trong `package-lock.json`:**

```json
"tree-sitter": "^0.21.1",
"tree-sitter-go": "^0.23.4",
"tree-sitter-java": "^0.23.5",
"tree-sitter-kotlin": "^0.3.8"
```

Các parser nhiều ngôn ngữ là dependency của công cụ, **không có nghĩa ứng dụng Arena3 được viết bằng Go, Java hay Kotlin**. `AGENTS.md` hướng dẫn `graft ask`, `graft grep`, `graft callers`, `graft skeleton`. MCP codebase-memory được nêu trong hướng dẫn phiên làm việc là một kênh tra cứu mã nguồn khác, không phải backend database của app.

Trong lần rà soát này, CLI graft cục bộ không chạy được do thiếu native build của `tree-sitter-kotlin` cho môi trường Node/Windows hiện tại; công cụ MCP cũng không cho thực hiện lời gọi theo chính sách phiên. Vì vậy việc đối chiếu tiếp tục từ các thẻ `graft/` có sẵn và các đoạn source thực tế. Đây là giới hạn công cụ tra cứu lúc viết tài liệu, không phải kết luận server Arena3 bị lỗi.

<a id="45-dependencies"></a>
## 45. Phân biệt dependency được cài với công nghệ đang dùng

**Là gì?** Một dependency có thể là công cụ phát triển, hạ tầng có điều kiện, mã tiện ích chưa được nối tới màn hình, hoặc thư viện nền của template. Bằng chứng mạnh hơn là import và lời gọi trong mã thực thi, kèm cấu hình bật tính năng.

**Tại sao cần hiểu?** Khi thuyết trình hoặc onboarding, liệt kê mọi tên trong `package.json` thành tính năng đang chạy sẽ mô tả sai hệ thống. Ngược lại, một khái niệm như transaction hay session có thể được tự cài đặt mà không có gói npm cùng tên.

**Nằm ở đâu?** So sánh `package.json` với `src/client/lib/use-read.ts`, `src/client/components/ui/index.tsx`, `src/server/controllers/validate.ts` và các integration thực tế.

**Ví dụ — dữ liệu trang được tải trong `src/client/lib/use-read.ts`:**

```ts
apiGet<T>(path, { fresh: round > 0 }).then(
  (data) => {
    if (!live) return;
    setAnswer({ path, data, error: null });
    setHeld(data);
  },
```

| Bằng chứng trong repo | Cách hiểu phù hợp |
| --- | --- |
| React, Router/Start, Tailwind được import và cấu hình | Thành phần nền đang được nối vào app |
| `useRead()` tự gọi API; UI có nhiều component tự viết | Không mặc định gọi lớp dữ liệu là React Query hoặc mọi bảng là TanStack Table |
| Zod xuất hiện trong preview bridge | Có Zod, nhưng validate nghiệp vụ chủ yếu cần đọc các hàm parse/handler |
| payOS, SMTP, AI, Google có kiểm tra cấu hình | Có mã tích hợp; hoạt động thực tế phụ thuộc cấu hình và điều kiện nghiệp vụ |
| `@tanstack/react-query`, `@tanstack/react-table`, `react-hook-form`, `@hookform/resolvers`, nhiều gói Radix, `zustand`, `date-fns` có trong package.json | Trong phạm vi rà soát `src/`, chưa thấy import trực tiếp các gói này; không trình bày chúng như lớp nghiệp vụ đang dùng |
| Kysely xuất hiện trong adapter Better Auth | Có vai trò ở hạ tầng auth; truy vấn nghiệp vụ chính dùng giao diện SQL/`pg`, không phải toàn bộ backend dùng query builder |
| tree-sitter nằm dưới dependency graft trong lockfile | Công cụ phân tích source phục vụ phát triển, không phải ngôn ngữ backend |

Khi học lần đầu, nên đọc theo thứ tự: JavaScript/TypeScript → React và hook → routing/API → database/transaction → session/phân quyền → các tích hợp và hiệu ứng. Mỗi lần chọn một thao tác cụ thể như giữ sân, đi theo sơ đồ mục 1 và mở đúng các file đã nêu; cách đó giúp nối các khái niệm thành một chương trình có thể hiểu được.
