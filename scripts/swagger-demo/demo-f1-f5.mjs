// Demo trước hội đồng: mở Swagger UI trong Chrome có cửa sổ và chạy hai luồng ngoại lệ F1, F5 chậm cho người xem theo kịp.
// F1: đăng ký trùng số điện thoại → 409/422 BR-01.
// F5: quản lý tắt cờ F5 → HLV gọi gợi ý giáo án bị 403 → bật lại → gọi lại thành công.
// Biến môi trường: BASE (mặc định http://127.0.0.1:8080), SLOW (ms, mặc định 600), PAUSE (ms giữa các bước, mặc định 2500),
// HEADLESS=1 để chạy ẩn, OUT để lưu ảnh (mặc định thư mục tạm, không đè bằng chứng trong docs/).
import { ROLES, BASE } from "../tests/test-helper.mjs";
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = process.env.OUT ?? path.join(os.tmpdir(), "arena3-swagger-demo");
const PAUSE = Number(process.env.PAUSE ?? 2500);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADLESS === "1", slowMo: Number(process.env.SLOW ?? 600), args: ["--start-maximized"] });
const page = await (await browser.newContext({ viewport: null })).newPage();
await page.goto(BASE + "/swagger/index.html");
await page.waitForSelector(".opblock");
const op = (method, p) => page.locator(`.opblock-${method}`).filter({ has: page.locator(`.opblock-summary-path[data-path="${p}"]`) }).first();

async function run(method, p, body, title) {
  console.log(`\n▶ ${title}\n  ${method.toUpperCase()} ${p}`);
  const b = op(method, p);
  await b.scrollIntoViewIfNeeded();
  if (!(await b.getAttribute("class")).includes("is-open")) await b.locator(".opblock-summary").click();
  const tryBtn = b.locator("button.try-out__btn").first();
  if ((await tryBtn.count()) && /try it out/i.test(await tryBtn.innerText())) await tryBtn.click();
  if (body !== undefined) await b.locator("textarea.body-param__text").fill(JSON.stringify(body, null, 2));
  await b.locator("button.execute").click();
  const res = b.locator(".live-responses-table .response").first();
  await res.waitFor({ timeout: 90000 });
  await res.scrollIntoViewIfNeeded();
  const code = (await res.locator(".response-col_status").innerText()).trim().match(/^\d+/)?.[0] ?? "?";
  const text = await b.locator(".live-responses-table .response-col_description .microlight").first().innerText();
  let j = null; try { j = JSON.parse(text); } catch {}
  console.log(`  → HTTP ${code}${j?.code ? ` ${j.code}${j.br ? " " + j.br : ""}: ${j.message ?? ""}` : ""}`);
  await b.screenshot({ path: path.join(OUT, `${title.replace(/[^\w]+/g, "-")}-${code}.png`) });
  await page.waitForTimeout(PAUSE);
  const clear = b.locator("button.btn-clear"); if (await clear.count()) await clear.click();
  await b.locator(".opblock-summary").click();
  return j;
}
const authorize = (t) => page.evaluate((t) => { ui.authActions.logout(["bearerAuth"]); ui.authActions.authorize({ bearerAuth: { name: "bearerAuth", schema: { type: "http", scheme: "bearer" }, value: t } }); }, t);
const login = (role) => run("post", "/auth/login", { login: ROLES[role].phone, phone: ROLES[role].phone, password: ROLES[role].password }, `Đăng nhập ${role}`);

await run("post", "/auth/register", { full_name: "Nguyen Van Nam", phone: ROLES.member.phone, email: "", password: "Abcd1234", pii_consent: true, captcha_token: "valid" }, "F1 đăng ký trùng số điện thoại");

const m = await login("manager");
await authorize(m.token);
await run("patch", "/flags", { F5: false }, "F5 quản lý tắt cờ F5");
const c = await login("coach");
await authorize(c.token);
await run("post", "/training-plans/suggest", { sport: "badminton", level: "beginner", goal: "footwork" }, "F5 HLV gọi gợi ý khi cờ tắt");
await authorize(m.token);
await run("patch", "/flags", { F5: true }, "F5 quản lý bật lại cờ F5");
await authorize(c.token);
await run("post", "/training-plans/suggest", { sport: "badminton", level: "beginner", goal: "footwork" }, "F5 HLV gọi gợi ý khi cờ bật");

console.log(`\nẢnh lưu ở ${OUT}`);
if (process.env.HEADLESS !== "1") await page.waitForTimeout(PAUSE * 2);
await browser.close();
