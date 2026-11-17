/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho module scripts/brand-check.mjs.
 * Kiểm tra toàn diện logic cảnh báo tài nguyên thương hiệu (Open Graph card, x-banner, site.json),
 * cơ chế kiểm tra qua dòng lệnh (CLI), và tính đồng nhất giữa mã nguồn với tài liệu hướng dẫn (SKILL.md, AGENTS.md).
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong quy trình QA/CI tự động,
 * đảm bảo ứng dụng không bị xuất bản khi thiếu hoặc sai chuẩn tài nguyên thương hiệu.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MAX_CARD_BYTES,
  OG_PENDING_MAX_AGE_MS,
  OG_PENDING_REL_PATH,
  computeBrandWarnings,
  ogPendingActive,
  parseBrandCheckArgs,
  siteDeclaresOgTypeGame,
} from "./brand-check.mjs";

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(TEMPLATE_ROOT, "scripts/brand-check.mjs");

const GAME_SITE = JSON.stringify({ title: "Wild Race", type: "x:game", card: "custom" });
const UTILITY_SITE = JSON.stringify({ title: "Invoice" });
const UTILITY_CUSTOM_SITE = JSON.stringify({ title: "Invoice", card: "custom" });

/**
 * Làm gì: Tạo thư mục workspace giả lập trong thư mục tạm của hệ thống kèm cấu trúc thư mục và các file thương hiệu để phục vụ test.
 * Được gọi ở: scripts/brand-check.test.mjs (trong hầu hết các ca kiểm thử)
 * - Tham số options: Đối tượng cấu hình tùy chọn để tạo môi trường test
 * - Tham số options.siteJson: Nội dung chuỗi JSON cho file src/server/og/site.json
 * - Tham số options.cardFile: Tên file ảnh thẻ chia sẻ trong thư mục public (vd: og.jpg, og.png)
 * - Tham số options.narrowFile: Tên file ảnh banner hẹp trong thư mục public (vd: x-banner.jpg)
 * - Tham số options.cardBytes: Dung lượng tính bằng byte của file cardFile (mặc định 200 KB)
 * - Tham số options.narrowBytes: Dung lượng tính bằng byte của file narrowFile (mặc định 200 KB)
 * - Tham số options.pendingAgeMs: Độ tuổi (ms) của file đánh dấu pending, dùng để kiểm tra tính hết hạn
 * @returns {string} Đường dẫn tuyệt đối tới thư mục workspace tạm thời vừa tạo
 */
function makeWorkspace({
  siteJson,
  cardFile,
  narrowFile,
  cardBytes = 200 * 1024,
  narrowBytes = 200 * 1024,
  pendingAgeMs,
} = {}) {
  // Bước 1: Tạo thư mục gốc tạm thời và khởi tạo sẵn các thư mục con: public, src/server/og, .grok
  const root = mkdtempSync(join(tmpdir(), "brand-check-"));
  mkdirSync(join(root, "public"), { recursive: true });
  mkdirSync(join(root, "src/server/og"), { recursive: true });
  mkdirSync(join(root, ".grok"), { recursive: true });
  // Bước 2: Tạo file đánh dấu .grok/og-pending và lùi mtime để kiểm tra trạng thái tác vụ đang chạy hoặc đã hết hạn
  if (pendingAgeMs !== undefined) {
    const marker = join(root, OG_PENDING_REL_PATH);
    writeFileSync(marker, "");
    const when = new Date(Date.now() - pendingAgeMs);
    utimesSync(marker, when, when);
  }
  // Bước 3: Ghi file cấu hình thương hiệu site.json nếu có dữ liệu truyền vào
  if (siteJson !== undefined) {
    writeFileSync(join(root, "src/server/og/site.json"), siteJson);
  }
  // Bước 4: Tạo file ảnh thẻ chia sẻ (og.jpg / og.png) với dung lượng byte giả lập
  if (cardFile !== undefined) {
    writeFileSync(join(root, "public", cardFile), Buffer.alloc(cardBytes, 7));
  }
  // Bước 5: Tạo file banner X feed định dạng hẹp (x-banner.jpg) với dung lượng byte giả lập
  if (narrowFile !== undefined) {
    writeFileSync(join(root, "public", narrowFile), Buffer.alloc(narrowBytes, 7));
  }
  // Bước 6: Trả về đường dẫn thư mục workspace tạm để test case sử dụng
  return root;
}

/**
 * Làm gì: Kiểm tra ứng dụng thông thường (không có canvas) khi thiếu thẻ tùy chỉnh chỉ nhận BRAND NOTE nhẹ thay vì cảnh báo lỗi.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("non-canvas app with no custom card gets a soft BRAND NOTE (utility exception)", () => {
  // Bước 1: Tạo workspace cho ứng dụng tiện ích thông thường (không có canvas) và tính toán cảnh báo
  const root = makeWorkspace({ siteJson: UTILITY_SITE });
  const warnings = computeBrandWarnings({ hasCanvas: false, workspaceRoot: root });
  // Bước 2: Xác thực chỉ trả về 1 thông báo nhắc nhở nhẹ (BRAND NOTE), không bị tính là lỗi chặn xuất bản
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^BRAND NOTE:/);
  assert.match(warnings[0], /plain utilit/);
  assert.doesNotMatch(warnings[0], /^BRAND WARNING:/);
});

/**
 * Làm gì: Kiểm tra ứng dụng thông thường có đầy đủ thẻ og.jpg và cấu hình card=custom thì không phát sinh cảnh báo.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("non-canvas app with a compliant card is silent", () => {
  const root = makeWorkspace({ siteJson: UTILITY_CUSTOM_SITE, cardFile: "og.jpg" });
  assert.deepEqual(computeBrandWarnings({ hasCanvas: false, workspaceRoot: root }), []);
});

/**
 * Làm gì: Kiểm tra trường hợp có file og.jpg nhưng site.json thiếu cấu hình "card": "custom" sẽ bị cảnh báo.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("card file without site.json card=custom warns", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE, cardFile: "og.jpg" });
  const warnings = computeBrandWarnings({ hasCanvas: false, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"card": "custom"/);
});

/**
 * Làm gì: Kiểm tra trường hợp có file og.jpg nhưng thiếu hoàn toàn file site.json sẽ bị cảnh báo yêu cầu cấu hình card=custom.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("card file with missing site.json warns for card=custom", () => {
  const root = makeWorkspace({ cardFile: "og.jpg" });
  const warnings = computeBrandWarnings({ hasCanvas: false, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"card": "custom"/);
});

/**
 * Làm gì: Kiểm tra khi file site.json bị lỗi cú pháp JSON thì hệ thống vẫn bắt lỗi an toàn và yêu cầu card=custom.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("card file with invalid site.json warns for card=custom", () => {
  const root = makeWorkspace({ siteJson: "{not-json", cardFile: "og.jpg" });
  const warnings = computeBrandWarnings({ hasCanvas: false, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"card": "custom"/);
});

/**
 * Làm gì: Kiểm tra file thẻ og.jpg vượt quá 600 KB (MAX_CARD_BYTES) sẽ cảnh báo kể cả với ứng dụng không có canvas.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("oversized card warns for non-canvas apps too", () => {
  // Bước 1: Tạo workspace cho ứng dụng tiện ích với ảnh thẻ og.jpg vượt quá giới hạn 600 KB (MAX_CARD_BYTES + 1)
  const root = makeWorkspace({
    siteJson: UTILITY_CUSTOM_SITE,
    cardFile: "og.jpg",
    cardBytes: MAX_CARD_BYTES + 1,
  });
  // Bước 2: Tính toán cảnh báo và xác thực có đúng 1 lỗi về kích thước ảnh vượt trần cho phép
  const warnings = computeBrandWarnings({ hasCanvas: false, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /over 600 KB/);
});

/**
 * Làm gì: Kiểm tra ứng dụng canvas (game) khi thiếu og.jpg và thiếu type x:game sẽ bị 2 cảnh báo chặn hoàn thành.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("canvas app with no card warns 'missing' and missing og:type", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE });
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  // Ứng dụng game/canvas bắt buộc phải có ảnh thẻ riêng (og.jpg) và khai báo type "x:game" trong site.json
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /og\.jpg.*is missing/s);
  assert.match(warnings[0], /not done/);
  assert.match(warnings[1], /site\.json/);
  assert.match(warnings[1], /og:type|x:game/);
});

/**
 * Làm gì: Kiểm tra ứng dụng canvas đã có og.jpg nhưng chưa có type x:game thì vẫn bị cảnh báo về type và thiếu x-banner.jpg.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("canvas card without type still warns for og:type", () => {
  const root = makeWorkspace({ siteJson: UTILITY_CUSTOM_SITE, cardFile: "og.jpg" });
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  assert.match(warnings.join("\n"), /x:game/);
  assert.match(warnings.join("\n"), /x-banner\.jpg/);
});

/**
 * Làm gì: Kiểm tra giới hạn 600 KB được áp dụng cho cả định dạng JPEG (og.jpg) và định dạng PNG cũ (og.png).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("oversized card warns on the scraper budget (jpg and legacy png)", () => {
  // Lặp qua cả hai định dạng ảnh thẻ được hỗ trợ để đảm bảo kiểm tra dung lượng đồng nhất
  for (const cardFile of ["og.jpg", "og.png"]) {
    const root = makeWorkspace({
      siteJson: GAME_SITE,
      cardFile,
      cardBytes: MAX_CARD_BYTES + 1,
      narrowFile: "x-banner.jpg",
    });
    const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
    assert.match(warnings[0], /over 600 KB/);
  }
});

/**
 * Làm gì: Kiểm tra game có đầy đủ thẻ og.jpg, type x:game trong site.json và banner x-banner.jpg thì không có cảnh báo nào.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("compliant game (custom card + site.json type + x-banner) is silent", () => {
  const root = makeWorkspace({
    siteJson: GAME_SITE,
    cardFile: "og.jpg",
    narrowFile: "x-banner.jpg",
  });
  assert.deepEqual(computeBrandWarnings({ hasCanvas: true, workspaceRoot: root }), []);
});

/**
 * Làm gì: Kiểm tra việc đặt og:type trong file mã nguồn __root.tsx không còn hợp lệ, bắt buộc phải khai báo tại site.json.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("__root.tsx og:type no longer satisfies the canvas gate", () => {
  const root = makeWorkspace({
    siteJson: UTILITY_CUSTOM_SITE,
    cardFile: "og.jpg",
    narrowFile: "x-banner.jpg",
  });
  // Tạo file __root.tsx chứa meta og:type để chứng minh cổng kiểm duyệt chỉ đọc site.json, không đọc code giao diện
  mkdirSync(join(root, "src/routes"), { recursive: true });
  writeFileSync(
    join(root, "src/routes/__root.tsx"),
    '{ property: "og:type", content: "x:game" }',
  );
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /x:game/);
});

/**
 * Làm gì: Kiểm tra file banner x-banner.jpg nếu vượt quá giới hạn 600 KB cũng bị cảnh báo tương tự như og.jpg.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("oversized x-banner warns on the same scraper budget as og.jpg", () => {
  const root = makeWorkspace({
    siteJson: GAME_SITE,
    cardFile: "og.jpg",
    narrowFile: "x-banner.jpg",
    narrowBytes: MAX_CARD_BYTES + 1,
  });
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /x-banner\.jpg is over 600 KB/);
});

/**
 * Làm gì: Kiểm tra dù dùng định dạng cũ og.png và đã có cấu hình type, ứng dụng game vẫn bắt buộc phải có x-banner.jpg.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("legacy png + site.json type still needs the X feed card", () => {
  const root = makeWorkspace({
    siteJson: GAME_SITE,
    cardFile: "og.png",
  });
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  assert.match(warnings.join("\n"), /x-banner\.jpg/);
});

/**
 * Làm gì: Kiểm tra hàm siteDeclaresOgTypeGame nhận diện chính xác type="x:game" (không phân biệt hoa thường và bỏ qua type khác).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("siteDeclaresOgTypeGame reads the site contract", () => {
  assert.equal(siteDeclaresOgTypeGame({ type: "x:game" }), true);
  assert.equal(siteDeclaresOgTypeGame({ type: "website" }), false);
  assert.equal(siteDeclaresOgTypeGame({}), false);
});

/**
 * Làm gì: Kiểm tra file marker .grok/og-pending còn mới (< 10 phút) sẽ ẩn toàn bộ cảnh báo để không làm phiền agent cha.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("a fresh og-pending marker silences the whole gate view", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE, pendingAgeMs: 1000 });
  // Every caller reports this array as a count, so an in-flight card has to
  // leave nothing behind — a note would print as "brand: 1 warning(s)".
  assert.deepEqual(computeBrandWarnings({ hasCanvas: true, workspaceRoot: root }), []);
  assert.deepEqual(computeBrandWarnings({ hasCanvas: false, workspaceRoot: root }), []);
});

/**
 * Làm gì: Kiểm tra file marker .grok/og-pending nếu đã hết hạn (> 10 phút) sẽ bị bỏ qua và các cảnh báo thiếu thẻ sẽ xuất hiện lại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("a stale og-pending marker is ignored and the warnings return", () => {
  // Tạo workspace với marker có mtime lùi về quá 10 phút để giả lập tác vụ ngầm bị treo hoặc chết giữa chừng
  const root = makeWorkspace({
    siteJson: UTILITY_SITE,
    pendingAgeMs: OG_PENDING_MAX_AGE_MS + 1000,
  });
  assert.equal(ogPendingActive(root), false);
  const warnings = computeBrandWarnings({ hasCanvas: true, workspaceRoot: root });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /not done/);
});

/**
 * Làm gì: Kiểm tra việc hết hạn của marker dựa trên thời gian tham chiếu động (tham số now) chứ không phụ thuộc vào việc sửa file.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the marker goes stale on the clock, not on the file", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE, pendingAgeMs: 1000 });
  // Bước 1: Tính 2 mốc thời gian: một mốc vẫn còn trong hạn (trước 5s) và một mốc đã quá hạn (sau 5s)
  const justInside = Date.now() + OG_PENDING_MAX_AGE_MS - 5000;
  const pastIt = Date.now() + OG_PENDING_MAX_AGE_MS + 5000;
  // Bước 2: Xác thực mốc còn hạn thì ẩn cảnh báo, mốc quá hạn thì cảnh báo lỗi xuất hiện trở lại
  assert.deepEqual(
    computeBrandWarnings({ hasCanvas: true, workspaceRoot: root, now: justInside }),
    [],
  );
  assert.match(
    computeBrandWarnings({ hasCanvas: true, workspaceRoot: root, now: pastIt })[0],
    /^BRAND WARNING:/,
  );
});

/**
 * Làm gì: Kiểm tra khi không có file marker thì ogPendingActive trả về false (không có tác vụ tạo thương hiệu nào đang chạy ngầm).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("no marker means nothing is in flight", () => {
  assert.equal(ogPendingActive(makeWorkspace()), false);
});

/**
 * Làm gì: Kiểm tra hàm phân tích cờ CLI parseBrandCheckArgs chỉ chấp nhận --game, --placeholder-ok, --root và báo lỗi với các cờ lạ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseBrandCheckArgs takes --game, --placeholder-ok and --root, and rejects the rest", () => {
  assert.deepEqual(parseBrandCheckArgs([]), { game: false, placeholderOk: false, root: null });
  assert.deepEqual(parseBrandCheckArgs(["--game", "--root", "/tmp/w"]), {
    game: true,
    placeholderOk: false,
    root: "/tmp/w",
  });
  assert.equal(parseBrandCheckArgs(["--placeholder-ok"]).placeholderOk, true);
  assert.match(parseBrandCheckArgs(["--root"]).error, /--root needs a directory/);
  assert.match(parseBrandCheckArgs(["--canvas"]).error, /unexpected argument: --canvas/);
});

/**
 * Làm gì: Chạy script brand-check.mjs dưới dạng tiến trình con bằng spawnSync để kiểm thử giao diện dòng lệnh (CLI).
 * Được gọi ở: scripts/brand-check.test.mjs (trong các ca kiểm thử CLI)
 * - Tham số root: Đường dẫn thư mục workspace cần kiểm tra
 * - Tham số extra: Mảng các đối số dòng lệnh bổ sung (mặc định là [])
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Kết quả thực thi tiến trình con (status, stdout, stderr)
 */
const runCheck = (root, extra = []) =>
  spawnSync(process.execPath, [SCRIPT, "--root", root, ...extra], { encoding: "utf8" });

/**
 * Làm gì: Kiểm tra CLI khi chạy với cờ --game mà thiếu thẻ sẽ trả về JSON chứa lỗi và mã thoát 1.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: a game missing its card reports JSON and exits 1", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE });
  const run = runCheck(root, ["--game"]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.pending, false);
  assert.equal(result.warnings, 2);
  assert.equal(result.workspaceRoot, root);
});

/**
 * Làm gì: Kiểm tra CLI khi chạy với cờ --game và có đủ thẻ hợp lệ sẽ trả về mã thoát 0 và không có tin nhắn cảnh báo.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: a compliant game passes", () => {
  const root = makeWorkspace({
    siteJson: GAME_SITE,
    cardFile: "og.jpg",
    narrowFile: "x-banner.jpg",
  });
  const run = runCheck(root, ["--game"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).messages, []);
});

/**
 * Làm gì: Kiểm tra khi chạy CLI trực tiếp, file marker pending chỉ được ghi nhận trong JSON chứ không làm ẩn lỗi của chính tác vụ đó.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: the task's own marker is reported, not honoured", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE, pendingAgeMs: 1000 });
  const run = runCheck(root, ["--game"]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.pending, true);
  assert.equal(result.warnings, 2);
});

/**
 * Làm gì: Kiểm tra khi truyền cờ CLI không xác định (--nope) thì tiến trình thất bại với mã thoát 1 và in JSON lỗi ra stderr.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: a bad argument fails with JSON on stderr", () => {
  const run = runCheck(makeWorkspace(), ["--nope"]);
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stderr).ok, false);
});

/**
 * Làm gì: Kiểm tra CLI chạy cho ứng dụng tiện ích thiếu thẻ vẫn báo lỗi 1, vì mục tiêu của lượt chạy này là phải sinh ra thẻ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: a non-game with no card fails too — the pass exists to produce one", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE });
  const run = runCheck(root);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.warnings, 1);
  assert.match(result.messages[0], /^BRAND WARNING: .*og\.jpg is missing and this pass exists/);
  // The parent's gate keeps tolerating the placeholder for a plain utility.
  assert.match(computeBrandWarnings({ hasCanvas: false, workspaceRoot: root })[0], /^BRAND NOTE:/);
});

/**
 * Làm gì: Kiểm tra cờ --placeholder-ok cho phép ứng dụng tiện ích bỏ qua thẻ mà vẫn thoát 0, nhưng cờ này không áp dụng được cho game.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: --placeholder-ok is how a plain-utility pass reports no card as expected", () => {
  const root = makeWorkspace({ siteJson: UTILITY_SITE });
  const run = runCheck(root, ["--placeholder-ok"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, true);
  assert.match(result.messages[0], /^BRAND NOTE:/);
  // A game is never a placeholder app, so the flag cannot excuse one.
  const game = runCheck(root, ["--game", "--placeholder-ok"]);
  assert.equal(game.status, 1, game.stdout + game.stderr);
  assert.match(JSON.parse(game.stdout).messages[0], /^BRAND WARNING: .*not done/s);
});

/**
 * Làm gì: Kiểm tra CLI chạy cho ứng dụng tiện ích có thẻ og.jpg và khai báo custom hợp lệ sẽ vượt qua với mã thoát 0.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("cli: a non-game with a compliant card passes", () => {
  const root = makeWorkspace({ siteJson: UTILITY_CUSTOM_SITE, cardFile: "og.jpg" });
  const run = runCheck(root);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).messages, []);
});

// --- the prompts are the only enforcement here, so pin them to the code ---

/**
 * Làm gì: Đọc nội dung tệp tài liệu trong dự án theo đường dẫn tương đối thành chuỗi UTF-8.
 * Được gọi ở: scripts/brand-check.test.mjs (trong ca kiểm thử tài liệu và hàm prohibitionSection)
 * - Tham số rel: Đường dẫn tương đối từ thư mục gốc dự án
 * @returns {string} Toàn bộ nội dung tệp dưới dạng chuỗi UTF-8
 */
const readDoc = (rel) => readFileSync(join(TEMPLATE_ROOT, rel), "utf8");

/**
 * Làm gì: Kiểm tra các tài liệu SKILL.md và AGENTS.md đồng nhất với mã nguồn về đường dẫn file marker và thời gian hết hạn (10 phút).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("SKILL.md and AGENTS.md name the marker path and bound this script uses", () => {
  // Prose wraps, so the minute count may straddle a line break.
  const bound = new RegExp(`${OG_PENDING_MAX_AGE_MS / 60_000}\\s+minutes`);
  // Quét cả hai tài liệu cốt lõi để đảm bảo hướng dẫn agent không bị lệch so với logic kiểm tra thực tế
  for (const rel of [".grok/skills/og/SKILL.md", "AGENTS.md"]) {
    const doc = readDoc(rel);
    assert.ok(doc.includes(`/workspace/${OG_PENDING_REL_PATH}`), `${rel}: marker path`);
    assert.ok(bound.test(doc), `${rel}: staleness bound`);
  }
});

// The two places that own "never wait on the brand task". Scanning the whole
// of AGENTS.md instead would make every unrelated `wait_tasks` mention a future
// feature adds to it this test's business.
const PROHIBITION_SECTIONS = [
  {
    rel: ".grok/skills/og/SKILL.md",
    label: '§ "Brand-asset pass"',
    from: "## Brand-asset pass:",
    until: /\n## /,
  },
  {
    rel: "AGENTS.md",
    label: "execution loop step 6",
    from: "6. **Brand-asset pass",
    until: /\n7\. /,
  },
];

/**
 * Làm gì: Trích xuất phần văn bản quy định cấm chờ brand task từ file tài liệu, loại bỏ định dạng Markdown và chuẩn hóa khoảng trắng.
 * Được gọi ở: scripts/brand-check.test.mjs (trong ca kiểm thử kiểm tra quy định cấm chờ)
 * - Tham số options: Cấu hình trích xuất tài liệu
 * - Tham số options.rel: Đường dẫn tương đối tới file tài liệu
 * - Tham số options.label: Nhãn định danh phần tài liệu cần kiểm tra
 * - Tham số options.from: Chuỗi đánh dấu vị trí bắt đầu
 * - Tham số options.until: Biểu thức chính quy đánh dấu vị trí kết thúc
 * @returns {string} Chuỗi văn bản đã trích xuất và chuẩn hóa khoảng trắng
 * @throws {assert.AssertionError} Ném lỗi nếu không tìm thấy chuỗi bắt đầu trong tài liệu
 */
function prohibitionSection({ rel, label, from, until }) {
  // Bước 1: Đọc nội dung file tài liệu và tìm vị trí bắt đầu của đoạn văn bản
  const doc = readDoc(rel);
  const start = doc.indexOf(from);
  assert.notEqual(start, -1, `${rel}: ${label} moved — no "${from.trim()}"`);
  // Bước 2: Xác định điểm kết thúc dựa trên biểu thức chính quy until
  const rest = doc.slice(start + from.length);
  const end = rest.search(until);
  // Markdown emphasis and prose wrapping both sit between the two words.
  // Bước 3: Cắt đoạn văn bản, xóa định dạng Markdown (` và *) và chuẩn hóa khoảng trắng thành ký tự cách đơn
  return (from + (end === -1 ? rest : rest.slice(0, end))).replace(/[`*]/g, "").replace(/\s+/g, " ");
}

/**
 * Làm gì: Kiểm tra các đoạn tài liệu quy định cấm không bao giờ cho phép chờ (wait_tasks) hoặc lấy kết quả trực tiếp (get_task_output).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the sections that own the brand-task prohibition never affirm a wait", () => {
  // Pinned on the shape of the prohibition, not on a negation being somewhere
  // nearby: "So: wait_tasks before the final verify, but never get_task_output"
  // keeps a negation in the sentence while instructing exactly the wait.
  const connectors = /(?:\s|[/,;]|\band\b|\bor\b|\bwait_tasks\b|\bget_task_output\b)+$/i;
  const negation = /\b(?:no|never|not|don['’]t)$/i;
  // Bước 1: Duyệt qua từng tài liệu quy ước để kiểm tra câu chữ quy định
  for (const section of PROHIBITION_SECTIONS) {
    const where = `${section.rel} ${section.label}`;
    const prose = prohibitionSection(section);
    const mentions = [...prose.matchAll(/wait_tasks|get_task_output/g)];
    assert.ok(mentions.length >= 2, `${where}: the prohibition itself went missing`);
    // Bước 2: Xác thực ngay trước mỗi lần nhắc tới wait_tasks hay get_task_output đều phải là một từ phủ định (no, never, not, don't)
    for (const match of mentions) {
      const before = prose.slice(0, match.index).replace(connectors, "");
      const context = prose.slice(Math.max(0, match.index - 60), match.index + 20);
      assert.ok(negation.test(before), `${where}: not a prohibition: …${context}…`);
    }
  }
});

/**
 * Làm gì: Kiểm tra mọi câu lệnh gọi brand-check.mjs được hướng dẫn trong SKILL.md đều dùng đúng các cờ CLI mà parser hỗ trợ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("SKILL.md tells the pass to self-check with the flag this CLI accepts", () => {
  // Bước 1: Đọc SKILL.md và trích xuất tất cả các dòng lệnh gọi brand-check.mjs
  const skill = readDoc(".grok/skills/og/SKILL.md");
  const invocations = skill.match(/node scripts\/brand-check\.mjs[^\n`]*/g) ?? [];
  assert.ok(invocations.length > 0);
  // Bước 2: Thử phân tích cú pháp từng câu lệnh để đảm bảo tài liệu không hướng dẫn các cờ CLI lạ gây lỗi
  for (const line of invocations) {
    const argv = line.replace("node scripts/brand-check.mjs", "").trim().split(/\s+/);
    assert.equal(parseBrandCheckArgs(argv.filter(Boolean)).error, undefined, line);
  }
});
