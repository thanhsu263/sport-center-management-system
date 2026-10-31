/**
 * 14e-deep-races.mjs — Tương tranh mở rộng (Expanded concurrency races)
 * Theo docs/AGENT-TEST-ROUND2.md Bước 5 (14e) & Prompt Vòng 3.
 * Lặp ĐỦ 6 race (RACE-01..06), mỗi race 20 vòng x 5 request song song:
 * - RACE-01: 2+ members hold same slot (20 vòng x 5 reqs)
 * - RACE-02: N members enroll in 1-cap class (20 vòng x 5 reqs)
 * - RACE-03: 2+ accept waitlist offer (20 vòng x 5 reqs)
 * - RACE-04: 2+ identical Idempotency-Key (20 vòng x 5 reqs)
 * - RACE-05: N redeem max_uses=1 promo (20 vòng x 5 reqs)
 * - RACE-06: 2+ concurrent shift close (20 vòng x 5 reqs)
 * Mỗi race là 1 check, kèm tỉ lệ bất thường.
 */
import crypto from "node:crypto";
import {
  api,
  check,
  ictDate,
  IDS,
  login,
  memberWithPlan,
  newMember,
  PHONES,
  slot,
  summary,
} from "../agent-lib.mjs";

console.log("=== 14e — TƯƠNG TRANH MỞ RỘNG (EXPANDED RACES x 20) ===");

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const coach = await login(PHONES.coach);

// Tạo 5 members có gói badminton active dùng chung cho toàn bộ suite
const members = [];
for (let i = 0; i < 5; i++) {
  const m = await memberWithPlan(mgr.token, IDS.planBadminton30);
  members.push(m);
}

const tokens = [mgr.token, rec.token, coach.token, members[0].token, members[1].token];
const memberTokens = members.map((m) => m.token);

// ───── RACE-01: HOLD TRANH CÙNG 1 SLOT (20 LẦN x 5 REQUESTS) ─────
console.log("\n--- Chạy RACE-01: 20 vòng hold slot ---");
let race1Anomalies = 0;
const RACE1_ROUNDS = 20;

for (let round = 0; round < RACE1_ROUNDS; round++) {
  const daysAhead = 2 + (round % 5);
  const hour = 7 + (Math.floor(round / 5) % 10);
  const targetSlot = slot(daysAhead, hour);

  const promises = tokens.map((tok) =>
    api("/bookings", {
      method: "POST",
      token: tok,
      body: { court_id: IDS.courtCL05, start_at: targetSlot },
    })
  );

  const responses = await Promise.all(promises);
  const winners = responses.filter((r) => r.status === 201).length;

  if (winners > 1) {
    race1Anomalies++;
  }

  // Dọn dẹp booking đã tạo nếu có
  for (const r of responses) {
    if (r.status === 201 && r.data?.booking?.id) {
      await api(`/bookings/${r.data.booking.id}/cancel`, { method: "POST", token: mgr.token, body: {} });
    }
  }
}

check(
  "RACE-01",
  `Tranh chấp giữ chỗ 1 slot (20 vòng x 5 reqs): tỉ lệ thắng kép ${race1Anomalies}/${RACE1_ROUNDS}`,
  { status: 200 },
  {
    test: () => race1Anomalies === 0,
    why: `Tuyệt đối không được có 2 người cùng giữ 1 slot (thực tế bất thường: ${race1Anomalies}/${RACE1_ROUNDS})`,
  }
);

// ───── RACE-02: GHI DANH LỚP CAPACITY=1 (20 LẦN x 5 REQUESTS) ─────
console.log("\n--- Chạy RACE-02: 20 vòng enroll lớp capacity=1 ---");
let race2Anomalies = 0;
const RACE2_ROUNDS = 20;

for (let round = 0; round < RACE2_ROUNDS; round++) {
  const clRes = await api("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: `race2-${round}`,
      capacity: 1,
      coach_id: coach.user.id,
      court_id: IDS.courtCL03,
      rrule: `FREQ=WEEKLY;BYDAY=MO;BYHOUR=${8 + (round % 10)}`,
      start_on: ictDate(2 + (round % 5)),
      end_on: ictDate(10 + (round % 5)),
      duration_min: 60,
    },
  });
  const cId = clRes.data?.id;
  if (!cId) continue;
  await api(`/classes/${cId}/publish`, { method: "POST", token: mgr.token });

  const promises = memberTokens.map((tok) =>
    api(`/classes/${cId}/enroll`, {
      method: "POST",
      token: tok,
    })
  );

  const responses = await Promise.all(promises);
  const confirmed = responses.filter(
    (r) => r.status === 201 && r.data?.waitlisted !== true && r.data?.enrollment?.status === "confirmed"
  ).length;

  const detail = await api(`/classes/${cId}`, { token: mgr.token });
  const enrolledCount = detail.data?.class?.enrolled_count ?? 0;

  if (confirmed > 1 || enrolledCount > 1) {
    race2Anomalies++;
  }

  // Dọn dẹp ghi danh của vòng này để không gây trùng lịch cho vòng sau
  for (const r of responses) {
    const eid = r.data?.enrollment?.id;
    if (eid) {
      await api(`/enrollments/${eid}`, { method: "DELETE", token: mgr.token });
    }
  }
}

check(
  "RACE-02",
  `Tranh chấp ghi danh lớp capacity=1 (20 vòng x 5 reqs): tỉ lệ vượt sĩ số ${race2Anomalies}/${RACE2_ROUNDS}`,
  { status: 200 },
  {
    test: () => race2Anomalies === 0,
    why: `Sĩ số lớp capacity=1 không được vượt quá 1 (thực tế bất thường: ${race2Anomalies}/${RACE2_ROUNDS})`,
  }
);

// ───── RACE-03: ACCEPT WAITLIST OFFER SONG SONG (20 LẦN x 5 REQUESTS) ─────
console.log("\n--- Chạy RACE-03: 20 vòng accept waitlist offer ---");
let race3Anomalies = 0;
let race3ExecutedRounds = 0;
const RACE3_ROUNDS = 20;

for (let round = 0; round < RACE3_ROUNDS; round++) {
  // Tạo lớp capacity=1
  const clRes = await api("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: `race3-${round}`,
      capacity: 1,
      coach_id: coach.user.id,
      court_id: IDS.courtCL02,
      rrule: `FREQ=WEEKLY;BYDAY=TU,WE,TH,FR,SA;BYHOUR=${9 + (round % 8)}`,
      start_on: ictDate(2),
      end_on: ictDate(14),
      duration_min: 60,
    },
  });
  const cId = clRes.data?.id;
  if (!cId) continue;
  await api(`/classes/${cId}/publish`, { method: "POST", token: mgr.token });

  // Member 0 ghi danh confirmed
  const enr0 = await api(`/classes/${cId}/enroll`, { method: "POST", token: members[0].token });
  // Member 1 ghi danh waitlisted
  const enr1 = await api(`/classes/${cId}/enroll`, { method: "POST", token: members[1].token });

  const enr0Id = enr0.data?.enrollment?.id;
  if (!enr0Id) continue;

  // Member 0 huỷ ghi danh -> kích hoạt inviteWaitlist cho Member 1
  await api(`/enrollments/${enr0Id}`, { method: "DELETE", token: members[0].token });

  // Lấy offer_id từ notifications của Member 1
  const notis = await api("/me/notifications", { token: members[1].token });
  const offerNoti = (notis.data?.items ?? []).find(
    (n) => n.template === "waitlist_offer" && n.payload?.class_id === cId
  );
  const offerId = offerNoti?.payload?.offer_id;

  if (offerId) {
    race3ExecutedRounds++;
    // Gửi 5 request accept song song cùng 1 offerId từ Member 1
    const promises = Array.from({ length: 5 }, () =>
      api(`/waitlist/${offerId}/accept`, { method: "POST", token: members[1].token })
    );

    const responses = await Promise.all(promises);
    const successCount = responses.filter((r) => r.status === 200).length;

    // Chỉ được đúng 1 request thành công 200, còn lại 409
    if (successCount > 1) {
      race3Anomalies++;
    }

    // Dọn dẹp enrollment của Member 1 sau khi accept thành công
    const m1NotiEnrId = offerNoti?.payload?.enrollment_id ?? enr1.data?.enrollment?.id;
    if (m1NotiEnrId) {
      await api(`/enrollments/${m1NotiEnrId}`, { method: "DELETE", token: members[1].token });
    }
  }
}

check(
  "RACE-03",
  `Tranh chấp accept waitlist offer (20 vòng x 5 reqs): tỉ lệ accept kép ${race3Anomalies}/${race3ExecutedRounds || RACE3_ROUNDS}`,
  { status: 200 },
  {
    test: () => race3ExecutedRounds === RACE3_ROUNDS && race3Anomalies === 0,
    why: `Tất cả 20 vòng đều phải thực hiện được và chỉ đúng 1 request accept thành công (thực tế: ${race3ExecutedRounds}/${RACE3_ROUNDS} vòng chạy, ${race3Anomalies} bất thường)`,
  }
);

// ───── RACE-04: IDEMPOTENCY-KEY SONG SONG (20 LẦN x 5 REQUESTS) ─────
console.log("\n--- Chạy RACE-04: 20 vòng Idempotency-Key song song ---");
let race4Anomalies = 0;
const RACE4_ROUNDS = 20;

for (let round = 0; round < RACE4_ROUNDS; round++) {
  const idemKey = `RACE4_IDEM_${Date.now()}_${round}`;
  const cId = round < 12 ? IDS.court1 : IDS.court2;
  const hour = 7 + (round % 12);
  const body = {
    date: ictDate(2),
    start_time: `${String(hour).padStart(2, "0")}:00`,
    duration_mins: 60,
  };

  const promises = Array.from({ length: 5 }, () =>
    api(`/courts/${cId}/hold`, {
      method: "POST",
      token: mgr.token,
      idemKey,
      body,
    })
  );

  const responses = await Promise.all(promises);
  const createdIds = new Set(
    responses.filter((r) => r.status === 201).map((r) => r.data?.booking?.id).filter(Boolean)
  );

  if (createdIds.size > 1) {
    race4Anomalies++;
  }
}

check(
  "RACE-04",
  `Idempotency-Key song song (20 vòng x 5 reqs): tỉ lệ tạo trùng ${race4Anomalies}/${RACE4_ROUNDS}`,
  { status: 200 },
  {
    test: () => race4Anomalies === 0,
    why: `Cùng 1 Idempotency-Key không được tạo ra nhiều hơn 1 bản ghi (thực tế bất thường: ${race4Anomalies}/${RACE4_ROUNDS})`,
  }
);

// ───── RACE-05: REDEEM PROMO MAX_USES=1 SONG SONG (20 LẦN x 5 REQUESTS) ─────
console.log("\n--- Chạy RACE-05: 20 vòng redeem promo max_uses=1 ---");
let race5Anomalies = 0;
const RACE5_ROUNDS = 20;

for (let round = 0; round < RACE5_ROUNDS; round++) {
  const code = `RACE5_${round}_${Math.floor(1000 + Math.random() * 9000)}`;
  const pr = await api("/promotions", {
    method: "POST",
    token: mgr.token,
    body: {
      code,
      name: `Race5 Promo ${round}`,
      kind: "amount",
      value: 10000,
      min_order_vnd: 20000,
      max_uses: 1,
      max_per_member: 1,
      applies_to: ["plan"],
      sport: "badminton",
      starts_at: new Date(Date.now() - 3600000).toISOString(),
      ends_at: new Date(Date.now() + 86400000).toISOString(),
      status: "active",
    },
  });
  const promoId = pr.data?.promo?.id;
  if (!promoId) continue;

  // Tạo 5 subscriptions pending cho 5 members
  const subs = await Promise.all(
    members.map((m) =>
      api("/subscriptions", {
        method: "POST",
        token: mgr.token,
        body: { plan_id: IDS.planBadminton30, user_id: m.user.id },
      })
    )
  );

  // 5 requests thanh toán song song sử dụng cùng promo code
  const payPromises = subs.map((s) => {
    const sId = s.data?.subscription?.id;
    const due = s.data?.amount_due_vnd ?? 500000;
    return api("/payments", {
      method: "POST",
      token: mgr.token,
      body: {
        ref_type: "subscription",
        ref_id: sId,
        method: "cash",
        amount_vnd: due - 10000,
        promo_code: code,
      },
    });
  });

  const responses = await Promise.all(payPromises);
  const paidSuccess = responses.filter((r) => r.status === 201).length;

  const redemptions = await api(`/promotions/${promoId}/redemptions`, { token: mgr.token });
  const redCount = redemptions.data?.items?.length ?? 0;

  // Với max_uses=1, chỉ duy nhất 1 payment được thành công với mã giảm giá
  if (paidSuccess > 1 || redCount > 1) {
    race5Anomalies++;
  }
}

check(
  "RACE-05",
  `Redeem promo max_uses=1 song song (20 vòng x 5 reqs): tỉ lệ redeem kép ${race5Anomalies}/${RACE5_ROUNDS}`,
  { status: 200 },
  {
    test: () => race5Anomalies === 0,
    why: `Chỉ duy nhất 1 giao dịch được áp dụng khuyến mãi max_uses=1 (thực tế bất thường: ${race5Anomalies}/${RACE5_ROUNDS})`,
  }
);

// ───── RACE-06: ĐÓNG CA SONG SONG (20 LẦN x 5 REQUESTS) ─────
console.log("\n--- Chạy RACE-06: 20 vòng đóng ca song song ---");
let race6Anomalies = 0;
const RACE6_ROUNDS = 20;

for (let round = 0; round < RACE6_ROUNDS; round++) {
  const op = await api("/shifts/open", { method: "POST", token: rec.token, body: {} });
  const sId = op.data?.shift?.id;
  if (!sId) continue;

  const promises = Array.from({ length: 5 }, () =>
    api(`/shifts/${sId}/close`, {
      method: "POST",
      token: rec.token,
      body: { cash_declared_vnd: 0 },
    })
  );

  const responses = await Promise.all(promises);
  const successCount = responses.filter((r) => r.status === 200).length;

  if (successCount > 1) {
    race6Anomalies++;
  }
}

check(
  "RACE-06",
  `Đóng ca song song (20 vòng x 5 reqs): tỉ lệ đóng kép ${race6Anomalies}/${RACE6_ROUNDS}`,
  { status: 200 },
  {
    test: () => race6Anomalies === 0,
    why: `Chỉ được đúng 1 request đóng ca thành công (thực tế bất thường: ${race6Anomalies}/${RACE6_ROUNDS})`,
  }
);

summary();
