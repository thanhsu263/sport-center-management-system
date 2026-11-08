import type { Sql } from "@/lib/db";
import { ApiError } from "./errors";
import { one } from "./tx";

export type FlagKey = "F4" | "F5" | "F6";

export async function flagsMap(sql: Sql): Promise<Record<string, boolean>> {
  const rows = await sql.query<{ key: string; enabled: boolean }>(
    `select key, enabled from feature_flags`,
  );
  const out: Record<string, boolean> = { F4: false, F5: false, F6: false };
  for (const r of rows) out[r.key] = r.enabled;
  return out;
}

export async function flagOn(sql: Sql, key: FlagKey): Promise<boolean> {
  const row = await one<{ enabled: boolean }>(sql, `select enabled from feature_flags where key = $1`, [key]);
  return row?.enabled === true;
}

/**
 * Refuse a request for a module the manager has switched off.
 *
 * 403, not 422: SRS BR-52 says a module that is off answers "forbidden", and the
 * code is stable so a screen can tell "switched off" from "not allowed for you".
 */
export async function requireFlag(sql: Sql, key: FlagKey) {
  if (!(await flagOn(sql, key))) {
    throw new ApiError(403, "FORBIDDEN", `Feature ${key} is switched off.`, { br: "BR-52", flag: key });
  }
}
