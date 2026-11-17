/**
 * Mục đích file:
 * Bộ unit test cho module scripts/browser-smoke-verdict.mjs và kiểm tra tích hợp trong scripts/browser-smoke.mjs.
 * Kiểm tra toàn diện việc chuẩn hóa văn bản, phát hiện sai lệch (divergence) giữa kết quả kiểm thử hiện tại và baseline,
 * phân tích cờ dòng lệnh CLI, suy luận đường dẫn file sinh ra, tính exit code và các ràng buộc bảo mật đường dẫn I/O.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong quy trình QA tự động trước khi triển khai ứng dụng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  baselineComparison,
  bodyTextPrefix,
  compareToBaseline,
  derivedPaths,
  exitCodeFor,
  normalizeBodyText,
  normalizedBodyTextHash,
  parseSmokeArgs,
} from "./browser-smoke-verdict.mjs";

// Thư mục gốc dự án, dùng để đọc file mã nguồn khi kiểm thử tĩnh (static assertion)
const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Làm gì: Tạo dữ liệu giả lập (mock data) cho một viewport (desktop/mobile) với các thuộc tính mặc định hợp lệ của smoke test.
 * Được gọi ở: scripts/browser-smoke-verdict.test.mjs - hàm verdict() và các ca kiểm thử test()
 * - Tham số overrides: Đối tượng ghi đè (override) các thuộc tính mặc định của viewport
 * @returns {Object} Đối tượng viewport mô phỏng kết quả kiểm tra giao diện trình duyệt
 */
function viewport(overrides = {}) {
  return {
    status: 200,
    title: "App",
    hasCanvas: false,
    horizontalOverflow: false,
    bodyTextLen: 500,
    bodyTextHash: "aaa",
    bodyTextPrefix: "hello world",
    consoleErrors: [],
    pageErrors: [],
    ...overrides,
  };
}

/**
 * Làm gì: Tạo cấu trúc dữ liệu verdict hoàn chỉnh gồm cả 2 viewport desktop và mobile để kiểm tra logic so sánh baseline.
 * Được gọi ở: scripts/browser-smoke-verdict.test.mjs - các ca kiểm thử test()
 * - Tham số desktop: Các thuộc tính ghi đè cho viewport desktop
 * - Tham số mobile: Các thuộc tính ghi đè cho viewport mobile
 * @returns {Object} Đối tượng verdict chứa viewports của cả desktop và mobile
 */
function verdict(desktop = {}, mobile = {}) {
  return { viewports: { desktop: viewport(desktop), mobile: viewport(mobile) } };
}

/**
 * Làm gì: Kiểm tra hàm normalizeBodyText gộp khoảng trắng và normalizedBodyTextHash tạo mã SHA-256 nhất quán.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("normalizes whitespace before hashing", () => {
  // Bước 1: Chuẩn hóa khoảng trắng: gộp các khoảng trắng/tab/xuống dòng liên tiếp thành 1 dấu cách và trim 2 đầu
  assert.equal(normalizeBodyText("  a \n\t b  "), "a b");
  // Bước 2: Hai văn bản có cùng nội dung chữ nhưng khác khoảng trắng thì mã hash SHA-256 phải bằng nhau
  assert.equal(normalizedBodyTextHash("a \n b"), normalizedBodyTextHash("  a b "));
  assert.notEqual(normalizedBodyTextHash("a b"), normalizedBodyTextHash("a c"));
});

/**
 * Làm gì: Kiểm tra normalizeBodyText xử lý an toàn các giá trị null, undefined và chuỗi rỗng thành chuỗi rỗng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("nullish and blank body text normalize to the empty string", () => {
  // Xử lý null/undefined thành chuỗi rỗng an toàn, tránh lỗi TypeError khi gọi replace hoặc trim
  assert.equal(normalizeBodyText(null), "");
  assert.equal(normalizeBodyText(undefined), "");
  assert.equal(normalizedBodyTextHash(""), normalizedBodyTextHash("  \n "));
});

/**
 * Làm gì: Kiểm tra hàm bodyTextPrefix chuẩn hóa chuỗi và cắt tối đa 64 ký tự đầu (IDENTITY_PREFIX_LEN).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("body text prefix is normalized and capped", () => {
  assert.equal(bodyTextPrefix("  a \n b  "), "a b");
  // Giới hạn tối đa 64 ký tự (hằng số IDENTITY_PREFIX_LEN) để nhận diện nhanh nội dung mở đầu trang
  assert.equal(bodyTextPrefix("x".repeat(200)).length, 64);
});

/**
 * Làm gì: Kiểm tra hai kết quả smoke test giống hệt nhau thì không bị coi là phân kỳ (divergesFromBaseline = false).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("identical runs do not diverge", () => {
  // Hai lần chạy có kết quả giống nhau: không phát sinh bất kỳ lý do cảnh báo nào
  const { divergesFromBaseline, reasons } = compareToBaseline(verdict(), verdict());
  assert.equal(divergesFromBaseline, false);
  assert.deepEqual(reasons, []);
});

/**
 * Làm gì: Kiểm tra việc thay đổi mã HTTP status (ví dụ từ 200 sang 500) bị phát hiện là sai lệch nghiêm trọng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("status change diverges", () => {
  // Mã trạng thái HTTP khác nhau giữa hiện tại và baseline kích hoạt cảnh báo sai lệch
  const { divergesFromBaseline, reasons } = compareToBaseline(verdict({ status: 500 }), verdict());
  assert.equal(divergesFromBaseline, true);
  assert.match(reasons.join(";"), /desktop: HTTP status changed 200 -> 500/);
});

/**
 * Làm gì: Kiểm tra khi tiêu đề trang (title) bị thay đổi so với baseline thì ghi nhận sai lệch giao diện.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("title change diverges", () => {
  // Tiêu đề thay đổi (ví dụ trang hiển thị tiêu đề 'Error' thay vì 'App') sẽ bị đánh dấu sai lệch
  const { divergesFromBaseline, reasons } = compareToBaseline(
    verdict({ title: "Error" }),
    verdict(),
  );
  assert.equal(divergesFromBaseline, true);
  assert.match(reasons.join(";"), /desktop: title changed \("App" -> "Error"\)/);
});

/**
 * Làm gì: Kiểm tra bỏ qua so sánh tiêu đề trang nếu một trong hai phía (current hoặc baseline) không có title.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("title comparison is skipped when either side lacks one", () => {
  // Nếu title là undefined ở một phía thì không coi là lỗi để đảm bảo tính tương thích ngược
  const { divergesFromBaseline } = compareToBaseline(
    verdict({ title: undefined }),
    verdict({ title: "App" }),
  );
  assert.equal(divergesFromBaseline, false);
});

/**
 * Làm gì: Kiểm tra quy tắc nghiệp vụ: thẻ canvas biến mất là lỗi hồi quy, nhưng canvas mới xuất hiện thì được chấp nhận.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("canvas disappearing diverges; canvas appearing does not", () => {
  // Bước 1: Thẻ canvas biến mất chứng tỏ game/đồ họa bị lỗi không render được, phải báo sai lệch
  const gone = compareToBaseline(verdict({ hasCanvas: false }), verdict({ hasCanvas: true }));
  assert.equal(gone.divergesFromBaseline, true);
  assert.match(gone.reasons.join(";"), /desktop: canvas disappeared/);

  // Bước 2: Thẻ canvas mới xuất hiện được xem là tính năng mới thêm vào, không coi là lỗi
  const appeared = compareToBaseline(verdict({ hasCanvas: true }), verdict({ hasCanvas: false }));
  assert.equal(appeared.divergesFromBaseline, false);
});

/**
 * Làm gì: Kiểm tra hiện tượng tràn ngang (horizontal overflow) xuất hiện trên mobile là lỗi, nhưng sửa hết lỗi thì hợp lệ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("horizontal overflow appearing diverges; clearing does not", () => {
  // Bước 1: Kiểm tra lỗi vỡ layout khi mobile xuất hiện thanh cuộn ngang ngoài ý muốn
  const appeared = compareToBaseline(
    verdict({}, { horizontalOverflow: true }),
    verdict({}, { horizontalOverflow: false }),
  );
  assert.equal(appeared.divergesFromBaseline, true);
  assert.match(appeared.reasons.join(";"), /mobile: horizontal overflow appeared/);

  // Bước 2: Kiểm tra khi bản build mới đã sửa được lỗi cuộn ngang (từ true thành false) thì không báo lỗi
  const cleared = compareToBaseline(
    verdict({}, { horizontalOverflow: false }),
    verdict({}, { horizontalOverflow: true }),
  );
  assert.equal(cleared.divergesFromBaseline, false);
});

/**
 * Làm gì: Kiểm tra xuất hiện lỗi console mới so với baseline sẽ bị đánh dấu là sai lệch phân kỳ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("new console errors diverge", () => {
  // Phát hiện lỗi console/page xuất hiện mới trên mobile so với baseline ban đầu
  const { divergesFromBaseline, reasons } = compareToBaseline(
    verdict({}, { consoleErrors: ["boom"] }),
    verdict(),
  );
  assert.equal(divergesFromBaseline, true);
  assert.match(reasons.join(";"), /mobile: console\/page errors appeared/);
});

/**
 * Làm gì: Kiểm tra các lỗi console đã tồn tại từ trước trong baseline thì không kích hoạt cảnh báo sai lệch lặp lại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("errors already present in the baseline do not re-diverge", () => {
  // Cả baseline và hiện tại đều có cùng lỗi console thì không tính là phân kỳ mới (tránh cảnh báo lặp)
  const { divergesFromBaseline } = compareToBaseline(
    verdict({ consoleErrors: ["boom"] }),
    verdict({ consoleErrors: ["boom"] }),
  );
  assert.equal(divergesFromBaseline, false);
});

/**
 * Làm gì: Kiểm tra khi độ dài văn bản body giảm đột ngột dưới 50% (COLLAPSE_RATIO = 0.5) thì báo lỗi sụp đổ nội dung.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("body text collapse diverges", () => {
  // Nội dung giảm từ 500 ký tự xuống 10 ký tự (< 50% ngưỡng COLLAPSE_RATIO) kích hoạt cảnh báo sụp đổ
  const { divergesFromBaseline, reasons } = compareToBaseline(
    verdict({ bodyTextLen: 10, bodyTextHash: "bbb" }),
    verdict(),
  );
  assert.equal(divergesFromBaseline, true);
  assert.match(reasons.join(";"), /desktop: body text collapsed \(500 -> 10 chars\)/);
});

/**
 * Làm gì: Kiểm tra trường hợp đặc biệt khi toàn bộ nội dung văn bản body bị xóa sạch về 0 ký tự (màn hình trắng).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("body text dropping to zero reports collapse", () => {
  // Độ dài giảm từ 500 về 0 ký tự báo lỗi sụp đổ giao diện (collapsed)
  const { reasons } = compareToBaseline(
    verdict({ bodyTextLen: 0, bodyTextHash: "bbb", bodyTextPrefix: "" }),
    verdict(),
  );
  assert.match(reasons.join(";"), /desktop: body text collapsed \(500 -> 0 chars\)/);
});

/**
 * Làm gì: Kiểm tra khi baseline có độ dài 0 nhưng hiện tại có nội dung thì báo 'changed' qua nhánh hash chứ không phải 'collapse'.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("zero-length baseline reports growth via the hash branch, not collapse", () => {
  // Baseline dài 0 ký tự (baseLen = 0) nên điều kiện collapse bị bỏ qua, kích hoạt nhánh so sánh hash
  const { reasons } = compareToBaseline(
    verdict({ bodyTextLen: 500 }),
    verdict({ bodyTextLen: 0, bodyTextHash: "bbb", bodyTextPrefix: "" }),
  );
  assert.match(reasons.join(";"), /desktop: body text changed \(0 -> 500 chars/);
});

/**
 * Làm gì: Kiểm tra sai khác hash nhưng độ lệch độ dài không đáng kể và cùng đoạn mở đầu (prefix) thì được chấp nhận.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("hash mismatch with a trivial length delta and same page start is tolerated", () => {
  // Lệch 10 ký tự (500 -> 510) nằm trong ngưỡng dung sai và prefix giống nhau nên không báo lỗi
  const { divergesFromBaseline } = compareToBaseline(
    verdict({ bodyTextLen: 510, bodyTextHash: "bbb" }),
    verdict(),
  );
  assert.equal(divergesFromBaseline, false);
});

/**
 * Làm gì: Kiểm tra độ lệch độ dài nhỏ nhưng đoạn mở đầu trang (prefix) bị thay đổi thì vẫn bị đánh dấu là sai lệch.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("hash mismatch with a trivial length delta but changed page start diverges", () => {
  // Dù độ dài chỉ lệch 10 ký tự nhưng mở đầu trang thay đổi thành '500 Internal Error', chứng tỏ trang bị thay thế
  const { divergesFromBaseline, reasons } = compareToBaseline(
    verdict({ bodyTextLen: 510, bodyTextHash: "bbb", bodyTextPrefix: "500 Internal Error" }),
    verdict(),
  );
  assert.equal(divergesFromBaseline, true);
  assert.match(
    reasons.join(";"),
    /desktop: body text replaced \(similar length, page start changed\)/,
  );
});

/**
 * Làm gì: Kiểm tra bỏ qua so sánh prefix khi một trong hai bản verdict thiếu thông tin bodyTextPrefix.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("prefix check is skipped when either side lacks a prefix", () => {
  // Kiểm tra 3 trường hợp: cả 2 thiếu prefix, baseline thiếu prefix, hoặc current thiếu prefix
  const cases = [
    [{ bodyTextPrefix: undefined }, { bodyTextPrefix: undefined }],
    [{}, { bodyTextPrefix: undefined }],
    [{ bodyTextPrefix: undefined }, {}],
  ];
  for (const [curOverrides, baseOverrides] of cases) {
    const { divergesFromBaseline } = compareToBaseline(
      verdict({ bodyTextLen: 510, bodyTextHash: "bbb", ...curOverrides }),
      verdict(baseOverrides),
    );
    assert.equal(divergesFromBaseline, false);
  }
});

/**
 * Làm gì: Kiểm tra ranh giới dung sai tỷ lệ 10%: với baseline 500 ký tự, lệch đúng 50 ký tự được bỏ qua, 51 ký tự sẽ báo lệch.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("length-delta tolerance boundary: 50 tolerated, 51 diverges (500-char baseline)", () => {
  // Lệch đúng 50 ký tự (= 10% của 500 ký tự) nằm trong giới hạn dung sai TRIVIAL_LEN_RATIO
  const at = compareToBaseline(verdict({ bodyTextLen: 550, bodyTextHash: "bbb" }), verdict());
  assert.equal(at.divergesFromBaseline, false);

  // Lệch 51 ký tự (> 10% của 500 ký tự) vượt quá ngưỡng dung sai cho phép nên báo sai lệch
  const over = compareToBaseline(verdict({ bodyTextLen: 551, bodyTextHash: "bbb" }), verdict());
  assert.equal(over.divergesFromBaseline, true);
  assert.match(over.reasons.join(";"), /desktop: body text changed/);
});

/**
 * Làm gì: Kiểm tra ngưỡng sàn dung sai cố định (TRIVIAL_LEN_DELTA = 20 ký tự) áp dụng cho các trang có văn bản ngắn (100 ký tự).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("length-delta floor dominates small baselines: 20 tolerated, 21 diverges (100-char baseline)", () => {
  const base = verdict({ bodyTextLen: 100 }, { bodyTextLen: 100 });
  // Với baseline 100 ký tự, ngưỡng sàn 20 ký tự chiếm ưu thế hơn 10% (10 ký tự): lệch 20 ký tự vẫn được chấp nhận
  const at = compareToBaseline(
    verdict({ bodyTextLen: 120, bodyTextHash: "bbb" }, { bodyTextLen: 100 }),
    base,
  );
  assert.equal(at.divergesFromBaseline, false);

  // Lệch 21 ký tự vượt ngưỡng sàn tối thiểu 20 ký tự nên bị tính là sai lệch
  const over = compareToBaseline(
    verdict({ bodyTextLen: 121, bodyTextHash: "bbb" }, { bodyTextLen: 100 }),
    base,
  );
  assert.equal(over.divergesFromBaseline, true);
});

/**
 * Làm gì: Kiểm tra ranh giới sụp đổ nội dung: giảm đúng 50% chỉ báo 'changed', giảm dưới 50% sẽ báo 'collapsed'.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("collapse boundary: exactly half is 'changed', one below is 'collapsed'", () => {
  // Đúng 50% (250/500): điều kiện curLen < baseLen * 0.5 là sai, rơi vào nhánh thay đổi thông thường
  const half = compareToBaseline(verdict({ bodyTextLen: 250, bodyTextHash: "bbb" }), verdict());
  assert.match(half.reasons.join(";"), /desktop: body text changed \(500 -> 250 chars/);

  // Dưới 50% (249/500): thỏa mãn curLen < baseLen * 0.5, kích hoạt cảnh báo sụp đổ nghiêm trọng
  const below = compareToBaseline(verdict({ bodyTextLen: 249, bodyTextHash: "bbb" }), verdict());
  assert.match(below.reasons.join(";"), /desktop: body text collapsed \(500 -> 249 chars\)/);
});

/**
 * Làm gì: Kiểm tra khi baseline thiếu dữ liệu của một viewport (ví dụ thiếu mobile) thì báo lỗi thiếu baseline.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("missing baseline viewport diverges", () => {
  // Baseline chỉ có desktop, thiếu hẳn viewport mobile nên phải báo phân kỳ
  const { divergesFromBaseline, reasons } = compareToBaseline(verdict(), {
    viewports: { desktop: viewport() },
  });
  assert.equal(divergesFromBaseline, true);
  assert.match(reasons.join(";"), /mobile: no baseline data/);
});

/**
 * Làm gì: Kiểm tra baseline là đối tượng rỗng hoặc null sẽ báo lỗi thiếu dữ liệu cho tất cả các viewport.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("empty or null baseline diverges for every viewport", () => {
  // Duyệt qua cả hai trường hợp baseline rỗng {} và baseline là null
  for (const baseline of [{}, null]) {
    const { divergesFromBaseline, reasons } = compareToBaseline(verdict(), baseline);
    assert.equal(divergesFromBaseline, true);
    assert.match(reasons.join(";"), /desktop: no baseline data/);
    assert.match(reasons.join(";"), /mobile: no baseline data/);
  }
});

/**
 * Làm gì: Kiểm tra nguyên tắc fail-closed: nếu dữ liệu verdict hiện tại bị hỏng hoặc rỗng thì mặc định báo thất bại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("degenerate current verdict fails closed", () => {
  // Kiểm tra các trường hợp current rác (null, undefined, object rỗng) đều phải chặn lại an toàn
  for (const current of [null, undefined, {}, { viewports: {} }]) {
    const { divergesFromBaseline, reasons } = compareToBaseline(current, verdict());
    assert.equal(divergesFromBaseline, true);
    assert.deepEqual(reasons, ["current verdict has no viewport data"]);
  }
});

/**
 * Làm gì: Kiểm tra cơ chế tích lũy: nhiều lỗi trên các viewport khác nhau đều được gom đầy đủ vào mảng reasons.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("multiple signals across viewports all accumulate", () => {
  // Desktop lỗi HTTP status và Mobile lỗi console error: cả 2 lý do đều được thu thập đầy đủ
  const { reasons } = compareToBaseline(
    verdict({ status: 500 }, { consoleErrors: ["boom"] }),
    verdict(),
  );
  assert.match(reasons.join(";"), /desktop: HTTP status changed/);
  assert.match(reasons.join(";"), /mobile: console\/page errors appeared/);
  assert.equal(reasons.length, 2);
});

/**
 * Làm gì: Kiểm tra hàm baselineComparison giải mã chuỗi JSON baseline hợp lệ và so sánh thành công.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("baselineComparison round-trips a valid baseline", () => {
  // Chuỗi JSON hợp lệ được parse trơn tru và trả về kết quả không có sai lệch
  const { divergesFromBaseline } = baselineComparison(verdict(), JSON.stringify(verdict()));
  assert.equal(divergesFromBaseline, false);
});

/**
 * Làm gì: Kiểm tra baselineComparison xử lý an toàn (fail-closed) khi chuỗi JSON baseline sai cú pháp hoặc sai cấu trúc.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("baselineComparison fails closed on malformed or wrong-shape baselines", () => {
  // Bước 1: Kiểm tra các chuỗi không parse được JSON (báo lỗi invalid JSON)
  for (const raw of ["{", "", "not json"]) {
    const { divergesFromBaseline, reasons } = baselineComparison(verdict(), raw);
    assert.equal(divergesFromBaseline, true);
    assert.deepEqual(reasons, ["baseline unreadable: invalid JSON"]);
  }
  // Bước 2: Kiểm tra các chuỗi JSON parse thành công nhưng không đúng cấu trúc verdict hợp lệ
  for (const raw of [
    "null",
    "[]",
    "0",
    "false",
    '""',
    "{}",
    '{"viewports": null}',
    '{"viewports": []}',
  ]) {
    const { divergesFromBaseline, reasons } = baselineComparison(verdict(), raw);
    assert.equal(divergesFromBaseline, true);
    assert.deepEqual(reasons, ["baseline unreadable: not a verdict object"]);
  }
});

/**
 * Làm gì: Kiểm tra parseSmokeArgs gán đúng các giá trị mặc định khi không truyền cờ dòng lệnh và biến môi trường.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseSmokeArgs defaults", () => {
  // Giá trị mặc định: URL local port 8080, file ảnh preview và không có baseline
  assert.deepEqual(parseSmokeArgs([], {}), {
    url: "http://127.0.0.1:8080/",
    outPng: "/workspace/screenshots/app-builder-preview.png",
    baseline: "",
  });
});

/**
 * Làm gì: Kiểm tra parseSmokeArgs nhận diện cờ --baseline mà không làm xáo trộn thứ tự các tham số vị trí khác.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseSmokeArgs consumes --baseline without shifting positionals", () => {
  // Cờ --baseline nằm giữa mảng tham số không làm ảnh hưởng đến việc phân tích URL và đường dẫn ảnh xuất ra
  assert.deepEqual(
    parseSmokeArgs(
      ["http://127.0.0.1:8081/", "--baseline", "/workspace/a.json", "/workspace/b.png"],
      {},
    ),
    {
      url: "http://127.0.0.1:8081/",
      outPng: "/workspace/b.png",
      baseline: "/workspace/a.json",
    },
  );
});

/**
 * Làm gì: Kiểm tra parseSmokeArgs báo lỗi khi cờ --baseline được đặt ở cuối câu lệnh nhưng không có giá trị đường dẫn.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseSmokeArgs rejects a trailing --baseline flag", () => {
  // Bắt buộc phải có đường dẫn file JSON phía sau cờ --baseline
  assert.deepEqual(parseSmokeArgs(["--baseline"], {}), {
    error: "--baseline requires a path to a prior verdict JSON",
  });
});

/**
 * Làm gì: Kiểm tra parseSmokeArgs hỗ trợ cú pháp gộp cờ và giá trị dạng --baseline=<path> cũng như xử lý lỗi khi rỗng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseSmokeArgs supports the --baseline= form", () => {
  // Bước 1: Trích xuất chính xác đường dẫn từ cú pháp --baseline=<path>
  assert.equal(parseSmokeArgs(["--baseline=/workspace/a.json"], {}).baseline, "/workspace/a.json");
  // Bước 2: Báo lỗi nếu cú pháp --baseline= không chứa giá trị đường dẫn
  assert.deepEqual(parseSmokeArgs(["--baseline="], {}), {
    error: "--baseline requires a path to a prior verdict JSON",
  });
});

/**
 * Làm gì: Kiểm tra parseSmokeArgs từ chối các cờ không xác định (bắt đầu bằng --) thay vì nhầm tưởng là tham số vị trí.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseSmokeArgs rejects unknown flags instead of treating them as positionals", () => {
  // Báo lỗi khi gặp cờ lạ không được định nghĩa trước
  assert.deepEqual(parseSmokeArgs(["--nope"], {}), { error: "unknown flag: --nope" });
  // Phân biệt hoa thường: cờ --Baseline viết hoa chữ cái cũng bị từ chối
  assert.deepEqual(
    parseSmokeArgs(["http://127.0.0.1:8080/", "--Baseline", "/workspace/a.json"], {}),
    {
      error: "unknown flag: --Baseline",
    },
  );
});

/**
 * Làm gì: Kiểm tra độ ưu tiên: cờ dòng lệnh --baseline được ưu tiên hơn biến môi trường BROWSER_SMOKE_BASELINE.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("parseSmokeArgs env fallback and flag precedence", () => {
  const env = { BROWSER_SMOKE_BASELINE: "/workspace/env.json" };
  // Bước 1: Tự động dùng biến môi trường BROWSER_SMOKE_BASELINE nếu không truyền cờ dòng lệnh
  assert.equal(parseSmokeArgs([], env).baseline, "/workspace/env.json");
  // Bước 2: Cờ dòng lệnh ghi đè giá trị của biến môi trường khi cả hai cùng xuất hiện
  assert.equal(
    parseSmokeArgs(["--baseline", "/workspace/flag.json"], env).baseline,
    "/workspace/flag.json",
  );
});

/**
 * Làm gì: Kiểm tra hàm derivedPaths tự động suy luận đường dẫn ảnh mobile và file verdict JSON từ đường dẫn ảnh desktop.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("derivedPaths handles .png, .PNG, and extensionless inputs", () => {
  // Xử lý đúng cho đuôi mở rộng chữ thường .png, chữ hoa .PNG và trường hợp không có đuôi mở rộng
  assert.deepEqual(derivedPaths("/workspace/shot.png"), {
    mobilePng: "/workspace/shot-mobile.png",
    verdictJson: "/workspace/shot.json",
  });
  assert.deepEqual(derivedPaths("/workspace/shot.PNG"), {
    mobilePng: "/workspace/shot-mobile.png",
    verdictJson: "/workspace/shot.json",
  });
  assert.deepEqual(derivedPaths("/workspace/shot"), {
    mobilePng: "/workspace/shot-mobile.png",
    verdictJson: "/workspace/shot.json",
  });
});

/**
 * Làm gì: Kiểm tra hàm exitCodeFor trả về mã thoát 0 khi các viewport đều chạy sạch và không có lỗi.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("exitCodeFor: clean run exits 0", () => {
  // Trạng thái kiểm thử hoàn toàn sạch lỗi tương ứng với exit code 0 (thành công)
  assert.equal(exitCodeFor(verdict().viewports), 0);
});

/**
 * Làm gì: Kiểm tra exitCodeFor trả về mã thoát 2 khi có lỗi console hoặc page error trong bất kỳ viewport nào.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("exitCodeFor: errors in any single viewport exit 2", () => {
  // Lỗi runtime (console error hoặc page error) được quy ước trả về mã thoát 2
  assert.equal(exitCodeFor(verdict({}, { consoleErrors: ["boom"] }).viewports), 2);
  assert.equal(exitCodeFor(verdict({ pageErrors: ["boom"] }).viewports), 2);
});

/**
 * Làm gì: Kiểm tra lỗi điều hướng (HTTP status >= 400 hoặc 0) trả về mã thoát 1 và có độ ưu tiên cao hơn lỗi runtime.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("exitCodeFor: navigation failure in any viewport exits 1, beating errors", () => {
  // Bước 1: Lỗi điều hướng mạng hoặc lỗi HTTP (status 500, status 0) trả về mã thoát 1
  assert.equal(exitCodeFor(verdict({}, { status: 500 }).viewports), 1);
  assert.equal(exitCodeFor(verdict({ status: 0 }).viewports), 1);
  // Bước 2: Khi vừa có lỗi HTTP vừa có lỗi console thì mã thoát 1 được ưu tiên hơn mã thoát 2
  assert.equal(exitCodeFor(verdict({ status: 404 }, { consoleErrors: ["boom"] }).viewports), 1);
});

/**
 * Làm gì: Kiểm tra ranh giới HTTP status: mã 399 được coi là thành công (exit 0), từ 400 trở lên hoặc undefined là lỗi (exit 1).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("exitCodeFor: 4xx boundary and missing status", () => {
  // Mã 399 là mã thành công cao nhất (exit 0), mã 400 bắt đầu dải lỗi client (exit 1)
  assert.equal(exitCodeFor(verdict({ status: 399 }).viewports), 0);
  assert.equal(exitCodeFor(verdict({ status: 400 }).viewports), 1);
  assert.equal(exitCodeFor(verdict({ status: undefined }).viewports), 1);
});

/**
 * Làm gì: Kiểm tra khi viewports là đối tượng rỗng hoặc undefined thì exitCodeFor coi là thất bại và trả về mã thoát 1.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("exitCodeFor: no viewport data is a failure", () => {
  // Không có dữ liệu viewport nào trả về đồng nghĩa với việc không điều hướng được trang
  assert.equal(exitCodeFor({}), 1);
  assert.equal(exitCodeFor(undefined), 1);
});

/**
 * Làm gì: Kiểm tra tĩnh (static assertion) file scripts/browser-smoke.mjs đảm bảo tích hợp đầy đủ các hàm guard và verdict.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("browser-smoke wires the guard and verdict helpers", () => {
  // Bước 1: Đọc mã nguồn file scripts/browser-smoke.mjs để kiểm tra cấu trúc mã tĩnh
  const src = readFileSync(join(TEMPLATE_ROOT, "scripts/browser-smoke.mjs"), "utf8");
  // Bước 2: Xác nhận import đầy đủ các module bảo vệ browser-guard và browser-smoke-verdict
  assert.match(src, /from "\.\/browser-guard\.mjs"/);
  assert.match(src, /from "\.\/browser-smoke-verdict\.mjs"/);
  // Bước 3: Đảm bảo mọi đường dẫn URL, PNG, JSON và baseline đều được bọc qua các hàm kiểm tra an toàn
  assert.match(src, /const args = parseSmokeArgs\(process\.argv\.slice\(2\), process\.env\)/);
  assert.match(src, /const url = checkedUrl\(args\.url\)/);
  assert.match(src, /const outPng = checkedOutputPath\(args\.outPng, \["\/workspace"\]\)/);
  assert.match(src, /const mobilePng = checkedOutputPath\(derived\.mobilePng, \["\/workspace"\]\)/);
  assert.match(src, /const outJson = checkedOutputPath\(derived\.verdictJson, \["\/workspace"\]/);
  assert.match(src, /checkedOutputPath\(realpathSync\(args\.baseline\), \["\/workspace"\]/);
  assert.match(src, /baselinePath === outJson/);
  assert.match(src, /normalizedBodyTextHash\(/);
  assert.match(src, /bodyTextPrefix\(/);
  assert.match(src, /baselineComparison\(/);
  assert.match(src, /process\.exitCode = exitCodeFor\(viewports\)/);
  // Bước 4: Kiểm tra sự kiện tải trang dùng 'domcontentloaded' thay vì 'networkidle' (Vite HMR không bao giờ đạt networkidle)
  assert.match(src, /waitUntil: "domcontentloaded"/);
  assert.doesNotMatch(
    src,
    /waitUntil:\s*["']networkidle["']/,
    "Vite HMR never reaches networkidle",
  );
  // Bước 5: Đảm bảo trình duyệt luôn được đóng trong khối finally và không gọi process.exit ngắt ngang
  assert.match(src, /} finally \{\s*await browser\?\.close\(\);/s);
  assert.doesNotMatch(
    src.slice(src.indexOf("let browser = null")),
    /process\.exit\(/,
    "process.exit after Chromium launch skips finally teardown",
  );
});

/**
 * Làm gì: Kiểm tra tĩnh mã nguồn scripts/browser-smoke.mjs đảm bảo mọi thao tác đọc/ghi file chỉ thực hiện trên đường dẫn đã guard.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("browser-smoke file I/O only touches guarded paths", () => {
  // Bước 1: Đọc mã nguồn scripts/browser-smoke.mjs và cấm hardcode trực tiếp chuỗi đường dẫn trong các hàm I/O
  const src = readFileSync(join(TEMPLATE_ROOT, "scripts/browser-smoke.mjs"), "utf8");
  assert.doesNotMatch(src, /(?:writeFileSync|readFileSync|statSync|realpathSync)\(\s*["'`]/);
  // Bước 2: Kiểm tra các thao tác ghi file (writeFileSync) chỉ được phép ghi vào biến outJson đã guard
  const writes = [...src.matchAll(/writeFileSync\(\s*([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]);
  assert.equal(writes.length, 2);
  assert.ok(
    writes.every((v) => v === "outJson"),
    `unexpected writeFileSync target: ${writes}`,
  );
  // Bước 3: Kiểm tra các thao tác đọc file (readFileSync, statSync) chỉ được phép truy cập biến baselinePath đã guard
  const reads = [...src.matchAll(/readFileSync\(\s*([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]);
  assert.deepEqual(reads, ["baselinePath"]);
  const stats = [...src.matchAll(/statSync\(\s*([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]);
  assert.deepEqual(stats, ["baselinePath"]);
});
