/**
 * repro-F28.mjs — Tái hiện F-28: Body JSON null gây TypeError HTTP 500
 */
import { api, login, PHONES } from "../agent-lib.mjs";

console.log("=== REPRO F-28: Body null causing TypeError HTTP 500 ===");

const member = await login(PHONES.memberNoPlan);

// Raw fetch với body là 'null' và content-type: application/json
const res = await api("/me", {
  method: "PATCH",
  token: member.token,
  body: null,
});

console.log(`Status: ${res.status}`);
console.log(`Body: ${JSON.stringify(res.data)}`);
console.log(JSON.stringify({ reproduced: res.status === 500, status: res.status }));
