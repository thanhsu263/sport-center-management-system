/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho hàm resolveSignInGateState trong src/client/auth/sign-in-gate.ts.
 * Kiểm tra các trạng thái chuyển đổi của cổng xác thực (SignInGate) gồm "pending", "signed_in" và "signed_out"
 * dựa trên cờ isPending (đang kiểm tra phiên) và hasUser (đã có thông tin người dùng).
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong bộ kiểm thử tự động,
 * bảo đảm component SignInGate hiển thị đúng giao diện (chờ, nội dung chính, hoặc nút đăng nhập),
 * tránh hiện tượng nhấp nháy giao diện (flash of unauthenticated content) khi trang web đang tải lại.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSignInGateState } from "./sign-in-gate.ts";

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm resolveSignInGateState, xác minh trạng thái xác thực trong các tình huống phiên khác nhau.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("resolveSignInGateState", () => {
  /**
   * Làm gì: Kiểm tra hàm luôn trả về "pending" khi yêu cầu kiểm tra phiên đang diễn ra (isPending = true), bất kể đã có user hay chưa.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is pending while the session check is in flight, user or not", () => {
    // Khi đang kiểm tra phiên và chưa có user -> giữ trạng thái "pending" để đợi kết quả
    assert.equal(
      resolveSignInGateState({ isPending: true, hasUser: false }),
      "pending",
    );
    // Dù bộ nhớ đệm có user cũ nhưng phiên đang được kiểm tra lại -> vẫn giữ "pending" để tránh dùng dữ liệu lỗi thời
    assert.equal(
      resolveSignInGateState({ isPending: true, hasUser: true }),
      "pending",
    );
  });

  /**
   * Làm gì: Kiểm tra hàm trả về "signed_in" khi phiên đã kiểm tra xong (isPending = false) và có thông tin người dùng (hasUser = true).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is signed_in once a user is present", () => {
    // Đã hoàn tất kiểm tra và xác nhận có người dùng đăng nhập hợp lệ -> chuyển sang "signed_in"
    assert.equal(
      resolveSignInGateState({ isPending: false, hasUser: true }),
      "signed_in",
    );
  });

  /**
   * Làm gì: Kiểm tra hàm chỉ trả về "signed_out" sau khi phiên đã kiểm tra xong (isPending = false) và xác nhận không có người dùng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is signed_out only after the check resolved with no user", () => {
    // Đã hoàn tất kiểm tra và xác nhận là khách vãng lai (không có user) -> an toàn để chuyển sang "signed_out"
    assert.equal(
      resolveSignInGateState({ isPending: false, hasUser: false }),
      "signed_out",
    );
  });
});
