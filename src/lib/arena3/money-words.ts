/**
 * Read a VND amount out in Vietnamese words.
 *
 * A Vietnamese invoice is not complete without "số tiền bằng chữ": the figure
 * spelled out is what settles a dispute when the digits are smudged, altered
 * or misread, so it is a required field rather than a courtesy.
 *
 * The rules that are easy to get wrong, and that the tests pin down:
 *   - 1 after a tens digit of 2..9 is "mốt", not "một"  (21 → hai mươi mốt)
 *   - 5 after any tens digit is "lăm", not "năm"        (15 → mười lăm)
 *   - a tens digit of 1 is "mười", not "một mươi"       (15 → mười lăm)
 *   - a zero in the tens column is spoken as "linh"     (105 → một trăm linh năm)
 *   - an interior group with no hundreds still says "không trăm"
 *     (1_005 → một nghìn không trăm linh năm), because dropping it would read
 *     back as 1_050.
 */

const DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

/** Group scales, smallest first. An INT column tops out inside "tỷ". */
const SCALES = ["", "nghìn", "triệu", "tỷ", "nghìn tỷ", "triệu tỷ"];

/**
 * Spell one 3-digit group.
 *
 * `withLeadingHundreds` is set for every group except the most significant
 * one, where "không trăm" would be noise rather than a place-holder.
 */
function readGroup(n: number, withLeadingHundreds: boolean): string {
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const units = n % 10;
  const out: string[] = [];

  if (hundreds > 0) {
    out.push(DIGITS[hundreds]!, "trăm");
  } else if (withLeadingHundreds && (tens > 0 || units > 0)) {
    out.push("không", "trăm");
  }

  if (tens > 1) {
    out.push(DIGITS[tens]!, "mươi");
    if (units === 1) out.push("mốt");
    else if (units === 5) out.push("lăm");
    else if (units > 0) out.push(DIGITS[units]!);
  } else if (tens === 1) {
    out.push("mười");
    if (units === 5) out.push("lăm");
    else if (units > 0) out.push(DIGITS[units]!);
  } else if (units > 0) {
    if (hundreds > 0 || withLeadingHundreds) out.push("linh");
    out.push(DIGITS[units]!);
  }

  return out.join(" ");
}

/** Spell a non-negative integer. `0` is "không". */
export function numberToVietnamese(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "không";

  // Split into 3-digit groups, least significant first.
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) {
    groups.push(rest % 1000);
  }
  if (groups.length > SCALES.length) {
    // Beyond what a VND invoice can hold; fall back to digits rather than
    // inventing a scale name.
    return n.toLocaleString("vi-VN");
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i]!;
    // A zero group carries no words, but its scale must not be spoken either.
    if (group === 0) continue;
    const words = readGroup(group, i !== groups.length - 1);
    parts.push(SCALES[i] ? `${words} ${SCALES[i]}` : words);
  }
  return parts.join(" ");
}

/**
 * The "số tiền bằng chữ" line: capitalised, in đồng, closed with a full stop.
 *
 * The trailing "./." is the convention on Vietnamese invoices — it marks the
 * end of the amount so nothing can be appended to it after the fact.
 */
export function vndInWords(amountVnd: number): string {
  // Assemble the whole sentence before capitalising: prefixing "âm" afterwards
  // would leave the capital stranded mid-line ("Âm Năm mươi nghìn đồng").
  const sentence = `${amountVnd < 0 ? "âm " : ""}${numberToVietnamese(amountVnd)} đồng`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}./.`;
}
