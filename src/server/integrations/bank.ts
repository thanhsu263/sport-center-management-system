import { validBankAccount, type BankAccount } from "../vietqr";

/**
 * The centre's bank account for VietQR transfers, from the server environment:
 *   BANK_BIN           six-digit NAPAS bank id (970422 = MB, 970436 = Vietcombank, …)
 *   BANK_ACCOUNT_NO    the account number
 *   BANK_ACCOUNT_NAME  the holder's name as the bank prints it
 *   BANK_NAME          optional display name; known BINs are named without it
 *
 * Nothing here is a secret (a payer has to see all of it), but it is the centre's real account,
 * so it lives in the deploy's environment rather than in code. Unset or malformed means "not set
 * up": members are not offered a transfer and the desk box says so, instead of showing an account
 * that is not the centre's.
 */
export type CentreBank = BankAccount & { bankName: string; accountName: string };

const KNOWN_BANKS: Record<string, string> = {
  "970422": "MB Bank",
  "970436": "Vietcombank",
  "970415": "VietinBank",
  "970418": "BIDV",
  "970405": "Agribank",
  "970407": "Techcombank",
  "970416": "ACB",
  "970432": "VPBank",
  "970423": "TPBank",
  "970403": "Sacombank",
  "970441": "VIB",
  "970443": "SHB",
  "970448": "OCB",
  "970437": "HDBank",
};

export function centreBank(): CentreBank | null {
  const env = typeof process !== "undefined" ? process.env : {};
  const bin = (env.BANK_BIN ?? "").trim();
  const accountNo = (env.BANK_ACCOUNT_NO ?? "").replace(/\s+/g, "");
  const accountName = (env.BANK_ACCOUNT_NAME ?? "").trim().toUpperCase();
  if (!validBankAccount({ bin, accountNo }) || !accountName) return null;
  const bankName = (env.BANK_NAME ?? "").trim() || KNOWN_BANKS[bin] || `BIN ${bin}`;
  return { bin, accountNo, accountName, bankName };
}
