import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loginApi, ROLES, BASE } from "../tests/test-helper.mjs";
const routes = JSON.parse(fs.readFileSync(new URL("./routes.json", import.meta.url), "utf8"));
const BODY = JSON.parse(fs.readFileSync(new URL("./bodies.json", import.meta.url), "utf8"));
const tk = {}; const login = async (r) => (tk[r] = (await loginApi(ROLES[r].phone, ROLES[r].password)).token);
for (const r of ["manager", "receptionist", "coach", "member"]) await login(r);
const call = async (method, p, role, body) => {
  const h = { "content-type": "application/json", "idempotency-key": crypto.randomUUID() };
  if (role) h.authorization = "Bearer " + tk[role];
  const res = await fetch(BASE + "/v1" + p, { method, headers: h, body: method === "GET" || method === "DELETE" && !body ? undefined : JSON.stringify(body ?? {}) , signal: AbortSignal.timeout(60000) }).catch((e) => ({ status: 0, text: async () => String(e), headers: new Map() }));
  const ct = res.headers.get?.("content-type") || "";
  let t = await res.text().catch(() => "");
  if (!/json|text\/plain/.test(ct) && t.length > 300) t = `[${ct}, ${t.length} bytes]`;
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, text: t, json: j };
};
const ids = {};
const first = async (role, p, pick) => { const r = await call("GET", p, role); try { return pick(r.json); } catch { return null; } };
ids.member = (await call("GET", "/me", "member")).json.user.id;
ids.classes = await first("coach", "/coach/classes", (j) => j.items[0].id);
ids.session = await first("coach", "/coach/schedule", (j) => j.items[0].id);
ids.court = await first("manager", "/courts", (j) => j.items[0].id);
ids.badCourt = await first("manager", "/courts", (j) => j.items.find((c) => c.sport === "badminton").id);
ids.coachUser = (await call("GET", "/me", "coach")).json.user.id;
ids.staff = await first("manager", "/staff", (j) => j.items.find((s) => s.role === "coach" && s.id !== ids.coachUser).id);
ids.memberCode = (await call("GET", "/me", "member")).json.user.member_code;
ids.equipment = await first("manager", "/equipment", (j) => (j.items || j.equipment)[0].id);
ids.promoCode = await first("manager", "/promotions", (j) => j.items[0].code);
const pr = (await call("GET", "/price-rules", "manager")).json; ids.priceItems = (pr?.items || pr?.rules || []).map(({court_id, sport, day_kind, start_local, end_local, is_peak, price_vnd}) => ({court_id, sport, day_kind, start_local, end_local, is_peak, price_vnd}));
ids.coach = (await first("manager", "/commission", (j) => j.items[0].coach_id));
ids.workorder = await first("manager", "/work-orders", (j) => j.items[0].id);
ids.promo = await first("manager", "/promotions", (j) => j.items[0].id);
ids.ticket = await first("manager", "/tickets", (j) => j.items[0].id);
ids.loan = await first("manager", "/equipment/loans", (j) => j.items[0].id);
ids.homework = await first("member", "/me/homework", (j) => j.items[0].id);
ids.payment = await first("manager", "/payments/pending", (j) => j.receipts[0].id);
ids.plan = await first("manager", "/plans", (j) => j.items[1].id);
ids.sport = "pickleball";
ids.asset = await first("manager", "/manager/site-assets", (j) => j.items[0].slot);
ids.enrollment = await first("member", "/me/certificates", (j) => j.items[0].enrollment_id);
ids.mbooking = await first("member", "/me/bookings", (j) => (j.bookings || j.items || j.court_bookings || []).find((b) => b.id)?.id);
ids.booking = ids.mbooking;
const studentId = await first("manager", "/reports/attendance", (j) => j.students[0].user_id);
ids.student = studentId;
const att = (await call("GET", "/sessions/" + ids.session + "/attendance", "coach")).json;
const roster = (att?.items || att?.students || att?.roster || []).map((x) => x.user_id).filter(Boolean);
ids.attItems = roster.map((u) => ({ user_id: u, result: "present" }));
ids.resItems = roster.map((u) => ({ user_id: u, plan_pct: 80, note: "Hoàn thành tốt", metrics: {} }));
const fill = (v) => typeof v === "string" && v.startsWith("$") ? (v === "$uuid" ? crypto.randomUUID() : v === "$pass" ? ROLES.member.password : ids[v.slice(1)]) : Array.isArray(v) ? v.map(fill) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : typeof v === "string" ? v.replace(/$(w+)/g, (m, k) => ids[k] ?? m) : v;
const sub = (p) => p.replace(/\{p\d\}(\.\w+)?/g, (m, ext, off, s) => {
  const before = s.slice(0, off).split("/").filter(Boolean);
  const k = before.slice(-1)[0] === "rates" || before.slice(-1)[0] === "pay" ? "coach" : before.slice(-1)[0];
  const map = { users: ids.member, coaches: ids.coach, certifications: ids.cert, courts: ids.court, staff: ids.staff, members: ids.member, plans: ids.plan, bookings: ids.booking, shifts: ids.shift, classes: ids.classes, sessions: ids.session, enrollments: ids.enrollment, online: ids.onlinePay, payments: ids.payment, series: ids.series, coach: ids.coach, "work-orders": ids.workorder, invoices: ids.invoice, reports: "revenue", subscriptions: ids.subscription, waitlist: ids.waitlist, loans: ids.loan, "training-plans": ids.tplan, students: ids.student, homework: ids.homework, promotions: ids.promo, tickets: ids.ticket, "site-assets": ids.asset, sports: ids.sport, conversations: ids.conv, certificates: ids.certPublic, me: ids.certTemplate };
  return (map[k] ?? "00000000-0000-0000-0000-000000000000") + (ext || "");
});
const hint = (p) => p.startsWith("/me") || p.startsWith("/tickets/mine") || p === "/subscriptions" || p.startsWith("/assistant") ? ["member", "coach", "receptionist", "manager"]
  : p.startsWith("/coach") || p.startsWith("/training-plans") || p.startsWith("/students") || p.startsWith("/homework") || /sessions\/\{p1\}\/(attendance|results)/.test(p) ? ["coach", "manager", "receptionist", "member"]
  : p.startsWith("/desk") || p.startsWith("/shifts") || p.startsWith("/walk-in") || p.startsWith("/payments") || p.startsWith("/bookings") ? ["receptionist", "manager", "coach", "member"]
  : ["manager", "receptionist", "coach", "member"];
const EARLY = ["POST /shifts/open", "POST /training-plans/suggest"];
const SKIP_LATE = ["POST /shifts/{p1}/close", "POST /auth/logout", "POST /me/sessions/sign-out-others", "POST /me/password"];
const order = [...routes.filter((r) => EARLY.includes(r.method + " " + r.path)), ...routes.filter((r) => !SKIP_LATE.includes(r.method + " " + r.path) && !EARLY.includes(r.method + " " + r.path)), ...routes.filter((r) => SKIP_LATE.includes(r.method + " " + r.path))];
import { createBrowser } from "../tests/test-helper.mjs";
import { chromium } from "playwright";
// HEADED=1: mở Chrome có cửa sổ; SLOW=ms: chậm mỗi thao tác; LIMIT=n: chỉ chạy n API đầu; OUT=thư mục ảnh khác (không ghi đè bằng chứng)
const HEADED = process.env.HEADED === "1";
const SLOW = Number(process.env.SLOW ?? (HEADED ? 400 : 0));
const LIMIT = Number(process.env.LIMIT ?? Infinity);
const OUT = process.env.OUT ?? fileURLToPath(new URL("../../docs/testing/swagger-evidence/all-api", import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const prevRole = JSON.parse(fs.readFileSync(new URL("./roles.json", import.meta.url), "utf8"));
const browser = HEADED ? await chromium.launch({ channel: "chrome", headless: false, slowMo: SLOW, args: ["--start-maximized"] }) : await createBrowser();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
await page.goto(BASE + "/swagger/index.html");
await page.waitForSelector(".opblock");
let cur = null;
const auth = async (t) => { if (t === cur) return; cur = t; await page.evaluate((t) => { ui.authActions.logout(["bearerAuth"]); if (t) ui.authActions.authorize({ bearerAuth: { name: "bearerAuth", schema: { type: "http", scheme: "bearer" }, value: t } }); }, t); };
const results = []; let i = 0;
for (const r of order) {
  if (i >= LIMIT) break;
  i++;
  const key = r.method + " " + r.path;
  const sp = r.path.replace(/\{p\d\}/g, "{id}");
  const slug = String(i).padStart(3, "0") + "-" + r.method + sp.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-$/, "");
  let url = sub(r.path);
  if ((key.startsWith("POST /members/{p1}") || key === "PATCH /members/{p1}") && !key.includes("points")) url = url.replace(ids.member, ids.student);
  const segs = r.path.split("/"), us = url.split("/"); let idVal = null;
  segs.forEach((s, k) => { if (/\{p\d\}/.test(s)) idVal = us[k].replace(/\.(xml|pdf)$/, ""); });
  const q = new URLSearchParams(fill(BODY[key]?.query ?? "").replace(/^\?/, ""));
  const body = fill(BODY[key]?.body);
  let role = r.kind === "public" ? "public" : (BODY[key]?.role || prevRole[key] || "manager");
  if (key === "POST /auth/logout") { await login("member2"); role = "member2"; }
  const b = page.locator(`.opblock-${r.method.toLowerCase()}`).filter({ has: page.locator(`.opblock-summary-path[data-path="${sp}"]`) }).first();
  if (key === "GET /live") { await b.scrollIntoViewIfNeeded(); await b.locator(".opblock-summary").click(); await page.waitForTimeout(300); await b.screenshot({ path: `${OUT}/${slug}-SSE.png` }); await b.locator(".opblock-summary").click(); results.push({ i, key, role: "public", status: "SSE", text: "Event stream stays open; not executed.", shot: `${slug}-SSE.png` }); continue; }
  await auth(role === "public" ? null : tk[role]);
  await b.scrollIntoViewIfNeeded();
  if (!(await b.getAttribute("class")).includes("is-open")) await b.locator(".opblock-summary").click();
  if (idVal) await b.locator('tr[data-param-name="id"] input').fill(idVal);
  for (const [k, v] of q) await b.locator(`tr[data-param-name="${k}"] input`).fill(v);
  const ta = b.locator("textarea.body-param__text");
  if (await ta.count()) await ta.fill(JSON.stringify(body ?? {}, null, 2));
  await b.locator("button.execute").click();
  let code = "0", text = "";
  try {
    const res = b.locator(".live-responses-table .response").first();
    await res.waitFor({ timeout: 90000 }); await page.waitForTimeout(350);
    code = (await res.locator(".response-col_status").innerText()).trim().match(/^[0-9]+/)?.[0] ?? "?";
    text = (await res.locator(".response-col_description").innerText()).trim();
  } catch (e) { text = "timeout: " + e.message.slice(0, 80); }
  let j = null; try { const bt = await b.locator(".live-responses-table .response-col_description .microlight").first().innerText({ timeout: 3000 }); j = JSON.parse(bt); } catch {}
  const secret = /reset-password|\/auth\/(login|google)|sign-out|password/.test(key);
  const mask = [b.locator(".curl-command"), b.locator(".request-url")];
  if (secret) mask.push(b.locator(".live-responses-table .microlight"));
  const shot = `${slug}-${code}.png`;
  await b.screenshot({ path: `${OUT}/${shot}`, mask });
  const nid = j && (j.id || j.item?.id || j.booking?.id || j.payment?.id || j.plan?.id || j.ticket?.id || j.shift?.id || j.subscription?.id || j.conversation?.id || j.series?.id || j.court?.id || j.promotion?.id || j.work_order?.id);
  const set = { "POST /bookings": "booking", "POST /shifts/open": "shift", "POST /payments": "payment", "POST /series": "series", "POST /tickets": "ticket", "POST /training-plans": "tplan", "POST /subscriptions": "subscription", "POST /conversations": "conv", "POST /payments/online": "onlinePay", "POST /work-orders": "workorder", "POST /promotions": "promo", "POST /staff": "staff", "POST /coaches/{p1}/certifications": "cert", "POST /manager/courts": "court2" };
  if (set[key] && nid) ids[set[key]] = nid;
  if (key === "POST /training-plans/suggest" && j?.payload) ids.suggestPayload = j.payload;
  const brief = (j ? JSON.stringify(j) : text).replace(/\s+/g, " ").replace(/"(phone|temp_password|token|email)":"[^"]*"/g, '"$1":"…"').slice(0, 200);
  results.push({ i, key, role, status: code, text: brief, shot });
  process.stdout.write(`${code} ${key} [${role}] ${brief.slice(0, 120)}\n`);
  const clear = b.locator("button.btn-clear"); if (await clear.count()) await clear.click();
  await b.locator(".opblock-summary").click();
}
fs.writeFileSync(process.env.OUT ? OUT + "/swresults.json" : new URL("./swresults.json", import.meta.url), JSON.stringify({ results }, null, 1));
await browser.close();
