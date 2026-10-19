/** Last 9 digits of a VN mobile, or null if the input is not a number. */
export function phoneLast9(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("84")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return /^\d{9}$/.test(d) ? d : null;
}

export function normalizePhone(raw: string): string {
  const tail = phoneLast9(raw);
  if (tail) return `+84${tail}`;
  return raw.trim().replace(/[\s.-]/g, "");
}

export function isValidVnPhone(p: string): boolean {
  return /^\+84[3-9]\d{8}$/.test(normalizePhone(p));
}

export function unaccentVi(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function passwordOk(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}
