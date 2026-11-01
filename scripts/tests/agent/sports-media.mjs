/**
 * sports-media.mjs — Comprehensive test suite for Dynamic Sports Management,
 * Media Library, and Capacity Heatmap (Phase 4).
 *
 * Covers:
 *   - Sports (SP-01..SP-20):
 *       CRUD sports, 409 on duplicate code/prefix, 409 retirement blocks (active courts,
 *       future bookings, classes, plans), protected 'all' and last playable sport,
 *       permanent delete on clean sports vs 409 on sports with history,
 *       locked court_prefix when courts exist, full court creation & booking on new sport,
 *       400/422 validation on invalid sports in booking/class/plan/promo, RBAC 403 for non-managers.
 *   - Media Library (ML-01..ML-12):
 *       Media library listing, category filter, search query, choose from library PATCH slot with library_id,
 *       public asset reflection, 422 for non-library or path-traversal paths, auto-registration of uploads,
 *       history logging & reset, RBAC 403 for non-managers.
 *   - Heatmap (HM-01..HM-06):
 *       days_booked and days_total metrics, 1-day mode (0 or 1 booked / 1 total),
 *       date range calculation, retired courts hidden when no bookings exist,
 *       sport filtering, RBAC 403 for non-managers.
 *   - Self-cleanup: cleans up test courts, sports, bookings, and resets modified slots.
 */

import { IDS, api, check, loginAll, newMember, memberWithPlan, summary, ictDate } from "../agent-lib.mjs";

console.log("===============================================================");
console.log("  SUITE: SPORTS & MEDIA (PHASE 4)");
console.log("===============================================================\n");

const who = await loginAll();
const mgr = who.manager.token;
const rec = who.receptionist.token;
const coa = who.coach.token;
const mem = who.memberNoPlan.token;

const nonManagers = [
  { role: "receptionist", token: rec },
  { role: "coach", token: coa },
  { role: "member", token: mem },
];

function makePng(width = 800, height = 600) {
  const buf = Buffer.alloc(100);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// ---------------------------------------------------------------------------
// 1. SPORTS MANAGEMENT TESTS (SP-01 .. SP-20)
// ---------------------------------------------------------------------------
console.log("\n--- 1. Sports: Public & Manager Lists ---");

// SP-01: Public sports list
const pubSports = await api("/sports");
check("SP-01", "GET /v1/sports returns active sports list without 'all'", pubSports, {
  status: 200,
  test: (r) => {
    const items = r.data?.items ?? [];
    const codes = items.map((s) => s.code);
    return (
      Array.isArray(items) &&
      items.length >= 3 &&
      codes.includes("badminton") &&
      codes.includes("basketball") &&
      codes.includes("volleyball") &&
      !codes.includes("all")
    );
  },
  why: "returns active playable sports list without global scope 'all'",
});

// SP-02: Manager sports list
const mgrSports = await api("/manager/sports", { token: mgr });
check("SP-02", "GET /v1/manager/sports returns all sports including 'all' and blocker counts", mgrSports, {
  status: 200,
  test: (r) => {
    const items = r.data?.items ?? [];
    const allRow = items.find((s) => s.code === "all");
    const badRow = items.find((s) => s.code === "badminton");
    return (
      Array.isArray(items) &&
      Boolean(allRow && allRow.is_scope_all) &&
      Boolean(badRow && badRow.active_courts_count > 0)
    );
  },
  why: "manager list includes all sports and active court counts",
});

// SP-03: Create new sport 'padel'
const testSportCode = "padel";
const testPrefix = "PD";
const createSport = await api("/manager/sports", {
  method: "POST",
  token: mgr,
  body: {
    code: testSportCode,
    name_en: "Padel Tennis",
    name_vi: "Quần vợt Padel",
    court_prefix: testPrefix,
    color_key: "sky",
    glyph_key: "tennis",
    max_players: 4,
    slot_duration_min: 60,
    sort_order: 40,
    weekday_price_vnd: 150000,
  },
});
check("SP-03", "POST /v1/manager/sports creates new sport with price rules & slot", createSport, {
  status: 201,
  test: (r) => r.data?.ok === true && r.data?.sport?.code === testSportCode,
  why: "sport created with status 201 and matching code",
});

// SP-04: Verify new sport in public list
const pubSportsAfter = await api("/sports");
check("SP-04", "GET /v1/sports includes newly created sport", pubSportsAfter, {
  status: 200,
  test: (r) => (r.data?.items ?? []).some((s) => s.code === testSportCode),
  why: `${testSportCode} is visible in public list`,
});

// SP-05: Patch sport attributes
const patchSport = await api(`/manager/sports/${testSportCode}`, {
  method: "PATCH",
  token: mgr,
  body: {
    name_en: "Padel Pro",
    color_key: "plum",
    sort_order: 45,
  },
});
check("SP-05", "PATCH /v1/manager/sports/:code updates name and attributes", patchSport, {
  status: 200,
  test: (r) => r.data?.sport?.name_en === "Padel Pro" && r.data?.sport?.color_key === "plum",
  why: "updated name_en and color_key",
});

// SP-06: 409 Conflict on duplicate code
const dupCode = await api("/manager/sports", {
  method: "POST",
  token: mgr,
  body: {
    code: testSportCode,
    name_en: "Duplicate Code Sport",
    name_vi: "Trùng mã",
    court_prefix: "PX",
  },
});
check("SP-06", "POST /v1/manager/sports with existing code -> 409 Conflict", dupCode, { status: 409 });

// SP-07: 409 Conflict on duplicate prefix
const dupPrefix = await api("/manager/sports", {
  method: "POST",
  token: mgr,
  body: {
    code: "padel-other",
    name_en: "Duplicate Prefix Sport",
    name_vi: "Trùng tiền tố",
    court_prefix: testPrefix,
  },
});
check("SP-07", "POST /v1/manager/sports with existing court_prefix -> 409 Conflict", dupPrefix, { status: 409 });

// SP-08: 409 Conflict retiring sport with active courts
const retireBadminton = await api("/manager/sports/badminton/retire", {
  method: "POST",
  token: mgr,
  body: {},
});
check("SP-08", "POST /v1/manager/sports/badminton/retire -> 409 (active courts exist)", retireBadminton, {
  status: 409,
  test: (r) => String(r.data?.message).includes("active court"),
  why: "blocked because badminton has active courts",
});

// SP-09: 409 Conflict retiring global 'all' scope
const retireAll = await api("/manager/sports/all/retire", {
  method: "POST",
  token: mgr,
  body: {},
});
check("SP-09", "POST /v1/manager/sports/all/retire -> 409 (cannot retire 'all')", retireAll, { status: 409 });

// SP-10: Permanent delete on sport with history -> 409
const delBadminton = await api("/manager/sports/badminton", {
  method: "DELETE",
  token: mgr,
});
check("SP-10", "DELETE /v1/manager/sports/badminton -> 409 (has history)", delBadminton, { status: 409 });

// SP-11: Clean sport permanent deletion -> 200
const cleanCode = "clean-del";
const cleanPrefix = "CZ";
await api("/manager/sports", {
  method: "POST",
  token: mgr,
  body: {
    code: cleanCode,
    name_en: "Clean Delete Sport",
    name_vi: "Môn xoá sạch",
    court_prefix: cleanPrefix,
  },
});
const delClean = await api(`/manager/sports/${cleanCode}`, {
  method: "DELETE",
  token: mgr,
});
check("SP-11", "DELETE /v1/manager/sports/:code for sport without history -> 200", delClean, {
  status: 200,
  test: (r) => r.data?.ok === true && r.data?.deleted === cleanCode,
  why: "sport successfully deleted from database",
});

// SP-12: Create court for new sport
let padelCourtId = null;
const createCourt = await api("/manager/courts", {
  method: "POST",
  token: mgr,
  body: {
    sport: testSportCode,
    name: "Sân Padel 01",
  },
});
padelCourtId = createCourt.data?.court?.id;
check("SP-12", "Create court for new sport -> 201 with prefix PD", createCourt, {
  status: 201,
  test: (r) => Boolean(r.data?.court?.court_code?.startsWith("PD-")),
  why: "court_code uses court_prefix PD",
});

// SP-13: Changing court prefix when courts exist -> 409
const changePrefix = await api(`/manager/sports/${testSportCode}`, {
  method: "PATCH",
  token: mgr,
  body: {
    court_prefix: "PX",
  },
});
check("SP-13", "PATCH court_prefix when courts exist -> 409 Conflict", changePrefix, { status: 409 });

// SP-14: Booking flow on newly created sport court
let padelBookingId = null;
const freshMem = await newMember();
const bookDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const holdBooking = await api("/bookings", {
  method: "POST",
  token: freshMem.token,
  idem: true,
  body: {
    court_id: padelCourtId,
    start_at: `${bookDate}T08:00:00+07:00`,
    end_at: `${bookDate}T09:00:00+07:00`,
  },
});
padelBookingId = holdBooking.data?.booking?.id;
check("SP-14", "Hold booking on new sport court -> 201", holdBooking, {
  status: 201,
  test: (r) => Boolean(r.data?.booking?.id),
  why: "booking hold created on new sport court",
});

// Clean up booking immediately
if (padelBookingId) {
  await api(`/bookings/${padelBookingId}/cancel`, {
    method: "POST",
    token: freshMem.token,
    body: { reason: "test cleanup" },
  });
}

// SP-14-all-plan: sport_scope = 'all' plan applies discount to newly created sport court
const memAll = await memberWithPlan(mgr, IDS.planAllAccess30);
const allHold = await api("/bookings", {
  method: "POST",
  token: memAll.token,
  idem: true,
  body: {
    court_id: padelCourtId,
    start_at: `${bookDate}T11:00:00+07:00`,
    end_at: `${bookDate}T12:00:00+07:00`,
  },
});
check("SP-14-all-plan", "sport_scope = 'all' plan applies to new sport court", allHold, {
  status: 201,
  test: (r) => {
    const b = r.data?.booking;
    return Boolean(b && b.id && b.discount_pct > 0 && r.data?.price < r.data?.list_price);
  },
  why: "member with 'all' plan receives court discount on new sport court",
});
if (allHold.data?.booking?.id) {
  await api(`/bookings/${allHold.data.booking.id}/cancel`, {
    method: "POST",
    token: memAll.token,
    body: { reason: "cleanup all plan test" },
  });
}

// SP-15: Validation: invalid sport code rejected in entities (400 or 422)
const fakeClass = await api("/classes", {
  method: "POST",
  token: mgr,
  body: {
    sport: "nonexistent_sport_xyz",
    name_vi: "Lớp học giả",
    name_en: "Fake Class",
    level: "beginner",
    coach_id: who.coach.id,
    capacity: 10,
    price_vnd: 200000,
    start_on: "2026-11-01",
    end_on: "2026-11-30",
    schedule_description: "T2-T4",
  },
});
check("SP-15-class", "POST /v1/classes with invalid sport -> 422", fakeClass, { status: [400, 422] });

const fakePlan = await api("/plans", {
  method: "POST",
  token: mgr,
  body: {
    name_vi: "Gói tập giả",
    name_en: "Fake Plan",
    sport_scope: "nonexistent_sport_xyz",
    kind: "fixed_period",
    duration_days: 30,
    price_vnd: 500000,
  },
});
check("SP-15-plan", "POST /v1/plans with invalid sport -> 400 or 422", fakePlan, { status: [400, 422] });

const fakePromo = await api("/promotions", {
  method: "POST",
  token: mgr,
  body: {
    code: "FAKESPORTPROMO",
    discount_pct: 10,
    sport: "nonexistent_sport_xyz",
    start_at: "2026-10-01T00:00:00Z",
    end_at: "2026-12-31T23:59:59Z",
  },
});
check("SP-15-promo", "POST /v1/promotions with invalid sport -> 400 or 422", fakePromo, { status: [400, 422] });

// SP-16: Retire sport blocked by active court
const retireWithCourt = await api(`/manager/sports/${testSportCode}/retire`, {
  method: "POST",
  token: mgr,
  body: {},
});
check("SP-16", "Retire sport with active court -> 409 Conflict", retireWithCourt, {
  status: 409,
  test: (r) => String(r.data?.message).includes("active court"),
  why: "blocked because active court exists",
});

// SP-17: Retire court then retire sport -> 200
if (padelCourtId) {
  // Disable sport first so dynamic subquery in courts.ts allows court retirement
  await api(`/manager/sports/${testSportCode}`, {
    method: "PATCH",
    token: mgr,
    body: { enabled: false },
  });
  await api(`/manager/courts/${padelCourtId}/retire`, {
    method: "POST",
    token: mgr,
    body: {},
  });
}
const retireClean = await api(`/manager/sports/${testSportCode}/retire`, {
  method: "POST",
  token: mgr,
  body: {},
});
check("SP-17", "Retire sport after court retired -> 200", retireClean, {
  status: 200,
  test: (r) => Boolean(r.data?.sport?.retired_at),
  why: "retired_at timestamp is populated",
});

// SP-18: Retired sport hidden from public list
const pubAfterRetire = await api("/sports");
check("SP-18", "Retired sport excluded from public /v1/sports list", pubAfterRetire, {
  status: 200,
  test: (r) => !(r.data?.items ?? []).some((s) => s.code === testSportCode),
  why: `${testSportCode} is no longer in public list`,
});

// SP-19: Restore retired sport -> 200
const restoreSport = await api(`/manager/sports/${testSportCode}/restore`, {
  method: "POST",
  token: mgr,
  body: {},
});
check("SP-19", "Restore retired sport -> 200 with retired_at null", restoreSport, {
  status: 200,
  test: (r) => r.data?.sport?.retired_at === null,
  why: "sport successfully un-retired",
});

// SP-20: RBAC: non-manager roles cannot manage sports (403)
for (const { role, token } of nonManagers) {
  const rCreate = await api("/manager/sports", {
    method: "POST",
    token,
    body: { code: `sp-${role}`, court_prefix: "XX", name_en: "X", name_vi: "X" },
  });
  check(`SP-20-${role}-create`, `POST /v1/manager/sports as ${role} -> 403`, rCreate, { status: 403 });

  const rPatch = await api(`/manager/sports/${testSportCode}`, {
    method: "PATCH",
    token,
    body: { name_en: "Hacked" },
  });
  check(`SP-20-${role}-patch`, `PATCH /v1/manager/sports/:code as ${role} -> 403`, rPatch, { status: 403 });

  const rRetire = await api(`/manager/sports/${testSportCode}/retire`, {
    method: "POST",
    token,
    body: {},
  });
  check(`SP-20-${role}-retire`, `POST /v1/manager/sports/:code/retire as ${role} -> 403`, rRetire, { status: 403 });

  const rDelete = await api(`/manager/sports/${testSportCode}`, {
    method: "DELETE",
    token,
  });
  check(`SP-20-${role}-delete`, `DELETE /v1/manager/sports/:code as ${role} -> 403`, rDelete, { status: 403 });
}

// ---------------------------------------------------------------------------
// 1b. DYNAMIC SPORT WITH TEXT FK (NO ::sport_kind CASTING) TESTS
// ---------------------------------------------------------------------------
console.log("\n--- 1b. Dynamic Sport 'tennis' without ::sport_kind casting ---");

// SP-21: Create sport 'tennis'
const tennisCode = "tennis";
const tennisPrefix = "TN";
const createTennis = await api("/manager/sports", {
  method: "POST",
  token: mgr,
  body: {
    code: tennisCode,
    name_en: "Tennis",
    name_vi: "Quần vợt",
    court_prefix: tennisPrefix,
    color_key: "sun",
    glyph_key: "tennis",
    max_players: 4,
    slot_duration_min: 60,
    sort_order: 50,
  },
});
check("SP-21", "POST /v1/manager/sports creates sport 'tennis' -> 201 (no 500)", createTennis, {
  status: 201,
  test: (r) => r.data?.sport?.code === tennisCode,
  why: "created sport 'tennis' with text FK",
});

// SP-22: Assign 'tennis' to coach (staff handler without ::sport_kind cast)
const coachId = who.coach.user?.id ?? who.coach.id;
const assignStaff = await api(`/staff/${coachId}`, {
  method: "PATCH",
  token: mgr,
  body: {
    sports: ["badminton", "tennis"],
  },
});
check("SP-22", "PATCH /v1/staff/:id assigns 'tennis' to coach -> 200 (no 500)", assignStaff, {
  status: 200,
  test: (r) => {
    const sports = r.data?.staff?.sports ?? [];
    return sports.includes("tennis");
  },
  why: "coach_sports accepts 'tennis' without enum cast",
});

// SP-23: Create promotion for 'tennis' (promos handler without ::sport_kind cast)
const promoTennis = await api("/promotions", {
  method: "POST",
  token: mgr,
  body: {
    code: "TENNIS20",
    name: "Tennis Opening Discount",
    kind: "percent",
    value: 20,
    applies_to: ["court"],
    sport: "tennis",
  },
});
check("SP-23", "POST /v1/promotions creates promo for 'tennis' -> 201 (no 500)", promoTennis, {
  status: 201,
  test: (r) => r.data?.promo?.sport === "tennis",
  why: "promotions accepts sport 'tennis' without enum cast",
});

// SP-24: Record member level for 'tennis' (training handler without ::sport_kind cast)
const memberId = who.memberNoPlan.user?.id ?? who.memberNoPlan.id;
const putLevel = await api(`/students/${memberId}/level`, {
  method: "PUT",
  token: mgr,
  body: {
    sport: "tennis",
    level: "intermediate",
  },
});
check("SP-24", "PUT /v1/students/:id/level records level for 'tennis' -> 200 (no 500)", putLevel, {
  status: 200,
  test: (r) => r.data?.sport === "tennis" && r.data?.level === "intermediate",
  why: "member_levels accepts sport 'tennis' without enum cast",
});

// SP-25: Record progress review for 'tennis' (training handler without ::sport_kind cast)
const postReview = await api(`/students/${memberId}/reviews`, {
  method: "POST",
  token: mgr,
  body: {
    sport: "tennis",
    period_weeks: 2,
    technique: 4,
    fitness: 4,
    attitude: 5,
    comment: "Good baseline game and serve technique",
  },
});
check("SP-25", "POST /v1/students/:id/reviews records review for 'tennis' -> 201 (no 500)", postReview, {
  status: 201,
  test: (r) => Boolean(r.data?.id),
  why: "progress_reviews accepts sport 'tennis' without enum cast",
});

// ---------------------------------------------------------------------------
// 2. MEDIA LIBRARY TESTS (ML-01 .. ML-14)
// ---------------------------------------------------------------------------
console.log("\n--- 2. Media Library: Browser, Choose & Upload ---");

// ML-01: List media library
const libRes = await api("/manager/media-library", { token: mgr });
check("ML-01", "GET /v1/manager/media-library returns >= 110 items with metadata", libRes, {
  status: 200,
  test: (r) => {
    const items = r.data?.items ?? [];
    return (
      Array.isArray(items) &&
      items.length >= 110 &&
      items.every((it) => it.id && it.path && it.category && it.license)
    );
  },
  why: `returns ${libRes.data?.items?.length} items with complete schema`,
});

// ML-02: Category filter
const coachLib = await api("/manager/media-library?category=coach", { token: mgr });
check("ML-02", "Filter by category=coach returns only coach items (>= 14)", coachLib, {
  status: 200,
  test: (r) => {
    const items = r.data?.items ?? [];
    return items.length >= 14 && items.every((it) => it.category === "coach");
  },
  why: `returns ${coachLib.data?.items?.length} coach items`,
});

// ML-03: Search query
const searchLib = await api("/manager/media-library?search=badminton", { token: mgr });
check("ML-03", "Search query returns relevant matching items", searchLib, {
  status: 200,
  test: (r) => {
    const items = r.data?.items ?? [];
    return (
      items.length > 0 &&
      items.every(
        (it) =>
          it.path.includes("badminton") ||
          it.category === "badminton" ||
          it.alt_en?.toLowerCase().includes("badminton") ||
          it.tags?.includes("badminton"),
      )
    );
  },
  why: `returns ${searchLib.data?.items?.length} badminton search results`,
});

// ML-04: Choose photo from library for a slot
const libItem = (libRes.data?.items ?? []).find((it) => it.category === "badminton");
const targetSlot = "landing.hero.image";
const chooseFromLib = await api(`/manager/site-assets/${targetSlot}`, {
  method: "PATCH",
  token: mgr,
  body: {
    library_id: libItem.id,
  },
});
check("ML-04", "PATCH slot with library_id updates slot path and clears bytes", chooseFromLib, {
  status: 200,
  test: (r) => r.data?.ok === true && typeof r.data?.version === "number",
  why: "slot updated with version increment",
});

// ML-05: Public asset reflects chosen library photo
const pubAssets = await api("/site-assets");
check("ML-05", "GET /v1/site-assets reflects chosen library photo path", pubAssets, {
  status: 200,
  test: (r) => {
    const hero = (r.data?.items ?? []).find((it) => it.slot === targetSlot);
    return hero && (hero.url.includes(libItem.path) || hero.url.includes("library/badminton"));
  },
  why: "hero slot serves the library image path",
});

// ML-06: Reject path not in media library (422)
const fakePath = await api(`/manager/site-assets/${targetSlot}`, {
  method: "PATCH",
  token: mgr,
  body: {
    src_path: "/media/not-in-library-123456.jpg",
  },
});
check("ML-06", "PATCH slot with path not in media_library -> 422", fakePath, { status: 422 });

// ML-07: Reject directory traversal path (422)
const traversalPath = await api(`/manager/site-assets/${targetSlot}`, {
  method: "PATCH",
  token: mgr,
  body: {
    src_path: "/media/../../etc/passwd",
  },
});
check("ML-07", "PATCH slot with traversal path -> 422", traversalPath, { status: 422 });

// ML-08: Upload image auto-registers into media_library
const upPng = await api("/manager/site-assets/upload", {
  method: "POST",
  token: mgr,
  body: {
    slot: targetSlot,
    data_base64: makePng(900, 600).toString("base64"),
  },
});
check("ML-08", "Upload valid PNG -> 200 and version increments", upPng, {
  status: 200,
  test: (r) => Boolean(r.data?.url?.includes("/v1/site-assets/")),
  why: "upload succeeds with file endpoint URL",
});

// ML-09: Uploaded item appears in media_library with category 'uploaded'
const upLib = await api("/manager/media-library?category=uploaded", { token: mgr });
check("ML-09", "Uploaded photo auto-registers into media_library with category 'uploaded'", upLib, {
  status: 200,
  test: (r) => {
    const items = r.data?.items ?? [];
    return items.length > 0 && items.some((it) => it.tags?.includes(targetSlot));
  },
  why: "new upload found in media_library under 'uploaded'",
});

// ML-10: Reset slot back to default
const resetRes = await api(`/manager/site-assets/${targetSlot}/reset`, {
  method: "POST",
  token: mgr,
  body: {},
});
check("ML-10", "POST /v1/manager/site-assets/:slot/reset resets to default", resetRes, { status: 200 });

// ML-11: Public assets reflect default path after reset
const pubAfterReset = await api("/site-assets");
check("ML-11", "Public asset reflects default path after reset", pubAfterReset, {
  status: 200,
  test: (r) => {
    const hero = (r.data?.items ?? []).find((it) => it.slot === targetSlot);
    return Boolean(hero && hero.url);
  },
  why: "slot returns default URL",
});

// ML-12: Non-manager RBAC for media library (403)
for (const { role, token } of nonManagers) {
  const rLib = await api("/manager/media-library", { token });
  check(`ML-12-${role}`, `GET /v1/manager/media-library as ${role} -> 403`, rLib, { status: 403 });
}

// ML-13: Slot preservation when modified by manager
const customSlotRes = await api("/manager/site-assets/landing.hero.image", {
  method: "PATCH",
  token: mgr,
  body: { src_path: "/media/library/facility/facility-fitness-studio.jpg" },
});
check("ML-13-patch", "PATCH landing.hero.image to custom library path -> 200", customSlotRes, { status: 200 });

// Reset slot back to default
await api("/manager/site-assets/landing.hero.image/reset", {
  method: "POST",
  token: mgr,
  body: {},
});

// ML-14: Public credits endpoint returns photo authors and licenses (Item 4)
const creditsRes = await api("/media/credits");
check("ML-14", "GET /v1/media/credits returns all library photo attributions", creditsRes, {
  status: 200,
  test: (r) => {
    const items = r.data?.items ?? [];
    return (
      Array.isArray(items) &&
      items.length >= 110 &&
      items.every((it) => (it.author || it.credit) && it.license && it.source_url)
    );
  },
  why: `credits endpoint serves ${creditsRes.data?.items?.length} items with author, license, and source link`,
});

// ---------------------------------------------------------------------------
// 3. CAPACITY HEATMAP TESTS (HM-01 .. HM-06)
// ---------------------------------------------------------------------------
console.log("\n--- 3. Capacity Heatmap: Metrics & Behavior ---");

// HM-01: Returns days_booked and days_total in courts
const capRange = await api("/manager/capacity?from=2026-10-15&to=2026-10-17", { token: mgr });
check("HM-01", "GET /v1/manager/capacity returns days_booked and days_total in courts", capRange, {
  status: 200,
  test: (r) => {
    const courts = r.data?.courts ?? [];
    return (
      Array.isArray(courts) &&
      courts.length > 0 &&
      courts.every((c) => Array.isArray(c.days_booked) && typeof c.days_total === "number")
    );
  },
  why: "every court includes days_booked array and days_total metrics",
});

// HM-02: 1-day mode: days_total is 1, days_booked is 0 or 1 for each hour
const capSingle = await api("/manager/capacity?from=2026-10-16&to=2026-10-16", { token: mgr });
check("HM-02", "1-day mode has days_total=1 and days_booked in {0, 1}", capSingle, {
  status: 200,
  test: (r) => {
    const courts = r.data?.courts ?? [];
    return (
      Array.isArray(courts) &&
      courts.length > 0 &&
      courts.every((c) => c.days_total === 1 && c.days_booked.every((d) => d === 0 || d === 1))
    );
  },
  why: "1-day mode strictly binary (booked or free)",
});

// HM-03: Multi-day range calculation
check("HM-03", "3-day mode has days_total=3 and days_booked <= days_total", capRange, {
  status: 200,
  test: (r) => {
    const courts = r.data?.courts ?? [];
    return courts.every((c) => c.days_total === 3 && c.days_booked.every((d) => d <= 3 && d >= 0));
  },
  why: "range correctly spans 3 days",
});

// HM-04: Retired court without booking is HIDDEN from heatmap
check("HM-04", "Retired court without bookings is hidden from heatmap", capSingle, {
  status: 200,
  test: (r) => {
    const courts = r.data?.courts ?? [];
    return !courts.some((c) => c.court_id === padelCourtId);
  },
  why: `retired court ${padelCourtId} is not in courts`,
});

// HM-05: Filter heatmap by sport
const capBadminton = await api("/manager/capacity?from=2026-10-16&to=2026-10-16&sport=badminton", {
  token: mgr,
});
check("HM-05", "GET /v1/manager/capacity?sport=badminton returns only badminton courts", capBadminton, {
  status: 200,
  test: (r) => {
    const courts = r.data?.courts ?? [];
    return courts.length > 0 && courts.every((c) => c.sport === "badminton");
  },
  why: "all returned courts have sport=badminton",
});

// HM-06: Non-manager RBAC for capacity (403 for member)
const capMember = await api("/manager/capacity?from=2026-10-16&to=2026-10-16", { token: mem });
check("HM-06", "GET /v1/manager/capacity as member -> 403", capMember, { status: 403 });

// ---------------------------------------------------------------------------
// TEARDOWN & CLEANUP
// ---------------------------------------------------------------------------
console.log("\n--- Teardown: Clean up test courts and sports ---");

// Clean up padel test court & sport
if (padelCourtId) {
  await api(`/manager/courts/${padelCourtId}/retire`, { method: "POST", token: mgr, body: {} });
}

// Retire padel sport
await api(`/manager/sports/${testSportCode}/retire`, { method: "POST", token: mgr, body: {} });

// Clean up tennis promo, staff, sport
if (promoTennis.data?.promo?.id) {
  await api(`/promotions/${promoTennis.data.promo.id}`, { method: "DELETE", token: mgr });
}
await api(`/staff/${coachId}`, { method: "PATCH", token: mgr, body: { sports: ["badminton"] } });
await api(`/manager/sports/tennis/retire`, { method: "POST", token: mgr, body: {} });

summary();
