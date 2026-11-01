import { api, newMember } from "../agent-lib.mjs";

console.log("=== KIỂM TRA CHẨN ĐOÁN LIM-02a (LOGIN) & LIM-02b (OTP) ===");

// 1. LIM-02a: Đăng nhập sai mật khẩu liên tiếp 8 lần
console.log("\n--- THỰC NGHIỆM LIM-02a: ĐĂNG NHẬP SAI MẬT KHẨU 8 LẦN LIÊN TIẾP ---");
const m = await newMember();
console.log(`Tạo hội viên mới: phone=${m.phone}, id=${m.user?.id}`);

for (let i = 1; i <= 8; i++) {
  const res = await api("/auth/login", {
    method: "POST",
    body: { login: m.phone, password: "WrongPassword123!" },
  });
  console.log(`Lần ${i}: status=${res.status}, code=${res.data?.code}, message=${JSON.stringify(res.data?.message)}`);
}

// 2. LIM-02b: Nhập sai OTP liên tiếp 8 lần
console.log("\n--- THỰC NGHIỆM LIM-02b: NHẬP SAI OTP 8 LẦN LIÊN TIẾP ---");
const testPhone = `09${Math.floor(10000000 + Math.random() * 90000000)}`;
// Tạo yêu cầu OTP đăng ký
const reg = await api("/auth/register", {
  method: "POST",
  body: {
    full_name: "Test OTP Lockout",
    phone: testPhone,
    password: "Password123!",
    pii_consent: true,
  },
});
console.log(`Đã gửi OTP tới ${testPhone}, register status=${reg.status}, otp=${reg.data?.otp}`);

for (let i = 1; i <= 8; i++) {
  const res = await api("/auth/otp/verify", {
    method: "POST",
    body: { phone: testPhone, otp: "000000" }, // OTP sai
  });
  console.log(`Lần ${i}: status=${res.status}, code=${res.data?.code}, message=${JSON.stringify(res.data?.message)}`);
}
