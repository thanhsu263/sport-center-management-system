/**
 * File: scripts/grok-pwa-plugin.test.mjs (phần 1: dòng 1-254)
 * Vai trò: Bộ kiểm thử đơn vị (unit test) tự động sử dụng node:test cho các tính năng PWA và OpenGraph.
 * Vị trí trong hệ thống: Kiểm thử logic của grok-pwa-shared.mjs và grok-pwa-plugin.mjs. Đảm bảo việc
 *   chèn các thẻ meta (PWA manifest, icon, OpenGraph, Twitter card, tác giả x:creator, grok:app_id) vào
 *   phần <head> của HTML chính xác, an toàn trước tấn công XSS, không bị trùng lặp và tuân thủ đúng thứ
 *   tự ưu tiên giữa cấu hình tĩnh (baked site.json) và file thực tế trên ổ đĩa (public/og.*).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appNameFromHost,
  createHeadInjector,
  grokXCreatorHeadTags,
  injectGrokPwaHead,
  isDocumentPath,
  isInstallQuery,
  publicAppHost,
  renderWebManifest,
  resolveOgCardAsset,
  snapshotOgIdentity,
  stripInstallParams,
} from "./grok-pwa-shared.mjs";
import { renderInstallPage } from "./grok-pwa-plugin.mjs";

/**
 * Làm gì: Lưu đường dẫn tuyệt đối đến thư mục gốc của dự án (template root) để các test case truy cập file cấu hình và tài nguyên tĩnh.
 * Được gọi ở: Nội bộ scripts/grok-pwa-plugin.test.mjs khi kiểm thử các file cấu hình như vite.config.ts hoặc server middleware.
 */
const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Làm gì: Kiểm tra hàm injectGrokPwaHead chèn đầy đủ manifest, apple-touch-icon và script extensions vào trước thẻ đóng </head>.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu thiếu các thẻ PWA bắt buộc hoặc chúng bị chèn sai vị trí ngoài thẻ <head>.
 */
test("injects before </head>", () => {
  const out = injectGrokPwaHead("<html><head><title>x</title></head><body></body></html>");
  assert.match(out, /rel="manifest"/);
  assert.match(out, /apple-touch-icon/);
  assert.match(out, /grok-app-builder\/extensions\.js/);
  // Đảm bảo các thẻ PWA được chèn vào bên trong phần <head>, trước thẻ đóng </head>
  assert.ok(out.indexOf("manifest") < out.indexOf("</head>"));
});

/**
 * Làm gì: Kiểm tra khi không truyền projectId, script extensions vẫn được nạp nhưng không chèn các thuộc tính hoặc meta chứa project ID rỗng.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu script extensions không được chèn hoặc vô tình làm lộ thẻ project ID rỗng.
 */
test("injects the extensions script without a project id", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", {
    appName: "Demo",
    projectId: "",
  });
  assert.match(out, /src="https:\/\/grok\.com\/grok-app-builder\/extensions\.js" defer/);
  // Khi projectId rỗng, không được sinh ra các thuộc tính hoặc thẻ meta định danh dự án
  assert.doesNotMatch(out, /grok-project-id/);
  assert.doesNotMatch(out, /data-project-id/);
  assert.doesNotMatch(out, /property="grok:app_id"/);
});

/**
 * Làm gì: Kiểm tra khi có projectId hợp lệ, injectGrokPwaHead phải chèn đầy đủ thẻ meta grok-project-id, thuộc tính data-project-id và grok:app_id.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu thông tin projectId không xuất hiện đầy đủ trong thẻ meta và script.
 */
test("injects project id on the script and meta when provided", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", {
    appName: "Demo",
    projectId: "proj-123",
  });
  // Xác minh project ID được gắn đầy đủ vào thẻ meta và thuộc tính data của script extensions
  assert.match(out, /name="grok-project-id" content="proj-123"/);
  assert.match(out, /data-project-id="proj-123"/);
  assert.match(out, /property="grok:app_id" content="proj-123"/);
});

/**
 * Làm gì: Kiểm tra tính lũy thừa (idempotency), đảm bảo không nhân bản thẻ grok:app_id khi injectGrokPwaHead được gọi nhiều lần trên cùng một HTML.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu kết quả lần chèn thứ 2 khác lần 1 hoặc thẻ grok:app_id xuất hiện nhiều hơn 1 lần.
 */
test("does not duplicate grok:app_id", () => {
  const ctx = { appName: "Demo", projectId: "proj-123" };
  const once = injectGrokPwaHead("<html><head></head></html>", ctx);
  // Bước 2: Gọi chèn lần thứ hai trên HTML đã xử lý trước đó để kiểm tra tính lũy thừa (idempotent)
  const twice = injectGrokPwaHead(once, ctx);
  assert.equal(once, twice);
  // Đếm số lần xuất hiện của thẻ grok:app_id để chắc chắn không bị lặp lại
  assert.equal(twice.split('property="grok:app_id"').length - 1, 1);
});

/**
 * Làm gì: Kiểm tra quy tắc nghiệp vụ: chỉ sinh thẻ x:creator khi có ĐỦ cả hai giá trị creator (username) và creatorId; thiếu 1 trong 2 thì bỏ qua hoàn toàn.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu hàm sinh thẻ khi thiếu dữ liệu creator hoặc creatorId.
 */
test("omits x:creator tags without both creator values", () => {
  // Bước 1: Kiểm tra hàm tiện ích grokXCreatorHeadTags trả về mảng rỗng nếu thiếu 1 trong 2 thông tin
  assert.deepEqual(grokXCreatorHeadTags("", "42"), []);
  assert.deepEqual(grokXCreatorHeadTags("@alice", ""), []);
  // Bước 2: Kiểm tra hàm injectGrokPwaHead không chèn thẻ x:creator vào HTML khi creatorId rỗng
  const out = injectGrokPwaHead("<html><head></head></html>", {
    appName: "Demo",
    projectId: "",
    creator: "@alice",
    creatorId: "",
  });
  assert.doesNotMatch(out, /property="x:creator"/);
});

/**
 * Làm gì: Kiểm tra khi cung cấp đầy đủ cả creator và creatorId, injectGrokPwaHead sẽ chèn chính xác hai thẻ meta x:creator và x:creator:id.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu một trong hai thẻ x:creator hoặc x:creator:id không xuất hiện đúng giá trị.
 */
test("injects x:creator tags when both creator values are set", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", {
    appName: "Demo",
    projectId: "",
    creator: "@alice",
    creatorId: "42",
  });
  // Khi có đủ cả username và ID, sinh cả 2 thẻ x:creator và x:creator:id tương ứng
  assert.match(out, /property="x:creator" content="@alice"/);
  assert.match(out, /property="x:creator:id" content="42"/);
});

/**
 * Làm gì: Kiểm tra cơ chế mã hóa ký tự đặc biệt (HTML escape) trong grokXCreatorHeadTags để phòng chống tấn công XSS qua thuộc tính content.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu các ký tự nguy hiểm như ngoặc nhọn hoặc nháy kép không được escape đúng chuẩn HTML entities.
 */
test("escapes x:creator values", () => {
  const tags = grokXCreatorHeadTags('"><script>', '1" onclick="alert(1)');
  // Đảm bảo các ký tự HTML nguy hiểm như ngoặc nhọn và nháy kép được escape thành entities để chống XSS
  assert.equal(
    tags[0],
    '<meta property="x:creator" content="&quot;&gt;&lt;script&gt;">',
  );
  assert.equal(
    tags[1],
    '<meta property="x:creator:id" content="1&quot; onclick=&quot;alert(1)">',
  );
});

/**
 * Làm gì: Kiểm tra tính lũy thừa cho các thẻ x:creator và x:creator:id, đảm bảo không bị nhân đôi khi chạy qua bộ lọc nhiều lần.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu các thẻ tác giả bị lặp lại nhiều hơn một lần trong tài liệu HTML.
 */
test("does not duplicate x:creator tags", () => {
  const ctx = { appName: "Demo", projectId: "", creator: "@alice", creatorId: "42" };
  const once = injectGrokPwaHead("<html><head></head></html>", ctx);
  const twice = injectGrokPwaHead(once, ctx);
  assert.equal(once, twice);
  // Đảm bảo mỗi thẻ x:creator và x:creator:id chỉ tồn tại duy nhất một lần trong HTML
  assert.equal(twice.split('property="x:creator" content=').length - 1, 1);
  assert.equal(twice.split('property="x:creator:id"').length - 1, 1);
});

/**
 * Làm gì: Kiểm tra cơ chế ghi đè của nền tảng: thay thế thẻ share-card cũ bằng chuẩn chung (summary_large_image) và đồng bộ og:title theo thẻ <title>.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu thẻ cũ vẫn còn sót lại hoặc og:title không được cập nhật từ tiêu đề trang.
 */
test("platform chrome overwrites share-card metas and always sets og:title", () => {
  // Bước 1: Chuẩn bị HTML mẫu có sẵn các thẻ meta cũ cần ghi đè (og:title cũ và twitter:card summary)
  const html =
    '<html><head><title>Hello World</title><meta property="og:title" content="Old"><meta name="twitter:card" content="summary"></head></html>';
  // Bước 2: Gọi injectGrokPwaHead để áp dụng cấu hình thẻ chia sẻ chuẩn từ nền tảng
  const out = injectGrokPwaHead(html, { appName: "Wild Race" });
  // Bước 3: Xác minh các thẻ cũ bị ghi đè hoàn toàn: card thành summary_large_image, title lấy từ thẻ <title>
  assert.match(out, /name="twitter:card" content="summary_large_image"/);
  assert.match(out, /property="og:title" content="Hello World"/);
  assert.doesNotMatch(out, /content="Old"/);
  assert.doesNotMatch(out, /content="summary"/);
  assert.equal(out.split('name="twitter:card"').length - 1, 1);
  assert.equal(out.split('property="og:title"').length - 1, 1);
  assert.doesNotMatch(out, /property="og:image"/);
});

/**
 * Làm gì: Kiểm tra tính lũy thừa khi chèn thẻ chia sẻ mạng xã hội, đảm bảo twitter:card và og:title không bị nhân bản.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu chuỗi HTML biến đổi ở lần chèn thứ hai hoặc có thẻ trùng lặp.
 */
test("does not duplicate twitter:card or og:title", () => {
  const once = injectGrokPwaHead("<html><head><title>Hello World</title></head></html>");
  const twice = injectGrokPwaHead(once);
  assert.equal(once, twice);
  // Xác minh twitter:card và og:title chỉ xuất hiện đúng một lần duy nhất
  assert.equal(twice.split('name="twitter:card"').length - 1, 1);
  assert.equal(twice.split('property="og:title"').length - 1, 1);
});

/**
 * Làm gì: Kiểm tra trường hợp cấu hình site.json có sẵn ảnh (site.image), hệ thống sẽ coi là custom card và dùng ảnh này thay vì placeholder từ og.grok.me.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu og:image không trỏ đến đúng domain và file ảnh đã cấu hình hoặc bị trỏ nhầm về og.grok.me.
 */
test("a baked site.image is treated as a custom card", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    cwd: mkdtempSync(join(tmpdir(), "grok-og-image-only-")),
    site: { title: "Wild Race", image: "/og.jpg" },
  });
  // Khi site có thuộc tính image, og:image được gắn domain ứng dụng thay vì trỏ đến dịch vụ placeholder og.grok.me
  assert.match(out, /property="og:image" content="https:\/\/wild-race\.grok\.me\/og\.jpg"/);
  assert.doesNotMatch(out, /og\.grok\.me/);
});

/**
 * Làm gì: Kiểm tra khi chạy trong môi trường production không có file trên ổ đĩa, thông tin định danh baked trong site.json vẫn sinh đủ thẻ OpenGraph tùy biến.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu thiếu các thẻ og:title, og:type hoặc og:image tương ứng với cấu hình baked.
 */
test("baked identity does not need a workspace filesystem", () => {
  // Bước 1: Tạo thư mục tạm rỗng mô phỏng môi trường production serverless không có file dự án trên đĩa
  const empty = mkdtempSync(join(tmpdir(), "grok-og-empty-"));
  const out = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    cwd: empty,
    site: { title: "Pixel Nova", type: "x:game", card: "custom" },
  });
  // Bước 2: Xác minh các thẻ OpenGraph được sinh đầy đủ từ thông tin định danh baked trong site.json
  assert.match(out, /property="og:title" content="Pixel Nova"/);
  assert.match(out, /property="og:type" content="x:game"/);
  assert.match(out, /property="og:image" content="https:\/\/wild-race\.grok\.me\/og\.jpg"/);
  assert.doesNotMatch(out, /og\.grok\.me/);
});

/**
 * Làm gì: Kiểm tra độ ưu tiên: file ảnh public/og.jpg trên ổ đĩa luôn được ưu tiên hơn cấu hình site rỗng, tránh việc rơi vào placeholder og.grok.me.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu og:image không trỏ đến file ảnh trên đĩa hoặc rơi vào og.grok.me.
 */
test("a public card file wins over a baked site without card=custom", () => {
  // Deploy middleware always passes a baked `site`. If that snapshot missed
  // the file, public/og.jpg must still beat the og.grok.me placeholder.
  // Bước 1: Tạo thư mục tạm chứa file ảnh public/og.jpg thực tế trên ổ đĩa
  const root = mkdtempSync(join(tmpdir(), "grok-og-card-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public/og.jpg"), "x");
  // Bước 2: Gọi injectGrokPwaHead với cấu hình site rỗng để kiểm tra file trên đĩa được ưu tiên hơn placeholder
  const out = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    cwd: root,
    site: {},
  });
  assert.match(out, /property="og:image" content="https:\/\/wild-race\.grok\.me\/og\.jpg"/);
  assert.doesNotMatch(out, /og\.grok\.me/);
});

/**
 * Làm gì: Kiểm tra cơ chế dự phòng định dạng ảnh: khi không có public/og.jpg, hệ thống sẽ tự động tìm và sử dụng public/og.png.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu og:image không nhận diện được file .png thay thế.
 */
test("public/og.png wins when jpg is absent", () => {
  // Bước 1: Tạo thư mục chỉ chứa public/og.png (không có file .jpg)
  const root = mkdtempSync(join(tmpdir(), "grok-og-png-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public/og.png"), "x");
  // Bước 2: Kiểm tra hệ thống tự động fallback sang nhận diện định dạng .png
  const out = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    cwd: root,
    site: { title: "Wild Race" },
  });
  assert.match(out, /property="og:image" content="https:\/\/wild-race\.grok\.me\/og\.png"/);
  assert.doesNotMatch(out, /og\.grok\.me/);
});

/**
 * Làm gì: Kiểm tra hàm resolveOgCardAsset tuân thủ đúng thứ tự ưu tiên: file vật lý trên đĩa > ảnh trong site.json > rỗng (để dùng placeholder).
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu thứ tự ưu tiên hoặc kết quả trả về của resolveOgCardAsset không chính xác.
 */
test("resolveOgCardAsset: disk file, then bake, then empty (placeholder)", () => {
  // Bước 1: Thư mục rỗng và không có cấu hình ảnh -> trả về rỗng để kích hoạt placeholder mặc định
  const empty = mkdtempSync(join(tmpdir(), "grok-og-none-"));
  assert.equal(resolveOgCardAsset({}, empty), "");
  assert.equal(resolveOgCardAsset({ title: "X" }, empty), "");

  // Bước 2: Thư mục rỗng nhưng cấu hình site có card="custom" -> trả về đường dẫn ảnh từ site.json
  const baked = resolveOgCardAsset({ card: "custom", image: "/og.jpg" }, empty);
  assert.equal(baked, "/og.jpg");

  // Bước 3: Thư mục có file thực tế trên đĩa -> file trên đĩa luôn có độ ưu tiên cao nhất
  const root = mkdtempSync(join(tmpdir(), "grok-og-disk-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public/og.jpg"), "x");
  assert.equal(resolveOgCardAsset({}, root), "/og.jpg");
  assert.equal(resolveOgCardAsset({ card: "custom", image: "/other.png" }, root), "/og.jpg");
});

/**
 * Làm gì: Kiểm tra snapshotOgIdentity tự động đánh dấu card="custom" và lưu image="/og.jpg" khi phát hiện file public/og.jpg trong thư mục dự án.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu snapshot không nhận diện đúng card custom hoặc sai đường dẫn ảnh.
 */
test("snapshotOgIdentity stamps card=custom from a public card file", () => {
  // Bước 1: Chuẩn bị thư mục chứa file public/og.jpg
  const root = mkdtempSync(join(tmpdir(), "grok-og-snap-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public/og.jpg"), "x");
  // Bước 2: Chụp snapshot thông tin định danh và kiểm tra thuộc tính card được tự động gán là "custom"
  const { site } = snapshotOgIdentity(root);
  assert.equal(site.card, "custom");
  assert.equal(site.image, "/og.jpg");
  assert.equal(site.banner, undefined);
});

/**
 * Làm gì: Kiểm tra hàm snapshotOgIdentity tự động trích xuất đường dẫn banner khi tồn tại file public/x-banner.jpg trên đĩa.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu site.banner không được gán đường dẫn /x-banner.jpg.
 */
test("snapshotOgIdentity stamps banner from public/x-banner.jpg", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-og-banner-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public/x-banner.jpg"), "x");
  // Kiểm tra thuộc tính banner được tự động nhận diện từ file public/x-banner.jpg
  const { site } = snapshotOgIdentity(root);
  assert.equal(site.banner, "/x-banner.jpg");
});

/**
 * Làm gì: Kiểm tra việc sinh thẻ x:game:image cùng kích thước chuẩn (1200x264) khi có banner và host công khai, đồng thời ghi đè thẻ cũ.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu thiếu các thẻ kích thước banner hoặc thẻ x:game:image cũ không bị ghi đè.
 */
test("emits x:game:image for a public host when site.banner is set", () => {
  // Bước 1: Chuẩn bị HTML có thẻ x:game:image cũ để kiểm tra khả năng ghi đè
  const html = "<html><head><meta property=\"x:game:image\" content=\"old\"></head></html>";
  const out = injectGrokPwaHead(html, {
    host: "wild-race.grok.me",
    site: { title: "Wild Race", type: "x:game", card: "custom", banner: "/x-banner.jpg" },
  });
  // Bước 2: Xác minh x:game:image nhận đường dẫn đầy đủ và các kích thước chuẩn (1200x264) của banner X/Twitter
  assert.match(
    out,
    /property="x:game:image" content="https:\/\/wild-race\.grok\.me\/x-banner\.jpg"/,
  );
  assert.match(out, /property="x:game:image:width" content="1200"/);
  assert.match(out, /property="x:game:image:height" content="264"/);
  assert.doesNotMatch(out, /content="old"/);
  assert.equal(out.split('property="x:game:image"').length - 1, 1);
});

/**
 * Làm gì: Kiểm tra điều kiện loại trừ: không sinh thẻ x:game:image nếu thiếu host công khai hoặc thiếu đường dẫn banner.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu thẻ x:game:image bị sinh ra khi không đủ điều kiện.
 */
test("does not emit x:game:image without a public host or banner", () => {
  // Trường hợp 1: Có banner nhưng không có public host -> không sinh thẻ banner
  const noHost = injectGrokPwaHead("<html><head></head></html>", {
    site: { banner: "/x-banner.jpg" },
  });
  assert.doesNotMatch(noHost, /x:game:image/);
  // Trường hợp 2: Có public host nhưng không có banner -> không sinh thẻ banner
  const noBanner = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    site: { type: "x:game", card: "custom" },
  });
  assert.doesNotMatch(noBanner, /x:game:image/);
});

/**
 * Làm gì: Kiểm tra tiêu đề "Grok App" trong site.json được coi là tên thật do người dùng chỉ định, không bị coi là giá trị rác để rơi vào fallback slug.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu og:title không lấy đúng giá trị "Grok App".
 */
test("site title Grok App is a real name, not a sentinel", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    site: { title: "Grok App" },
  });
  // Tiêu đề "Grok App" được giữ nguyên làm og:title, không bị ghi đè bởi subdomain fallback
  assert.match(out, /property="og:title" content="Grok App"/);
});

/**
 * Làm gì: Kiểm tra cơ chế tự động chuyển đổi slug tên miền (wild-race.grok.me) thành tiêu đề dự phòng (Wild Race) khi không có tiêu đề rõ ràng.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu og:title không được tạo từ subdomain dạng title-case.
 */
test("published grok.me slug is still a title fallback", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
  });
  // Tự động chuyển slug subdomain "wild-race" thành tiêu đề dạng Title Case ("Wild Race")
  assert.match(out, /property="og:title" content="Wild Race"/);
});

/**
 * Làm gì: Kiểm tra hàm publicAppHost từ chối các domain nội bộ/tạm thời của Vercel để tránh lộ URL hệ thống trong thẻ og:image.
 * Được gọi ở: test runner (node --test)
 * - Lỗi có thể ném: AssertionError nếu các domain hệ thống Vercel không trả về chuỗi rỗng.
 */
test("rejects Vercel system hosts as og:image origins", () => {
  // Các tên miền hệ thống tạm thời của Vercel không được dùng làm origin cho og:image (phải trả về chuỗi rỗng)
  assert.equal(publicAppHost("01a020b6-803a-71a2-bb47-e2bec57eb9a2-662k8x1l1-xai-org.vercel.app"), "");
  assert.equal(publicAppHost("demo.vercel.app:443"), "");
  assert.equal(publicAppHost("vercel.app"), "");
  assert.equal(publicAppHost("wild-race.grok.me"), "wild-race.grok.me");
});

/**
 * Làm gì: Kiểm tra biến môi trường VITE_PUBLIC_HOSTNAME luôn được ưu tiên hơn header Host trong request để làm domain cho thẻ og:image.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("published VITE_PUBLIC_HOSTNAME wins over request Host for og:image", () => {
  // Bước 1: Lưu lại giá trị biến môi trường ban đầu và thiết lập VITE_PUBLIC_HOSTNAME giả lập
  const prev = process.env.VITE_PUBLIC_HOSTNAME;
  process.env.VITE_PUBLIC_HOSTNAME = "plum-plaza-reef-dream.grok.me";
  try {
    // Bước 2: Thử nghiệm với host nội bộ Vercel, kiểm tra og:image dùng domain công khai thay vì domain vercel.app
    const vercelHost = injectGrokPwaHead("<html><head><title>RACK</title></head></html>", {
      host: "01a020b6-803a-71a2-bb47-e2bec57eb9a2-662k8x1l1-xai-org.vercel.app",
      site: { title: "RACK", card: "custom" },
    });
    assert.match(
      vercelHost,
      /property="og:image" content="https:\/\/plum-plaza-reef-dream\.grok\.me\/og\.jpg"/,
    );
    assert.doesNotMatch(vercelHost, /vercel\.app/);

    // Bước 3: Thử nghiệm với host tùy chỉnh khác, đảm bảo VITE_PUBLIC_HOSTNAME vẫn được ưu tiên hàng đầu
    const otherPublicHost = injectGrokPwaHead("<html><head><title>RACK</title></head></html>", {
      host: "custom.example.com",
      site: { title: "RACK", card: "custom" },
    });
    assert.match(
      otherPublicHost,
      /property="og:image" content="https:\/\/plum-plaza-reef-dream\.grok\.me\/og\.jpg"/,
    );
    assert.doesNotMatch(otherPublicHost, /custom\.example\.com/);
  // Bước 4: Khôi phục lại biến môi trường ban đầu trong khối finally để tránh ảnh hưởng các test case khác
  } finally {
    if (prev === undefined) delete process.env.VITE_PUBLIC_HOSTNAME;
    else process.env.VITE_PUBLIC_HOSTNAME = prev;
  }
});

/**
 * Làm gì: Kiểm tra khi request đến từ host Vercel mà không có VITE_PUBLIC_HOSTNAME thì không sinh thẻ og:image, tránh lộ domain nội bộ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("vercel Host without a public hostname emits no og:image", () => {
  // Bước 1: Tạm thời xóa biến môi trường VITE_PUBLIC_HOSTNAME
  const prev = process.env.VITE_PUBLIC_HOSTNAME;
  delete process.env.VITE_PUBLIC_HOSTNAME;
  try {
    // Bước 2: Gọi injectGrokPwaHead với host Vercel và kiểm tra không xuất hiện thẻ og:image
    const out = injectGrokPwaHead("<html><head><title>RACK</title></head></html>", {
      host: "01a020b6-803a-71a2-bb47-e2bec57eb9a2-662k8x1l1-xai-org.vercel.app",
      site: { title: "RACK", card: "custom" },
    });
    assert.doesNotMatch(out, /property="og:image"/);
    assert.doesNotMatch(out, /vercel\.app/);
  // Bước 3: Phục hồi lại biến môi trường trong khối finally
  } finally {
    if (prev === undefined) delete process.env.VITE_PUBLIC_HOSTNAME;
    else process.env.VITE_PUBLIC_HOSTNAME = prev;
  }
});

/**
 * Làm gì: Kiểm tra việc sinh thẻ og:image cho host công khai, ưu tiên ảnh thẻ riêng (og.jpg) khi có cấu hình card=custom thay vì ảnh placeholder.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("emits og:image for a public host and prefers a custom card", () => {
  // Bước 1: Khi chưa có card="custom", tạo thẻ og:image dùng dịch vụ tạo ảnh placeholder og.grok.me kèm kích thước chuẩn 1200
  const placeholder = injectGrokPwaHead("<html><head></head></html>", {
    appName: "Wild Race",
    host: "wild-race.grok.me",
    site: { title: "Wild Race" },
  });
  assert.match(
    placeholder,
    /property="og:image" content="https:\/\/og\.grok\.me\/v1\/card\.png\?host=wild-race\.grok\.me&amp;title=Wild%20Race"/,
  );
  assert.match(placeholder, /property="og:image:width" content="1200"/);

  // Bước 2: Khi có cấu hình card="custom", chuyển sang dùng đường dẫn ảnh nội bộ /og.jpg và gắn type tương ứng
  const custom = injectGrokPwaHead("<html><head></head></html>", {
    appName: "Wild Race",
    host: "wild-race.grok.me",
    site: { title: "Wild Race", card: "custom", type: "x:game" },
  });
  assert.match(custom, /property="og:image" content="https:\/\/wild-race\.grok\.me\/og\.jpg"/);
  assert.match(custom, /property="og:type" content="x:game"/);
});

/**
 * Làm gì: Kiểm tra URL ảnh thẻ placeholder tự động bổ sung tham số color khi site.color là mã màu hex 6 chữ số hợp lệ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("placeholder og:image appends site.color when it is 6-digit hex", () => {
  // Bước 1: Mã màu hợp lệ dạng hex (#FF4D2E) được cắt bỏ dấu # và đưa vào query param color
  const themed = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    site: { title: "Wild Race", color: "#FF4D2E" },
  });
  assert.match(
    themed,
    /property="og:image" content="https:\/\/og\.grok\.me\/v1\/card\.png\?host=wild-race\.grok\.me&amp;title=Wild%20Race&amp;color=FF4D2E"/,
  );

  // Bước 2: Tên màu không đúng định dạng hex (ví dụ "red") sẽ bị bỏ qua
  const invalid = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    site: { title: "Wild Race", color: "red" },
  });
  assert.doesNotMatch(invalid, /color=/);

  // Bước 3: Khi dùng thẻ tùy chỉnh (card="custom"), tham số color không được gắn vì dùng file ảnh tĩnh riêng
  const custom = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    site: { title: "Wild Race", card: "custom", color: "FF4D2E" },
  });
  assert.doesNotMatch(custom, /color=/);
});

/**
 * Làm gì: Kiểm tra các ký tự thực thể HTML trong thẻ title (như &amp;) không bị mã hóa hai lần thành &amp;amp; trên og:title.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("document title entities are not double-escaped on og:title", () => {
  const out = injectGrokPwaHead(
    "<html><head><title>Cats &amp; Dogs</title></head></html>",
  );
  assert.match(out, /property="og:title" content="Cats &amp; Dogs"/);
  assert.doesNotMatch(out, /Cats &amp;amp; Dogs/);
});

/**
 * Làm gì: Kiểm tra giá trị title được khai báo tường minh trong site.json luôn được ưu tiên hơn tiêu đề suy luận từ host slug.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("site.json title wins over the host slug", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", {
    host: "wild-race.grok.me",
    site: { title: "Pixel Nova" },
  });
  assert.match(out, /property="og:title" content="Pixel Nova"/);
});

/**
 * Làm gì: Kiểm tra hàm injectGrokPwaHead tự động tạo mới cặp thẻ <head>...</head> khi tài liệu HTML đầu vào thiếu thẻ head.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("injects into documents with no head element", () => {
  const out = injectGrokPwaHead("<html><body>hi</body></html>", { appName: "Solo" });
  assert.match(out, /<head>/);
  assert.match(out, /property="og:title" content="Solo"/);
  assert.match(out, /<\/head>/);
});

/**
 * Làm gì: Kiểm tra bộ chèn thẻ dạng luồng (createHeadInjector) nhận diện thẻ đóng </HEAD> không phân biệt hoa thường khi bị ngắt qua nhiều chunk.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("streaming injector matches </HEAD> case-insensitively", () => {
  // Bước 1: Khởi tạo streaming injector với thông tin ứng dụng
  const injector = createHeadInjector({ appName: "Wild Race" });
  // Bước 2: Đẩy các chunk HTML với thẻ đóng </HEAD> viết hoa bị chia cắt giữa </HE và AD>
  const chunks = [
    ...injector.push("<html><HEAD><title>x</title></HE"),
    ...injector.push("AD><body>hello</body></html>"),
  ];
  // Bước 3: Ghép nối kết quả và kiểm tra các thẻ metadata đã được chèn chính xác trước thẻ đóng
  const out = Buffer.concat(chunks).toString("utf8");
  assert.match(out, /property="og:title" content="x"/);
  assert.match(out, /<body>hello<\/body>/);
});
/**
 * Làm gì: Kiểm tra hàm injectGrokPwaHead không bị lặp lại thẻ script extensions.js khi được gọi liên tiếp nhiều lần.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */

// Bước 1: Chuẩn bị ngữ cảnh ứng dụng và thực hiện chèn lần đầu
test("does not duplicate the extensions script", () => {
  const ctx = { appName: "Demo", projectId: "proj-123" };
  // Bước 2: Thực hiện chèn lần hai trên kết quả của lần chèn đầu
  const once = injectGrokPwaHead("<html><head></head></html>", ctx);
  // Bước 3: Xác thực nội dung giữ nguyên và file script extensions.js chỉ xuất hiện duy nhất 1 lần
  const twice = injectGrokPwaHead(once, ctx);
  assert.equal(once, twice);
  assert.equal(twice.split("extensions.js").length - 1, 1);
});

/**
 * Làm gì: Kiểm tra tính lũy đẳng (idempotent) của hàm injectGrokPwaHead, gọi nhiều lần vẫn cho kết quả chuỗi HTML đồng nhất.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("is idempotent", () => {
  const once = injectGrokPwaHead("<html><head></head></html>");
  const twice = injectGrokPwaHead(once);
  assert.equal(once, twice);
});

/**
 * Làm gì: Kiểm tra thuộc tính apple-mobile-web-app-title nhận đúng giá trị appName được truyền vào.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("uses the app name in the injected title tag", () => {
  const out = injectGrokPwaHead("<html><head></head></html>", { appName: "Wild Race" });
  assert.match(out, /apple-mobile-web-app-title" content="Wild Race"/);
});

/**
 * Làm gì: Kiểm tra bộ chèn thẻ dạng luồng xử lý trơn tru trường hợp thẻ đóng </head> bị phân tách ở ranh giới giữa 2 chunk.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("streaming injector handles </head> split across chunks", () => {
  // Bước 1: Khởi tạo streaming injector
  const injector = createHeadInjector({ appName: "Wild Race" });
  // Bước 2: Đẩy 2 chunk liên tiếp có ranh giới cắt đôi thẻ </head> thành </he và ad>
  const chunks = [
    ...injector.push("<html><head><title>x</title></he"),
    ...injector.push("ad><body>hello</body></html>"),
  ];
  // Bước 3: Ghép dữ liệu và xác nhận thẻ manifest nằm đúng vị trí ngay trước thẻ </head>
  const out = Buffer.concat(chunks).toString("utf8");
  assert.match(out, /rel="manifest"/);
  assert.ok(out.indexOf("manifest") < out.indexOf("</head>"));
  assert.match(out, /<body>hello<\/body>/);
  assert.deepEqual(injector.flush(), []);
});

/**
 * Làm gì: Kiểm tra các chunk dữ liệu đến sau phần head được truyền qua nguyên vẹn mà không bị biến đổi hay xử lý thừa.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("streaming injector passes post-head chunks through untouched", () => {
  const injector = createHeadInjector();
  injector.push("<html><head></head>");
  const [tail] = injector.push("<body>tail</body>");
  assert.equal(tail.toString("utf8"), "<body>tail</body>");
});

/**
 * Làm gì: Kiểm tra cơ chế dự phòng (fallback) của streaming injector khi luồng dữ liệu kết thúc mà không xuất hiện thẻ </head>.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("streaming injector falls back when no </head> is seen", () => {
  // Bước 1: Đẩy chunk HTML chưa đóng thẻ head, lúc này dữ liệu được giữ lại trong bộ đệm nội bộ
  const injector = createHeadInjector();
  assert.deepEqual(injector.push("<html><head>"), []);
  // Bước 2: Gọi flush() khi kết thúc luồng để xả toàn bộ dữ liệu kèm thẻ PWA đã chèn
  const out = Buffer.concat(injector.flush()).toString("utf8");
  assert.match(out, /rel="manifest"/);
});

/**
 * Làm gì: Kiểm tra hàm isInstallQuery nhận diện đúng tham số query cài đặt PWA trên iOS (?install=1|true và platform=ios).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("detects install query", () => {
  // Chỉ trả về true khi đồng thời có cờ cài đặt hợp lệ (install=1 hoặc true) VÀ platform=ios
  assert.equal(isInstallQuery("/?install=1&platform=ios"), true);
  assert.equal(isInstallQuery("/app?foo=1&install=true&platform=ios"), true);
  assert.equal(isInstallQuery("/?install=1"), false);
  assert.equal(isInstallQuery("/?install=1&platform=android"), false);
  assert.equal(isInstallQuery("/?install=0&platform=ios"), false);
  assert.equal(isInstallQuery("/"), false);
});

/**
 * Làm gì: Kiểm tra hàm isDocumentPath phân biệt chính xác giữa đường dẫn trang HTML với đường dẫn API và tài nguyên tĩnh.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("filters non-document paths", () => {
  // Đường dẫn trang web thông thường trả về true, trong khi API và file tĩnh (css, ảnh) trả về false để tránh can thiệp nhầm
  assert.equal(isDocumentPath("/"), true);
  assert.equal(isDocumentPath("/app"), true);
  assert.equal(isDocumentPath("/api/thing"), false);
  assert.equal(isDocumentPath("/__grok/install/styles.css"), false);
  assert.equal(isDocumentPath("/logo.png"), false);
});

/**
 * Làm gì: Kiểm tra hàm stripInstallParams loại bỏ sạch các tham số cài đặt (install, platform) khỏi query string nhưng giữ nguyên các tham số khác.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("strips install params from the app link", () => {
  assert.equal(stripInstallParams("/?install=1&platform=ios"), "/");
  assert.equal(stripInstallParams("/app?install=1&platform=ios&tab=2"), "/app?tab=2");
});

/**
 * Làm gì: Kiểm tra hàm appNameFromHost trích xuất tên ứng dụng đẹp mắt từ domain slug (ví dụ wild-race -> Wild Race) và dùng tên mặc định cho localhost/IP.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("names the install page from host slug", () => {
  assert.equal(appNameFromHost("localhost:8080"), "Grok App");
  assert.equal(appNameFromHost("172.17.154.217:8080"), "Grok App");
  assert.equal(appNameFromHost("wild-race.grok.me"), "Wild Race");
});

/**
 * Làm gì: Kiểm tra hàm appNameFromHost từ chối các host có ký tự bất thường hoặc mã script độc hại để phòng chống tấn công XSS.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("rejects hosts that are not plain slugs", () => {
  assert.equal(appNameFromHost("<script>alert(1)</script>"), "Grok App");
  assert.equal(appNameFromHost('"><img src=x onerror=1>.grok.me'), "Grok App");
});

/**
 * Làm gì: Kiểm tra hàm renderInstallPage tạo mã HTML cho trang hướng dẫn cài đặt với tên ứng dụng, CSS và link điều hướng đã thay thế hết placeholder.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("renders install page markup", () => {
  // Bước 1: Render trang hướng dẫn cài đặt từ host và URL hiện tại
  const html = renderInstallPage("wild-race.grok.me", "/?install=1&platform=ios");
  assert.match(html, /Add Wild Race to your/);
  assert.match(html, /\/__grok\/install\/styles\.css/);
  assert.match(html, /href="\/"/);
  // Bước 2: Kiểm tra các biến mẫu {{APP_NAME}} và {{APP_URL}} đã được thay thế triệt để
  assert.equal(html.includes("{{APP_NAME}}"), false);
  assert.equal(html.includes("{{APP_URL}}"), false);
});

/**
 * Làm gì: Kiểm tra các giá trị lấy từ hostname được escape ký tự an toàn khi render vào trang cài đặt để ngăn chặn XSS.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("escapes host-derived values in the install page", () => {
  const html = renderInstallPage("<script>alert(1)</script>", "/?install=1&platform=ios");
  assert.equal(html.includes("<script>alert(1)</script>"), false);
});

/**
 * Làm gì: Kiểm tra hàm renderWebManifest tạo file cấu hình Web App Manifest chứa tên ứng dụng trích xuất từ hostname và icon PWA.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("renders the manifest with the per-app name", () => {
  // Bước 1: Parse nội dung JSON của web manifest được sinh ra
  const manifest = JSON.parse(renderWebManifest("wild-race.grok.me"));
  // Bước 2: Kiểm tra các trường định danh tên ứng dụng và đường dẫn icon PWA tiêu chuẩn
  assert.equal(manifest.name, "Wild Race");
  assert.equal(manifest.short_name, "Wild Race");
  assert.equal(manifest.icons[0].src, "/__grok/icon-180.png");
});

// Tripwires: the deployed-app path only works if Nitro scans server/ — an
// accidental edit that drops serverDir or the middleware file would otherwise
// fail silently (published apps would just render the app for ?install=1).
/**
 * Làm gì: Kiểm tra file vite.config.ts luôn giữ cấu hình serverDir trỏ vào ./server và kích hoạt grokPwaPlugin để Nitro nhận diện middleware.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("vite config keeps the nitro serverDir wiring", () => {
  // Bước 1: Đọc nội dung file cấu hình vite.config.ts
  const viteConfig = readFileSync(join(TEMPLATE_ROOT, "vite.config.ts"), "utf8");
  // Bước 2: Kiểm tra cấu hình kết nối Nitro serverDir và plugin grokPwaPlugin
  assert.match(viteConfig, /serverDir:\s*"\.\/server"/);
  assert.match(viteConfig, /grokPwaPlugin\(\)/);
});

/**
 * Làm gì: Kiểm tra file Nitro middleware (server/middleware/grok-pwa.ts) cùng các tài nguyên tĩnh đi kèm tồn tại đầy đủ trong dự án.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("nitro middleware and its bundled assets exist", () => {
  // Bước 1: Kiểm tra nội dung file middleware tham chiếu đúng template HTML và virtual module
  const middleware = readFileSync(join(TEMPLATE_ROOT, "server/middleware/grok-pwa.ts"), "utf8");
  assert.match(middleware, /install-page\.html\?raw/);
  assert.match(middleware, /virtual:grok-og-identity/);
  // Bước 2: Xác nhận các file tài nguyên tĩnh phục vụ PWA thực sự tồn tại trên ổ đĩa
  readFileSync(join(TEMPLATE_ROOT, "scripts/install-page.html"));
  readFileSync(join(TEMPLATE_ROOT, "public/__grok/icon-180.png"));
  readFileSync(join(TEMPLATE_ROOT, "public/__grok/install/styles.css"));
});

/**
 * Làm gì: Kiểm tra plugin Vite (grok-pwa-plugin.mjs) đóng gói metadata định danh Open Graph thành virtual module virtual:grok-og-identity.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("vite plugin bakes og identity as a virtual module", () => {
  const plugin = readFileSync(join(TEMPLATE_ROOT, "scripts/grok-pwa-plugin.mjs"), "utf8");
  assert.match(plugin, /virtual:grok-og-identity/);
  assert.match(plugin, /snapshotOgIdentity/);
});

