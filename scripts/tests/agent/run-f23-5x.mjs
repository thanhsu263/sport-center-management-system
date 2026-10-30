import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log("=== THỰC HIỆN XÁC MINH F-23 (5 LẦN LIÊN TIẾP VỚI SERVER SẠCH) ===");

let hitCount = 0;
const results = [];

for (let i = 1; i <= 5; i++) {
  console.log(`\n--- LẦN CHẠY ${i}/5 ---`);
  const proc = spawnSync(process.execPath, [join(ROOT, "scripts", "tests", "agent", "run-suite.mjs"), "repro-F23.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });

  const stdout = proc.stdout || "";
  const stderr = proc.stderr || "";

  // Tìm dòng JSON kết quả {"reproduced":...}
  const match = stdout.match(/\{"reproduced":\s*(true|false)[^\}]*\}/);
  let isHit = false;
  let rawJson = null;
  if (match) {
    try {
      rawJson = JSON.parse(match[0]);
      isHit = rawJson.reproduced === true;
    } catch {}
  }

  if (isHit) {
    hitCount++;
    console.log(`Kết quả lần ${i}: TÁI HIỆN THÀNH CÔNG (HIT) - status: ${rawJson?.delStatus}`);
  } else {
    console.log(`Kết quả lần ${i}: THẤT BẠI (MISSED)`);
    console.log("Stdout tail:", stdout.slice(-400));
    if (stderr) console.log("Stderr:", stderr.slice(-400));
  }

  results.push({ run: i, hit: isHit, detail: rawJson });
}

console.log(`\n=== TỔNG KẾT XÁC MINH F-23: ${hitCount}/5 lần TÁI HIỆN THÀNH CÔNG ===`);
