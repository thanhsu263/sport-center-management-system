/**
 * Suite 12: Background jobs, race conditions, limits & concurrency.
 *
 * Cases:
 *  - JOB-01: Hold expiration sweep & slot reopening
 *  - JOB-02: Payment/confirm on an expired hold rejected (4xx)
 *  - JOB-03: Waitlist offer expiry when unaccepted
 *  - JOB-04: Cashier shift close tallies cash payments accurately
 *  - RACE-01: Concurrent hold on identical slot (1 wins, 1 gets 409 CONFLICT_SLOT)
 *  - RACE-02: Concurrent class enrollment on capacity=1 (1 confirmed, others waitlisted)
 *  - RACE-03: Concurrent acceptance of same waitlist offer (1 wins, 1 gets 409 CONFLICT_STATE)
 *  - RACE-04: Concurrent requests with identical Idempotency-Key
 *  - RACE-05: Concurrent redemption of max_uses=1 promo (1 wins, 1 gets 422 BR-41)
 *  - RACE-06: Concurrent shift close calls (1 wins, 1 gets 409 CONFLICT_STATE)
 *  - LIM-01: Rapid registration loop to F-04 boundary returns clean 4xx/2xx, never 500
 *  - LIM-02: Repeated failed logins return 400/401/429, never 500
 *  - LIM-03: Oversized request payload returns 4xx cleanly, never 500
 *
 * Run: node scripts/tests/agent/run-suite.mjs 12
 */
import {
  IDS,
  PHONES,
  api,
  blocked,
  check,
  freeSlotAnyDay,
  ictDate,
  login,
  memberWithPlan,
  newMember,
  sleep,
  summary,
} from "../agent-lib.mjs";

console.log("=== Suite 12: Jobs & Races ===");

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const coach = await login(PHONES.coach);

// ───────────────────────────── 1. Background Jobs (JOB-) ─────────────────────────────

// JOB-01 & JOB-02: Hold expiration sweep & expired hold confirmation
console.log("\n--- JOB-01 & JOB-02: Hold expiration ---");
const patchSet = await api("/settings", {
  method: "PATCH",
  token: mgr.token,
  body: { hold_minutes: 1 },
});
if (patchSet.status !== 200) {
  blocked("JOB-01", "Hold expires after hold_minutes", `Could not set hold_minutes to 1: ${patchSet.status}`);
  blocked("JOB-02", "Confirming expired hold", "Prerequisite hold_minutes=1 failed");
} else {
  const J1 = await newMember();
  const sHold = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 });
  if (!sHold) {
    blocked("JOB-01", "Hold expires", "No free slot available");
    blocked("JOB-02", "Confirm expired hold", "No free slot available");
  } else {
    const h1 = await api("/bookings", {
      method: "POST",
      token: J1.token,
      idem: true,
      body: { court_id: sHold.court_id, start_at: sHold.start_at },
    });
    if (h1.status !== 201) {
      blocked("JOB-01", "Hold creation", `POST /bookings failed: ${h1.status}`);
      blocked("JOB-02", "Confirm expired hold", "Hold creation failed");
    } else {
      console.log("Waiting 80s for 1-minute hold to expire and background sweep to trigger...");
      await sleep(80_000);

      // Check whether background sweep cancelled the hold (poll up to 25s for 15s interval tick)
      for (let attempt = 0; attempt < 5; attempt++) {
        const bStatus = await api(`/bookings/${h1.data.booking.id}`, { token: mgr.token });
        if (bStatus.data?.booking?.status === "cancelled") {
          console.log(`Hold swept and cancelled after attempt ${attempt + 1}`);
          break;
        }
        await sleep(5_000);
      }

      // Verify slot is reopened by having Member J2 hold it
      const J2 = await newMember();
      const h2 = await api("/bookings", {
        method: "POST",
        token: J2.token,
        idem: true,
        body: { court_id: sHold.court_id, start_at: sHold.start_at },
      });
      check("JOB-01", "Hold expires after hold_minutes and slot reopened", h2, {
        status: 201,
        test: (r) => r.data?.booking?.status === "hold",
        why: "new hold succeeds on released slot",
      });

      // JOB-02: Member J1 attempts to confirm expired hold
      const cf = await api(`/bookings/${h1.data.booking.id}/confirm`, {
        method: "POST",
        token: J1.token,
        idem: true,
        body: { method: "transfer" },
      });
      check("JOB-02", "Confirming an expired hold is rejected (4xx) and creates no booking", cf, {
        status: [409, 422],
        notStatus: [200, 201, 202, 500],
      });
    }
  }

  // Restore hold_minutes setting to default
  await api("/settings", {
    method: "PATCH",
    token: mgr.token,
    body: { hold_minutes: 10 },
  });
}

// JOB-03: Waitlist offer expiry
blocked(
  "JOB-03",
  "Waitlist offer expiry when unaccepted",
  "Requires 1-hour waitlist_offer_hours elapse; no time travel API endpoint available",
);

// JOB-04: Shift close tallies cash accurately
console.log("\n--- JOB-04: Shift close cash tally ---");
const rec2 = await login(PHONES.receptionist2);
const curShift = await api("/shifts/current", { token: rec2.token });
let s4Id = curShift.data?.shift?.id;
if (!s4Id) {
  const openRes = await api("/shifts/open", { method: "POST", token: rec2.token });
  s4Id = openRes.data?.shift?.id;
}

if (!s4Id) {
  blocked("JOB-04", "Shift close tally", "Could not acquire open cashier shift for receptionist2");
} else {
  // Post 2 cash payments in this shift using booking payments at the desk
  const mForTally = await newMember();
  const sA = await freeSlotAnyDay(rec2.token, { court: IDS.court1 });
  const hA = await api("/bookings", {
    method: "POST",
    token: mForTally.token,
    idem: true,
    body: { court_id: sA.court_id, start_at: sA.start_at },
  });
  const bA = hA.data?.booking;
  const pay1 = await api("/payments", {
    method: "POST",
    token: rec2.token,
    idem: true,
    body: {
      ref_type: "booking",
      ref_id: bA?.id,
      method: "cash",
      amount_vnd: bA?.price_vnd ?? 60000,
    },
  });

  const sB = await freeSlotAnyDay(rec2.token, { court: IDS.court2 });
  const hB = await api("/bookings", {
    method: "POST",
    token: mForTally.token,
    idem: true,
    body: { court_id: sB.court_id, start_at: sB.start_at },
  });
  const bB = hB.data?.booking;
  const pay2 = await api("/payments", {
    method: "POST",
    token: rec2.token,
    idem: true,
    body: {
      ref_type: "booking",
      ref_id: bB?.id,
      method: "cash",
      amount_vnd: bB?.price_vnd ?? 60000,
    },
  });

  const amt1 = Number(pay1.data?.payment?.amount_vnd ?? bA?.price_vnd ?? 60000);
  const amt2 = Number(pay2.data?.payment?.amount_vnd ?? bB?.price_vnd ?? 60000);
  const totalCash = amt1 + amt2;

  // JOB-04 gốc: Chỉ có tiền mặt, tổng két = tổng cash
  const clShift = await api(`/shifts/${s4Id}/close`, {
    method: "POST",
    token: rec2.token,
    body: { cash_declared_vnd: totalCash },
  });
  check("JOB-04", "Cashier shift close tallies cash payments posted in shift", clShift, {
    status: 200,
    test: (r) => r.data?.cash_system_vnd === totalCash,
    why: `cash_system_vnd (${clShift.data?.cash_system_vnd}) must equal sum of cash payments (${totalCash})`,
  });

  // JOB-04b: Shift close với payment method=quota (F-12)
  // Mở ca mới cho rec, post 1 payment quota, đóng ca kiểm tra tiền két không tính quota
  const s4bOpen = await api("/shifts/open", { method: "POST", token: rec.token });
  const s4bId = s4bOpen.data?.shift?.id;
  if (s4bId) {
    await api("/payments", {
      method: "POST",
      token: rec.token,
      idem: true,
      body: {
        ref_type: "booking",
        ref_id: bA?.id,
        method: "quota",
        amount_vnd: 100000,
      },
    });
    const clShift4b = await api(`/shifts/${s4bId}/close`, {
      method: "POST",
      token: rec.token,
      body: { cash_declared_vnd: 0 },
    });
    check("JOB-04b", "Shift close excludes quota payments from cash_system_vnd (F-12)", clShift4b, {
      status: 200,
      test: (r) => r.data?.cash_system_vnd === 0,
      why: `cash_system_vnd (${clShift4b.data?.cash_system_vnd}) must not count quota phantom revenue into cash (expected 0, F-12)`,
    });
  } else {
    blocked("JOB-04b", "Shift close quota test", "could not open shift for receptionist");
  }
}

// ───────────────────────────── 2. Race Conditions (RACE-) ─────────────────────────────

// RACE-01: 2 members book identical slot concurrently
console.log("\n--- RACE-01: Concurrent booking slot hold ---");
const M1 = await newMember();
const M2 = await newMember();
const sRace1 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 });
if (!sRace1) {
  blocked("RACE-01", "Concurrent hold", "No free slot available");
} else {
  const [res1, res2] = await Promise.all([
    api("/bookings", {
      method: "POST",
      token: M1.token,
      idem: true,
      body: { court_id: sRace1.court_id, start_at: sRace1.start_at },
    }),
    api("/bookings", {
      method: "POST",
      token: M2.token,
      idem: true,
      body: { court_id: sRace1.court_id, start_at: sRace1.start_at },
    }),
  ]);
  const race1Statuses = [res1.status, res2.status].sort();
  check("RACE-01", "2 members holding same slot concurrently: 1 wins (201), 1 gets 409 CONFLICT_SLOT", {
    status: 200,
    data: { s1: res1.status, s2: res2.status, codes: [res1.data?.code, res2.data?.code] },
    request: { method: "POST", path: "/bookings" },
  }, {
    test: () => race1Statuses[0] === 201 && race1Statuses[1] === 409,
    why: "exactly one 201 and one 409 CONFLICT_SLOT",
  });
}

// RACE-02: N members enroll in 1-capacity class concurrently
console.log("\n--- RACE-02: Concurrent class enrollment on capacity=1 ---");
const createCl = await api("/classes", {
  method: "POST",
  token: mgr.token,
  body: {
    sport: "badminton",
    level: "agent-race",
    capacity: 1,
    coach_id: coach.user.id,
    court_id: IDS.courtCL02,
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=9",
    start_on: ictDate(2),
    end_on: ictDate(14),
    duration_min: 60,
  },
});
const classId = createCl.data?.id;
await api(`/classes/${classId}/publish`, { method: "POST", token: mgr.token });

const MB1 = await memberWithPlan(mgr.token, IDS.planBadminton30);
const MB2 = await memberWithPlan(mgr.token, IDS.planBadminton30);
const MB3 = await memberWithPlan(mgr.token, IDS.planBadminton30);

const enrollResults = await Promise.all([
  api(`/classes/${classId}/enroll`, { method: "POST", token: MB1.token }),
  api(`/classes/${classId}/enroll`, { method: "POST", token: MB2.token }),
  api(`/classes/${classId}/enroll`, { method: "POST", token: MB3.token }),
]);

const confirmedCount = enrollResults.filter(
  (r) => r.status === 201 && r.data?.waitlisted !== true && r.data?.enrollment?.status === "confirmed",
).length;
const waitlistCount = enrollResults.filter(
  (r) => r.status === 201 && (r.data?.waitlisted === true || r.data?.enrollment?.status === "waitlisted"),
).length;
const clCheck = await api(`/classes/${classId}`, { token: mgr.token });

check("RACE-02", "3 members enrolling into capacity 1 class concurrently: 1 confirmed, 2 waitlisted, count <= capacity", {
  status: 200,
  data: { confirmedCount, waitlistCount, enrolled_count: clCheck.data?.class?.enrolled_count },
  request: { method: "POST", path: `/classes/${classId}/enroll` },
}, {
  test: () => confirmedCount === 1 && waitlistCount === 2 && clCheck.data?.class?.enrolled_count === 1,
  why: "exactly 1 confirmed, 2 waitlisted, enrolled_count equals 1",
});

// RACE-03: 2 concurrent accepts of waitlist offer
console.log("\n--- RACE-03: Concurrent acceptance of waitlist offer ---");
const confirmedEnr = enrollResults.find(
  (r) => r.data?.enrollment?.status === "confirmed",
)?.data?.enrollment;
const confirmedMemberToken = [MB1, MB2, MB3].find((m) => m.user.id === confirmedEnr?.user_id)?.token;

if (!confirmedEnr || !confirmedMemberToken) {
  blocked("RACE-03", "Waitlist offer acceptance race", "No confirmed enrollment to cancel");
} else {
  // Cancel confirmed enrollment to trigger inviteWaitlist
  await api(`/enrollments/${confirmedEnr.id}`, { method: "DELETE", token: confirmedMemberToken });

  // Find waitlisted member who received offer notification
  const wlMembers = [MB1, MB2, MB3].filter((m) => m.user.id !== confirmedEnr.user_id);
  let offerId = null;
  let targetWlMember = null;

  for (const m of wlMembers) {
    const notis = await api("/me/notifications", { token: m.token });
    const offerNoti = notis.data?.items?.find((n) => n.template === "waitlist_offer");
    if (offerNoti?.payload?.offer_id) {
      offerId = offerNoti.payload.offer_id;
      targetWlMember = m;
      break;
    }
  }

  if (!offerId || !targetWlMember) {
    blocked("RACE-03", "Waitlist offer acceptance race", "No waitlist offer received in notifications");
  } else {
    const [acc1, acc2] = await Promise.all([
      api(`/waitlist/${offerId}/accept`, { method: "POST", token: targetWlMember.token }),
      api(`/waitlist/${offerId}/accept`, { method: "POST", token: targetWlMember.token }),
    ]);
    const accStatuses = [acc1.status, acc2.status].sort();
    check("RACE-03", "2 concurrent accepts of waitlist offer: 1 succeeds (200), 1 gets 409 CONFLICT_STATE", {
      status: 200,
      data: { acc1: acc1.status, acc2: acc2.status },
      request: { method: "POST", path: `/waitlist/${offerId}/accept` },
    }, {
      test: () => accStatuses[0] === 200 && accStatuses[1] === 409,
      why: "exactly one 200 and one 409 CONFLICT_STATE",
    });
  }
}

// RACE-04: Concurrent requests with identical Idempotency-Key
console.log("\n--- RACE-04: Concurrent requests with identical Idempotency-Key ---");
const idemKey = crypto.randomUUID();
const raceSlot = await freeSlotAnyDay(mgr.token, { court: IDS.court1 });
const [idemRes1, idemRes2] = await Promise.all([
  api("/bookings", { method: "POST", token: MB1.token, idemKey, body: { court_id: raceSlot.court_id, start_at: raceSlot.start_at } }),
  api("/bookings", { method: "POST", token: MB1.token, idemKey, body: { court_id: raceSlot.court_id, start_at: raceSlot.start_at } }),
]);
check("RACE-04", "2 concurrent requests with same Idempotency-Key return identical result and single effect", {
  status: 200,
  data: { s1: idemRes1.status, s2: idemRes2.status, b1: idemRes1.data?.booking?.id, b2: idemRes2.data?.booking?.id },
  request: { method: "POST", path: "/bookings" },
}, {
  test: () =>
    idemRes1.status === 201 &&
    idemRes2.status === 201 &&
    Boolean(idemRes1.data?.booking?.id) &&
    idemRes1.data?.booking?.id === idemRes2.data?.booking?.id,
  why: "both return 201 with identical booking id",
});

// RACE-05: Concurrent redemption of max_uses=1 promo
console.log("\n--- RACE-05: Concurrent redemption of max_uses=1 promo ---");
const promoCode = "RACE" + Math.floor(1000 + Math.random() * 9000);
const createPr = await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: {
    code: promoCode,
    name: "Race Promo",
    kind: "amount",
    value: 50000,
    min_order_vnd: 100000,
    max_uses: 1,
    max_per_member: 1,
    applies_to: ["plan"],
    sport: "badminton",
    starts_at: new Date(Date.now() - 3600000).toISOString(),
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    status: "active",
  },
});
const promoId = createPr.data?.promo?.id;
const PA = await newMember();
const PB = await newMember();
const subA = await api("/subscriptions", {
  method: "POST",
  token: mgr.token,
  body: { plan_id: IDS.planBadminton30, user_id: PA.user.id },
});
const subB = await api("/subscriptions", {
  method: "POST",
  token: mgr.token,
  body: { plan_id: IDS.planBadminton30, user_id: PB.user.id },
});

const [payA, payB] = await Promise.all([
  api("/payments", {
    method: "POST",
    token: mgr.token,
    idem: true,
    body: {
      ref_type: "subscription",
      ref_id: subA.data.subscription.id,
      method: "cash",
      amount_vnd: subA.data.amount_due_vnd - 50000,
      promo_code: promoCode,
    },
  }),
  api("/payments", {
    method: "POST",
    token: mgr.token,
    idem: true,
    body: {
      ref_type: "subscription",
      ref_id: subB.data.subscription.id,
      method: "cash",
      amount_vnd: subB.data.amount_due_vnd - 50000,
      promo_code: promoCode,
    },
  }),
]);

const payStatuses = [payA.status, payB.status].sort();
const redemptions = await api(`/promotions/${promoId}/redemptions`, { token: mgr.token });

check("RACE-05", "2 concurrent redemptions of max_uses=1 promo: 1 wins (201), 1 gets 422 BR-41", {
  status: 200,
  data: { payA: payA.status, payB: payB.status, redemptionsCount: redemptions.data?.items?.length },
  request: { method: "POST", path: "/payments" },
}, {
  test: () => payStatuses[0] === 201 && payStatuses[1] === 422 && redemptions.data?.items?.length === 1,
  why: "one 201, one 422, exactly 1 redemption recorded",
});

// RACE-06: Concurrent shift close
console.log("\n--- RACE-06: Concurrent shift close ---");
const shOpen = await api("/shifts/open", { method: "POST", token: rec.token });
const shId = shOpen.data?.shift?.id;
if (!shId) {
  blocked("RACE-06", "Concurrent shift close", "Could not open shift for receptionist");
} else {
  const [shC1, shC2] = await Promise.all([
    api(`/shifts/${shId}/close`, { method: "POST", token: rec.token, body: { cash_declared_vnd: 0 } }),
    api(`/shifts/${shId}/close`, { method: "POST", token: rec.token, body: { cash_declared_vnd: 0 } }),
  ]);
  const shStatuses = [shC1.status, shC2.status].sort();
  check("RACE-06", "2 concurrent shift close requests: 1 succeeds (200), 1 gets 409 CONFLICT_STATE", {
    status: 200,
    data: { s1: shC1.status, s2: shC2.status },
    request: { method: "POST", path: `/shifts/${shId}/close` },
  }, {
    test: () => shStatuses[0] === 200 && shStatuses[1] === 409,
    why: "one 200 and one 409 CONFLICT_STATE",
  });
}

// ───────────────────────────── 3. Limits & Boundary Testing (LIM-) ─────────────────────────────

console.log("\n--- LIM-01: Rapid registration loop to F-04 boundary ---");
let f04Hit = false;
let lim1Error500 = false;
let regSuccessCount = 0;
for (let i = 0; i < 40; i++) {
  const p = `097${String(Math.floor(1000000 + Math.random() * 9000000))}`;
  const reg = await api("/auth/register", {
    method: "POST",
    body: { full_name: `Lim Member ${i}`, phone: p, password: "TestPassword123!", pii_consent: true },
  });
  if (reg.status === 500) {
    lim1Error500 = true;
    break;
  }
  if (reg.status === 202 && reg.data?.otp) {
    const v = await api("/auth/otp/verify", { method: "POST", body: { phone: p, otp: reg.data.otp } });
    if (v.status === 500) {
      lim1Error500 = true;
      break;
    }
    if (v.status === 409 && v.data?.constraint === "users_member_code_key") {
      f04Hit = true;
      break;
    }
    if (v.status === 200) regSuccessCount++;
  } else if (reg.status === 429) {
    break;
  }
}
check("LIM-01", "Registration loop to F-04 boundary succeeds without member code collision", {
  status: lim1Error500 ? 500 : (f04Hit ? 409 : 200),
  data: { regSuccessCount, f04Hit },
  request: { method: "POST", path: "/auth/register" },
}, {
  test: () => !lim1Error500 && !f04Hit,
  why: f04Hit ? "hit unique constraint collision on users_member_code_key (F-04 active)" : "clean registration loop without member code collision",
});

console.log("\n--- LIM-02a: Repeated failed logins lockout (F-01) ---");
// Bằng chứng code: src/lib/arena3/handlers/auth.ts#L223-L230 quy định:
// if (fails >= 5) { update users set failed_logins = ..., locked_until = now() + interval '15 minutes'; throw err.rateLimited(...); }
// Kỳ vọng: đạt ngưỡng 5 lần sai mật khẩu liên tiếp phải trả về HTTP 429 RATE_LIMITED (errors.ts#L53).
let loginLastStatus = 0;
let loginLastCode = null;
for (let i = 0; i < 5; i++) {
  const badLogin = await api("/auth/login", {
    method: "POST",
    body: { login: "0900000001", password: `WrongPassword${i}!` },
  });
  if (i === 4) {
    loginLastStatus = badLogin.status;
    loginLastCode = badLogin.data?.code;
  }
}
check("LIM-02a", "Failed logins reaching threshold (fails >= 5 per auth.ts#L224) triggers HTTP 429 RATE_LIMITED", {
  status: loginLastStatus,
  data: { status: loginLastStatus, code: loginLastCode },
  request: { method: "POST", path: "/auth/login" },
}, {
  status: 429,
  code: "RATE_LIMITED",
  why: `expected 429 RATE_LIMITED per auth.ts#L224-L230; got status=${loginLastStatus}, code=${loginLastCode} (F-01)`,
});

console.log("\n--- LIM-02b: Repeated OTP attempts rate limiting (F-02) ---");
// Bằng chứng code: src/lib/arena3/handlers/auth.ts#L159 quy định:
// if (ch.attempts >= 5) throw err.rateLimited("Too many OTP attempts — locked for 15 minutes.");
// Mỗi lần sai: update otp_challenges set attempts = attempts + 1 (auth.ts#L162).
// Kỳ vọng: sau 5 lần sai, lần thử thứ 6 phải bị chặn bởi ch.attempts >= 5 và trả về HTTP 429 RATE_LIMITED (errors.ts#L53).
const pOtp = `098${String(Math.floor(1000000 + Math.random() * 9000000))}`;
const regOtp = await api("/auth/register", {
  method: "POST",
  body: { full_name: "OTP Test Member", phone: pOtp, password: "Password123!", pii_consent: true },
});
let otp6Status = 0;
let otp6Code = null;
if (regOtp.status === 202) {
  for (let i = 0; i < 6; i++) {
    const badOtp = await api("/auth/otp/verify", {
      method: "POST",
      body: { phone: pOtp, otp: "000000" },
    });
    if (i === 5) {
      otp6Status = badOtp.status;
      otp6Code = badOtp.data?.code;
    }
  }
}
check("LIM-02b", "OTP attempts exceeding threshold (attempts >= 5 per auth.ts#L159) triggers HTTP 429 RATE_LIMITED", {
  status: otp6Status,
  data: { status: otp6Status, code: otp6Code },
  request: { method: "POST", path: "/auth/otp/verify" },
}, {
  status: 429,
  code: "RATE_LIMITED",
  why: `expected 429 RATE_LIMITED per auth.ts#L159; got status=${otp6Status}, code=${otp6Code} (F-02)`,
});

console.log("\n--- LIM-03: Oversized request payload ---");
const bigBody = {
  login: "0999999999",
  password: "A".repeat(10_000),
};
const bigRes = await api("/auth/login", { method: "POST", body: bigBody });
check("LIM-03", "Oversized payload (10KB) returns 4xx cleanly, never 500", bigRes, {
  notStatus: [429, 500],
  test: (r) => r.status >= 400 && r.status < 500 && r.status !== 429,
  why: "status is 4xx, not 429 (not locked), and never 500",
});

summary();
