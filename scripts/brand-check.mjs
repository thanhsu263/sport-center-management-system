#!/usr/bin/env node
/**
 * Brand-asset gate shared by browser-smoke.mjs (and unit-testable without a
 * browser): a canvas app is almost always a game / visually rich app, and
 * those must ship a custom share card — the default og.grok.me placeholder is
 * not acceptable for them (see .grok/skills/og/SKILL.md).
 *
 * Games must also set type=x:game in src/server/og/site.json so the platform
 * injector emits og:type for X game-card unfurls, and public/x-banner.jpg for
 * the 50:11 X feed card. A card file is enough for bake to emit /og.jpg, but
 * brand-check still requires site.json `"card": "custom"` so the agent-facing
 * contract stays explicit.
 *
 * Checked on the filesystem (not the served head) so preview and mid-scaffold
 * workspaces are judged the same way.
 *
 * Also runnable, so the background brand task can check its own work before it
 * reports (the parent answers without waiting for it):
 *
 *   node scripts/brand-check.mjs [--game] [--placeholder-ok] [--root <dir>]
 *
 * That run judges the files on disk even though the task is holding the
 * og-pending marker; the marker only silences what the parent's gates see. It
 * also requires the custom card: its caller is normally the pass that exists to
 * produce one, so the placeholder the parent tolerates for a plain utility is a
 * failed pass here. --placeholder-ok is for the other launch — a pass doing
 * favicon, PWA icons and title for a plain utility that keeps the og.grok.me
 * card — where no card is the expected verdict rather than a failure.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OG_SITE_REL_PATH, readOgSite, siteHasCustomCard } from "./grok-pwa-shared.mjs";

// Over this, link scrapers (X card previews included) time out or skip the
// image, so the card silently fails to unfurl. The og skill's JPEG contract
// (ffmpeg -q:v 4, ~150-300 KB) exists precisely to stay under it.
/**
 * Làm gì: Ngưỡng dung lượng tối đa (600 KB) cho ảnh share card (og.jpg / og.png) và banner (x-banner.jpg). Vượt quá mức này link scraper sẽ bỏ qua hoặc timeout khiến card không hiển thị preview.
 * Được gọi ở: scripts/brand-check.mjs (trong hàm brandWarningsOnDisk), scripts/brand-check.test.mjs (test runner (node --test)).
 */
export const MAX_CARD_BYTES = 600 * 1024;

// Written by the brand task while it generates, removed when it finishes.
/**
 * Làm gì: Đường dẫn tương đối trỏ tới file marker .grok/og-pending, dùng để báo hiệu tác vụ nền đang tạo ảnh brand asset.
 * Được gọi ở: scripts/brand-check.mjs (trong hàm ogPendingActive), scripts/brand-check.test.mjs (hàm makeWorkspace, test runner (node --test)).
 */
export const OG_PENDING_REL_PATH = ".grok/og-pending";
// A Stop mid-generation leaves the marker behind, so the demotion expires
// instead of hiding a missing card forever on that workspace.
/**
 * Làm gì: Thời gian hết hạn tối đa của marker (10 phút = 600.000 ms), phòng trường hợp tác vụ tạo ảnh bị huỷ đột ngột khiến file marker bị kẹt lại.
 * Được gọi ở: scripts/brand-check.mjs (trong hàm ogPendingActive), scripts/brand-check.test.mjs (test runner (node --test)).
 */
export const OG_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Làm gì: Kiểm tra xem file cấu hình site.json có khai báo thuộc tính type là "x:game" hay không để nền tảng gắn meta tag og:type phục vụ hiển thị game card trên X (Twitter).
 * Được gọi ở: scripts/brand-check.mjs (trong hàm brandWarningsOnDisk), scripts/brand-check.test.mjs (test runner (node --test)).
 * - Tham số site: Đối tượng cấu hình đọc từ src/server/og/site.json.
 * - Trả về: boolean True nếu site.type là "x:game" (không phân biệt hoa thường), ngược lại false.
 */
export function siteDeclaresOgTypeGame(site) {
  return String(site?.type ?? "").toLowerCase() === "x:game";
}

/**
 * Làm gì: Xác định tác vụ tạo ảnh brand asset có đang chạy trong workspace hay không bằng cách kiểm tra sự tồn tại và thời gian sửa đổi (mtime) của file marker .grok/og-pending.
 * Được gọi ở: scripts/brand-check.mjs (trong computeBrandWarnings và khối thực thi CLI), scripts/brand-check.test.mjs (test runner (node --test)).
 * - Tham số workspaceRoot: Đường dẫn thư mục gốc của workspace cần kiểm tra.
 * - Tham số now: Mốc thời gian hiện tại tính bằng millisecond (mặc định Date.now()).
 * - Trả về: boolean True nếu file marker tồn tại và chưa quá 10 phút tuổi, ngược lại false.
 */
export function ogPendingActive(workspaceRoot, now = Date.now()) {
  try {
    // Bước 1: Kiểm tra thời gian sửa đổi gần nhất (mtimeMs) của file marker xem có còn trong hạn 10 phút hay không.
    const { mtimeMs } = statSync(join(workspaceRoot, OG_PENDING_REL_PATH));
    return now - mtimeMs < OG_PENDING_MAX_AGE_MS;
  } catch {
    // Bước 2: File marker không tồn tại (statSync ném lỗi) -> không có tác vụ nào đang chờ.
    return false;
  }
}

/**
 * What the parent's gates see. The brand pass may still be generating when a
 * gate runs, and "missing" would send the agent to redo the task's work.
 *
 * In flight is silence, not a note: callers report this array as warnings, so
 * anything left in it — however it is worded — reaches the agent as one.
 */
export function computeBrandWarnings({
  hasCanvas,
  workspaceRoot = "/workspace",
  now = Date.now(),
}) {
  // Bước 1: Nếu tác vụ tạo ảnh brand đang chạy (marker còn hiệu lực), tạm thời bỏ qua cảnh báo để tránh báo lỗi trùng lặp khi agent đang sinh asset.
  if (ogPendingActive(workspaceRoot, now)) return [];
  // Bước 2: Khi không còn tác vụ chờ, tiến hành kiểm tra thực tế các file brand asset hiện có trên ổ đĩa.
  return brandWarningsOnDisk({ hasCanvas, workspaceRoot });
}

/**
 * The files on disk, marker ignored — the brand pass's own view of its work.
 * Deliberately not exported: a gate that reached for this instead of
 * `computeBrandWarnings` would warn about a card that is still generating.
 * `cardRequired` is for a caller that is itself the brand pass: for it the
 * placeholder is a failure, not the plain-utility default the parent's gate
 * leaves alone.
 */
function brandWarningsOnDisk({
  hasCanvas,
  workspaceRoot = "/workspace",
  cardRequired = false,
}) {
  // Bước 1: Khởi tạo đường dẫn tài liệu hướng dẫn, cấu hình site.json và tìm file share card (ưu tiên og.jpg rồi đến og.png).
  const skillPath = join(workspaceRoot, ".grok/skills/og/SKILL.md");
  const sitePath = join(workspaceRoot, OG_SITE_REL_PATH);
  const site = readOgSite(workspaceRoot);
  const cardPath = [
    join(workspaceRoot, "public/og.jpg"),
    join(workspaceRoot, "public/og.png"),
  ].find(existsSync);
  const warnings = [];

  // Bước 2: Kiểm tra file share card. Nếu đã có file, kiểm tra dung lượng (<= 600 KB) và cờ card="custom" trong site.json.
  if (cardPath !== undefined) {
    // Cảnh báo nếu ảnh quá nặng (> 600 KB) vì link scraper trên mạng xã hội sẽ bỏ qua hoặc timeout
    if (statSync(cardPath).size > MAX_CARD_BYTES) {
      warnings.push(
        `BRAND WARNING: ${cardPath} is over 600 KB — link scrapers (X card previews included) `
          + "time out or skip images this heavy, so the card silently fails to unfurl. "
          + `Re-encode as JPEG (public/og.jpg, ffmpeg -q:v 4) per ${skillPath}.`,
      );
    }
    // Yêu cầu khai báo rõ ràng "card": "custom" trong site.json để định danh asset minh bạch
    if (!siteHasCustomCard(site)) {
      warnings.push(
        `BRAND WARNING: ${cardPath} exists but ${sitePath} is missing "card": "custom". `
          + "Bake infers custom from the file, but set the flag in "
          + `${sitePath} per ${skillPath} so identity is explicit.`,
      );
    }
  } else if (hasCanvas) {
    // Bước 3: Nếu không có file card nhưng ứng dụng có thẻ canvas (game/đồ hoạ), cảnh báo bắt buộc tạo share card 1200x630.
    warnings.push(
      `BRAND WARNING: this looks like a game/canvas app but ${workspaceRoot}/public/og.jpg `
        + "is missing. Games and visually rich apps must ship a custom 1200x630 share card "
        + "built from the app's own art — the default og.grok.me placeholder card is not "
        + `acceptable for them. You are not done: open ${skillPath} and finish the `
        + "brand-asset pass.",
    );
  } else if (cardRequired) {
    // Bước 4: Nếu lượt chạy này yêu cầu bắt buộc card (cardRequired: true từ brand task), báo lỗi thiếu ảnh.
    warnings.push(
      `BRAND WARNING: ${workspaceRoot}/public/og.jpg is missing and this pass exists to `
        + "produce it. Generate the 1200x630 card from the app's own art and hand it over "
        + `per ${skillPath}. If no image-generation tool is available in this session, `
        + "report that instead of reporting a pass — the app keeps the og.grok.me "
        + "placeholder.",
    );
  } else {
    // Bước 5: Ứng dụng tiện ích đơn giản (CRUD/converter) không có canvas được phép dùng card mặc định, chỉ ghi nhận ghi chú (BRAND NOTE).
    warnings.push(
      "BRAND NOTE: no custom public/og.jpg — the platform will serve the og.grok.me placeholder. "
        + "Custom cards are the default for games of every kind (DOM board/word games included), "
        + "whimsical apps, creative tools, and brand-forward pages — only plain utilities "
        + "(converters, CRUD trackers, admin dashboards) keep the placeholder. If this app "
        + `is not a plain utility, finish the brand-asset pass per ${skillPath}.`,
    );
  }

  // Bước 6: Kiểm tra khai báo type="x:game" cho game canvas để kích hoạt đúng định dạng game card trên X (Twitter).
  if (hasCanvas && !siteDeclaresOgTypeGame(site)) {
    warnings.push(
      'BRAND WARNING: this looks like a game/canvas app but src/server/og/site.json is missing '
        + '"type": "x:game". X uses og:type=x:game to present the unfurl as a game card — set '
        + `it in ${sitePath} per ${skillPath}. Do not invent `
        + "x:type or overload twitter:card as the game signal.",
    );
  }

  // Games with a custom link card must also ship the 50:11 X feed card.
  // Skip while still on the og.grok.me placeholder — that pass has not started yet.
  // Bước 7: Với game canvas đã có share card, kiểm tra tiếp banner feed 50:11 (public/x-banner.jpg) và dung lượng tối đa 600 KB.
  if (hasCanvas && cardPath !== undefined) {
    const bannerPath = join(workspaceRoot, "public/x-banner.jpg");
    if (!existsSync(bannerPath)) {
      warnings.push(
        `BRAND WARNING: this looks like a game/canvas app but ${bannerPath} is missing. `
          + "Games need a 50:11 X feed card (1200×264 JPEG) at public/x-banner.jpg — "
          + `open ${skillPath} and finish the brand-asset pass.`,
      );
    } else if (statSync(bannerPath).size > MAX_CARD_BYTES) {
      warnings.push(
        `BRAND WARNING: ${bannerPath} is over 600 KB — link scrapers (X card previews `
          + "included) time out or skip images this heavy, so the feed card silently fails "
          + `to unfurl. Re-encode as JPEG (ffmpeg -q:v 4) per ${skillPath}.`,
      );
    }
  }

  // Bước 8: Trả về danh sách tất cả các cảnh báo (BRAND WARNING) và ghi chú (BRAND NOTE) tìm thấy.
  return warnings;
}

/**
 * Làm gì: Phân tích các đối số dòng lệnh (CLI flags) khi chạy trực tiếp file brand-check.mjs.
 * Được gọi ở: scripts/brand-check.mjs (trong khối thực thi CLI process.argv ở dòng 197), scripts/brand-check.test.mjs (test runner (node --test)).
 * - Tham số argv: Mảng chuỗi các đối số truyền vào từ dòng lệnh (thường là process.argv.slice(2)).
 * - Trả về: Object Chứa các cờ { game, placeholderOk, root } nếu hợp lệ, hoặc { error } nếu đối số sai cú pháp.
 */
export function parseBrandCheckArgs(argv) {
  // Bước 1: Khởi tạo thông điệp hướng dẫn usage và các biến cờ với giá trị mặc định.
  const usage =
    "usage: node scripts/brand-check.mjs [--game] [--placeholder-ok] [--root <dir>]";
  let game = false;
  let placeholderOk = false;
  let root = null;
  // Bước 2: Duyệt từng tham số trong mảng argv để nhận diện các cờ tuỳ chọn (--game, --placeholder-ok, --root).
  for (let i = 0; i < argv.length; i += 1) {
    // --game runs the checks browser-smoke.mjs derives from a real <canvas>;
    // DOM board/word games need them too and have no canvas to detect.
    if (argv[i] === "--game") {
      game = true;
    } else if (argv[i] === "--placeholder-ok") {
      placeholderOk = true;
    } else if (argv[i] === "--root") {
      // Lấy giá trị thư mục ngay sau cờ --root; báo lỗi cú pháp nếu thiếu giá trị
      root = argv[++i];
      if (root === undefined) return { error: `--root needs a directory — ${usage}` };
    } else {
      return { error: `unexpected argument: ${argv[i]} — ${usage}` };
    }
  }
  // Bước 3: Trả về đối tượng chứa các cờ và đường dẫn root sau khi parse thành công.
  return { game, placeholderOk, root };
}

/**
 * Làm gì: Phân loại thông điệp xem có phải cảnh báo vi phạm nghiêm trọng (BRAND WARNING) hay chỉ là ghi chú mềm (BRAND NOTE).
 * Được gọi ở: scripts/brand-check.mjs (trong khối thực thi CLI ở dòng 212 để lọc warnings).
 * - Tham số message: Chuỗi thông điệp cần kiểm tra.
 * - Trả về: boolean True nếu thông điệp bắt đầu bằng "BRAND WARNING:", ngược lại false.
 */
function isBrandWarning(message) {
  return message.startsWith("BRAND WARNING:");
}

// Khối điều khiển thực thi khi script được gọi trực tiếp từ dòng lệnh Node.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Bước 1: Phân tích các đối số dòng lệnh; dừng script và xuất mã lỗi nếu đối số không hợp lệ.
  const args = parseBrandCheckArgs(process.argv.slice(2));
  if (args.error) {
    console.error(JSON.stringify({ ok: false, error: args.error }, null, 2));
    process.exit(1);
  }
  // Bước 2: Xác định thư mục gốc workspace từ tham số --root hoặc mặc định là thư mục cha.
  const workspaceRoot = args.root ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  // The caller here is the brand task checking its own work: it is holding the
  // marker (report it, but judge the assets on disk) and it owes a custom card
  // whether or not the app draws to a canvas — unless it was launched for a
  // plain utility that keeps the placeholder, which only it knows.
  // Bước 3: Thẩm định các asset thương hiệu thực tế trên đĩa qua hàm brandWarningsOnDisk.
  const messages = brandWarningsOnDisk({
    hasCanvas: args.game,
    workspaceRoot,
    cardRequired: !args.placeholderOk,
  });
  // Bước 4: Lọc riêng danh sách các cảnh báo vi phạm nghiêm trọng (BRAND WARNING).
  const warnings = messages.filter(isBrandWarning);
  // Bước 5: Xuất kết quả kiểm tra dưới định dạng JSON ra console và thiết lập mã thoát tiến trình (0 nếu đạt, 1 nếu có lỗi).
  console.log(
    JSON.stringify(
      {
        ok: warnings.length === 0,
        workspaceRoot,
        pending: ogPendingActive(workspaceRoot),
        warnings: warnings.length,
        messages,
      },
      null,
      2,
    ),
  );
  process.exitCode = warnings.length === 0 ? 0 : 1;
}
