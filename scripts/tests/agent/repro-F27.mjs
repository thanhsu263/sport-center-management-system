/**
 * repro-F27.mjs — Tái hiện F-27: Ký tự NUL byte trong chuỗi đầu vào gây HTTP 500
 */
import { api, login, PHONES } from "../agent-lib.mjs";

console.log("=== REPRO F-27: Null byte in input string causing HTTP 500 ===");

const member = await login(PHONES.memberNoPlan);

const res = await api("/me", {
  method: "PATCH",
  token: member.token,
  body: { full_name: "Test\u0000Name" },
});

console.log(`Status: ${res.status}`);
console.log(`Body: ${JSON.stringify(res.data)}`);
console.log(JSON.stringify({ reproduced: res.status === 500, status: res.status }));
