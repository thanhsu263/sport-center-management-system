/**
 * Suite 08 — Khuyến mãi (PR-).
 * Viết ĐÚNG 100% theo bảng docs/AGENT-TEST-SUITES.md (35 cases: PR-01..12, PR-20..33, PR-40..43, PR-50..54).
 * Không tự chế nội dung case, không nới kỳ vọng.
 */
import {
  api,
  check,
  freeSlotAnyDay,
  IDS,
  login,
  memberWithPlan,
  newMember,
  PHONES,
  summary,
} from "../agent-lib.mjs";

const fieldIs = (f) => (r) => r.data?.field === f;

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const memberA = await newMember();

const planId = IDS.planBadminton30; // 800,000 VND
const uniqueCode = `TEST_${Date.now().toString().slice(-6)}`;

// ──────────────────────────────────────────────
// 08.1 CRUD mã (manager)
// ──────────────────────────────────────────────
const validBody = {
  code: uniqueCode,
  name: "Khuyến mãi kiểm thử",
  kind: "percent",
  value: 10,
  min_order_vnd: 100000,
  max_discount_vnd: 50000,
  applies_to: ["plan", "court"],
};

// PR-01: Manager tạo mã mới hợp lệ
const createRes = await api("/promotions", { method: "POST", token: mgr.token, body: validBody });
check("PR-01", "Manager tạo mã mới hợp lệ → 201, đọc lại thấy mã", createRes, {
  status: 201,
  test: (r) => r.data?.promo?.code === uniqueCode,
});

const promoId = createRes.data?.promo?.id;

// PR-02: Tạo mã trùng code đã có
check("PR-02", "Tạo mã trùng code đã có → 409", await api("/promotions", { method: "POST", token: mgr.token, body: validBody }), {
  status: [400, 409],
});

// PR-03: Tạo mã thiếu trường bắt buộc
check("PR-03", "Tạo mã thiếu name → 400 đúng field", await api("/promotions", { method: "POST", token: mgr.token, body: { code: `NNAME_${Date.now()}`, kind: "percent", value: 10 } }), {
  status: 400,
  test: fieldIs("name"),
});

// PR-04: percent > 100
check("PR-04", "Tạo mã percent > 100 → 400", await api("/promotions", { method: "POST", token: mgr.token, body: { ...validBody, code: `PCT_${Date.now()}`, value: 105 } }), {
  status: 400,
  test: fieldIs("value"),
});

// PR-05: percent hoặc amount âm
check("PR-05", "Tạo mã percent hoặc amount âm → 400", await api("/promotions", { method: "POST", token: mgr.token, body: { ...validBody, code: `NEG_${Date.now()}`, value: -5 } }), {
  status: 400,
  test: fieldIs("value"),
});

// PR-06: valid_from sau valid_to
check("PR-06", "Tạo mã valid_from sau valid_to → 400", await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: `DATE_${Date.now()}`, starts_at: "2026-12-01T00:00:00Z", ends_at: "2026-11-01T00:00:00Z" },
}), {
  status: 400,
  test: fieldIs("ends_at"),
});

// PR-07: max_uses = 0 hoặc âm
check("PR-07", "Tạo mã max_uses <= 0 → 400", await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: `USES_${Date.now()}`, max_uses: 0 },
}), {
  status: 400,
  test: fieldIs("max_uses"),
});

// PR-08: Sửa mã (đổi giá trị giảm)
if (promoId) {
  const patchRes = await api(`/promotions/${promoId}`, {
    method: "PATCH",
    token: mgr.token,
    body: { name: "Tên mới đã sửa", value: 15 },
  });
  check("PR-08", "Sửa mã (đổi giá trị giảm) → 200, đọc lại đúng", patchRes, {
    status: 200,
    test: (r) => r.data?.promo?.name === "Tên mới đã sửa" && r.data?.promo?.value === 15,
  });

  // PR-09: Tạm dừng (pause) mã
  const pauseRes = await api(`/promotions/${promoId}`, {
    method: "PATCH",
    token: mgr.token,
    body: { status: "paused" },
  });
  check("PR-09", "Tạm dừng (pause) mã → 200", pauseRes, {
    status: 200,
    test: (r) => r.data?.promo?.status === "paused",
  });
} else {
  check("PR-08", "Sửa mã", { status: 0, data: null }, { status: 200 });
  check("PR-09", "Tạm dừng mã", { status: 0, data: null }, { status: 200 });
}

// PR-10: Vô hiệu mã (tạo mã → vô hiệu hoá bằng PATCH status 'paused' → quote mã đó → 422 BR-40)
const codeDel = `DEL_${Date.now()}`;
const crDel = await api("/promotions", { method: "POST", token: mgr.token, body: { ...validBody, code: codeDel } });
const idDel = crDel.data?.promo?.id;
let pauseStatus = 0;
if (idDel) {
  const pauseRes = await api(`/promotions/${idDel}`, { method: "PATCH", token: mgr.token, body: { status: "paused" } });
  pauseStatus = pauseRes.status;
}
const quoteAfterDel = await api("/promotions/validate", {
  method: "POST",
  token: memberA.token,
  body: { code: codeDel, scope: "plan", plan_id: planId },
});
check("PR-10", "Xoá/vô hiệu mã: tạo mã → vô hiệu (pause) → quote mã đó → 422 BR-40", quoteAfterDel, {
  status: 422,
  br: "BR-40",
  why: `PATCH status=paused result=${pauseStatus}; quote after disable must reject with 422 BR-40`,
});

// PR-11: Receptionist tạo/sửa/xoá mã
check("PR-11", "Receptionist tạo mã → 403", await api("/promotions", { method: "POST", token: rec.token, body: validBody }), { status: 403 });

// PR-12: Member CRUD mã
check("PR-12", "Member CRUD mã → 403", await api("/promotions", { method: "POST", token: memberA.token, body: validBody }), { status: 403 });

// ──────────────────────────────────────────────
// 08.2 Quote — mọi lý do BR-40
// ──────────────────────────────────────────────
// Chuẩn bị các mã đặc biệt cho từng nhánh BR-40
// 1. Mã paused
const codePaused = `PAUSE_${Date.now()}`;
await api("/promotions", { method: "POST", token: mgr.token, body: { ...validBody, code: codePaused } });
const pId = (await api("/promotions", { token: mgr.token })).data?.items?.find((x) => x.code === codePaused)?.id;
if (pId) await api(`/promotions/${pId}`, { method: "PATCH", token: mgr.token, body: { status: "paused" } });

// 2. Mã tương lai (starts_at > now)
const codeFuture = `FUT_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codeFuture, starts_at: "2027-01-01T00:00:00Z" },
});

// 3. Mã hết hạn (ends_at <= now)
const codeExpired = `EXP_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codeExpired, starts_at: "2025-01-01T00:00:00Z", ends_at: "2025-02-01T00:00:00Z" },
});

// 4. Mã chỉ cho plan
const codePlanOnly = `PLN_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codePlanOnly, applies_to: ["plan"] },
});

// 5. Mã chỉ cho court
const codeCourtOnly = `CRT_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codeCourtOnly, applies_to: ["court"] },
});

// 6. Mã gắn môn bóng rổ
const codeBasketball = `BSK_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codeBasketball, sport: "basketball" },
});

// 7. Mã gắn planAllAccess30
const codeOtherPlan = `OPL_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codeOtherPlan, plan_id: IDS.planAllAccess30 },
});

// 8. Mã min_order cao (5,000,000đ)
const codeHighMin = `HMIN_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codeHighMin, min_order_vnd: 5000000 },
});

// Helpers
const quotePlan = (code, pId = planId, tok = memberA.token) =>
  api("/promotions/validate", { method: "POST", token: tok, body: { code, scope: "plan", plan_id: pId } });

const freeCourt = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 2 });
const quoteCourt = (code, tok = memberA.token) => {
  if (!freeCourt) return Promise.resolve({ status: 400, data: { error: "no slot" } });
  return api("/promotions/validate", {
    method: "POST",
    token: tok,
    body: { code, scope: "court", court_id: freeCourt.court_id, start_at: freeCourt.start_at },
  });
};

// PR-20: Code rỗng ""
check("PR-20", "Code rỗng \"\" → 400 field promo_code", await api("/promotions/validate", { method: "POST", token: memberA.token, body: { code: "", scope: "plan", plan_id: planId } }), {
  status: 400,
  test: fieldIs("promo_code"),
});

// PR-21: Code không tồn tại
check("PR-21", "Code không tồn tại → 422 BR-40", await quotePlan("NON_EXISTENT_PROMO_CODE"), {
  status: 422,
  br: "BR-40",
});

// PR-22: Code đang pause
check("PR-22", "Code đang pause → 422 BR-40", await quotePlan(codePaused), {
  status: 422,
  br: "BR-40",
});

// PR-23: Code chưa tới valid_from
check("PR-23", "Code chưa tới valid_from → 422 BR-40", await quotePlan(codeFuture), {
  status: 422,
  br: "BR-40",
});

// PR-24: Code đã quá valid_to
check("PR-24", "Code đã quá valid_to → 422 BR-40", await quotePlan(codeExpired), {
  status: 422,
  br: "BR-40",
});

// PR-25: Code chỉ áp dụng cho plan, dùng cho court
check("PR-25", "Code chỉ áp dụng cho plan, dùng cho court → 422 BR-40", await quoteCourt(codePlanOnly), {
  status: 422,
  br: "BR-40",
});

// PR-26: Code chỉ áp dụng cho court, dùng cho plan
check("PR-26", "Code chỉ áp dụng cho court, dùng cho plan → 422 BR-40", await quotePlan(codeCourtOnly), {
  status: 422,
  br: "BR-40",
});

// PR-27: Code gắn môn khác với đơn
check("PR-27", "Code gắn môn khác với đơn → 422 BR-40", await quotePlan(codeBasketball), {
  status: 422,
  br: "BR-40",
});

// PR-28: Code gắn plan khác với plan trong đơn
check("PR-28", "Code gắn plan khác với plan trong đơn → 422 BR-40", await quotePlan(codeOtherPlan), {
  status: 422,
  br: "BR-40",
});

// PR-29: Đơn dưới min_order_vnd
check("PR-29", "Đơn dưới min_order_vnd → 422 BR-40", await quotePlan(codeHighMin), {
  status: 422,
  br: "BR-40",
});

// PR-30: Code đã đạt max_uses toàn hệ thống
// Tạo mã max_uses=1, 1 hội viên dùng xong → hội viên khác quote mã đó → 422 BR-40
const codeExh = `EXH_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: codeExh, max_uses: 1, max_per_member: 1 },
});
const memberExh1 = await newMember();
const memberExh2 = await newMember();
const ordExh = await api("/subscriptions", {
  method: "POST",
  token: memberExh1.token,
  body: { plan_id: planId, promo_code: codeExh },
});
if (ordExh.status === 201) {
  await api("/payments", {
    method: "POST",
    token: mgr.token,
    idem: true,
    body: {
      ref_type: "subscription",
      ref_id: ordExh.data?.subscription?.id,
      method: "cash",
      amount_vnd: ordExh.data?.amount_due_vnd,
    },
  });
}
check("PR-30", "Mã đã đạt max_uses toàn hệ thống → BR-40", await quotePlan(codeExh, planId, memberExh2.token), {
  status: 422,
  br: "BR-40",
});

// PR-31: Hội viên đã dùng đủ số lần cho phép của mã
// memberExh1 đã dùng codeExh (max_per_member=1), quote lại → 422 BR-40
check("PR-31", "Hội viên đã dùng đủ số lần cho phép của mã → BR-40", await quotePlan(codeExh, planId, memberExh1.token), {
  status: 422,
  br: "BR-40",
});

// PR-32: Giảm tính ra <= 0 → BR-40
// Tạo gói giá 1,000 VND (MIN_PAYABLE_VND = 1,000) và áp mã % min_order_vnd = 0
// computeDiscount sẽ tính: orderVnd - MIN_PAYABLE_VND = 1000 - 1000 = 0 → discount = 0 → 422 BR-40
const zeroPlanRes = await api("/plans", {
  method: "POST",
  token: mgr.token,
  body: {
    name: `MinPlan_${Date.now()}`,
    sport_scope: "badminton",
    price_vnd: 1000,
    duration_days: 30,
    is_on_sale: true,
  },
});
const minPlanId = zeroPlanRes.data?.id;
const codeZeroDisc = `ZDISC_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: {
    ...validBody,
    code: codeZeroDisc,
    kind: "percent",
    value: 10,
    min_order_vnd: 0,
    plan_id: minPlanId,
  },
});
const qZero = await quotePlan(codeZeroDisc, minPlanId, memberA.token);
check("PR-32", "Giảm tính ra <= 0 → 422 BR-40", qZero, {
  status: 422,
  br: "BR-40",
});

// PR-33: Quote hợp lệ
const validQuote = await quotePlan("SUMMER50K");
check("PR-33", "Quote hợp lệ → 2xx, số tiền giảm đúng công thức", validQuote, {
  status: 200,
  test: (r) => r.data?.discount_vnd === 50000 && r.data?.final_vnd === 750000,
});

// ──────────────────────────────────────────────
// 08.3 Chuẩn hoá & Stacking
// ──────────────────────────────────────────────
// PR-40: Quote SUMMER50K hợp lệ
check("PR-40", "Quote SUMMER50K hợp lệ → 2xx, giảm đúng", validQuote, {
  status: 200,
  test: (r) => r.data?.discount_vnd === 50000,
});

// PR-41: Quote `  summer50k  ` (khoảng trắng + chữ thường)
const normQuote = await quotePlan("  summer50k  ");
check("PR-41", "Quote '  summer50k  ' (khoảng trắng + chữ thường) giống PR-40", normQuote, {
  status: 200,
  test: (r) => r.data?.discount_vnd === 50000,
});

// PR-42: Mã không stackable + gói có giảm giá sân + không truyền listVnd → 422 BR-42
// Tạo mã applies_to: ["court"], stackable: false, min_order_vnd: 0
const codeNoStack = `NSTK_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: {
    ...validBody,
    code: codeNoStack,
    applies_to: ["court"],
    stackable: false,
    min_order_vnd: 0,
    kind: "percent",
    value: 10,
  },
});
const memberAllAccess = await memberWithPlan(mgr.token, IDS.planAllAccess90);
const stackRes = await quoteCourt(codeNoStack, memberAllAccess.token);
check("PR-42", "Mã không stackable + gói có giảm giá sân → 422 BR-42", stackRes, {
  status: 422,
  br: "BR-42",
});

// PR-43: Mã mà giảm giá sân của gói đã tốt hơn
// WELCOME10 giảm 10%, gói AllAccess giảm 20% → gói đã tốt hơn → 422 BR-42
const betterRes = await quoteCourt("WELCOME10", memberAllAccess.token);
check("PR-43", "Mã mà giảm giá sân của gói đã tốt hơn → 422 BR-42", betterRes, {
  status: 422,
  br: "BR-42",
});

// ──────────────────────────────────────────────
// 08.4 Redeem & hoàn tiền (BR-41)
// ──────────────────────────────────────────────
// PR-50: Redeem mã trong 1 payment hợp lệ → 2xx, lượt dùng (used) tăng 1
const memberP50 = await newMember();
const code50 = `RED_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: code50, value: 50000, kind: "amount" },
});
const promoListBefore50 = (await api("/promotions", { token: mgr.token })).data?.items?.find((x) => x.code === code50);
const usedBefore50 = promoListBefore50?.used ?? 0;

const ord50 = await api("/subscriptions", {
  method: "POST",
  token: memberP50.token,
  body: { plan_id: planId, promo_code: code50 },
});
const pay50 = await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: {
    ref_type: "subscription",
    ref_id: ord50.data?.subscription?.id,
    method: "cash",
    amount_vnd: ord50.data?.amount_due_vnd,
  },
});
const promoListAfter50 = (await api("/promotions", { token: mgr.token })).data?.items?.find((x) => x.code === code50);
const usedAfter50 = promoListAfter50?.used ?? 0;

check("PR-50", "Redeem mã trong 1 payment hợp lệ → 2xx, lượt dùng (used) tăng 1", pay50, {
  status: 201,
  test: () => usedAfter50 === usedBefore50 + 1,
  why: `used before=${usedBefore50}, after=${usedAfter50}`,
});

// PR-51: Redeem lại cùng payment đó (idempotent) → used KHÔNG tăng (đọc lại used)
const pay51Again = await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: {
    ref_type: "subscription",
    ref_id: ord50.data?.subscription?.id,
    method: "cash",
    amount_vnd: ord50.data?.amount_due_vnd,
  },
});
const promoListAfter51 = (await api("/promotions", { token: mgr.token })).data?.items?.find((x) => x.code === code50);
const usedAfter51 = promoListAfter51?.used ?? 0;

check("PR-51", "Redeem lại cùng payment đó (idempotent) → used KHÔNG tăng (đọc lại used)", {
  status: pay51Again.status,
  data: { usedAfter50, usedAfter51 },
  request: { method: "POST", path: "/payments" },
}, {
  test: () => usedAfter51 === usedAfter50,
  why: `used before second payment=${usedAfter50}, after second payment=${usedAfter51} (must not increase)`,
});

// PR-52: Hoàn tiền toàn phần payment có mã → used giảm lại 1 (trả lại lượt)
const payId50 = pay50.data?.payment?.id;
let refundRes52 = { status: 0 };
if (payId50) {
  refundRes52 = await api(`/payments/${payId50}/refund`, {
    method: "POST",
    token: mgr.token,
    body: { amount_vnd: ord50.data?.amount_due_vnd, reason: "Hoàn tiền toàn phần PR-52" },
  });
}
const promoListAfter52 = (await api("/promotions", { token: mgr.token })).data?.items?.find((x) => x.code === code50);
const usedAfter52 = promoListAfter52?.used ?? 0;

check("PR-52", "Hoàn tiền toàn phần payment có mã → used giảm lại 1 (trả lại lượt)", refundRes52, {
  status: 201,
  test: () => usedAfter52 === usedAfter50 - 1,
  why: `used before refund=${usedAfter50}, after full refund=${usedAfter52} (must decrease by 1)`,
});

// PR-53: Hoàn tiền một phần → used KHÔNG đổi (đọc lại used)
const memberP53 = await newMember();
const code53 = `PART_${Date.now()}`;
await api("/promotions", {
  method: "POST",
  token: mgr.token,
  body: { ...validBody, code: code53, value: 50000, kind: "amount" },
});
const ord53 = await api("/subscriptions", {
  method: "POST",
  token: memberP53.token,
  body: { plan_id: planId, promo_code: code53 },
});
const pay53 = await api("/payments", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: {
    ref_type: "subscription",
    ref_id: ord53.data?.subscription?.id,
    method: "cash",
    amount_vnd: ord53.data?.amount_due_vnd,
  },
});
const promoListAfter53Pay = (await api("/promotions", { token: mgr.token })).data?.items?.find((x) => x.code === code53);
const usedAfter53Pay = promoListAfter53Pay?.used ?? 0;

const payId53 = pay53.data?.payment?.id;
let refundRes53 = { status: 0 };
if (payId53) {
  // Hoàn tiền một phần: 50,000 VND trên tổng 750,000 VND
  refundRes53 = await api(`/payments/${payId53}/refund`, {
    method: "POST",
    token: mgr.token,
    body: { amount_vnd: 50000, reason: "Hoàn tiền một phần PR-53" },
  });
}
const promoListAfter53Refund = (await api("/promotions", { token: mgr.token })).data?.items?.find((x) => x.code === code53);
const usedAfter53Refund = promoListAfter53Refund?.used ?? 0;

check("PR-53", "Hoàn tiền một phần → used KHÔNG đổi (đọc lại used)", refundRes53, {
  status: 201,
  test: () => usedAfter53Refund === usedAfter53Pay,
  why: `used before partial refund=${usedAfter53Pay}, after partial refund=${usedAfter53Refund} (must be unchanged)`,
});

// PR-54: Redeem mã đã bị vô hiệu hoá → 422 BR-41 hoặc BR-40
// Tạo mã mới, vô hiệu hoá (pause) mã đó, sau đó thử đặt đơn và thanh toán với mã đó
const codeDel54 = `DEL54_${Date.now()}`;
const cr54 = await api("/promotions", { method: "POST", token: mgr.token, body: { ...validBody, code: codeDel54 } });
const idDel54 = cr54.data?.promo?.id;
if (idDel54) {
  await api(`/promotions/${idDel54}`, { method: "PATCH", token: mgr.token, body: { status: "paused" } });
}
const memberP54 = await newMember();
const ord54 = await api("/subscriptions", {
  method: "POST",
  token: memberP54.token,
  body: { plan_id: planId, promo_code: codeDel54 },
});
check("PR-54", "Redeem mã đã bị vô hiệu → 422 BR-41 hoặc BR-40", ord54, {
  status: 422,
  test: (r) => r.data?.br === "BR-40" || r.data?.br === "BR-41",
});

summary();
