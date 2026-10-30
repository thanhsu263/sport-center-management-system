/**
 * repro-F25.mjs — Tái hiện F-25: POST /classes với assistant_id không tồn tại gây HTTP 500
 */
import { api, ictDate, IDS, login, PHONES } from "../agent-lib.mjs";

console.log("=== REPRO F-25: POST /classes with nonexistent assistant_id ===");

const mgr = await login(PHONES.manager);
const coach = await login(PHONES.coach);

const res = await api("/classes", {
  method: "POST",
  token: mgr.token,
  body: {
    sport: "badminton",
    level: "repro-f25",
    capacity: 10,
    coach_id: coach.user.id,
    assistant_id: "99999999-9999-4999-8999-999999999999", // Nonexistent assistant user
    court_id: IDS.courtCL01,
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9",
    start_on: ictDate(2),
    end_on: ictDate(14),
    duration_min: 60,
  },
});

console.log(`Status: ${res.status}`);
console.log(`Body: ${JSON.stringify(res.data)}`);
console.log(JSON.stringify({ reproduced: res.status === 500, status: res.status }));
