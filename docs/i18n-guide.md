# Arena3 EN/VI translation guide (for whoever converts a file)

The app ships in English and Vietnamese with a header toggle. English is the source text.

## Mechanics (read `src/lib/i18n.tsx` first, 100 lines)

- `import { t, tk, locale } from "@/lib/i18n";`
- Every user-visible English string becomes `t("English text")`. JSX text becomes `{t("English text")}`.
  Attributes too: `aria-label={t("Close")}`, `placeholder={t("Name, phone or member code")}`, `title=…`, `alt=…`, toast messages, confirm() text, empty-state titles/hints, button labels, table headings.
- The English string is the dictionary key, **a plain string literal** (double quotes, no template literal, no concatenation, no variable) so `scripts/i18n-check.mjs` can find it.
- Variables: `t("{n} seats left", { n })`. One placeholder name per value. Never build a sentence by gluing translated fragments — translate the whole sentence with placeholders (word order differs in Vietnamese).
- Plurals: Vietnamese has none. Where English switches on a count write both whole sentences: `n === 1 ? t("1 seat left") : t("{n} seats left", { n })`; both need an entry (the Vietnamese can be identical in shape).
- `t()` runs at render time. **Never call `t()` at module scope** (a constant array of nav items, a label table) — the language would be frozen at import. For module-scope constants write the English with `tk("Courts")` (identity, only marks it for the checker) and call `t(item.label)` where it is drawn.
- Dates and numbers: replace hard-coded `"en-GB"` / `"en-US"` / `"en-CA"` locales used for *display* with `locale()` (returns `vi-VN` or `en-GB`) — but keep `en-CA` (it is used to produce `YYYY-MM-DD` keys) and any `timeZone` option untouched. Money stays `12,000đ` style via the existing helpers unless the helper is in your file.
- Do NOT translate: brand "Arena3", phone/ID/codes, sport proper names are fine to translate via labels (see below), anything that comes from the database (member names, class names, plan names) or enum codes used in logic, CSS classes, route paths, API paths, console messages, code comments.
- Keep the English wording exactly as it is today (it is the key). If you must fix an English typo, fix it in the code and use the fixed text.
- Do not change layout, styling, logic or behaviour. This is a text-only pass. Vietnamese is usually ~10–25% longer: if you see a fixed-width or `truncate` container that will obviously clip, loosen it (`min-w-0`, `text-balance`, wrap) rather than shortening the Vietnamese.

## Dictionary files

Add entries to **your own** dictionary file only (given in your task): `src/lib/i18n/vi.<area>.ts`, shape:

```ts
export const desk: Record<string, string> = {
  "Open shift": "Mở ca",
  "{n} seats left": "Còn {n} chỗ",
};
```

Keys exactly equal the English literal inside `t()`. Same placeholders in the value. One entry per line (the checker reads `"key": "value"` at line starts). Sort roughly by file. Use double quotes and escape inner quotes with `\"`.

## Vietnamese style

Natural, short, friendly, written for a sports-centre customer or front-desk staff — not machine-literal. Address the user as "bạn" (members) and neutral imperative for staff screens. Keep button labels short (verb first: "Mở ca", "Thu tiền", "Lưu").

Glossary (use these consistently):

| English | Vietnamese |
|---|---|
| Court / courts | Sân |
| Member / members | Hội viên |
| Front desk / Reception(ist) | Lễ tân |
| Manager | Quản lý |
| Coach | Huấn luyện viên (short: HLV) |
| Plan / membership plan | Gói tập |
| Class / classes | Lớp |
| Booking / book | Đặt sân / đặt |
| Attendance | Điểm danh (page title "Điểm danh") |
| Check in / gate | Vào cổng / Cổng |
| Check-in pass | Mã vào cổng |
| Receipt(s) | Biên lai |
| Payment(s) | Thanh toán |
| Refund | Hoàn tiền |
| Transfer to check | Chuyển khoản cần đối soát |
| Shift (cash shift) | Ca (ca thu ngân) |
| Gear / loan | Dụng cụ / cho mượn |
| Promo code | Mã khuyến mãi |
| Pricing / prices | Bảng giá |
| Peak / Off-peak | Giờ cao điểm / Giờ thường |
| Waitlist | Danh sách chờ |
| Enrol | Đăng ký |
| Progress / Level | Tiến độ / Trình độ |
| Homework | Bài tập về nhà |
| Audit log / Activity | Nhật ký thao tác |
| At risk | Sắp rời bỏ |
| Staff | Nhân viên |
| Settings | Cài đặt |
| Reports | Báo cáo |
| Notifications | Thông báo |
| Sign in / Log in | Đăng nhập |
| Sign out | Đăng xuất |
| Save / Cancel / Close / Back / Next / Done | Lưu / Hủy / Đóng / Quay lại / Tiếp / Xong |
| Badminton / Basketball / Volleyball | Cầu lông / Bóng rổ / Bóng chuyền |
| Beginner / Intermediate / Advanced | Cơ bản / Trung bình / Nâng cao |
| Weekday / Weekend / Holiday | Ngày thường / Cuối tuần / Ngày lễ |
| Paid / Unpaid / Pending | Đã thanh toán / Chưa thanh toán / Đang chờ |
| Active / Expired / Frozen | Đang hiệu lực / Hết hạn / Tạm khóa |
| Present / Late / Absent / Excused | Có mặt / Đến muộn / Vắng / Có phép |

Money amounts keep the "đ" / "₫" suffix. Times are 24-hour.

## Done means

1. `npx tsc --noEmit` is clean.
2. `node scripts/i18n-check.mjs` reports **no MISSING keys from your files** (other people's files may show missing until they finish — filter by your paths).
3. Grep your files for leftover user-visible English (JSX text between tags, string attributes, toast calls) and convert them.
4. Do not touch files outside your list. Do not run the dev server restart, build, git commit or push. Do not delete anything.
