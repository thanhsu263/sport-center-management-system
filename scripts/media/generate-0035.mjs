import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("scripts/media/library.json", "utf8"));

function escapeSql(str) {
  if (str === null || str === undefined) return "NULL";
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function escapeSqlArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "'{}'";
  const elements = arr.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(",");
  return `'{${elements}}'`;
}

const lines = [
  "-- 0035_media_library.sql",
  "-- Curated media library and asset slots upgrade",
  "",
  "CREATE TABLE IF NOT EXISTS media_library (",
  "  id          TEXT PRIMARY KEY,",
  "  path        TEXT NOT NULL UNIQUE,",
  "  kind        TEXT NOT NULL DEFAULT 'image',",
  "  category    TEXT NOT NULL,",
  "  tags        TEXT[] NOT NULL DEFAULT '{}',",
  "  width       INT,",
  "  height      INT,",
  "  alt_en      TEXT NOT NULL,",
  "  alt_vi      TEXT NOT NULL,",
  "  credit      TEXT,",
  "  source_url  TEXT,",
  "  license     TEXT NOT NULL,",
  "  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()",
  ");",
  "",
  "CREATE INDEX IF NOT EXISTS idx_media_library_category ON media_library(category);",
  "CREATE INDEX IF NOT EXISTS idx_media_library_tags ON media_library USING gin(tags);",
  "",
  "-- Seed Media Library Items",
  "INSERT INTO media_library (id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license, created_at) VALUES",
];

const valueLines = manifest.map((item, idx) => {
  const isLast = idx === manifest.length - 1;
  const vals = [
    escapeSql(item.id),
    escapeSql(item.path),
    escapeSql(item.kind || "image"),
    escapeSql(item.category),
    escapeSqlArray(item.tags || []),
    item.width ?? 1280,
    item.height ?? 720,
    escapeSql(item.alt_en || ""),
    escapeSql(item.alt_vi || ""),
    escapeSql(item.credit || ""),
    escapeSql(item.source_url || ""),
    escapeSql(item.license || "CC BY-SA 4.0"),
    escapeSql(item.created_at || "2026-10-17T00:00:00.000Z"),
  ].join(", ");
  return `  (${vals})${isLast ? "" : ","}`;
});

lines.push(...valueLines);
lines.push("ON CONFLICT (id) DO NOTHING;");
lines.push("");

// Coach portrait updates
lines.push(
  "-- Upgrade seeded coach assets to verified high-resolution portraits",
  "UPDATE site_assets",
  "   SET src_path = '/media/library/coach/coach-nguyen-minh-khoa.jpg',",
  "       default_path = '/media/library/coach/coach-nguyen-minh-khoa.jpg'",
  " WHERE slot = 'coach.00000000-0000-0000-0000-000000000011'",
  "   AND bytes IS NULL",
  "   AND src_path = default_path;",
  "",
  "UPDATE site_assets",
  "   SET src_path = '/media/library/coach/coach-tran-thi-lan.jpg',",
  "       default_path = '/media/library/coach/coach-tran-thi-lan.jpg'",
  " WHERE slot = 'coach.00000000-0000-0000-0000-000000000012'",
  "   AND bytes IS NULL",
  "   AND src_path = default_path;",
  "",
  "UPDATE site_assets",
  "   SET src_path = '/media/library/coach/coach-pham-duc-anh.jpg',",
  "       default_path = '/media/library/coach/coach-pham-duc-anh.jpg'",
  " WHERE slot = 'coach.00000000-0000-0000-0000-000000000013'",
  "   AND bytes IS NULL",
  "   AND src_path = default_path;",
  "",
  "UPDATE site_assets",
  "   SET src_path = '/media/library/coach/coach-le-quoc-viet.jpg',",
  "       default_path = '/media/library/coach/coach-le-quoc-viet.jpg'",
  " WHERE slot = 'coach.00000000-0000-0000-0000-000000000014'",
  "   AND bytes IS NULL",
  "   AND src_path = default_path;",
  "",
  "UPDATE site_assets",
  "   SET src_path = '/media/library/coach/coach-minh-quan.jpg',",
  "       default_path = '/media/library/coach/coach-minh-quan.jpg'",
  " WHERE slot = 'coach.00000000-0000-0000-0000-000000000003'",
  "   AND bytes IS NULL",
  "   AND src_path = default_path;",
  ""
);

// General slot upgrades to curated indoor multi-sport photos
const SLOT_UPDATES = [
  { slot: "landing.hero.image", path: "/media/library/facility/facility-multi-court-arena-view.jpg" },
  { slot: "landing.courts.badminton", path: "/media/library/badminton/badminton-indoor-court-wide.jpg" },
  { slot: "landing.courts.basketball", path: "/media/library/basketball/basketball-court-hardwood.jpg" },
  { slot: "landing.courts.volleyball", path: "/media/library/volleyball/volleyball-net-action-arena.jpg" },
  { slot: "landing.facilities.badminton", path: "/media/library/badminton/badminton-racket-frame-view.jpg" },
  { slot: "landing.facilities.basketball", path: "/media/library/basketball/basketball-practice-hall.jpg" },
  { slot: "landing.facilities.volleyball", path: "/media/library/volleyball/volleyball-spike-block-drill.jpg" },
  { slot: "landing.facilities.reception", path: "/media/library/facility/facility-sports-reception.jpg" },
  { slot: "landing.facilities.hall", path: "/media/library/facility/facility-hardwood-gym-hall.jpg" },
  { slot: "landing.closing", path: "/media/library/facility/facility-arena-grandstand-hall.jpg" },
  { slot: "auth.login.image", path: "/media/library/facility/facility-arena-grandstand-hall.jpg" },
  { slot: "auth.register.image", path: "/media/library/coach/coach-young-athlete-trainer.jpg" },
  { slot: "sport.badminton", path: "/media/library/badminton/badminton-indoor-court-wide.jpg" },
  { slot: "sport.basketball", path: "/media/library/basketball/basketball-indoor-wooden-court.jpg" },
  { slot: "sport.volleyball", path: "/media/library/volleyball/volleyball-net-action-arena.jpg" },
  { slot: "sport.all", path: "/media/library/facility/facility-multi-court-arena-view.jpg" },
  { slot: "banner.book", path: "/media/library/facility/facility-multi-court-arena-view.jpg" },
  { slot: "banner.classes", path: "/media/library/class/class-functional-agility-class.jpg" },
  { slot: "banner.train", path: "/media/library/class/class-movement-drills.jpg" },
  { slot: "banner.coach", path: "/media/library/class/class-team-conditioning.jpg" },
  { slot: "banner.gate", path: "/media/library/facility/facility-sports-reception.jpg" },
  { slot: "banner.manager", path: "/media/library/facility/facility-hardwood-gym-hall.jpg" },
];

lines.push("-- Upgrade existing general site slots to verified curated high-resolution library images");
for (const u of SLOT_UPDATES) {
  lines.push(
    "UPDATE site_assets",
    `   SET src_path = '${u.path}',`,
    `       default_path = '${u.path}'`,
    ` WHERE slot = '${u.slot}'`,
    "   AND bytes IS NULL",
    "   AND src_path = default_path;",
    ""
  );
}

// Add missing slots (Phase 3.5)
lines.push(
  "-- Add missing slots for plan, class, empty state, and gallery with curated photography",
  "INSERT INTO site_assets (slot, kind, src_path, default_path, alt_en, alt_vi) VALUES",
  "  ('plan.default', 'image', '/media/library/event/event-championship-sports-hall.jpg', '/media/library/event/event-championship-sports-hall.jpg', 'Membership plan card', 'Thẻ gói tập hội viên'),",
  "  ('class.default', 'image', '/media/library/class/class-functional-agility-class.jpg', '/media/library/class/class-functional-agility-class.jpg', 'Training class session', 'Lớp học đào tạo kỹ năng'),",
  "  ('empty.default', 'image', '/media/library/badminton/badminton-empty-courts-hall.jpg', '/media/library/badminton/badminton-empty-courts-hall.jpg', 'Empty state illustration', 'Hình nền trạng thái trống'),",
  "  ('landing.gallery.1', 'image', '/media/library/badminton/badminton-shuttlecock-on-net.jpg', '/media/library/badminton/badminton-shuttlecock-on-net.jpg', 'Badminton in action', 'Pha cầu lông kịch tính'),",
  "  ('landing.gallery.2', 'image', '/media/library/basketball/basketball-jump-shot-drive.jpg', '/media/library/basketball/basketball-jump-shot-drive.jpg', 'Basketball jump shot', 'Cú ném bóng rổ'),",
  "  ('landing.gallery.3', 'image', '/media/library/volleyball/volleyball-powerful-spike.jpg', '/media/library/volleyball/volleyball-powerful-spike.jpg', 'Volleyball block', 'Pha chắn bóng chuyền'),",
  "  ('landing.gallery.4', 'image', '/media/library/facility/facility-hardwood-gym-hall.jpg', '/media/library/facility/facility-hardwood-gym-hall.jpg', 'Competition courts', 'Mặt sân thi đấu'),",
  "  ('landing.gallery.5', 'image', '/media/library/facility/facility-sports-reception.jpg', '/media/library/facility/facility-sports-reception.jpg', 'Friendly reception', 'Lễ tân tiếp đón'),",
  "  ('landing.gallery.6', 'image', '/media/library/equipment/equipment-1-shuttlecocks-yonex-aerosensa-20.jpg', '/media/library/equipment/equipment-1-shuttlecocks-yonex-aerosensa-20.jpg', 'Floor texture detail', 'Chi tiết vân sàn chuyên dụng'),",
  "  ('landing.gallery.7', 'image', '/media/library/facility/facility-fitness-studio.jpg', '/media/library/facility/facility-fitness-studio.jpg', 'Player lounge area', 'Khu nghỉ ngơi vận động viên'),",
  "  ('landing.gallery.8', 'image', '/media/library/facility/facility-arena-exterior-entrance.jpg', '/media/library/facility/facility-arena-exterior-entrance.jpg', 'Arena3 frontage', 'Mặt tiền trung tâm')",
  "ON CONFLICT (slot) DO NOTHING;",
  ""
);

fs.writeFileSync("migrations/0035_media_library.sql", lines.join("\n"), "utf8");
console.log(`Generated migrations/0035_media_library.sql with ${manifest.length} media library items.`);
