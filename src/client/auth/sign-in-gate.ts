/**
 * Quản lý trạng thái cổng xác thực (Sign-in Gate) ở phía client.
 * File cung cấp các kiểu dữ liệu và hàm thuần túy (pure function) để xác định trạng thái phiên đăng nhập của người dùng,
 * hỗ trợ component SignInGate (src/client/auth/gates.tsx) quyết định hiển thị nội dung, nút đăng nhập hoặc màn hình chờ.
 */
export type SignInGateState = "pending" | "signed_in" | "signed_out";

export type SignInGateInput = {
  isPending: boolean;
  hasUser: boolean;
};

/**
 * Làm gì: Phân giải trạng thái cổng đăng nhập ("pending", "signed_in", "signed_out") dựa trên tiến trình kiểm tra phiên và dữ liệu người dùng.
 * Được gọi ở: src/client/auth/gates.tsx (component SignInGate), test runner (node --test trong src/client/auth/sign-in-gate.test.ts).
 * @param input Đối tượng chứa cờ isPending (đang kiểm tra phiên hay không) và hasUser (đã có user hợp lệ hay chưa).
 * @returns Trạng thái phiên đăng nhập: "pending" nếu đang kiểm tra, "signed_in" nếu đã có người dùng, "signed_out" nếu không có người dùng.
 */
export function resolveSignInGateState(
  input: SignInGateInput,
): SignInGateState {
  // Bước 1: Ưu tiên trả về "pending" khi phiên đang được tải (isPending = true) để tránh chớp nháy giao diện (flash) giữa trạng thái đã đăng nhập và chưa đăng nhập.
  if (input.isPending) return "pending";
  // Bước 2: Khi phiên đã tải xong (isPending = false), kiểm tra nếu có user thì trả về "signed_in", ngược lại trả về "signed_out".
  return input.hasUser ? "signed_in" : "signed_out";
}
