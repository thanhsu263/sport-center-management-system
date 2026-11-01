/**
 * Suite 11 — Cấu hình & báo cáo (11-settings-reports.mjs).
 * Viết theo docs/AGENT-TEST-INSTRUCTIONS.md và docs/AGENT-TEST-SUITES.md mục 11.
 * Tiền tố: SET-, RPT-, AUD-, LST-.
 * Ước lượng: ~2 hội viên mới.
 */
import {
  api,
  blocked,
  check,
  ictDate,
  login,
  newMember,
  PHONES,
  summary,
} from "../agent-lib.mjs";

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);
const memberA = await newMember();

// ──────────────────────────────────────────────
// 11.1 Cấu hình hệ thống (SET-)
// ──────────────────────────────────────────────

// Lưu lại settings ban đầu để dọn dẹp ở cuối
const originalSettingsRes = await api("/settings", { token: mgr.token });
const origSettings = originalSettingsRes.data;

// SET-01: Manager đọc settings
check("SET-01", "Manager đọc settings → 200", originalSettingsRes, {
  status: 200,
  test: (r) => r.data?.open_time !== undefined && r.data?.close_time !== undefined,
});

try {
  // SET-02: Manager sửa settings hợp lệ (ví dụ: hold_minutes, book_ahead_days)
  const patchValidRes = await api("/settings", {
    method: "PATCH",
    token: mgr.token,
    body: {
      hold_minutes: 12,
      book_ahead_days: 10,
    },
  });
  check("SET-02", "Manager sửa settings hợp lệ → 200, đọc lại đúng", patchValidRes, {
    status: 200,
    test: (r) => r.data?.hold_minutes === 12 && r.data?.book_ahead_days === 10,
  });

  // SET-03: Đặt giá trị ngoài biên (âm, quá lớn, sai kiểu)
  const patchInvalidRes = await api("/settings", {
    method: "PATCH",
    token: mgr.token,
    body: {
      hold_minutes: -5,
    },
  });
  check("SET-03", "Đặt giá trị ngoài biên (hold_minutes < 1) → 400", patchInvalidRes, {
    status: 400,
    test: (r) => r.data?.field === "hold_minutes",
  });

  // SET-04: Đặt giờ mở cửa open_time >= close_time
  const patchHoursRes = await api("/settings", {
    method: "PATCH",
    token: mgr.token,
    body: {
      open_time: "22:00",
      close_time: "06:00",
    },
  });
  check("SET-04", "Đặt giờ mở cửa open_time >= close_time → 400", patchHoursRes, {
    status: 400,
  });

  // SET-05: Receptionist/member sửa settings
  const recPatchRes = await api("/settings", {
    method: "PATCH",
    token: rec.token,
    body: { hold_minutes: 15 },
  });
  check("SET-05-rec", "Receptionist sửa settings → 403", recPatchRes, {
    status: 403,
  });
  const memPatchRes = await api("/settings", {
    method: "PATCH",
    token: memberA.token,
    body: { hold_minutes: 15 },
  });
  check("SET-05", "Member sửa settings → 403", memPatchRes, {
    status: 403,
  });

  // SET-06: Bật/tắt feature flag (F4 classes)
  const disableFlagRes = await api("/flags", {
    method: "PATCH",
    token: mgr.token,
    body: { F4: false },
  });
  check("SET-06-disable", "Tắt feature flag F4 → 200", disableFlagRes, {
    status: 200,
    test: (r) => r.data?.flags?.F4 === false,
  });

  // Khi F4 tắt, route yêu cầu F4 (/at-risk) phải từ chối (403)
  const flagBlockRes = await api("/at-risk", { token: mgr.token });
  check("SET-06", "Sau khi tắt F4, route yêu cầu F4 bị chặn → 403", flagBlockRes, {
    status: 403,
  });

  // Bật lại F4
  const enableFlagRes = await api("/flags", {
    method: "PATCH",
    token: mgr.token,
    body: { F4: true },
  });
  check("SET-06-restore", "Bật lại feature flag F4 → 200", enableFlagRes, {
    status: 200,
    test: (r) => r.data?.flags?.F4 === true,
  });

} finally {
  // Dọn sạch settings về ban đầu
  if (origSettings) {
    await api("/settings", {
      method: "PATCH",
      token: mgr.token,
      body: {
        hold_minutes: origSettings.hold_minutes,
        book_ahead_days: origSettings.book_ahead_days,
        open_time: origSettings.open_time,
        close_time: origSettings.close_time,
      },
    });
    await api("/flags", { method: "PATCH", token: mgr.token, body: { F4: true } });
  }
}

// ──────────────────────────────────────────────
// 11.2 Báo cáo doanh thu & công suất (RPT-)
// ──────────────────────────────────────────────

// RPT-01: Manager xem doanh thu theo khoảng ngày
const revRes = await api("/reports/revenue?from=2026-10-01&to=2026-10-31", {
  token: mgr.token,
});
check("RPT-01", "Manager xem doanh thu theo khoảng ngày → 200, có totals", revRes, {
  status: 200,
  test: (r) => r.data?.totals !== undefined && typeof r.data?.by_source === "object",
});

// RPT-02: Doanh thu với ngày bắt đầu > ngày kết thúc
const revInvalidRange = await api("/reports/revenue?from=2026-10-31&to=2026-10-01", {
  token: mgr.token,
});
check("RPT-02", "Doanh thu với ngày bắt đầu > ngày kết thúc → 400", revInvalidRange, {
  status: 400,
  test: (r) => r.data?.field === "to",
});

// RPT-03: Doanh thu định dạng ngày sai
const revBadDate = await api("/reports/revenue?from=sai-dinh-dang&to=2026-10-31", {
  token: mgr.token,
});
check("RPT-03", "Doanh thu định dạng ngày sai → 400", revBadDate, {
  status: 400,
  test: (r) => r.data?.field === "from",
});

// RPT-04: Báo cáo công suất sân (occupancy)
const occRepRes = await api(`/reports/occupancy?date=${ictDate(0)}`, {
  token: mgr.token,
});
check("RPT-04", "Báo cáo công suất sân (occupancy) → 200, có items", occRepRes, {
  status: 200,
  test: (r) => Array.isArray(r.data?.items) && r.data?.date !== undefined,
});

// RPT-05: Xuất CSV báo cáo hoá đơn
const csvExportRes = await api("/invoices/export?format=csv", {
  token: mgr.token,
});
check("RPT-05", "Xuất CSV hoá đơn → 200, định dạng text/csv, có header", csvExportRes, {
  status: 200,
  test: (r) => {
    const isCsvType = String(r.headers?.["content-type"] ?? "").includes("text/csv");
    const hasHeader = typeof r.data === "string" && r.data.includes("So_hoa_don");
    return isCsvType && hasHeader;
  },
});

// RPT-06: Member xem báo cáo doanh thu
const memRevRes = await api("/reports/revenue", {
  token: memberA.token,
});
check("RPT-06", "Member xem báo cáo doanh thu → 403", memRevRes, {
  status: 403,
});

// ──────────────────────────────────────────────
// 11.3 Nhật ký kiểm toán (AUD-)
// ──────────────────────────────────────────────

// AUD-01: Manager xem audit log
const auditRes = await api("/audit", { token: mgr.token });
check("AUD-01", "Manager xem audit log → 200, có danh sách items", auditRes, {
  status: 200,
  test: (r) => Array.isArray(r.data?.items),
});

// AUD-02: Một hành động ghi/xoá có tạo bản ghi audit
// Vừa gọi PATCH /flags và PATCH /settings ở trên, đọc lại audit log thấy hành động tương ứng
const hasAuditAction = auditRes.data?.items?.some(
  (it) => it.action === "patch_flags" || it.action === "patch_settings",
);
check("AUD-02", "Hành động ghi/sửa có tạo bản ghi audit → đọc lại thấy entry", auditRes, {
  status: 200,
  test: () => hasAuditAction,
});

// AUD-03: Member/receptionist xem audit log
const recAuditRes = await api("/audit", { token: rec.token });
check("AUD-03-rec", "Receptionist xem audit log → 403", recAuditRes, {
  status: 403,
});
const memAuditRes = await api("/audit", { token: memberA.token });
check("AUD-03", "Member xem audit log → 403", memAuditRes, {
  status: 403,
});

// ──────────────────────────────────────────────
// 11.4 Danh sách & phân trang (LST-)
// ──────────────────────────────────────────────

// LST-01: Manager list members không limit → mặc định kẹp limit (tối đa 25)
const defaultListRes = await api("/directory/members", { token: mgr.token });
check("LST-01", "Manager list members không limit → 200, giới hạn mặc định (<= 25)", defaultListRes, {
  status: 200,
  test: (r) => Array.isArray(r.data?.items) && r.data?.items.length <= 25,
});

// LST-02: List với limit hợp lệ (limit=3)
const limitListRes = await api("/directory/members?limit=3", { token: mgr.token });
check("LST-02", "List với limit=3 → 200, đúng 3 dòng", limitListRes, {
  status: 200,
  test: (r) => r.data?.items?.length === 3,
});

// LST-03: List với limit quá lớn / âm / sai kiểu
const invalidLimitRes = await api("/directory/members?limit=-5", { token: mgr.token });
check("LST-03-neg", "List với limit âm → 400", invalidLimitRes, {
  status: 400,
  test: (r) => r.data?.field === "limit",
});
const overLimitRes = await api("/directory/members?limit=500", { token: mgr.token });
check("LST-03", "List với limit vượt trần (500 > 100) → 400", overLimitRes, {
  status: 400,
  test: (r) => r.data?.field === "limit",
});

// LST-04: List với offset/cursor hợp lệ
const page1Res = await api("/directory/members?limit=3&offset=0", { token: mgr.token });
const page2Res = await api("/directory/members?limit=3&offset=3", { token: mgr.token });
const p1Ids = new Set(page1Res.data?.items?.map((it) => it.id));
const hasOverlap = page2Res.data?.items?.some((it) => p1Ids.has(it.id));
check("LST-04", "List với offset hợp lệ → 200, không trùng lặp giữa các trang", page2Res, {
  status: 200,
  test: () => !hasOverlap && (page2Res.data?.items?.length ?? 0) > 0,
});

// LST-05: Member list toàn bộ members
const memListAllRes = await api("/directory/members", { token: memberA.token });
check("LST-05", "Member list danh bạ toàn bộ members → 403", memListAllRes, {
  status: 403,
});

// Tổng kết
summary();
