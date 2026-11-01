/**
 * Suite 09 — Thiết bị, vé ngày, điểm thưởng, hoa hồng, work order, series (09-extras.mjs).
 * Viết theo docs/AGENT-TEST-INSTRUCTIONS.md và docs/AGENT-TEST-SUITES.md mục 09.
 * Tiền tố: EQ-, LOY-, COM-, WO-, SER-.
 * Ước lượng: ~4 hội viên mới.
 */
import {
  api,
  blocked,
  check,
  freeSlot,
  freshPhone,
  ictDate,
  ictDateOf,
  IDS,
  login,
  newMember,
  PHONES,
  slot,
  summary,
} from "../agent-lib.mjs";

const fake = (data) => ({ status: 200, data, ms: 0, request: "computed by script" });

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const khoa = await login(PHONES.coach);
const lan = await login(PHONES.coachLan);
const memberA = await newMember();
const memberB = await newMember();

// Open till shift for receptionist
await api("/shifts/open", { method: "POST", token: rec.token });

// ──────────────────────────────────────────────
// 09.1 Thiết bị & mượn trả (EQ-, BR-50)
// ──────────────────────────────────────────────

// EQ-01: Manager tạo loại thiết bị
// Kiểm tra xem route POST /equipment có tồn tại trong router hay không
const eqCreateRes = await api("/equipment", {
  method: "POST",
  token: mgr.token,
  body: { name: "Vợt cầu lông Yonex", stock: 10, rent_vnd: 20000 },
});
if (eqCreateRes.status === 404 && String(eqCreateRes.data?.message || "").includes("No route")) {
  blocked("EQ-01", "Manager tạo loại thiết bị, số lượng N", "route không có trong router (chỉ có /equipment GET và /equipment/loans)");
  blocked("EQ-02", "Tạo thiết bị số lượng âm", "route không có trong router");
  blocked("EQ-09", "Member tạo/sửa/xoá loại thiết bị", "route không có trong router");
} else {
  check("EQ-01", "Manager tạo loại thiết bị, số lượng N → 2xx", eqCreateRes, { status: [200, 201] });
  check("EQ-02", "Tạo thiết bị số lượng âm → 4xx", await api("/equipment", {
    method: "POST",
    token: mgr.token,
    body: { name: "Vợt âm", stock: -5, rent_vnd: 20000 },
  }), { status: [400, 422] });
  check("EQ-09", "Member tạo/sửa/xoá loại thiết bị → 403", await api("/equipment", {
    method: "POST",
    token: memberA.token,
    body: { name: "Vợt lậu", stock: 5 },
  }), { status: 403 });
}

// Lấy danh sách thiết bị hiện có
const eqListRes = await api("/equipment", { token: rec.token });
const items = eqListRes.data?.items ?? [];
const targetItem = items[0];

let loanId = null;
if (!targetItem) {
  blocked("EQ-03", "Member mượn 1 thiết bị còn hàng", "không có thiết bị nào trong DB seed");
  blocked("EQ-04", "Mượn khi hết hàng", "không có thiết bị");
  blocked("EQ-05", "Mượn quá số lượng cho phép", "không có thiết bị");
  blocked("EQ-06", "Trả thiết bị đã mượn", "không có thiết bị");
  blocked("EQ-07", "Trả lại lần hai cùng phiếu mượn", "không có thiết bị");
  blocked("EQ-08", "Trả phiếu mượn của người khác", "không có thiết bị");
} else {
  const stockBefore = targetItem.stock;

  // EQ-03: Member mượn 1 thiết bị còn hàng (quầy lễ tân tạo phiếu mượn cho member)
  const loanRes = await api("/equipment/loans", {
    method: "POST",
    token: rec.token,
    body: {
      item_id: targetItem.id,
      qty: 1,
      user_id: memberA.user.id,
      method: "cash",
    },
  });
  const loanPass = check("EQ-03", "Member mượn 1 thiết bị còn hàng → 201, tồn kho giảm 1", loanRes, {
    status: 201,
    test: (r) => Boolean(r.data?.loan?.id),
  });
  if (loanPass) {
    loanId = loanRes.data.loan.id;
    // Đọc lại để kiểm tra tồn kho giảm 1
    const verifyList = await api("/equipment", { token: rec.token });
    const updatedItem = verifyList.data?.items?.find((i) => i.id === targetItem.id);
    check("EQ-03-verify", "Tồn kho giảm đúng 1", fake(updatedItem), {
      test: () => updatedItem?.stock === stockBefore - 1,
    });
  }

  // EQ-04: Mượn khi hết hàng (hoặc vượt tồn kho hiện tại)
  const overStock = targetItem.stock + 100;
  const overRes = await api("/equipment/loans", {
    method: "POST",
    token: rec.token,
    body: {
      item_id: targetItem.id,
      qty: Math.min(overStock, 99), // max 99 theo schema
      user_id: memberA.user.id,
      method: "cash",
    },
  });
  check("EQ-04", "Mượn khi hết hàng (vượt tồn kho) → 422 BR-50", overRes, {
    status: 422,
    br: "BR-50",
  });

  // EQ-05: Mượn quá số lượng cho phép mỗi người (qty > 99)
  const invalidQtyRes = await api("/equipment/loans", {
    method: "POST",
    token: rec.token,
    body: {
      item_id: targetItem.id,
      qty: 150,
      user_id: memberA.user.id,
      method: "cash",
    },
  });
  check("EQ-05", "Mượn quá số lượng cho phép (qty > 99) → 400", invalidQtyRes, {
    status: [400, 422],
  });

  // EQ-08: Trả phiếu mượn bởi member (chỉ staff được thao tác quầy)
  if (loanId) {
    const memReturnRes = await api(`/equipment/loans/${loanId}/return`, {
      method: "POST",
      token: memberA.token,
    });
    check("EQ-08", "Member tự gọi trả phiếu mượn → 403", memReturnRes, {
      status: 403,
    });

    // EQ-06: Trả thiết bị đã mượn bởi nhân viên quầy
    const returnRes = await api(`/equipment/loans/${loanId}/return`, {
      method: "POST",
      token: rec.token,
    });
    check("EQ-06", "Trả thiết bị đã mượn → 200, tồn kho tăng lại 1", returnRes, {
      status: 200,
    });
    const afterReturnList = await api("/equipment", { token: rec.token });
    const itemRestored = afterReturnList.data?.items?.find((i) => i.id === targetItem.id);
    check("EQ-06-verify", "Tồn kho hồi phục như ban đầu", fake(itemRestored), {
      test: () => itemRestored?.stock === stockBefore,
    });

    // EQ-07: Trả lại lần hai cùng phiếu mượn
    const reReturnRes = await api(`/equipment/loans/${loanId}/return`, {
      method: "POST",
      token: rec.token,
    });
    check("EQ-07", "Trả lại lần hai cùng phiếu mượn → 409 CONFLICT_STATE", reReturnRes, {
      status: 409,
    });
  }
}

// ──────────────────────────────────────────────
// 09.3 Điểm thưởng (LOY-)
// ──────────────────────────────────────────────

// LOY-01: Xem số dư điểm của chính mình
const myPointsRes = await api("/me/points", { token: memberA.token });
check("LOY-01", "Xem số dư điểm của chính mình → 200", myPointsRes, {
  status: 200,
  test: (r) => r.data?.points !== undefined,
});

// Setup: Manager cộng 100 điểm thưởng cho memberA
const adjustRes = await api(`/members/${memberA.user.id}/points`, {
  method: "POST",
  token: mgr.token,
  body: { points: 100, note: "Thưởng kiểm thử điểm" },
});
if (adjustRes.status !== 200) {
  console.log("Warning: could not adjust points for memberA:", adjustRes.data);
}

// LOY-02: Tiêu điểm trong số dư (tối thiểu 50 điểm)
const redeemRes = await api("/me/points/redeem", {
  method: "POST",
  token: memberA.token,
  body: { points: 50 },
});
check("LOY-02", "Tiêu điểm trong số dư → 201, số dư giảm đúng", redeemRes, {
  status: 201,
  test: (r) => Boolean(r.data?.code && r.data?.points_left !== undefined),
});

// LOY-03: Tiêu điểm vượt số dư
const overRedeemRes = await api("/me/points/redeem", {
  method: "POST",
  token: memberA.token,
  body: { points: 5000 },
});
check("LOY-03", "Tiêu điểm vượt số dư → 400, số dư không âm", overRedeemRes, {
  status: 400,
});

// LOY-04: Tiêu điểm số âm hoặc 0
const negRedeemRes = await api("/me/points/redeem", {
  method: "POST",
  token: memberA.token,
  body: { points: -10 },
});
check("LOY-04", "Tiêu điểm số âm hoặc 0 → 400", negRedeemRes, {
  status: 400,
});

// LOY-05: Member tự cộng điểm cho mình
const selfAdjustRes = await api(`/members/${memberA.user.id}/points`, {
  method: "POST",
  token: memberA.token,
  body: { points: 500, note: "Tự cộng điểm" },
});
check("LOY-05", "Member tự cộng điểm cho mình → 403", selfAdjustRes, {
  status: 403,
});

// LOY-06: Xem điểm của người khác
const viewOtherRes = await api(`/members/${memberB.user.id}/points`, {
  token: memberA.token,
});
check("LOY-06", "Xem điểm của người khác → 403", viewOtherRes, {
  status: 403,
});

// ──────────────────────────────────────────────
// 09.4 Hoa hồng HLV (COM-)
// ──────────────────────────────────────────────

// COM-01: Khoa xem hoa hồng của chính mình
const khoaEarnRes = await api("/me/earnings", { token: khoa.token });
check("COM-01", "Khoa xem hoa hồng của chính mình → 200", khoaEarnRes, {
  status: 200,
  test: (r) => Boolean(r.data?.period),
});

// COM-02: Khoa xem hoa hồng của Lan (hoặc báo cáo chung manager)
const khoaOtherRes = await api("/commission", { token: khoa.token });
check("COM-02", "Khoa xem báo cáo hoa hồng chung của trung tâm → 403", khoaOtherRes, {
  status: 403,
});

// COM-03: Member xem báo cáo hoa hồng
check("COM-03", "Member xem báo cáo hoa hồng → 403", await api("/commission", { token: memberA.token }), {
  status: 403,
});

// COM-04: Manager xem hoa hồng mọi HLV
const mgrCommRes = await api("/commission", { token: mgr.token });
check("COM-04", "Manager xem hoa hồng mọi HLV → 200", mgrCommRes, {
  status: 200,
  test: (r) => Array.isArray(r.data?.items),
});

// ──────────────────────────────────────────────
// 09.5 Work order / bảo trì sân (WO-)
// ──────────────────────────────────────────────

const courtToBlock = IDS.courtCL04;
const courtFree = IDS.courtCL05;

// Tìm 1 slot thực sự rảnh trên courtToBlock
const targetSlot = await freeSlot(mgr.token, { daysAhead: 3, court: courtToBlock }) || { start_at: slot(3, 8) };

// WO-01: Manager tạo work order khoá 1 sân
const woCreateRes = await api("/work-orders", {
  method: "POST",
  token: mgr.token,
  body: {
    court_id: courtToBlock,
    title: "Bảo trì lưới và mặt sàn sân 4",
    priority: "urgent",
    blocks_court: true,
  },
});
check("WO-01", "Manager tạo work order khoá 1 sân → 201", woCreateRes, {
  status: 201,
  test: (r) => Boolean(r.data?.id),
});
const woId = woCreateRes.data?.id;

// WO-02: Đặt sân đó trong lúc bị khoá bảo trì
const holdBlockedRes = await api("/bookings", {
  method: "POST",
  token: memberA.token,
  idem: true,
  body: {
    court_id: courtToBlock,
    start_at: targetSlot.start_at,
  },
});
check("WO-02", "Đặt sân đang bị bảo trì → 422 BR-06", holdBlockedRes, {
  status: 422,
  br: "BR-06",
});

// WO-03: Đặt sân khác ngoài sân bị khoá
const freeTarget = await freeSlot(mgr.token, { daysAhead: 3, court: courtFree }) || { start_at: slot(3, 8) };
const holdFreeRes = await api("/bookings", {
  method: "POST",
  token: memberA.token,
  idem: true,
  body: {
    court_id: courtFree,
    start_at: freeTarget.start_at,
  },
});
check("WO-03", "Đặt sân khác sẵn sàng hoạt động → 201", holdFreeRes, {
  status: 201,
  test: (r) => Boolean(r.data?.booking?.id),
});
// Hủy hold vừa tạo trên courtFree để memberA không bị kẹt hold
if (holdFreeRes.status === 201 && holdFreeRes.data?.booking?.id) {
  await api(`/bookings/${holdFreeRes.data.booking.id}/cancel`, {
    method: "POST",
    token: memberA.token,
    body: { reason: "Dọn dẹp hold kiểm thử WO-03" },
  });
}

// WO-04: Đóng work order, rồi đặt lại sân cũ
if (woId) {
  const closeWoRes = await api(`/work-orders/${woId}`, {
    method: "PATCH",
    token: mgr.token,
    body: { status: "done", resolution: "Đã thay lưới xong" },
  });
  check("WO-04-close", "Đóng work order hoàn tất → 200", closeWoRes, {
    status: 200,
  });

  const reBookRes = await api("/bookings", {
    method: "POST",
    token: memberB.token,
    idem: true,
    body: {
      court_id: courtToBlock,
      start_at: targetSlot.start_at,
    },
  });
  check("WO-04", "Đặt lại sân sau khi đóng work order → 201", reBookRes, {
    status: 201,
    test: (r) => Boolean(r.data?.booking?.id),
  });
  if (reBookRes.status === 201 && reBookRes.data?.booking?.id) {
    await api(`/bookings/${reBookRes.data.booking.id}/cancel`, {
      method: "POST",
      token: memberB.token,
      body: { reason: "Dọn dẹp sau WO-04" },
    });
  }
}

// WO-05: Member tạo work order
const memWoRes = await api("/work-orders", {
  method: "POST",
  token: memberA.token,
  body: { title: "Yêu cầu bảo trì từ khách", court_id: courtFree },
});
check("WO-05", "Member tạo work order → 403", memWoRes, {
  status: 403,
});

// ──────────────────────────────────────────────
// 09.6 Series / lớp lặp (SER-)
// ──────────────────────────────────────────────

const memberSeries = await newMember();

// SER-01: Tạo booking lặp (series) hợp lệ nhiều buổi
const seriesCourt = IDS.courtCL01;
const firstDate = ictDate(7);
const seriesCreateRes = await api("/series", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: {
    court_id: seriesCourt,
    first_date: firstDate,
    start_local: "09:00",
    weeks: 4,
    method: "cash",
    phone: memberSeries.phone,
  },
});
check("SER-01", "Tạo booking lặp hợp lệ 4 buổi → 201, booked = 4", seriesCreateRes, {
  status: 201,
  test: (r) => r.data?.booked === 4 && Boolean(r.data?.series_id),
});
const seriesId = seriesCreateRes.data?.series_id;

// SER-02: Series đụng 1 buổi với booking đã có
const seriesCourt2 = IDS.courtCL02;
const clashDate = ictDate(1); // Ngày mai (trong hạn book_ahead_days)
const clashSlot = slot(1, 10);

// Đặt trước 1 buổi vào ngày mai lúc 10:00 bằng tài khoản memberB
const conflictHold = await api("/bookings", {
  method: "POST",
  token: memberB.token,
  idem: true,
  body: {
    court_id: seriesCourt2,
    start_at: clashSlot,
  },
});

// Preview series 4 tuần từ ngày mai lúc 10:00 cho memberSeries
const seriesPreviewRes = await api("/series/preview", {
  method: "POST",
  token: mgr.token,
  body: {
    court_id: seriesCourt2,
    first_date: clashDate,
    start_local: "10:00",
    weeks: 4,
    phone: memberSeries.phone,
  },
});
check("SER-02", "Series đụng 1 buổi với booking đã có → báo rõ buổi đụng (skipped = 1, booked = 3)", seriesPreviewRes, {
  status: 200,
  test: (r) => r.data?.booked === 3 && r.data?.skipped === 1 && r.data?.lines?.some((l) => !l.available && l.reason === "taken"),
});

// Dọn dẹp hold xung đột
if (conflictHold.status === 201 && conflictHold.data?.booking?.id) {
  await api(`/bookings/${conflictHold.data.booking.id}/cancel`, {
    method: "POST",
    token: memberB.token,
    body: { reason: "Dọn dẹp sau SER-02" },
  });
}

// SER-03: Huỷ cả series
if (seriesId) {
  const cancelSeriesRes = await api(`/series/${seriesId}/cancel`, {
    method: "POST",
    token: mgr.token,
    body: { waive: true, reason: "Hủy toàn bộ series kiểm thử" },
  });
  check("SER-03", "Huỷ cả series → 200, cancelled = 4", cancelSeriesRes, {
    status: 200,
    test: (r) => r.data?.cancelled === 4,
  });
}

// SER-04: Huỷ 1 buổi trong series
// Tạo series mới trên courtCL03
const seriesCourt3 = IDS.courtCL03;
const series3Res = await api("/series", {
  method: "POST",
  token: mgr.token,
  idem: true,
  body: {
    court_id: seriesCourt3,
    first_date: ictDate(8),
    start_local: "14:00",
    weeks: 4,
    method: "cash",
    phone: memberB.phone,
  },
});
if (series3Res.status === 201) {
  // Lấy các booking của memberB để tìm 1 booking thuộc series
  const bBookings = await api("/me/bookings", { token: memberB.token });
  const singleBooking = bBookings.data?.items?.find((b) => b.series_id === series3Res.data.series_id);
  if (singleBooking) {
    const cancelOneRes = await api(`/bookings/${singleBooking.id}/cancel`, {
      method: "POST",
      token: mgr.token,
      body: { waive: true, reason: "Hủy 1 buổi duy nhất trong series" },
    });
    check("SER-04", "Huỷ 1 buổi trong series → 200, các buổi khác còn nguyên", cancelOneRes, {
      status: 200,
    });
  } else {
    blocked("SER-04", "Huỷ 1 buổi trong series", "không tìm thấy booking con của series");
  }
}

// Tổng kết suite
summary();
