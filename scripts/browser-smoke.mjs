#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { checkedOutputPath, checkedUrl } from "./browser-guard.mjs";
import { computeBrandWarnings } from "./brand-check.mjs";
import {
  authInvariantWarnings,
  buildAuthEnabled,
  compareAuthInvariant,
  probeDevAuthEnabled,
} from "./check-auth-invariant.mjs";
import {
  baselineComparison,
  bodyTextPrefix,
  derivedPaths,
  exitCodeFor,
  normalizeBodyText,
  normalizedBodyTextHash,
  parseSmokeArgs,
} from "./browser-smoke-verdict.mjs";

// Bước 1: Phân tích các đối số dòng lệnh và biến môi trường; dừng tiến trình ngay nếu có cờ không hợp lệ.
const args = parseSmokeArgs(process.argv.slice(2), process.env);
if (args.error) {
  console.error(JSON.stringify({ ok: false, error: args.error }, null, 2));
  process.exit(1);
}

// Bước 2: Kiểm tra an toàn cho URL (chỉ cho phép localhost/loopback) và các đường dẫn file ảnh, JSON đầu ra (bắt buộc nằm trong /workspace).
const url = checkedUrl(args.url);
const outPng = checkedOutputPath(args.outPng, ["/workspace"]);
// Tự động suy diễn đường dẫn file ảnh mobile (-mobile.png) và file JSON phán quyết (.json) từ đường dẫn ảnh desktop.
const derived = derivedPaths(outPng);
const mobilePng = checkedOutputPath(derived.mobilePng, ["/workspace"]);
const outJson = checkedOutputPath(derived.verdictJson, ["/workspace"], "verdict JSON");

// Giới hạn dung lượng tối đa 1 MB cho file baseline để tránh đọc file rác hoặc quá lớn gây nghẽn bộ nhớ.
const MAX_BASELINE_BYTES = 1024 * 1024;
const baselineRequested = Boolean(args.baseline);
let baselinePath = null;
let baselineResolveError = null;
// Bước 3: Phân giải đường dẫn thực tế của file baseline nếu người dùng yêu cầu so sánh qua cờ --baseline.
if (baselineRequested) {
  try {
    baselinePath = checkedOutputPath(realpathSync(args.baseline), ["/workspace"], "baseline");
  } catch (err) {
    baselineResolveError = err?.code ?? "unresolvable path";
  }
  // Ràng buộc an toàn: đường dẫn baseline không được trùng với file verdict JSON đầu ra để tránh tự ghi đè lên baseline.
  if (baselinePath === outJson) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error:
            `--baseline ${args.baseline} is this run's own verdict output; ` +
            "pass a distinct output PNG (e.g. app-builder-built.png) so the baseline is not overwritten",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

// Thời gian chờ tải trang (mặc định 45 giây) để xử lý các ứng dụng tải nhiều tài nguyên hoặc mạng nội bộ chậm.
const timeoutMs = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS || 45000);

// Danh sách hai kích thước màn hình cần kiểm thử: desktop (1280x800) và mobile chuẩn iPhone (390x844).
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, screenshot: outPng },
  { name: "mobile", width: 390, height: 844, screenshot: mobilePng },
];

// Đảm bảo thư mục cha chứa ảnh chụp màn hình tồn tại trước khi khởi chạy trình duyệt.
mkdirSync(dirname(outPng), { recursive: true });

/**
 * Làm gì: So sánh đối tượng phán quyết (verdict) hiện tại với file baseline JSON để phát hiện các sai lệch giao diện hoặc lỗi hồi quy.
 * Được gọi ở: scripts/browser-smoke.mjs (dòng 154, trong luồng kiểm thử chính khi cờ --baseline được bật).
 * - Tham số verdict: Đối tượng phán quyết chứa dữ liệu các viewports, cảnh báo thương hiệu và xác thực của lượt chạy này.
 * @returns {{divergesFromBaseline: boolean, reasons: string[]}} Kết quả so sánh gồm cờ sai lệch và danh sách các lý do khác biệt.
 */
function compareAgainstBaseline(verdict) {
  // Bước 1: Kiểm tra xem file baseline có đọc được không; nếu không phân giải được đường dẫn thì ghi nhận sai lệch.
  if (!baselinePath) {
    return {
      divergesFromBaseline: true,
      reasons: [`baseline unreadable: ${baselineResolveError ?? "unresolvable path"}`],
    };
  }
  try {
    // Bước 2: Kiểm tra dung lượng file baseline không vượt quá giới hạn an toàn 1 MB.
    if (statSync(baselinePath).size > MAX_BASELINE_BYTES) {
      return { divergesFromBaseline: true, reasons: ["baseline unreadable: too large"] };
    }
    // Bước 3: Đọc nội dung file baseline và gọi baselineComparison để so sánh chi tiết từng viewport.
    return baselineComparison(verdict, readFileSync(baselinePath, "utf8"));
  } catch (err) {
    // Bắt lỗi phát sinh khi đọc file (lỗi quyền truy cập, file bị xóa) và trả về thông báo lỗi thay vì làm dừng chương trình.
    return {
      divergesFromBaseline: true,
      reasons: [`baseline unreadable: ${err?.code ?? "read error"}`],
    };
  }
}

let browser = null;
// Bước 4: Khởi chạy Playwright Chromium headless và lần lượt kiểm thử từng cấu hình viewport.
try {
  // Chạy với cờ --no-sandbox và --disable-dev-shm-usage để tương thích tốt với môi trường container Linux / Docker.
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const viewports = {};
  // Bước 5: Lần lượt mở trang, chụp ảnh màn hình và kiểm tra lỗi trên từng viewport (desktop và mobile).
  for (const vp of VIEWPORTS) {
    // Khởi tạo danh sách lưu các lỗi console và lỗi runtime chưa được bắt trên trang.
    const errors = { consoleErrors: [], pageErrors: [] };
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
    });
    // Lắng nghe và gom các log console.error phát sinh từ mã nguồn phía client.
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.consoleErrors.push(msg.text());
    });
    // Lắng nghe các lỗi ngoại lệ chưa được xử lý (uncaught page exceptions) xảy ra trên trang.
    page.on("pageerror", (err) => errors.pageErrors.push(String(err?.message || err)));
    // `domcontentloaded`, not `networkidle`: Vite keeps an HMR websocket open, so
    // networkidle never settles and would burn the whole timeout.
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const status = resp?.status() ?? 0;
    // Chờ 1 giây sau khi tải xong HTML để JavaScript hoàn tất render, animation và gọi API ban đầu.
    await page.waitForTimeout(1000);

    // Thu thập thông tin kiểm thử: tiêu đề trang, kiểm tra sự tồn tại của thẻ canvas (ứng dụng đồ họa/game) và nội dung văn bản.
    const title = await page.title();
    const hasCanvas = (await page.locator("canvas").count()) > 0;
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    // Kiểm tra lỗi vỡ layout: cộng 1px dung sai tránh sai số làm tròn subpixel; nếu scrollWidth lớn hơn thì trang đang bị tràn ngang.
    const horizontalOverflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth > el.clientWidth + 1;
    });
    // Chụp ảnh màn hình viewport hiện tại để lưu bằng chứng kiểm thử trực quan.
    await page.screenshot({ path: vp.screenshot, fullPage: false });
    await page.close();

    // Lưu toàn bộ kết quả đo lường, mã băm nội dung và danh sách lỗi của viewport này vào đối tượng kết quả.
    viewports[vp.name] = {
      width: vp.width,
      height: vp.height,
      status,
      title,
      hasCanvas,
      bodyTextLen: normalizeBodyText(bodyText).length,
      bodyTextHash: normalizedBodyTextHash(bodyText),
      bodyTextPrefix: bodyTextPrefix(bodyText),
      horizontalOverflow,
      consoleErrors: errors.consoleErrors,
      pageErrors: errors.pageErrors,
      screenshot: vp.screenshot,
    };
  }

  // Bước 6: Kiểm tra các quy tắc tài nguyên thương hiệu (nếu có thẻ canvas thì bắt buộc phải có share card tùy chỉnh).
  const brandWarnings = computeBrandWarnings({ hasCanvas: viewports.desktop.hasCanvas });
  // Only a dev server answers /__app-env, so smoking the built output reads as
  // indeterminate — report a divergence, never the absence of an observation.
  const authWarnings = authInvariantWarnings(
    compareAuthInvariant({
      devAuthEnabled: await probeDevAuthEnabled(url),
      buildAuthEnabled: buildAuthEnabled(),
    }),
  );
  // Bước 7: Tổng hợp phán quyết cuối cùng (verdict) và so sánh với baseline nếu có yêu cầu.
  const verdict = { url, viewports, brandWarnings, authWarnings, verdictFile: outJson };
  if (baselineRequested) {
    const { divergesFromBaseline, reasons } = compareAgainstBaseline(verdict);
    verdict.divergesFromBaseline = divergesFromBaseline;
    verdict.baselineReasons = reasons;
  }

  // Bước 8: Ghi phán quyết ra file JSON và in ra console để các tác vụ gọi (agent/CI) thu nhận kết quả.
  writeFileSync(outJson, JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
  // Xuất toàn bộ cảnh báo thương hiệu và cảnh báo lệch cấu hình auth ra stderr để lập trình viên lưu ý.
  for (const w of [...brandWarnings, ...authWarnings]) console.error(w);
  // Set the code rather than aborting the process so the `finally` browser
  // teardown always runs (agents typically smoke twice per turn; leaking
  // Chromium accumulates across retries).
  process.exitCode = exitCodeFor(viewports);
} catch (err) {
  // Bước 9: Xử lý ngoại lệ nếu quá trình kiểm thử gặp sự cố nghiêm trọng (mất mạng, timeout, hoặc không thể khởi chạy browser).
  const failure = { ok: false, url, error: String(err?.message || err) };
  // Cố gắng ghi thông tin lỗi thất bại ra file verdict JSON để các công cụ gọi script có thể đọc được nguyên nhân.
  try {
    writeFileSync(outJson, JSON.stringify(failure, null, 2));
  } catch (writeErr) {
    failure.verdictWriteError = String(writeErr?.message || writeErr);
  }
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
} finally {
  // Bước 10: Dọn dẹp tài nguyên, luôn đảm bảo đóng trình duyệt Chromium để tránh rò rỉ tiến trình nền.
  await browser?.close();
}
