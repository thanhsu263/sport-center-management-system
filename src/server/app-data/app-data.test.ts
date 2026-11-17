/**
 * Mục đích file:
 * Tập hợp các bài kiểm thử đơn vị (unit test) cho module app-data connector trên server và shared.
 * Xác minh cơ chế lưu cache lỗi tạm thời (failure memoization), xử lý token và mã 401 giữa môi trường preview và deployed,
 * khả năng xử lý tham số không thể tuần tự hóa (non-serializable), và các tiện ích kiểm tra đăng nhập.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong bộ kiểm thử tự động của hệ thống,
 * bảo đảm tính ổn định và an toàn khi ứng dụng tích hợp dữ liệu với các connector bên ngoài (Google Drive, Calendar, Notion,...).
 */
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  callTool,
  failureMemoSize,
  isConnectorTokenReady,
} from "./client.server.ts";
import { ConnectorType, GoogleCalendarTools } from "../../shared/app-data/types.ts";
import type { ToolArgs } from "../../shared/app-data/types.ts";
import { isLoginRequired, redirectToLoginIfRequired } from "../../shared/app-data/login.ts";
import { classifyCallToolError } from "../../client/app-data/errors.ts";
import type { CallToolResult } from "../../shared/app-data/types.ts";

type WindowStub = {
  location: { assign: (url: string) => void; href: string };
  self?: unknown;
  top?: unknown;
  open?: (url: string, target: string) => unknown;
};

/**
 * Làm gì: Giả lập biến toàn cục window (stub window) trong Node.js để chạy kiểm thử liên quan đến trình duyệt rồi dọn dẹp an toàn.
 * Được gọi ở: src/server/app-data/app-data.test.ts trong các ca kiểm thử hàm redirectToLoginIfRequired
 * @param stub Đối tượng window giả lập chứa location, open hoặc các thuộc tính cần test
 * @param fn Hàm callback thực thi logic test cần môi trường window
 * @returns Kết quả trả về của hàm fn
 */
function withWindow<T>(stub: WindowStub, fn: () => T): T {
  // Bước 1: Gán đối tượng stub vào globalThis.window để giả lập môi trường trình duyệt trong Node.js
  (globalThis as { window?: unknown }).window = stub;
  try {
    // Bước 2: Thực thi hàm kiểm thử và bảo đảm window stub luôn được xóa trong khối finally, tránh ảnh hưởng test khác
    return fn();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

/**
 * Làm gì: Tạo chuỗi JWT giả lập có cấu trúc 3 phần (header.payload.signature) được mã hóa base64url để phục vụ kiểm thử.
 * Được gọi ở: src/server/app-data/app-data.test.ts trong các ca kiểm thử mô phỏng connector access token
 * @param claims Tập các trường payload (claims) như sub, iat, exp cần đóng gói vào JWT
 * @returns Chuỗi JWT giả lập định dạng base64url
 */
function fakeJwt(claims: Record<string, unknown>): string {
  // Mã hóa dữ liệu thành chuỗi base64url theo chuẩn JWT RFC 7519 mà không cần ký số bảo mật thực tế
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.sig`;
}

/**
 * Làm gì: Giả lập phản hồi HTTP từ gate server (mock fetch) và theo dõi số lượt gọi API trong khi chạy test.
 * Được gọi ở: src/server/app-data/app-data.test.ts trong các ca kiểm thử gọi callTool
 * @param status Mã trạng thái HTTP phản hồi (ví dụ: 200, 401, 500)
 * @param body Dữ liệu JSON trả về trong body của response giả lập
 * @param run Hàm callback async thực thi test, nhận hàm calls() để kiểm tra số lần fetch đã gọi
 * @returns Promise<void> hoàn tất sau khi dọn dẹp biến môi trường và khôi phục fetch gốc
 */
async function withStubbedGate(
  status: number,
  body: Record<string, unknown>,
  run: (calls: () => number) => Promise<void>,
): Promise<void> {
  // Bước 1: Thiết lập GROK_CONNECTORS_URL trỏ về URL giả lập và ghi đè globalThis.fetch để đếm request gọi ra ngoài
  process.env.GROK_CONNECTORS_URL = "https://connectors.invalid.example";
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    // Bước 2: Thực thi hàm kiểm thử và bảo đảm khôi phục fetch gốc cùng biến môi trường trong khối finally
    await run(() => calls);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GROK_CONNECTORS_URL;
  }
}

/**
 * Làm gì: Nhóm các ca kiểm thử tính năng failure memoization (ghi nhớ kết quả lỗi tạm thời trong 5s) của callTool.
 * Được gọi ở: test runner (node --test)
 */
describe("callTool failure memo", () => {
  /**
   * Làm gì: Kiểm tra lỗi giống hệt nhau phát sinh trong khoảng thời gian TTL sẽ trả về từ cache thay vì gọi lại gate.
   * Được gọi ở: test runner (node --test)
   */
  it("replays an identical failure within the memo window without refetching", async () => {
    await withStubbedGate(500, { ok: false, errorMessage: "boom" }, async (calls) => {
      // Bước 1: Chuẩn bị tham số gọi tool với connector Google Drive và token của user 1
      const options = {
        connectorType: ConnectorType.GoogleDrive,
        token: fakeJwt({ sub: "memo-user-1", iat: 1000, exp: 2000 }),
      };
      // Bước 2: Gọi tool 2 lần liên tiếp cùng tham số; kiểm tra kết quả lần 2 lấy từ cache và số lần fetch chỉ bằng 1
      const first = await callTool("google_drive_search", { q: "memo" }, options);
      const second = await callTool("google_drive_search", { q: "memo" }, options);
      assert.equal(first.ok, false);
      assert.equal(first.errorMessage, "boom");
      assert.deepEqual(second, first);
      assert.equal(calls(), 1);
    });
  });

  /**
   * Làm gì: Kiểm tra khóa cache được tạo theo định danh user (sub trong JWT) để token được cấp mới vẫn dùng chung cache lỗi.
   * Được gọi ở: test runner (node --test)
   */
  it("keys by token identity so a reminted token shares the memo entry", async () => {
    await withStubbedGate(500, { ok: false, errorMessage: "boom" }, async (calls) => {
      // Bước 1: Gọi lần 1 với token ban đầu (iat: 1000) của memo-user-2, gate ghi nhận lỗi 500 vào cache
      const first = await callTool(
        "google_drive_search",
        { q: "remint" },
        {
          connectorType: ConnectorType.GoogleDrive,
          token: fakeJwt({ sub: "memo-user-2", iat: 1000, exp: 2000 }),
        },
      );
      // Bước 2: Gọi lần 2 với token vừa được refresh (iat: 1001, cùng sub memo-user-2); tái sử dụng cache nên calls vẫn là 1
      const second = await callTool(
        "google_drive_search",
        { q: "remint" },
        {
          connectorType: ConnectorType.GoogleDrive,
          token: fakeJwt({ sub: "memo-user-2", iat: 1001, exp: 2001 }),
        },
      );
      assert.equal(first.ok, false);
      assert.deepEqual(second, first);
      assert.equal(calls(), 1);

      // Bước 3: Gọi với user khác (memo-user-3); khác identity sub nên không dùng chung cache và phải fetch lần 2 (calls = 2)
      const other = await callTool(
        "google_drive_search",
        { q: "remint" },
        {
          connectorType: ConnectorType.GoogleDrive,
          token: fakeJwt({ sub: "memo-user-3", iat: 1000, exp: 2000 }),
        },
      );
      assert.equal(other.ok, false);
      assert.equal(calls(), 2);
    });
  });

  /**
   * Làm gì: Kiểm tra cơ chế tự động dọn dẹp các mục cache hết hạn (TTL 5s) khi ghi mục mới, tránh rò rỉ bộ nhớ.
   * Được gọi ở: test runner (node --test)
   */
  it("sweeps expired entries on write so unique keys do not accumulate", async () => {
    await withStubbedGate(500, { ok: false, errorMessage: "boom" }, async () => {
      // Bước 1: Kích hoạt mock timer cho Date để kiểm soát mốc thời gian kiểm thử (bắt đầu tại 1.000.000 ms)
      mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      try {
        const sizeBefore = failureMemoSize();
        const options = {
          connectorType: ConnectorType.GoogleDrive,
          token: fakeJwt({ sub: "memo-user-5", iat: 1000, exp: 2000 }),
        };
        // Bước 2: Ghi 2 mục lỗi vào cache với query khác nhau (sweep-a, sweep-b); kích thước cache tăng thêm 2
        await callTool("google_drive_search", { q: "sweep-a" }, options);
        await callTool("google_drive_search", { q: "sweep-b" }, options);
        assert.equal(failureMemoSize(), sizeBefore + 2);

        // Bước 3: Dịch chuyển thời gian qua ngưỡng TTL 5 giây (+5.001 ms) và ghi mục sweep-c; hai mục cũ hết hạn phải bị dọn dẹp sạch
        mock.timers.setTime(1_000_000 + 5_001);
        await callTool("google_drive_search", { q: "sweep-c" }, options);
        assert.equal(
          failureMemoSize(),
          sizeBefore + 1,
          "expired sweep-a/sweep-b entries must be removed on the sweep-c write",
        );
      } finally {
        mock.timers.reset();
      }
    });
  });

  /**
   * Làm gì: Kiểm tra lỗi 401 yêu cầu đăng nhập không bao giờ bị lưu cache để tránh chặn người dùng sau khi đã xác thực xong.
   * Được gọi ở: test runner (node --test)
   */
  it("never memoizes login-required 401s", async () => {
    // Bước 1: Giả lập môi trường production đã deploy bằng biến GROK_PROJECT_ID
    process.env.GROK_PROJECT_ID = "proj-1";
    try {
      await withStubbedGate(401, { errorMessage: "login required" }, async (calls) => {
        const options = {
          connectorType: ConnectorType.GoogleDrive,
          token: fakeJwt({ sub: "memo-user-4", iat: 1000, exp: 2000 }),
        };
        // Bước 2: Gọi tool 2 lần liên tiếp; do lỗi 401 không được memoize nên cả 2 lần đều phải fetch trực tiếp (calls = 2)
        const first = await callTool("google_drive_search", { q: "auth" }, options);
        const second = await callTool("google_drive_search", { q: "auth" }, options);
        assert.equal(first.ok, false);
        assert.equal(first.loginRequired, true);
        assert.equal(second.loginRequired, true);
        assert.equal(calls(), 2);
      });
    } finally {
      delete process.env.GROK_PROJECT_ID;
    }
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử so sánh hành vi xử lý token và mã lỗi của callTool giữa môi trường preview và deployed.
 * Được gọi ở: test runner (node --test)
 */
describe("callTool in the workspace preview vs deployed", () => {
  const options = { connectorType: ConnectorType.GoogleDrive };
  const savedEnvToken = process.env.GROK_CONNECTOR_ACCESS_TOKEN;

  // Xóa sạch biến môi trường token và project ID trước mỗi test case để đảm bảo trạng thái độc lập
  beforeEach(() => {
    delete process.env.GROK_CONNECTOR_ACCESS_TOKEN;
    delete process.env.GROK_PROJECT_ID;
  });
  // Khôi phục lại biến môi trường GROK_CONNECTOR_ACCESS_TOKEN và xóa GROK_PROJECT_ID sau khi chạy xong test
  afterEach(() => {
    if (savedEnvToken === undefined) {
      delete process.env.GROK_CONNECTOR_ACCESS_TOKEN;
    } else {
      process.env.GROK_CONNECTOR_ACCESS_TOKEN = savedEnvToken;
    }
    delete process.env.GROK_PROJECT_ID;
  });

  /**
   * Làm gì: Kiểm tra môi trường preview khi chưa có token sẽ trả về pending thay vì loginRequired để chờ panel preview đẩy token.
   * Được gọi ở: test runner (node --test)
   */
  it("returns pending (no loginRequired) when the preview has no token yet", async () => {
    // Ở preview khi chưa có token, kết quả trả về pending: true với mã connector_token_pending để client chờ
    const result = await callTool("google_drive_search", {}, options);
    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
    assert.equal(result.loginRequired, undefined);
    assert.match(result.errorMessage ?? "", /^connector_token_pending/);
  });

  /**
   * Làm gì: Kiểm tra ứng dụng đã deploy khi thiếu token sẽ trả về lỗi missing_connector_token thuần, không hiển thị nút đăng nhập.
   * Được gọi ở: test runner (node --test)
   */
  it("returns a plain error (no sign-in CTA) when a deployed app has no token", async () => {
    // Khi deploy thiếu token do bypass gate, redirect đăng nhập không giải quyết được nên không gán loginRequired
    process.env.GROK_PROJECT_ID = "proj-1";
    const result = await callTool("google_drive_search", {}, options);
    assert.equal(result.ok, false);
    assert.equal(result.loginRequired, undefined);
    assert.equal(result.loginUrl, undefined);
    assert.equal(result.pending, undefined);
    assert.match(result.errorMessage ?? "", /^missing_connector_token/);
  });

  /**
   * Làm gì: Kiểm tra lỗi 401 trong preview được coi là pending và token bị gate từ chối sẽ được lưu tạm để chặn gọi lặp lại.
   * Được gọi ở: test runner (node --test)
   */
  it("treats a gate 401 in the preview as pending and parks the rejected token", async () => {
    await withStubbedGate(401, { errorMessage: "login required" }, async (calls) => {
      // Bước 1: Gán token ban đầu và xác nhận token ở trạng thái sẵn sàng (isConnectorTokenReady = true)
      process.env.GROK_CONNECTOR_ACCESS_TOKEN = fakeJwt({ sub: "p", iat: 1, exp: 2 });
      assert.equal(isConnectorTokenReady(), true);

      // Bước 2: Gate trả về 401; preview chuyển kết quả thành pending và đánh dấu token hiện tại bị từ chối (ready = false)
      const result = await callTool("google_drive_search", {}, options);
      assert.equal(result.pending, true);
      assert.equal(result.loginRequired, undefined);
      assert.match(result.errorMessage ?? "", /^connector_token_pending/);
      assert.equal(calls(), 1);
      assert.equal(isConnectorTokenReady(), false);

      // Bước 3: Khi panel preview đẩy token mới có digest khác, hệ thống tự động nhận diện sẵn sàng trở lại (ready = true)
      process.env.GROK_CONNECTOR_ACCESS_TOKEN = fakeJwt({ sub: "p", iat: 3, exp: 4 });
      assert.equal(isConnectorTokenReady(), true);
    });
  });

  /**
   * Làm gì: Kiểm tra ứng dụng đã deploy khi gặp lỗi 401 từ gate sẽ giữ cờ loginRequired = true để kích hoạt điều hướng đăng nhập.
   * Được gọi ở: test runner (node --test)
   */
  it("keeps loginRequired for a gate 401 on a deployed app", async () => {
    // Trên production đã deploy, lỗi 401 từ gate phải giữ nguyên loginRequired: true để giao diện mở trang đăng nhập
    process.env.GROK_PROJECT_ID = "proj-1";
    await withStubbedGate(401, { errorMessage: "login required" }, async () => {
      const result = await callTool("google_drive_search", {}, {
        ...options,
        token: fakeJwt({ sub: "d", iat: 1, exp: 2 }),
      });
      assert.equal(result.loginRequired, true);
      assert.equal(result.pending, undefined);
    });
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm callTool khi gặp các trường hợp ngoại lệ đầu vào.
 * Được gọi ở: test runner (node --test)
 */
describe("callTool", () => {
  /**
   * Làm gì: Kiểm tra callTool trả về phản hồi lỗi an toàn (ok: false) khi tham số có tham chiếu vòng, không để văng ngoại lệ.
   * Được gọi ở: test runner (node --test)
   */
  it("resolves ok:false for non-serializable args instead of rejecting", async () => {
    process.env.GROK_CONNECTORS_URL = "https://connectors.invalid.example";
    try {
      // Bước 1: Tạo đối tượng chứa tham chiếu vòng (circular reference) khiến JSON.stringify ném lỗi
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = await callTool(
        "google_drive_search",
        circular as ToolArgs,
        {
          connectorType: ConnectorType.GoogleDrive,
          token: "opaque-token",
        },
      );
      // Bước 2: callTool phải bắt lỗi serialize và trả về ok: false kèm thông báo circular thay vì reject Promise
      assert.equal(result.ok, false);
      assert.match(result.errorMessage ?? "", /circular/i);
    } finally {
      delete process.env.GROK_CONNECTORS_URL;
    }
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm isLoginRequired, xác minh điều kiện cờ loginRequired khi gọi tool thất bại.
 * Được gọi ở: test runner (node --test)
 */
describe("isLoginRequired", () => {
  /**
   * Làm gì: Kiểm tra hàm chỉ trả về true khi kết quả gọi tool thất bại (ok: false) và có cờ loginRequired: true.
   * Được gọi ở: test runner (node --test)
   */
  it("is true only for login-required failures", () => {
    // Trường hợp hợp lệ: ok = false và loginRequired = true -> trả về true
    assert.equal(
      isLoginRequired({ ok: false, data: null, loginRequired: true }),
      true,
    );
    // Các trường hợp không hợp lệ: thiếu cờ loginRequired hoặc có errorMessage thông thường -> trả về false
    assert.equal(isLoginRequired({ ok: false, data: null }), false);
    assert.equal(
      isLoginRequired({ ok: false, data: null, errorMessage: "access_denied" }),
      false,
    );
    // Khi ok = true (thành công), hàm luôn trả về false ngay cả khi cờ loginRequired bị gán true
    assert.equal(
      isLoginRequired({
        ok: true,
        data: {},
        loginRequired: true,
      } as CallToolResult),
      false,
    );
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm redirectToLoginIfRequired, kiểm tra hành vi điều hướng người dùng tới trang đăng nhập khi kết quả gọi tool yêu cầu xác thực.
 * Được gọi ở: test runner (node --test)
 */
describe("redirectToLoginIfRequired", () => {
  /**
   * Làm gì: Kiểm tra hàm không thực hiện điều hướng (no-op) và trả về false khi kết quả gọi tool không yêu cầu đăng nhập.
   * Được gọi ở: test runner (node --test)
   */
  it("no-ops when login is not required", () => {
    let target = "";
    // Bước 1: Giả lập môi trường window và gọi hàm khi lỗi thông thường (không có cờ loginRequired)
    const did = withWindow(
      {
        location: {
          assign: (u) => {
            target = u;
          },
          href: "https://my-app.grok.me/current",
        },
      },
      () =>
        redirectToLoginIfRequired({
          ok: false,
          data: null,
          errorMessage: "tool error",
        }),
    );
    // Bước 2: Xác nhận hàm trả về false và không có URL nào được gán vào window.location
    assert.equal(did, false);
    assert.equal(target, "");
  });

  /**
   * Làm gì: Kiểm tra hàm điều hướng người dùng qua window.location.assign tới loginUrl do server trả về khi chạy trực tiếp trong trình duyệt.
   * Được gọi ở: test runner (node --test)
   */
  it("navigates to the server-built loginUrl in the browser", () => {
    let target = "";
    // Bước 1: Giả lập môi trường window độc lập (không trong iframe) và kích hoạt điều hướng khi có loginUrl
    const did = withWindow(
      {
        location: {
          assign: (u) => {
            target = u;
          },
          href: "https://my-app.grok.me/current",
        },
      },
      () =>
        redirectToLoginIfRequired({
          ok: false,
          data: null,
          loginRequired: true,
          loginUrl: "https://gate.grok.me/__gate/signin?return_to=x",
        }),
    );
    // Bước 2: Xác nhận hàm trả về true và window.location.assign đã nhận đúng đường dẫn loginUrl
    assert.equal(did, true);
    assert.equal(target, "https://gate.grok.me/__gate/signin?return_to=x");
  });

  /**
   * Làm gì: Kiểm tra hàm mở tab mới bằng window.open và xóa opener khi chạy trong iframe (như Grok preview) để tránh lỗi bảo mật và không bị chặn frame.
   * Được gọi ở: test runner (node --test)
   */
  it("opens a new tab instead of navigating when framed", () => {
    let assigned = "";
    let opened = "";
    const openedTab: { opener?: unknown } = { opener: "parent" };
    // Bước 1: Giả lập môi trường iframe (self khác top) với phương thức window.open để mở tab mới
    const did = withWindow(
      {
        self: "frame",
        top: "host",
        open: (url) => {
          opened = url;
          return openedTab;
        },
        location: {
          assign: (u) => {
            assigned = u;
          },
          href: "https://my-app.grok.me/current",
        },
      },
      () =>
        redirectToLoginIfRequired({
          ok: false,
          data: null,
          loginRequired: true,
          loginUrl: "https://gate.grok.me/__gate/signin?return_to=x",
        }),
    );
    // Bước 2: Xác nhận tab mới đã mở tới loginUrl, openedTab.opener được xóa về null để bảo mật, và trang hiện tại không bị navigate
    assert.equal(did, true);
    assert.equal(opened, "https://gate.grok.me/__gate/signin?return_to=x");
    assert.equal(openedTab.opener, null);
    assert.equal(assigned, "");
  });

  /**
   * Làm gì: Kiểm tra cơ chế dự phòng tự động chuyển sang window.location.assign khi chạy trong iframe nhưng trình duyệt chặn popup (window.open trả về null).
   * Được gọi ở: test runner (node --test)
   */
  it("falls back to navigation when framed and the popup is blocked", () => {
    let assigned = "";
    // Bước 1: Giả lập iframe nhưng window.open trả về null (trình duyệt chặn mở tab mới)
    const did = withWindow(
      {
        self: "frame",
        top: "host",
        open: () => null,
        location: {
          assign: (u) => {
            assigned = u;
          },
          href: "https://my-app.grok.me/current",
        },
      },
      () =>
        redirectToLoginIfRequired({
          ok: false,
          data: null,
          loginRequired: true,
          loginUrl: "https://gate.grok.me/__gate/signin?return_to=x",
        }),
    );
    // Bước 2: Xác nhận hàm dự phòng sang window.location.assign để người dùng vẫn được điều hướng tới loginUrl
    assert.equal(did, true);
    assert.equal(assigned, "https://gate.grok.me/__gate/signin?return_to=x");
  });

  /**
   * Làm gì: Kiểm tra hàm trả về false và không thực hiện điều hướng nếu kết quả yêu cầu đăng nhập nhưng không có loginUrl hợp lệ.
   * Được gọi ở: test runner (node --test)
   */
  it("returns false when the result has no loginUrl", () => {
    let target = "";
    // Bước 1: Giả lập window và gọi hàm với kết quả có loginRequired = true nhưng thiếu loginUrl
    const did = withWindow(
      {
        location: {
          assign: (u) => {
            target = u;
          },
          href: "https://my-app.grok.me/current",
        },
      },
      () =>
        redirectToLoginIfRequired({ ok: false, data: null, loginRequired: true }),
    );
    // Bước 2: Xác nhận hàm trả về false và không có URL nào được gán do thiếu đường dẫn chuyển hướng
    assert.equal(did, false);
    assert.equal(target, "");
  });

  /**
   * Làm gì: Kiểm tra hàm xử lý an toàn khi chạy trên server (SSR) nơi đối tượng window là undefined, trả về false mà không gây crash ứng dụng.
   * Được gọi ở: test runner (node --test)
   */
  it("returns false on the server (no window)", () => {
    // Khi chạy ở môi trường server (Node.js) không có đối tượng window -> hàm bỏ qua và trả về false an toàn
    const did = redirectToLoginIfRequired({
      ok: false,
      data: null,
      loginRequired: true,
      loginUrl: "https://gate.grok.me/__gate/signin?return_to=x",
    });
    assert.equal(did, false);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hằng số enum GoogleCalendarTools, xác minh danh sách tên tool connector lịch được hỗ trợ.
 * Được gọi ở: test runner (node --test)
 */
describe("GoogleCalendarTools", () => {
  /**
   * Làm gì: Kiểm tra GoogleCalendarTools không chứa tên tool list_events cũ mà chỉ hỗ trợ search và listCalendars theo chuẩn connector.
   * Được gọi ở: test runner (node --test)
   */
  it("does not expose a list_events name", () => {
    // Bước 1: Xác minh tên định danh của các tool hợp lệ: search và listCalendars
    assert.equal(GoogleCalendarTools.search, "google_calendar_search");
    assert.equal(GoogleCalendarTools.listCalendars, "google_calendar_list_calendars");
    // Bước 2: Đảm bảo danh sách tool không chứa tool google_calendar_list_events đã bị loại bỏ
    const toolNames: readonly string[] = Object.values(GoogleCalendarTools);
    assert.equal(toolNames.includes("google_calendar_list_events"), false);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm classifyCallToolError, kiểm tra logic phân loại và chuẩn hóa các thông báo lỗi từ connector tool.
 * Được gọi ở: test runner (node --test)
 */
describe("classifyCallToolError", () => {
  /**
   * Làm gì: Kiểm tra hàm trả về null khi kết quả gọi tool thành công (ok = true), biểu thị không có lỗi cần xử lý.
   * Được gọi ở: test runner (node --test)
   */
  it("returns null for successful results", () => {
    // Kết quả thành công (ok: true) thì không có trạng thái lỗi -> trả về null
    assert.equal(classifyCallToolError({ ok: true, data: {} }), null);
  });

  /**
   * Làm gì: Kiểm tra lỗi token đang chờ xử lý (pending = true) trong môi trường preview được ưu tiên phân loại thành kind "pending" trước mọi loại lỗi khác.
   * Được gọi ở: test runner (node --test)
   */
  it("classifies a pending preview token as pending before any other kind", () => {
    // Bước 1: Giả lập kết quả gọi tool trong môi trường preview khi token chưa sẵn sàng (pending: true)
    const state = classifyCallToolError({
      ok: false,
      data: null,
      pending: true,
      errorMessage: "connector_token_pending: the preview has not received the connector token yet",
    });
    // Bước 2: Xác nhận loại lỗi là "pending" và thông điệp hiển thị trạng thái đang kết nối dữ liệu
    assert.equal(state?.kind, "pending");
    assert.match(state?.message ?? "", /Connecting/);
    assert.match(state?.detail ?? "", /connector_token_pending/);
  });

  /**
   * Làm gì: Kiểm tra lỗi missing_connector_token trên ứng dụng đã deploy được phân loại thành kind "error" thay vì hiển thị nút đăng nhập (login CTA).
   * Được gọi ở: test runner (node --test)
   */
  it("classifies a deployed missing token as error, not a login CTA", () => {
    // Bước 1: Giả lập lỗi thiếu token connector trên app đã deploy (yêu cầu truy cập qua edge gate)
    const state = classifyCallToolError({
      ok: false,
      data: null,
      errorMessage: "missing_connector_token: open this app through the edge gate",
    });
    // Bước 2: Xác nhận loại lỗi là "error" để thông báo người dùng, tránh nhầm sang trạng thái "login"
    assert.equal(state?.kind, "error");
    assert.match(state?.detail ?? "", /missing_connector_token/);
  });

  /**
   * Làm gì: Kiểm tra lỗi yêu cầu đăng nhập từ gate (loginRequired = true) khi không có thông báo missing_token được phân loại chính xác thành kind "login".
   * Được gọi ở: test runner (node --test)
   */
  it("classifies gate loginRequired without a missing-token message as login", () => {
    // Bước 1: Giả lập kết quả yêu cầu đăng nhập từ cổng xác thực gate
    const state = classifyCallToolError({
      ok: false,
      data: null,
      loginRequired: true,
      errorMessage: "login required",
    });
    // Bước 2: Xác nhận phân loại thành "login" để giao diện kích hoạt luồng đăng nhập tài khoản
    assert.equal(state?.kind, "login");
    assert.equal(state?.detail, "login required");
  });

  /**
   * Làm gì: Kiểm tra các lỗi "connector_not_connected" và "FAILED_PRECONDITION" đều được phân loại về loại lỗi chung "not_connected".
   * Được gọi ở: test runner (node --test)
   */
  it("classifies not_connected and failed_precondition", () => {
    // Bước 1: Kiểm tra lỗi connector_not_connected khi chưa kết nối connector trong Grok
    assert.equal(
      classifyCallToolError({
        ok: false,
        data: null,
        errorMessage: "connector_not_connected: Notion",
      })?.kind,
      "not_connected",
    );
    // Bước 2: Kiểm tra lỗi FAILED_PRECONDITION từ backend cũng được quy chuẩn về "not_connected"
    assert.equal(
      classifyCallToolError({
        ok: false,
        data: null,
        errorMessage: "FAILED_PRECONDITION: no connector",
      })?.kind,
      "not_connected",
    );
  });

  /**
   * Làm gì: Kiểm tra lỗi gọi công cụ vượt ngoài phạm vi cấp phép (scope_denied) được phân loại thành kind "scope_denied" kèm thông điệp công cụ nằm ngoài grant.
   * Được gọi ở: test runner (node --test)
   */
  it("classifies scope_denied without claiming a missing grant", () => {
    // Bước 1: Giả lập lỗi yêu cầu tool vượt ngoài phạm vi cấp quyền (grant scope)
    const state = classifyCallToolError({
      ok: false,
      data: null,
      errorMessage: "scope_denied: tool notion-list-recent-pages not in grant scopes",
    });
    // Bước 2: Xác nhận kind là "scope_denied" và chi tiết lỗi phản ánh đúng tên tool bị từ chối
    assert.equal(state?.kind, "scope_denied");
    assert.match(state?.message ?? "", /tool outside its grant/);
    assert.match(state?.detail ?? "", /notion-list-recent-pages/);
  });

  /**
   * Làm gì: Kiểm tra lỗi từ chối quyền truy cập dữ liệu (access_denied) được phân loại thành kind "access_denied".
   * Được gọi ở: test runner (node --test)
   */
  it("classifies access_denied", () => {
    // Lỗi access_denied được chuyển thành kind "access_denied" để UI hiển thị thông báo người dùng không có quyền truy cập dữ liệu
    assert.equal(
      classifyCallToolError({
        ok: false,
        data: null,
        errorMessage: "access_denied",
      })?.kind,
      "access_denied",
    );
  });

  /**
   * Làm gì: Kiểm tra cơ chế dự phòng trả về kind "error" kèm thông điệp gốc khi gặp lỗi lạ, hoặc câu thông báo mặc định nếu không có errorMessage.
   * Được gọi ở: test runner (node --test)
   */
  it("falls back to a generic error with the raw message", () => {
    // Bước 1: Khi gặp lỗi không xác định, gán kind "error" và giữ lại thông báo lỗi gốc errorMessage
    const state = classifyCallToolError({
      ok: false,
      data: null,
      errorMessage: "boom",
    });
    assert.equal(state?.kind, "error");
    assert.equal(state?.message, "boom");
    // Bước 2: Khi errorMessage rỗng hoặc undefined, sử dụng câu thông báo lỗi mặc định thân thiện với người dùng
    const empty = classifyCallToolError({ ok: false, data: null });
    assert.equal(empty?.kind, "error");
    assert.equal(empty?.message, "Something went wrong. Try again.");
    assert.equal(empty?.detail, undefined);
  });
});
