/**
 * File: src/client/lib/multiplayer/p2p.test.ts
 * Vai trò: Kiểm thử tự động (unit test) cho module mạng ngang hàng P2PRoom.
 * Tập trung kiểm tra tính năng xác thực signaling (gửi Bearer token, refresh token),
 * xử lý khi relay từ chối phiên (401/403) và cơ chế tự động thử lại khi gặp lỗi tạm thời (503).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { P2PRoom } from "./p2p";

/**
 * The signaling calls, with `fetch` swapped out.
 *
 * `p2p.ts` only touches WebRTC APIs once a roster comes back with somebody in
 * it, so an empty roster lets the join, poll, signal and leave paths run under
 * plain node. Runs under `tsx` (see the `test` script) because this module is
 * imported without a file extension.
 */

// Cấu trúc dữ liệu ghi lại thông tin mỗi request HTTP fetch đã gửi đi trong môi trường test
type Call = { url: string; method: string; headers: Record<string, string> };

/**
 * Làm gì: Chuyển đổi toàn bộ tên các HTTP header về dạng chữ thường để dễ dàng so sánh trong test
 * Được gọi ở: src/client/lib/multiplayer/p2p.test.ts trong hàm harness
 * @param headers Danh sách headers ban đầu từ request
 * @returns Record<string, string> Đối tượng headers mới với tất cả key viết thường
 */
function lower(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries((headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

/**
 * Làm gì: Tạo môi trường test giả lập (test harness), ghi đè globalThis.fetch và console.warn để chặn và kiểm tra các request signaling
 * Được gọi ở: Các bài test bên dưới trong file p2p.test.ts
 * @param responder Callback nhận HTTP method và trả về phản hồi giả lập tương ứng
 * @returns Đối tượng chứa danh sách calls đã ghi nhận và hàm restore để dọn dẹp môi trường
 */
function harness(responder: (method: string) => { ok: boolean; status: number; body?: unknown }) {
  // Bước 1: Khởi tạo mảng lưu lịch sử calls và sao lưu các hàm gốc của môi trường
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  // The room logs a refusal on purpose; keep it out of the test output.
  console.warn = () => {};
  // Bước 2: Ghi đè globalThis.fetch để chặn và ghi nhận các cuộc gọi signaling
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, headers: lower(init?.headers) });
    const r = responder(method);
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
  }) as typeof fetch;
  // Bước 3: Trả về đối tượng chứa danh sách calls để assert và hàm restore để hoàn nguyên môi trường
  return {
    calls,
    /**
     * Làm gì: Khôi phục lại globalThis.fetch và console.warn về trạng thái gốc ban đầu sau khi test xong
     * Được gọi ở: Khối finally của các bài test trong file này
     * @returns void
     */
    restore() {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    },
  };
}

/**
 * Làm gì: Dữ liệu phản hồi mẫu HTTP 200 chứa danh sách peers và signals rỗng (phòng chưa có ai)
 * Được gọi ở: Truyền vào hàm harness trong các bài test của file này
 */
const emptyRoster = { ok: true, status: 200, body: { peers: [], signals: [] } };

// Bộ kiểm thử xác thực signaling và cơ chế thử lại của P2PRoom
describe("p2p signaling auth", () => {
  /**
   * Làm gì: Kiểm tra P2PRoom luôn gửi session token trong Authorization header và không để lộ token trên URL
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   */
  it("sends the session token on every signaling call", async () => {
    // Bước 1: Khởi tạo test harness với danh sách peer rỗng và tạo P2PRoom có getAuthToken
    const h = harness(() => emptyRoster);
    const room = new P2PRoom({ room: "r1", selfId: "u1", getAuthToken: () => "tok-123" });
    try {
      // Bước 2: Thực hiện join phòng và đóng phòng (close) để phát sinh các cuộc gọi signaling
      await room.join();
      room.close();
      // The poll, and the leave that teardown fires.
      // Bước 3: Kiểm tra các request phát sinh: phải có cả poll và leave, kèm Bearer token chính xác
      assert.ok(h.calls.length >= 2, `expected a poll and a leave, got ${h.calls.length}`);
      for (const c of h.calls) {
        assert.equal(c.headers.authorization, "Bearer tok-123", `${c.method} ${c.url} carried no token`);
      }
      // Never in the query string: that ends up in logs and history.
      const poll = h.calls.find((c) => c.method === "GET");
      assert.ok(poll && !poll.url.includes("tok-123"));
    } finally {
      h.restore();
    }
  });

  /**
   * Làm gì: Kiểm tra request signaling không gửi Authorization header khi ứng dụng không cung cấp getAuthToken
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   */
  it("omits the header when the app supplies no token", async () => {
    // Bước 1: Khởi tạo P2PRoom không truyền hàm getAuthToken
    const h = harness(() => emptyRoster);
    const room = new P2PRoom({ room: "r1", selfId: "u1" });
    try {
      // Bước 2: Thực hiện join và close phòng
      await room.join();
      room.close();
      // Bước 3: Xác nhận toàn bộ request gửi đi đều không có Authorization header
      for (const c of h.calls) assert.equal(c.headers.authorization, undefined);
    } finally {
      h.restore();
    }
  });

  /**
   * Làm gì: Kiểm tra P2PRoom gọi getAuthToken mới nhất cho từng request, đảm bảo token mới được dùng sau khi refresh
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   */
  it("reads the token fresh on each call, so a refresh is picked up", async () => {
    // Bước 1: Khởi tạo P2PRoom với token ban đầu là 'first'
    const h = harness(() => emptyRoster);
    let token = "first";
    const room = new P2PRoom({ room: "r1", selfId: "u1", getAuthToken: () => token });
    try {
      // Bước 2: Thực hiện join với token ban đầu, sau đó đổi token thành 'second' và close phòng
      await room.join();
      token = "second";
      room.close();
      // Bước 3: Xác nhận request leave cuối cùng sử dụng token mới ('second')
      const leave = h.calls.at(-1);
      assert.equal(leave?.headers.authorization, "Bearer second");
    } finally {
      h.restore();
    }
  });

  /**
   * Làm gì: Kiểm tra P2PRoom tự dừng hoạt động khi relay từ chối phiên (401), không retry liên tục gây nghẽn tài nguyên
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   */
  it("stops the room when the relay refuses the session", async () => {
    // Bước 1: Giả lập signaling server trả về lỗi 401 Unauthorized khi nhận request poll GET
    let polls = 0;
    const h = harness((method) => {
      if (method === "GET") polls += 1;
      return { ok: false, status: 401, body: {} };
    });
    // Bước 2: Khởi tạo P2PRoom với callback onAuthError để bắt mã trạng thái từ chối phiên
    let refused: number | null = null;
    const room = new P2PRoom({
      room: "r1",
      selfId: "u1",
      onAuthError: (s) => {
        refused = s;
      },
    });
    try {
      // Bước 3: Thực hiện join phòng và kiểm tra lỗi xác thực
      await room.join();
      assert.equal(refused, 401);
      // One attempt, not a retry loop. This is the whole bug: the poll loop
      // swallowed the 401 and asked again on every tick, so a signaling route
      // that answered 401 to everything looked like P2P simply being
      // unavailable. Waited past IDLE_POLL_MS (2s), or a room that *is* still
      // polling would look identical to one that stopped.
      await new Promise((r) => setTimeout(r, 2300));
      assert.equal(polls, 1);
    } finally {
      room.close();
      h.restore();
    }
  });

  /**
   * Làm gì: Kiểm tra P2PRoom tiếp tục thử lại (retry) khi gặp sự cố tạm thời (503) thay vì dừng kết nối
   * Được gọi ở: test runner (node --test)
   * @returns Promise<void>
   */
  it("keeps retrying a transient failure", async () => {
    // Bước 1: Giả lập server trả về lỗi 503 Service Unavailable khi nhận request poll GET
    let polls = 0;
    const h = harness((method) => {
      if (method !== "GET") return emptyRoster;
      polls += 1;
      return { ok: false, status: 503, body: {} };
    });
    // Bước 2: Khởi tạo P2PRoom và theo dõi cờ refused qua callback onAuthError
    let refused = false;
    const room = new P2PRoom({ room: "r1", selfId: "u1", onAuthError: () => (refused = true) });
    try {
      // Bước 3: Thực hiện join phòng và xác nhận hệ thống tiếp tục thử lại (retry) mà không kích hoạt onAuthError
      await room.join();
      // Past IDLE_POLL_MS: with no peers yet the loop ticks every 2s, not 400ms.
      await new Promise((r) => setTimeout(r, 2300));
      // A relay that is briefly down is not a refusal: the room must not give up.
      assert.equal(refused, false);
      assert.ok(polls > 1, `expected a retry, saw ${polls} poll(s)`);
    } finally {
      room.close();
      h.restore();
    }
  });
});
