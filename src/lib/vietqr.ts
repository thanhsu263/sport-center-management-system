/**
 * VietQR (NAPAS) bank-transfer payloads: the EMVCo merchant-presented QR that every Vietnamese
 * banking app reads.
 *
 * The string is a run of tag-length-value fields; tag 38 names the receiving account (the NAPAS
 * GUID A000000727, the bank's BIN, the account number, service QRIBFTTA = transfer to an account)
 * and tag 63 closes it with a CRC16-CCITT (0xFFFF start, polynomial 0x1021) over everything
 * before it, "6304" included. A payload without that checksum is the one banking apps refuse.
 *
 * Pure functions, no imports: the node test runner checks them directly, and the desk box and
 * the member's booking card build the same string.
 */

export type BankAccount = {
  /** Six-digit NAPAS bank identifier, e.g. 970422 for MB. */
  bin: string;
  accountNo: string;
};

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/** CRC16-CCITT-FALSE as four upper-case hex digits. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * The transfer reference ("nội dung chuyển khoản") as banks carry it: plain upper-case ASCII,
 * letters, digits and spaces, at most 25 characters (the NAPAS limit for tag 62-08).
 */
export function transferReference(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 25)
    .trim();
}

/** Whether an account can go into a payload at all. */
export function validBankAccount(a: Partial<BankAccount> | null | undefined): a is BankAccount {
  return !!a && /^\d{6}$/.test(a.bin ?? "") && /^[0-9A-Za-z]{4,19}$/.test(a.accountNo ?? "");
}

/**
 * A VietQR payload for a transfer of `amountVnd` (whole dong, omitted for an open amount) with
 * `reference` as its content. Throws on an account that cannot be encoded.
 */
export function vietQrPayload(account: BankAccount, amountVnd?: number, reference?: string): string {
  if (!validBankAccount(account)) throw new Error("A VietQR account needs a 6-digit BIN and an account number.");
  const amount = amountVnd != null && amountVnd > 0 ? String(Math.round(amountVnd)) : "";
  const note = reference ? transferReference(reference) : "";
  const merchant = tlv("00", "A000000727") + tlv("01", tlv("00", account.bin) + tlv("01", account.accountNo)) + tlv("02", "QRIBFTTA");
  const body =
    tlv("00", "01") +
    // 12 = dynamic (amount fixed for this one payment), 11 = static (the payer types it).
    tlv("01", amount ? "12" : "11") +
    tlv("38", merchant) +
    tlv("53", "704") +
    (amount ? tlv("54", amount) : "") +
    tlv("58", "VN") +
    (note ? tlv("62", tlv("08", note)) : "") +
    "6304";
  return body + crc16(body);
}

/** Split a payload back into its top-level fields (for tests and debugging). */
export function readTlv(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isInteger(len)) break;
    out[id] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}
