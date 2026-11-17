/**
 * File: src/client/components/otp-input.tsx
 * Vai trò: Cung cấp các component nhập mã OTP 6 số (OtpInput), nút đếm ngược gửi lại mã (OtpResend) và hàm phân bổ ký tự OTP (spreadOtpDigits).
 * Vị trí trong hệ thống: Được sử dụng trong các màn hình xác thực tài khoản như đăng ký (register) và quên mật khẩu (forgot).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "./ui";
import { t } from "../lib/i18n";

/**
 * Làm gì: Phân bổ các chữ số từ chuỗi nhập hoặc paste vào mã OTP 6 ký tự bắt đầu từ ô chỉ định và tính toán vị trí ô cần focus tiếp theo.
 * Được gọi ở: src/client/components/otp-input.tsx (hàm fill), src/server/services/arena3.test.ts (bộ test kiểm thử OTP).
 * @param value Chuỗi mã OTP hiện tại.
 * @param index Vị trí ô input đang nhận dữ liệu (từ 0 đến 5).
 * @param text Chuỗi ký tự người dùng vừa nhập hoặc paste vào.
 * @returns Object gồm `value` (chuỗi OTP mới đã ghép và loại bỏ khoảng trắng thừa ở cuối) và `focusIndex` (chỉ số ô cần focus tiếp theo, hoặc null).
 */
export function spreadOtpDigits(value: string, index: number, text: string) {
  // Bước 1: Lọc bỏ ký tự không phải số (\D) và cắt tối đa theo số ô còn trống tính từ index.
  const incoming = text.replace(/\D/g, "").slice(0, 6 - index);
  // Bước 2: Chuẩn hóa chuỗi OTP hiện tại thành mảng 6 phần tử, các ô trống được lấp bằng khoảng trắng.
  const digits = value.padEnd(6, " ").split("");
  // Nếu text rỗng (người dùng xóa ký tự), đặt ô hiện tại thành khoảng trắng để giữ nguyên độ dài mảng.
  if (!text) digits[index] = " ";
  // Bước 3: Ghi đè từng chữ số mới vào các ô liên tiếp bắt đầu từ vị trí index.
  for (let offset = 0; offset < incoming.length; offset++) {
    digits[index + offset] = incoming[offset];
  }
  // Bước 4: Trả về chuỗi OTP hoàn chỉnh và vị trí ô tiếp theo cần focus (giới hạn tối đa ô 5).
  return {
    value: digits.join("").trimEnd(),
    focusIndex: incoming.length ? Math.min(5, index + incoming.length) : null,
  };
}

/**
 * Làm gì: Component hiển thị 6 ô nhập mã OTP riêng biệt, hỗ trợ paste chuỗi số, tự động chuyển focus, phím xóa lùi và mũi tên điều hướng.
 * Được gọi ở: src/routes/register.tsx (RegisterPage), src/routes/forgot.tsx (ForgotPage).
 * Props quan trọng:
 * - value: Chuỗi OTP 6 số hiện tại người dùng đang nhập.
 * - onChange: Callback nhận chuỗi OTP mới khi có thay đổi.
 * - invalid: Cờ đánh dấu dữ liệu không hợp lệ để đổi viền ô sang màu đỏ cảnh báo.
 * - errorId: ID của thông báo lỗi phục vụ trợ năng (aria-describedby).
 * @returns Phần tử JSX biểu diễn nhóm ô nhập mã OTP.
 */
export function OtpInput({ value, onChange, invalid, errorId }: {
  value: string; onChange: (value: string) => void; invalid?: boolean; errorId?: string;
}) {
  // Mảng ref lưu trữ tham chiếu đến 6 phần tử DOM input để điều khiển focus bàn phím.
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const label = useId();
  // Tách chuỗi OTP thành mảng 6 ký tự để render tương ứng vào 6 ô input.
  const digits = value.padEnd(6, " ").split("");
  // Hàm focus an toàn vào ô input theo index (kẹp trong khoảng 0 đến 5 để tránh lỗi ngoài mảng).
  const focus = (index: number) => inputs.current[Math.max(0, Math.min(5, index))]?.focus();
  // Xử lý khi người dùng nhập hoặc paste số: tính toán lại chuỗi OTP và tự động nhảy con trỏ sang ô kế tiếp.
  const fill = (index: number, text: string) => {
    const next = spreadOtpDigits(value, index, text);
    onChange(next.value);
    if (next.focusIndex !== null) focus(next.focusIndex);
  };
  return <div role="group" aria-labelledby={label} aria-describedby={invalid ? errorId : undefined}>
    <p id={label} className="mb-2 text-center text-sm font-medium">{t("6-digit code")}</p>
    <div className="mx-auto grid w-full max-w-72 grid-cols-6 gap-2">
      {digits.map((digit, index) => <Input key={index}
        ref={(node) => { inputs.current[index] = node; }}
        className={`aspect-square h-auto min-w-0 px-0 text-center text-xl tabular-nums ${invalid ? "border-danger" : ""}`}
        aria-label={t("Digit {n}", { n: index + 1 })} aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        inputMode="numeric" autoComplete={index === 0 ? "one-time-code" : "off"}
        value={digit.trim()} required pattern="[0-9]" maxLength={6}
        onFocus={(e) => e.target.select()}
        onChange={(e) => fill(index, e.target.value)}
        onPaste={(e) => {
          e.preventDefault();
          fill(index, e.clipboardData.getData("text"));
        }}
        onKeyDown={(e) => {
          if (e.key === "Backspace" && !digit.trim()) { e.preventDefault(); focus(index - 1); }
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault(); focus(index + (e.key === "ArrowLeft" ? -1 : 1));
          }
        }} />)}
    </div>
  </div>;
}

/**
 * Làm gì: Component hiển thị nút gửi lại mã OTP kèm bộ đếm ngược thời gian chờ (cooldown) để ngăn người dùng spam yêu cầu.
 * Được gọi ở: src/routes/register.tsx (RegisterPage), src/routes/forgot.tsx (ForgotPage).
 * Props quan trọng:
 * - until: Mốc thời gian timestamp (ms) kết thúc khoảng thời gian chờ gửi lại mã.
 * - disabled: Cờ vô hiệu hóa nút bấm (ví dụ khi đang gửi request xử lý trên server).
 * - onResend: Callback được gọi khi người dùng bấm nút gửi lại mã.
 * @returns Phần tử JSX hiển thị nút gửi lại mã OTP hoặc thời gian đếm ngược còn lại.
 */
export function OtpResend({ until, disabled, onResend }: { until: number; disabled: boolean; onResend: () => void }) {
  const [now, setNow] = useState(Date.now);
  // Bước 1: Khởi tạo timer cập nhật timestamp hiện tại mỗi 500ms để đếm ngược mượt mà, dọn dẹp timer khi unmount.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  // Bước 2: Tính số giây đếm ngược còn lại cho đến mốc until (làm tròn lên và không âm).
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return <div className="border-t border-line pt-4 text-center text-sm">
    <button type="button" className="hit text-accent-2 underline underline-offset-2 disabled:text-muted disabled:no-underline"
      disabled={disabled || seconds > 0} onClick={onResend}>
      {seconds ? t("Resend in {seconds}s", { seconds }) : t("Didn't get a code? Resend")}
    </button>
  </div>;
}
