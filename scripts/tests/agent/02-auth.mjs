/**
 * Sign-in, sign-up with OTP, password reset, lockout, sessions, own profile.
 *
 * Every account this suite locks or changes is one it registered itself, so
 * the seeded accounts the other suites rely on are never touched.
 *
 *   node scripts/tests/agent/02-auth.mjs
 */
import { PASS, PHONES, api, check, freshPhone, login, newMember, summary } from "../agent-lib.mjs";

const post = (path, body, token) => api(path, { method: "POST", body, token });
const yearsAgo = (y) => `${new Date().getUTCFullYear() - y}-01-15`;

/* ---------- Login ---------- */
{
  const r = await post("/auth/login", { login: PHONES.manager, password: PASS });
  check("AU-01", "manager signs in with 0xxx phone", r, {
    status: 200,
    test: (x) => x.data.token && x.data.expires_at && x.data.user?.role === "manager",
    why: "body has token, expires_at, user.role = manager",
  });
  check("AU-02", "login response never carries a password hash", r, {
    test: (x) => !JSON.stringify(x.data).includes("password_hash"),
    why: "no password_hash anywhere in the body",
  });
  check("AU-03", "sign in with +84 phone form", await post("/auth/login", { login: `+84${PHONES.manager.slice(1)}`, password: PASS }), {
    status: 200,
  });
  check("AU-04", "sign in with `phone` field instead of `login`", await post("/auth/login", { phone: PHONES.manager, password: PASS }), {
    status: 200,
  });
  const me = await api("/me", { token: r.data.token });
  const email = me.data?.user?.email;
  if (email) {
    check("AU-05", "sign in with email", await post("/auth/login", { login: email, password: PASS }), { status: 200 });
    check("AU-06", "email is case-insensitive (advisory)", await post("/auth/login", { login: email.toUpperCase(), password: PASS }), {
      status: 200,
      advisory: true,
      why: "people type their email with a capital letter; known finding F-08",
    });
  }
  check("AU-07", "no password → 422", await post("/auth/login", { login: PHONES.manager }), { status: 422, code: "VALIDATION" });
  check("AU-08", "no login → 422", await post("/auth/login", { password: PASS }), { status: 422, code: "VALIDATION" });
  check("AU-09", "unknown phone → 401", await post("/auth/login", { login: "0979999999", password: PASS }), {
    status: 401,
    code: "UNAUTHENTICATED",
  });
  check("AU-10", "body that is not JSON → 4xx, not 500", await api("/auth/login", { method: "POST", rawBody: "{not json" }), {
    status: [400, 422],
  });
  const unknownPhone = await post("/auth/login", { login: "0979999999", password: "Wrong1234a" });
  const wrongPw = await post("/auth/login", { login: PHONES.memberNoPlan, password: "Wrong1234a" });
  check("AU-11", "unknown phone and wrong password give the same status and message (no account probing)", wrongPw, {
    status: unknownPhone.status,
    test: (x) => x.data?.message === unknownPhone.data?.message,
    why: `same message for both: "${unknownPhone.data?.message}"`,
  });
}

/* ---------- Lockout (on a fresh account) ---------- */
{
  const m = await newMember();
  for (let i = 1; i <= 4; i += 1) {
    check(`LK-0${i}`, `wrong password #${i} → 401`, await post("/auth/login", { login: m.phone, password: "Wrong1234" }), {
      status: 401,
      code: "UNAUTHENTICATED",
    });
  }
  check("LK-05", "wrong password #5 → 429 locked", await post("/auth/login", { login: m.phone, password: "Wrong1234" }), {
    status: 429,
    code: "RATE_LIMITED",
  });
  check("LK-06", "right password while locked → still 429", await post("/auth/login", { login: m.phone, password: m.password }), {
    status: 429,
    code: "RATE_LIMITED",
  });
  check("LK-07", "a session opened before the lock is refused while locked", await api("/me", { token: m.token }), {
    status: 429,
  });
  const fg = await post("/auth/password/forgot", { phone: m.phone });
  check("LK-08", "forgot-password works for a locked account", fg, { status: 202, test: (x) => x.data.otp, why: "otp echoed" });
  const reset = await post("/auth/otp/verify", { phone: m.phone, otp: fg.data?.otp, purpose: "reset", password: "NewPass123" });
  check("LK-09", "reset clears the lock", reset, { status: 200 });
  check("LK-10", "login with the new password after reset → 200", await post("/auth/login", { login: m.phone, password: "NewPass123" }), {
    status: 200,
  });
  check("LK-11", "old password no longer works", await post("/auth/login", { login: m.phone, password: m.password }), { status: 401 });
}

/* ---------- Wrong password count resets after a good login ---------- */
{
  const m = await newMember();
  for (let i = 0; i < 3; i += 1) await post("/auth/login", { login: m.phone, password: "Wrong1234" });
  await post("/auth/login", { login: m.phone, password: m.password });
  for (let i = 0; i < 3; i += 1) await post("/auth/login", { login: m.phone, password: "Wrong1234" });
  check("LK-12", "3 bad + good + 3 bad does not lock (counter resets)", await post("/auth/login", { login: m.phone, password: m.password }), {
    status: 200,
  });
}

/* ---------- Register ---------- */
{
  const base = () => ({ full_name: "Reg Test", phone: freshPhone(), password: "Test1234a", pii_consent: true });
  const reg = (patch) => post("/auth/register", { ...base(), ...patch });
  check("RG-01", "no full_name → 422 field full_name", await reg({ full_name: undefined }), {
    status: 422,
    code: "VALIDATION",
    test: (x) => x.data.field === "full_name",
    why: "field = full_name",
  });
  check("RG-02", "phone 12345 → 422 field phone", await reg({ phone: "12345" }), {
    status: 422,
    test: (x) => x.data.field === "phone",
    why: "field = phone",
  });
  check("RG-03", "phone with +841 (not a mobile prefix) → 422", await reg({ phone: "+84120000001" }), { status: 422 });
  check("RG-04", "password 7 chars → BR-02", await reg({ password: "Abc1234" }), { status: 422, br: "BR-02" });
  check("RG-05", "password letters only → BR-02", await reg({ password: "abcdefghij" }), { status: 422, br: "BR-02" });
  check("RG-06", "password digits only → BR-02", await reg({ password: "1234567890" }), { status: 422, br: "BR-02" });
  check("RG-07", "pii_consent missing → BR-04", await reg({ pii_consent: undefined }), { status: 422, br: "BR-04" });
  check("RG-08", "pii_consent \"true\" (string) is not consent → BR-04", await reg({ pii_consent: "true" }), { status: 422, br: "BR-04" });
  check("RG-09", "minor (10 years old) without guardian → BR-03", await reg({ dob: yearsAgo(10) }), { status: 422, br: "BR-03" });
  check("RG-10", "minor with guardian → 202", await reg({ dob: yearsAgo(10), guardian_name: "Parent", guardian_phone: "0912345678" }), {
    status: 202,
  });
  check("RG-11", "adult (30) needs no guardian → 202", await reg({ dob: yearsAgo(30) }), { status: 202 });
  check("RG-12", "phone that already has an account → BR-01", await reg({ phone: PHONES.memberNoPlan }), { status: 422, br: "BR-01" });

  const phone = freshPhone();
  const ok = await post("/auth/register", { full_name: "Nguyễn Thử Nghiệm", phone, password: "Test1234a", pii_consent: true });
  check("RG-13", "valid sign-up → 202 with challenge_id (+ otp in test mode)", ok, {
    status: 202,
    test: (x) => x.data.challenge_id && /^\d{6}$/.test(String(x.data.otp)),
    why: "challenge_id present and otp is 6 digits",
  });
  check("RG-14", "wrong OTP → 422 field otp", await post("/auth/otp/verify", { phone, otp: "000000" === ok.data.otp ? "111111" : "000000" }), {
    status: 422,
    test: (x) => x.data.field === "otp",
    why: "field = otp",
  });
  check("RG-15", "verify with no otp → 422", await post("/auth/otp/verify", { phone }), { status: 422 });
  const v = await post("/auth/otp/verify", { phone, otp: ok.data.otp });
  check("RG-16", "right OTP → 200 with a member session", v, {
    status: 200,
    test: (x) => x.data.token && x.data.user?.role === "member" && x.data.user?.member_code,
    why: "token, role member, member_code set",
  });
  check("RG-17", "same OTP again → 422 (challenge used up)", await post("/auth/otp/verify", { phone, otp: ok.data.otp }), { status: 422 });
  check("RG-18", "register the same phone again → BR-01", await post("/auth/register", { ...base(), phone }), { status: 422, br: "BR-01" });
  check("RG-19", "new member can sign in", await post("/auth/login", { login: phone, password: "Test1234a" }), { status: 200 });
  const me = await api("/me", { token: v.data?.token });
  check("RG-20", "Vietnamese name kept exactly", me, {
    status: 200,
    test: (x) => x.data.user.full_name === "Nguyễn Thử Nghiệm",
    why: "full_name round-trips with diacritics",
  });

  // OTP brute force
  const p2 = freshPhone();
  const r2 = await post("/auth/register", { ...base(), phone: p2 });
  const wrong = r2.data.otp === "123456" ? "654321" : "123456";
  for (let i = 1; i <= 5; i += 1) await post("/auth/otp/verify", { phone: p2, otp: wrong });
  check("RG-21", "6th OTP try after 5 wrong → 429", await post("/auth/otp/verify", { phone: p2, otp: r2.data.otp }), {
    status: 429,
    code: "RATE_LIMITED",
  });

  // Email clash
  const mgr = await login(PHONES.manager);
  const mgrMe = await api("/me", { token: mgr.token });
  if (mgrMe.data?.user?.email) {
    check("RG-22", "email already used by someone → BR-01", await reg({ email: mgrMe.data.user.email }), { status: 422, br: "BR-01" });
  }
  check("RG-23", "very long full_name (500 chars) → 4xx, not 500", await reg({ full_name: "A".repeat(500) }), {
    notStatus: [500],
  });
}

/* ---------- Forgot password ---------- */
{
  check("FG-01", "forgot with invalid phone → 422", await post("/auth/password/forgot", { phone: "abc" }), { status: 422 });
  const unknown = await post("/auth/password/forgot", { phone: "0979999998" });
  check("FG-02", "forgot for a phone with no account → 202, no otp", unknown, {
    status: 202,
    test: (x) => x.data.otp === undefined,
    why: "no otp for an unknown phone",
  });
  const m = await newMember();
  const known = await post("/auth/password/forgot", { phone: m.phone });
  check("FG-03", "forgot for a real account → 202 (+ otp in test mode)", known, { status: 202, test: (x) => x.data.otp, why: "otp echoed" });
  check("FG-04", "reset with weak new password → BR-02", await post("/auth/otp/verify", { phone: m.phone, otp: known.data.otp, purpose: "reset", password: "short" }), {
    status: 422,
    br: "BR-02",
  });
  check("FG-05", "reset with good password → 200", await post("/auth/otp/verify", { phone: m.phone, otp: known.data.otp, purpose: "reset", password: "Reset1234" }), {
    status: 200,
  });
  check("FG-06", "sign in with the reset password", await post("/auth/login", { login: m.phone, password: "Reset1234" }), { status: 200 });
  check("FG-07", "a reset OTP cannot be used as a register OTP", await post("/auth/otp/verify", { phone: m.phone, otp: known.data.otp, purpose: "register" }), {
    status: [422, 429],
  });
  check(
    "FG-08",
    "sessions opened before a password reset are ended",
    await api("/me", { token: m.token }),
    { status: 401, advisory: true },
  );
}

/* ---------- Session ---------- */
{
  const s = await login(PHONES.memberNoPlan);
  check("SS-01", "GET /me with token → user, subscriptions[], inbox[]", await api("/me", { token: s.token }), {
    status: 200,
    test: (x) => x.data.user && Array.isArray(x.data.subscriptions) && Array.isArray(x.data.inbox),
    why: "user + subscriptions[] + inbox[]",
  });
  check("SS-02", "made-up token → 401", await api("/me", { token: "not-a-real-token" }), { status: 401 });
  check("SS-03", "token without 'Bearer ' → 401", await api("/me", { headers: { authorization: s.token } }), { status: 401 });
  check("SS-04", "'bearer' in lower case is accepted", await api("/me", { headers: { authorization: `bearer ${s.token}` } }), { status: 200 });
  check("SS-05", "token with one char changed → 401", await api("/me", { token: `${s.token.slice(0, -1)}${s.token.endsWith("a") ? "b" : "a"}` }), {
    status: 401,
  });
  const s2 = await login(PHONES.memberNoPlan);
  check("SS-06", "logout → 204", await post("/auth/logout", undefined, s2.token), { status: 204 });
  check("SS-07", "token after logout → 401", await api("/me", { token: s2.token }), { status: 401 });
  check("SS-08", "logout ends only that session (the other one still works)", await api("/me", { token: s.token }), { status: 200 });
}

/* ---------- Own profile ---------- */
{
  const m = await newMember();
  const patch = (body) => api("/me", { method: "PATCH", token: m.token, body });
  check("PF-01", "change phone through PATCH /me → 422", await patch({ phone: "0912345679" }), { status: 422 });
  check("PF-02", "change email through PATCH /me → 422", await patch({ email: "x@example.com" }), { status: 422 });
  check("PF-03", "rename → 200 and saved", await patch({ full_name: "Đổi Tên" }), {
    status: 200,
    test: (x) => x.data.user?.full_name === "Đổi Tên",
    why: "user.full_name = Đổi Tên",
  });
  check("PF-04", "health notes saved", await patch({ health_notes: "Hen suyễn nhẹ" }), {
    status: 200,
    test: (x) => x.data.user?.health_notes === "Hen suyễn nhẹ",
    why: "health_notes saved",
  });
  check("PF-05", "full_name 300 chars → 400, not 500", await patch({ full_name: "B".repeat(300) }), { status: [400, 422] });
  check("PF-06", "PATCH /me {role: manager} is ignored or refused, never 500", await patch({ role: "manager" }), {
    notStatus: 500,
    test: (x) => x.status !== 200 || x.data?.user?.role !== "manager",
    why: "the response must not show role manager",
  });
  const after = await api("/me", { token: m.token });
  check("PF-07", "role is still member after PATCH {role: manager}", after, {
    status: 200,
    test: (x) => x.data.user.role === "member",
    why: "role unchanged",
  });
  // 10 profile edits per 5 minutes; PF-03..PF-06 used up to 4 (a rejected 500 may not count).
  let last;
  for (let i = 0; i < 12; i += 1) last = await patch({ full_name: `Limit ${i}` });
  check("PF-08", "more than 10 profile edits in 5 minutes → 429", last, { status: 429, code: "RATE_LIMITED" });
}

/* ---------- Change password ---------- */
{
  const m = await newMember();
  const other = await login(m.phone, m.password);
  const pw = (body) => post("/me/password", body, m.token);
  check("PW-01", "missing fields → 422", await pw({}), { status: 422 });
  check("PW-02", "confirm does not match → 422 field confirm_password", await pw({ current_password: m.password, new_password: "Next1234a", confirm_password: "Other1234" }), {
    status: 422,
    test: (x) => x.data.field === "confirm_password",
    why: "field = confirm_password",
  });
  check("PW-03", "weak new password → 422 field new_password", await pw({ current_password: m.password, new_password: "weak" }), {
    status: 422,
    test: (x) => x.data.field === "new_password",
    why: "field = new_password",
  });
  check("PW-04", "new = current → 422", await pw({ current_password: m.password, new_password: m.password }), { status: 422 });
  check("PW-05", "wrong current password → 422 field current_password", await pw({ current_password: "Wrong1234", new_password: "Next1234a" }), {
    status: 422,
    test: (x) => x.data.field === "current_password",
    why: "field = current_password",
  });
  check("PW-06", "valid change → 200", await pw({ current_password: m.password, new_password: "Next1234a", confirm_password: "Next1234a" }), {
    status: 200,
  });
  check("PW-07", "sign in with the new password", await post("/auth/login", { login: m.phone, password: "Next1234a" }), { status: 200 });
  check("PW-08", "old password refused", await post("/auth/login", { login: m.phone, password: m.password }), { status: 401 });
  check("PW-09", "other open sessions are ended after a password change", await api("/me", { token: other.token }), {
    status: 401,
    advisory: true,
  });
  // 5 per 15 minutes. PW-03..PW-06 counted 4 of them.
  await pw({ current_password: "Next1234a", new_password: "weak" });
  check("PW-10", "6th password change attempt in 15 minutes → 429", await pw({ current_password: "Next1234a", new_password: "weak" }), {
    status: 429,
  });
}

summary();
