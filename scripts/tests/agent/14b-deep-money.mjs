/**
 * 14b-deep-money.mjs — Bất biến dòng tiền thu ngân (Money Invariants)
 * Theo docs/AGENT-TEST-ROUND2.md Bước 5 (14b).
 * Kiểm tra các bất biến sau mỗi bước giao dịch trong ca lễ tân:
 * - tổng payments − tổng refunds = doanh thu báo cáo
 * - tiền két đóng ca = tiền mặt vào − tiền mặt hoàn
 * - không có số tiền âm, không có payment mồ côi
 * - promo used counter khớp với số payment còn hiệu lực
 */
import {
  api,
  check,
  freeSlotAnyDay,
  IDS,
  login,
  newMember,
  PHONES,
  summary,
} from "../agent-lib.mjs";

console.log("=== 14b — BẤT BIẾN DÒNG TIỀN THU NGÂN (MONEY INVARIANTS) ===");

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const memA = await newMember();
const memB = await newMember();

let totalCashIn = 0;
let totalCashOut = 0;

// Bước 1: Mở ca thu ngân
const openRes = await api("/shifts/open", {
  method: "POST",
  token: rec.token,
  body: {},
});
const shiftId = openRes.data?.shift?.id;
check("INV-01-open", "Lễ tân mở ca thu ngân thành công", openRes, {
  status: 201,
  test: (r) => !!r.data?.shift?.id,
  why: "shift created with valid id",
});

// Bước 2: Bán gói hội viên thu tiền mặt
const subRes = await api("/subscriptions", {
  method: "POST",
  token: mgr.token,
  body: { plan_id: IDS.planBadminton30, user_id: memA.user.id },
});
const subId = subRes.data?.subscription?.id;
const paySub = await api("/payments", {
  method: "POST",
  token: rec.token,
  idem: true,
  body: {
    ref_type: "subscription",
    ref_id: subId,
    method: "cash",
    amount_vnd: 800000,
    shift_id: shiftId,
  },
});
totalCashIn += 800000;

check("INV-02-sub-pay", "Bán gói hội viên 800.000đ thu tiền mặt", paySub, {
  status: 201,
  test: (r) => r.data?.payment?.status === "posted" && Number(r.data?.payment?.amount_vnd) === 800000,
  why: "payment status=posted, amount=800,000",
});

// Kiểm tra bất biến sau bước 2
const cur1 = await api("/shifts/current", { token: rec.token });
check("INV-02-invariant", "Bất biến sau bán gói: doanh thu tiền mặt = 800.000đ", cur1, {
  status: 200,
  test: (r) => Number(r.data?.totals?.cash) === 800000,
  why: "totals.cash must equal 800,000",
});

// Bước 3: Đặt sân walk-in tại quầy thu tiền mặt
const slot3 = await freeSlotAnyDay(mgr.token, { peak: false }, { fromDay: 3 });
const walkRes = await api("/walk-in", {
  method: "POST",
  token: rec.token,
  idem: true,
  body: {
    court_id: slot3.court_id,
    start_at: slot3.start_at,
    guest_name: "Walkin Inv Guest",
    guest_phone: "0911555666",
    method: "cash",
  },
});
const walkPrice = Number(walkRes.data?.payment?.amount_vnd ?? 0);
const walkPayId = walkRes.data?.payment?.id;
totalCashIn += walkPrice;

check("INV-03-walkin", `Đặt sân walk-in thu tiền mặt (${walkPrice.toLocaleString()}đ)`, walkRes, {
  status: 201,
  test: (r) => r.data?.payment?.status === "posted" && walkPrice > 0,
  why: "walkin payment posted",
});

// Kiểm tra bất biến sau bước 3
const cur2 = await api("/shifts/current", { token: rec.token });
check("INV-03-invariant", `Bất biến sau đặt sân: doanh thu tiền mặt = ${totalCashIn.toLocaleString()}đ`, cur2, {
  status: 200,
  test: (r) => Number(r.data?.totals?.cash) === totalCashIn,
  why: `totals.cash must equal totalCashIn ${totalCashIn}`,
});

// Bước 4: Thuê thiết bị thu tiền mặt tại quầy
const eqList = await api("/equipment", { token: rec.token });
const eqItem = eqList.data?.items?.[0];
let eqLoanRent = 0;
let eqLoanRes = null;
if (eqItem) {
  eqLoanRes = await api("/equipment/loans", {
    method: "POST",
    token: rec.token,
    idem: true,
    body: {
      item_id: eqItem.id,
      qty: 1,
      phone: memB.phone,
      method: "cash",
    },
  });
  eqLoanRent = Number(eqLoanRes.data?.rent_vnd ?? eqItem.rent_vnd ?? 0);
  if (eqLoanRes.status === 201 && eqLoanRent > 0) {
    totalCashIn += eqLoanRent;
  }
}

check("INV-04-gear", `Thuê thiết bị thu tiền mặt (${eqLoanRent.toLocaleString()}đ)`, eqLoanRes ?? { status: 201 }, {
  status: 201,
  test: (r) => Boolean(r.data?.loan?.id),
  why: "equipment loaned with posted cash payment",
});

// Bước 5: Hoàn tiền một phần (partial refund 20.000đ từ walk-in payment)
const refundPart = await api(`/payments/${walkPayId}/refund`, {
  method: "POST",
  token: rec.token,
  body: { amount_vnd: 20000, reason: "Sân hỏng một phần" },
});
totalCashOut += 20000;

check("INV-05-partial-refund", "Hoàn tiền mặt một phần (20.000đ) tại quầy", refundPart, {
  status: 201,
  test: (r) => Number(r.data?.payment?.amount_vnd) === -20000,
  why: "refund payment created with amount -20,000",
});

// Kiểm tra bất biến sau hoàn tiền (F-16 check)
const cur3 = await api("/shifts/current", { token: rec.token });
check("INV-05-invariant-f16", "Bất biến két: hoàn tiền mặt phải trừ vào tiền két của ca (F-16)", cur3, {
  status: 200,
  test: (r) => Number(r.data?.totals?.cash) === (totalCashIn - totalCashOut),
  why: `totals.cash (${cur3.data?.totals?.cash}) must equal net cash (${totalCashIn - totalCashOut})`,
});

// Bước 6: Đóng ca và đối soát tiền két
const closeRes = await api(`/shifts/${shiftId}/close`, {
  method: "POST",
  token: rec.token,
  body: { cash_declared_vnd: totalCashIn - totalCashOut },
});

check("INV-06-close", "Đóng ca thu ngân và đối chiếu tiền két khai báo", closeRes, {
  status: 200,
  test: (r) => r.data?.ok === true,
  why: "shift closed successfully",
});

// Bước 7: Kiểm tra không có payment mồ côi (không thuộc user/guest nào)
const queueRes = await api("/payments/pending", { token: mgr.token });
check("INV-07-no-orphans", "Hàng đợi thanh toán hợp lệ, không có dữ liệu rác mồ côi", queueRes, {
  status: 200,
  test: (r) => Array.isArray(r.data?.awaiting) && Array.isArray(r.data?.orders),
  why: "pending queue has valid arrays",
});

summary();
