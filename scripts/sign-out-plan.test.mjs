/**
 * Mục đích file:
 * File unit test cho scripts/sign-out-plan.mjs, kiểm thử quy trình đăng xuất (signOut)
 * và dọn dẹp phiên trước khi đăng nhập mới (pre-sign-in session clear).
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong bộ kiểm thử tự động của hệ thống.
 * Xác minh tính đúng đắn cho hai môi trường: Live Preview (dùng bearer token trong sessionStorage,
 * ưu tiên xóa token local để không treo UI) và Deployed (dùng HttpOnly cookie, chỉ chuyển hướng khi server xác nhận).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEPLOYED_SIGN_OUT_TIMEOUT_MS,
  PREVIEW_SIGN_OUT_TIMEOUT_MS,
  runPreSignInSignOut,
  runSignOut,
  settleWithin,
  signOutTimeoutMs,
} from "./sign-out-plan.mjs";

/**
 * Làm gì: Hằng số thời gian timeout ngắn (20ms) dùng riêng cho các ca kiểm thử để chạy nhanh mà không cần chờ lâu.
 * Được gọi ở: scripts/sign-out-plan.test.mjs (trong harness, settleWithin và preSignIn).
 */
const TEST_TIMEOUT_MS = 20;

/**
 * Làm gì: Tạo một Promise pending vĩnh viễn để giả lập tình huống request mạng bị treo không phản hồi.
 * Được gọi ở: scripts/sign-out-plan.test.mjs (trong các test case kiểm tra cơ chế timeout).
 * @returns {Promise<never>} Promise không bao giờ hoàn thành (pending vĩnh viễn).
 */
const hangs = () => new Promise(() => {});
/**
 * Làm gì: Tạo một Promise reject ngay lập tức với lỗi "network down" để giả lập lỗi rớt mạng.
 * Được gọi ở: scripts/sign-out-plan.test.mjs (trong các test case kiểm tra xử lý lỗi khi gọi request).
 * @returns {Promise<never>} Promise bị reject với Error("network down").
 */
const rejects = () => Promise.reject(new Error("network down"));

/**
 * Drain pending microtasks without advancing mocked time, so "has it finished
 * yet?" is answered by the mocked clock rather than by wall-clock luck.
 * `setImmediate` stays real — only `setTimeout` is mocked.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A `runSignOut` call with the browser effects replaced by recorders, so each
 * test asserts on what actually happened rather than on how it was written.
 */
function harness(overrides = {}) {
  /** @type {string[]} */
  // Bước 1: Khởi tạo mảng ghi nhận thứ tự thao tác (clear, redirect) và biến đếm số lượng request
  const order = [];
  let requests = 0;
  // Bước 2: Thiết lập cấu hình mặc định cho các bước chạy runSignOut, cho phép ghi đè qua overrides
  const steps = {
    livePreview: false,
    hasBearer: true,
    requestSignOut: () => {
      requests += 1;
      return Promise.resolve();
    },
    clearToken: () => order.push("clear"),
    redirect: () => order.push("redirect"),
    timeoutMs: TEST_TIMEOUT_MS,
    ...overrides,
  };
  // Bước 3: Trả về đối tượng kiểm thử gồm danh sách thao tác, số request và hàm thực thi runSignOut
  return {
    order,
    get requests() {
      return requests;
    },
    run: () => runSignOut(steps),
  };
}

/** Live preview: the bearer is the session, so the local clear always wins. */
const preview = (overrides = {}) => harness({ livePreview: true, ...overrides });

/** Deployed: only the server can clear the `__Host-` cookie. */
const deployed = (overrides = {}) => harness({ livePreview: false, ...overrides });

// ── Live preview ─────────────────────────────────────────────────────────────

/**
 * Làm gì: Kiểm tra trên preview khi request thành công thì phải xóa token trước, sau đó mới redirect.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("preview: a successful sign-out clears the token, then redirects", async () => {
  // Bước 1: Khởi tạo harness mô phỏng môi trường Live Preview với cấu hình mặc định
  const h = preview();
  // Bước 2: Kích hoạt runSignOut và kiểm tra thứ tự thực hiện: clear token rồi mới redirect
  await h.run();
  assert.equal(h.requests, 1);
  assert.deepEqual(h.order, ["clear", "redirect"]);
});

/**
 * Làm gì: Kiểm tra trên preview dù request thất bại (lỗi mạng) thì token vẫn được xóa và chuyển hướng bình thường.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("preview: a rejected sign-out still clears the token and redirects", async () => {
  // Live Preview dựa vào token local, nên request lên server dù lỗi vẫn phải dọn dẹp token và redirect để không treo người dùng
  const h = preview({ requestSignOut: rejects });
  await h.run();
  assert.deepEqual(h.order, ["clear", "redirect"]);
});

/**
 * Làm gì: Kiểm tra trên preview nếu hàm gọi request ném ngoại lệ đồng bộ thì hệ thống vẫn xóa token và redirect.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("preview: a sign-out that throws synchronously still clears and redirects", async () => {
  // Hàm settleWithin bọc try/catch đồng bộ để lỗi ngoại lệ không làm sập luồng đăng xuất của người dùng
  const h = preview({
    requestSignOut: () => {
      throw new Error("no fetch");
    },
  });
  await h.run();
  assert.deepEqual(h.order, ["clear", "redirect"]);
});

/**
 * Làm gì: Kiểm tra trên preview khi request bị treo vĩnh viễn thì sau khi hết hạn timeout, hệ thống vẫn xóa token và redirect.
 * Được gọi ở: test runner (node --test)
 * @param {import('node:test').TestContext} t Context của test runner hỗ trợ mock timer.
 * @returns {Promise<void>}
 */
test("preview: a sign-out that never settles clears and redirects once the wait expires", async (t) => {
  // Bước 1: Bật mock timer để chủ động tua thời gian trong test mà không phụ thuộc đồng hồ thực tế
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = preview({ requestSignOut: hangs });
  const done = h.run();

  // Bước 2: Tua thời gian ngay trước ngưỡng timeout (19ms), xác nhận chưa có hành động nào bị bỏ dở sớm
  t.mock.timers.tick(TEST_TIMEOUT_MS - 1);
  await flush();
  assert.deepEqual(h.order, [], "the server still has its window — do not give up early");

  // Bước 3: Nhích thêm 1ms đạt mốc timeout (20ms), xác nhận hệ thống từ bỏ chờ đợi và hoàn tất clear rồi redirect
  t.mock.timers.tick(1);
  await done;
  assert.deepEqual(h.order, ["clear", "redirect"]);
});

/**
 * Làm gì: Kiểm tra trên preview nếu không có bearer token thì bỏ qua việc gửi request lên server.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("preview: no bearer means nothing to invalidate, so no request is made", async () => {
  // Không có token nghĩa là không có session để hủy trên server, chỉ cần xóa local state và redirect
  const h = preview({ hasBearer: false });
  await h.run();
  assert.equal(h.requests, 0);
  assert.deepEqual(h.order, ["clear", "redirect"]);
});

/**
 * Làm gì: Kiểm tra trên preview nếu có bearer token thì bắt buộc phải gửi request lên server để hủy session.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("preview: a stored bearer is still invalidated server-side", async () => {
  // Khi có token lưu trữ, hệ thống luôn cố gắng gửi request báo server hủy session tương ứng
  const h = preview({ hasBearer: true });
  await h.run();
  assert.equal(h.requests, 1);
});

// ── Deployed ─────────────────────────────────────────────────────────────────
// JS cannot delete the HttpOnly `__Host-` cookie and `cookieCache` keeps
// serving the cached session, so an unconfirmed sign-out must NOT look like one.

/**
 * Làm gì: Kiểm tra trên môi trường deployed khi server xác nhận đăng xuất thành công thì mới xóa token và redirect.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("deployed: a confirmed sign-out clears the token, then redirects", async () => {
  // Deployed dựa vào HttpOnly cookie do server quản lý, chỉ redirect khi server đã xác nhận hủy cookie thành công
  const h = deployed();
  await h.run();
  assert.deepEqual(h.order, ["clear", "redirect"]);
});

/**
 * Làm gì: Kiểm tra trên deployed nếu request bị treo quá hạn thì throw lỗi và TUYỆT ĐỐI KHÔNG redirect.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("deployed: a sign-out that never settles throws and does NOT redirect", async () => {
  // Tránh đánh lừa người dùng rằng họ đã đăng xuất trong khi HttpOnly cookie trên server vẫn còn hiệu lực
  const h = deployed({ requestSignOut: hangs });
  await assert.rejects(h.run(), /still signed in/);
  assert.deepEqual(h.order, [], "no redirect may claim a sign-out the server never made");
});

/**
 * Làm gì: Kiểm tra trên deployed nếu request đăng xuất bị reject thì throw lỗi và không redirect.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("deployed: a rejected sign-out throws and does NOT redirect", async () => {
  // Khi server chưa xóa được cookie, client không được tự ý xóa state hoặc redirect như thể đã đăng xuất
  const h = deployed({ requestSignOut: rejects });
  await assert.rejects(h.run(), /still signed in/);
  assert.deepEqual(h.order, []);
});

/**
 * Làm gì: Kiểm tra lỗi quá hạn (timed out) và lỗi thất bại thông thường (failed) có thông điệp phân biệt rõ ràng.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("deployed: the timeout is distinguishable from a rejection", async () => {
  // Phân biệt rõ thông báo lỗi để UI hiển thị chính xác lý do (hết giờ chờ vs request thất bại) cho người dùng
  await assert.rejects(deployed({ requestSignOut: hangs }).run(), /timed out/);
  await assert.rejects(deployed({ requestSignOut: rejects }).run(), /Sign-out failed/);
});

// ── Bounded wait (also used by `signIn`'s pre-sign-in session clear) ──────────

/**
 * Làm gì: Kiểm tra settleWithin luôn trả về chuỗi kết quả (ok, failed, timeout) và không bao giờ reject Promise.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("settleWithin reports the outcome and never rejects", async () => {
  // settleWithin chuẩn hóa mọi phản hồi thành kết quả định danh an toàn để phía gọi tự quyết định nghiệp vụ
  assert.equal(await settleWithin(() => Promise.resolve(), TEST_TIMEOUT_MS), "ok");
  assert.equal(await settleWithin(rejects, TEST_TIMEOUT_MS), "failed");
  assert.equal(await settleWithin(hangs, TEST_TIMEOUT_MS), "timeout");
});

/**
 * Làm gì: Kiểm tra settleWithin đợi đủ thời gian timeout đã định trước khi trả về kết quả timeout chứ không treo mãi mãi.
 * Được gọi ở: test runner (node --test)
 * @param {import('node:test').TestContext} t Context của test runner hỗ trợ mock timer.
 * @returns {Promise<void>}
 */
test("settleWithin waits its full window, then gives up rather than hanging", async (t) => {
  // Bước 1: Bật mock timer và gọi settleWithin với request bị treo vĩnh viễn
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome = null;
  const done = settleWithin(hangs, TEST_TIMEOUT_MS).then((o) => (outcome = o));

  // Bước 2: Khi chưa đủ thời gian timeout (19ms), kết quả vẫn là null vì promise vẫn đang được chờ
  t.mock.timers.tick(TEST_TIMEOUT_MS - 1);
  await flush();
  assert.equal(outcome, null, "the request still has time left");

  // Bước 3: Đủ thời gian timeout (20ms), bộ đếm thời gian kích hoạt và trả về kết quả timeout
  t.mock.timers.tick(1);
  await done;
  assert.equal(outcome, "timeout", "the caller is never left waiting on a wedged request");
});

// ── Pre-sign-in session clear (`signIn`) ─────────────────────────────────────
// Same per-environment bound as sign-out, but best effort: it also runs when
// there is no prior session, so a failure must never block sign-in.

/** A pre-sign-in clear whose request never settles. */
function preSignIn(livePreview, overrides = {}) {
  // Bước 1: Khởi tạo biến đếm số lần gọi clearToken
  let cleared = 0;
  // Bước 2: Kích hoạt runPreSignInSignOut với mock request bị treo để test giới hạn thời gian chờ
  const done = runPreSignInSignOut({
    livePreview,
    hasBearer: true,
    requestSignOut: hangs,
    clearToken: () => (cleared += 1),
    ...overrides,
  });
  // Bước 3: Trả về Promise hoàn thành và getter số lần clearToken để kiểm tra assertion
  return {
    done,
    get cleared() {
      return cleared;
    },
  };
}

/**
 * Làm gì: Kiểm tra việc dọn dẹp trước đăng nhập ở preview sẽ dừng chờ đúng hạn mức PREVIEW_SIGN_OUT_TIMEOUT_MS (1.5s).
 * Được gọi ở: test runner (node --test)
 * @param {import('node:test').TestContext} t Context của test runner hỗ trợ mock timer.
 * @returns {Promise<void>}
 */
test("pre-sign-in: the preview clear gives up at the preview bound", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = preSignIn(true);

  // Trước mốc 1500ms, token chưa được clear vì vẫn đang chờ server phản hồi
  t.mock.timers.tick(PREVIEW_SIGN_OUT_TIMEOUT_MS - 1);
  await flush();
  assert.equal(h.cleared, 0);

  // Vừa đạt mốc 1500ms, hủy chờ server và thực hiện clearToken để chuẩn bị đăng nhập
  t.mock.timers.tick(1);
  await h.done;
  assert.equal(h.cleared, 1);
});

/**
 * Làm gì: Kiểm tra phiên deployed khi dọn dẹp trước đăng nhập phải chờ trọn vẹn hạn mức DEPLOYED_SIGN_OUT_TIMEOUT_MS (10s).
 * Được gọi ở: test runner (node --test)
 * @param {import('node:test').TestContext} t Context của test runner hỗ trợ mock timer.
 * @returns {Promise<void>}
 */
test("pre-sign-in: a deployed session gets the deployed window, not the preview one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = preSignIn(false);

  // Tại mốc 1.5s của preview, deployed vẫn chưa được clear vì session deployed chỉ server mới hủy được
  t.mock.timers.tick(PREVIEW_SIGN_OUT_TIMEOUT_MS);
  await flush();
  assert.equal(
    h.cleared,
    0,
    "only the server can end a deployed session — do not start OAuth while it is still live",
  );

  // Tua tiếp đến mốc 10s của deployed, lúc này hết thời gian chờ mới tiến hành clearToken
  t.mock.timers.tick(DEPLOYED_SIGN_OUT_TIMEOUT_MS - PREVIEW_SIGN_OUT_TIMEOUT_MS);
  await h.done;
  assert.equal(h.cleared, 1);
});

/**
 * Làm gì: Kiểm tra việc dọn dẹp phiên cũ thất bại không bao giờ chặn quá trình đăng nhập mới (best effort).
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("pre-sign-in: a failed clear never blocks sign-in", async () => {
  // Best effort by design: this also runs with no prior session to clear.
  // runPreSignInSignOut hoạt động theo cơ chế best-effort, không ném lỗi để người dùng mới luôn đăng nhập được
  await preSignIn(false, { requestSignOut: rejects, timeoutMs: TEST_TIMEOUT_MS }).done;
  await preSignIn(true, { requestSignOut: rejects, timeoutMs: TEST_TIMEOUT_MS }).done;
});

/**
 * Làm gì: Kiểm tra trên preview nếu không có bearer token thì bỏ qua việc gửi request xóa phiên cũ lên server.
 * Được gọi ở: test runner (node --test)
 * @returns {Promise<void>}
 */
test("pre-sign-in: the preview skips the request when there is no bearer", async () => {
  let requests = 0;
  // Trong preview không có bearer thì không có gì để hủy trên server, bỏ qua request và chỉ clear local
  const h = preSignIn(true, {
    hasBearer: false,
    requestSignOut: () => {
      requests += 1;
      return hangs();
    },
  });
  await h.done;
  assert.equal(requests, 0);
  assert.equal(h.cleared, 1);
});

/**
 * Làm gì: Kiểm tra hàm signOutTimeoutMs trả về đúng hằng số timeout tương ứng với từng môi trường.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("every sign-out bound comes from one rule", () => {
  // Quy tắc tính timeout tập trung tại một nơi giúp hành vi đăng xuất nhất quán trong toàn bộ ứng dụng
  assert.equal(signOutTimeoutMs(true), PREVIEW_SIGN_OUT_TIMEOUT_MS);
  assert.equal(signOutTimeoutMs(false), DEPLOYED_SIGN_OUT_TIMEOUT_MS);
});

/**
 * Làm gì: Kiểm tra các giá trị timeout mặc định nằm trong khoảng an toàn và deployed luôn chờ lâu hơn preview.
 * Được gọi ở: test runner (node --test)
 * @param {import('node:test').TestContext} t Context của test runner hỗ trợ mock timer.
 * @returns {Promise<void>}
 */
test("the defaults are bounded, and deployed waits longer than preview", async (t) => {
  // Bước 1: Kiểm tra các ngưỡng timeout mặc định nằm trong khoảng hợp lý (preview <= 2s, deployed <= 30s)
  assert.ok(PREVIEW_SIGN_OUT_TIMEOUT_MS > 0 && PREVIEW_SIGN_OUT_TIMEOUT_MS <= 2000);
  assert.ok(DEPLOYED_SIGN_OUT_TIMEOUT_MS > PREVIEW_SIGN_OUT_TIMEOUT_MS);
  assert.ok(DEPLOYED_SIGN_OUT_TIMEOUT_MS <= 30_000);

  // Bước 2: Kiểm tra hàm preview chạy đúng với giá trị timeout mặc định (1500ms) khi timeoutMs không được truyền vào
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = preview({ requestSignOut: hangs, timeoutMs: undefined });
  const done = h.run();
  t.mock.timers.tick(PREVIEW_SIGN_OUT_TIMEOUT_MS);
  await done;
  assert.deepEqual(h.order, ["clear", "redirect"]);
});
