/**
 * repro-F26.mjs — Tái hiện F-26: Chen hàng waitlist (thử cả 2 thứ tự)
 */
import { api, ictDate, IDS, login, memberWithPlan, PHONES } from "../agent-lib.mjs";

console.log("=== REPRO F-26: Waitlist Queue Jumping Testing ===");

const mgr = await login(PHONES.manager);
const coach = await login(PHONES.coach);

async function findNotification(tok, template, pred = () => true) {
  const r = await api("/me/notifications", { token: tok });
  for (const n of r.data?.items ?? []) {
    let p = n.payload;
    if (typeof p === "string") {
      try { p = JSON.parse(p); } catch { p = {}; }
    }
    if (n.template === template && pred(p ?? {})) return { ...n, payload: p ?? {} };
  }
  return null;
}

async function setupClassWithOffer() {
  const cr = await api("/classes", {
    method: "POST",
    token: mgr.token,
    body: {
      sport: "badminton",
      level: `repro-f26-${Date.now()}`,
      capacity: 1,
      coach_id: coach.user.id,
      court_id: IDS.courtCL02,
      rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9",
      start_on: ictDate(2),
      end_on: ictDate(14),
      duration_min: 60,
    },
  });
  const classId = cr.data?.id;
  await api(`/classes/${classId}/publish`, { method: "POST", token: mgr.token });

  const mA = await memberWithPlan(mgr.token, IDS.planBadminton30);
  const mB = await memberWithPlan(mgr.token, IDS.planBadminton30);
  const mC = await memberWithPlan(mgr.token, IDS.planBadminton30);

  // mA chiếm suất (confirmed)
  const enrA = await api(`/classes/${classId}/enroll`, { method: "POST", token: mA.token });
  // mB vào waitlist (waitlisted)
  const enrB = await api(`/classes/${classId}/enroll`, { method: "POST", token: mB.token });

  // mA rời lớp -> tự động phát sinh offer cho mB
  await api(`/enrollments/${enrA.data?.enrollment?.id}`, { method: "DELETE", token: mA.token });

  // Tìm offer_id trong thông báo của mB
  const notif = await findNotification(mB.token, "waitlist_offer", (p) => p.class_id === classId);
  const offerId = notif?.payload?.offer_id;

  return { classId, mA, mB, mC, offerId };
}

// THỨ TỰ 1: Member C ghi danh TRƯỚC KHI Member B accept offer
console.log("\n--- THỨ TỰ 1: Ghi danh trước khi waitlist accept (Queue Jumping) ---");
const t1 = await setupClassWithOffer();
const jumpEnroll = await api(`/classes/${t1.classId}/enroll`, { method: "POST", token: t1.mC.token });
const cStatus = jumpEnroll.data?.enrollment?.status;
const cWaitlisted = jumpEnroll.data?.waitlisted;
console.log(`Member C enroll: status=${jumpEnroll.status}, enrStatus=${cStatus}, waitlisted=${cWaitlisted}`);

// Sau đó Member B gọi accept offer của mình
let bAcceptAfterJumpStatus = 0;
let bAcceptAfterJumpCode = "";
if (t1.offerId) {
  const bRes = await api(`/waitlist/${t1.offerId}/accept`, { method: "POST", token: t1.mB.token });
  bAcceptAfterJumpStatus = bRes.status;
  bAcceptAfterJumpCode = bRes.data?.code;
  console.log(`Member B accept sau khi C chen: status=${bRes.status}, code=${bRes.data?.code}`);
}
// Tái hiện F-26 khi: C được confirmed chen hàng (cStatus === 'confirmed') VÀ B bị từ chối lớp đã đầy (status === 422 BR-21)
const order1Reproduced = cStatus === "confirmed" && bAcceptAfterJumpStatus === 422;

// THỨ TỰ 2: Member B accept offer TRƯỚC, sau đó Member C mới ghi danh
console.log("\n--- THỨ TỰ 2: Waitlist accept trước, sau đó Member C mới ghi danh ---");
const t2 = await setupClassWithOffer();
let bAcceptFirstStatus = 0;
if (t2.offerId) {
  const bRes = await api(`/waitlist/${t2.offerId}/accept`, { method: "POST", token: t2.mB.token });
  bAcceptFirstStatus = bRes.status;
  console.log(`Member B accept trước: status=${bRes.status}`);
}
const cEnrollAfter = await api(`/classes/${t2.classId}/enroll`, { method: "POST", token: t2.mC.token });
console.log(`Member C enroll sau: status=${cEnrollAfter.status}, waitlisted=${cEnrollAfter.data?.waitlisted}`);

console.log(JSON.stringify({
  reproduced: order1Reproduced,
  order1: { cStatus, bAcceptStatus: bAcceptAfterJumpStatus, bCode: bAcceptAfterJumpCode },
  order2: { bAcceptStatus: bAcceptFirstStatus, cWaitlisted: cEnrollAfter.data?.waitlisted },
}));
