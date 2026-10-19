import { dbSource, getPglite, type Sql } from "@/lib/db";
import type { Pool, PoolClient } from "pg";

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

function wrap(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}

const globalRef = globalThis as typeof globalThis & { __arena3NeonPool__?: Pool };

async function neonPool(): Promise<Pool> {
  if (!globalRef.__arena3NeonPool__) {
    const { Pool: PgPool, types } = await import("pg");
    types.setTypeParser(20, Number);
    types.setTypeParser(1082, (v: string) => v);
    types.setTypeParser(1186, (v: string) => v);
    const pool = new PgPool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => {
      console.error("[arena3 neon pool error]", err.message);
    });
    globalRef.__arena3NeonPool__ = pool;
  }
  return globalRef.__arena3NeonPool__;
}

/**
 * Throw this when the writes made so far must survive the error — a wrong
 * password still has to count toward the lockout. `withTx` commits, then
 * rethrows `inner`.
 */
export class KeepWrites extends Error {
  readonly inner: unknown;
  constructor(inner: unknown) {
    super("keep writes");
    this.inner = inner;
  }
}

/**
 * @internal test-only
 * Overrides the PGlite instance used by `withTx` for isolated unit tests.
 */
let overridePglite: import("@electric-sql/pglite").PGlite | null = null;

/**
 * @internal test-only
 * Sets or clears the test PGlite override instance.
 */
export function setOverridePglite(pg: import("@electric-sql/pglite").PGlite | null): void {
  overridePglite = pg;
}

export async function withTx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (overridePglite || dbSource === "pglite") {
    const pg = overridePglite ?? (await getPglite());
    let keptError: unknown = undefined;
    let hasKeptError = false;
    const out = await pg.transaction(async (tx) => {
      const run: Run = async <R>(text: string, params: unknown[]) => {
        const result = await tx.query<R>(text, params ?? []);
        return result.rows;
      };
      try {
        return await fn(wrap(run));
      } catch (e) {
        if (e instanceof KeepWrites) {
          keptError = e.inner;
          hasKeptError = true;
          return undefined as unknown as T;
        }
        throw e;
      }
    });
    if (hasKeptError) {
      throw keptError;
    }
    return out;
  }
  const pool = await neonPool();
  const client: PoolClient = await pool.connect();
  const clientErrHandler = (err: Error) => {
    console.error("[arena3 client error]", err.message);
  };
  client.on("error", clientErrHandler);
  let hasError = false;
  try {
    await client.query("BEGIN");
    const run: Run = async <R>(text: string, params: unknown[]) => {
      const result = await client.query(text, params ?? []);
      return result.rows as R[];
    };
    const out = await fn(wrap(run));
    await client.query("COMMIT");
    return out;
  } catch (e) {
    if (e instanceof KeepWrites) {
      try {
        await client.query("COMMIT");
        hasError = false;
      } catch (commitErr) {
        hasError = true;
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw commitErr;
      }
      throw e.inner;
    }
    hasError = true;
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.removeListener("error", clientErrHandler);
    client.release(hasError);
  }
}

export async function one<T>(sql: Sql, text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await sql.query<T>(text, params);
  return rows[0];
}

export async function q<T>(sql: Sql, text: string, params: unknown[] = []): Promise<T[]> {
  return sql.query<T>(text, params);
}
