export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT_SLOT"
  | "HOLD_EXPIRED"
  | "CONFLICT_STATE"
  | "BR_VIOLATION"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "INTERNAL";

export class ApiError extends Error {
  // Declared longhand: `node --experimental-strip-types` (the unit tests) cannot
  // erase constructor parameter properties.
  status: number;
  code: ErrorCode;
  extra: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  body(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

export const err = {
  unauth: (msg = "Please sign in.") => new ApiError(401, "UNAUTHENTICATED", msg),
  forbidden: (msg = "You do not have permission.") => new ApiError(403, "FORBIDDEN", msg),
  notFound: (msg = "Not found.") => new ApiError(404, "NOT_FOUND", msg),
  conflictSlot: (msg = "That slot is already held.", extra: Record<string, unknown> = {}) =>
    new ApiError(409, "CONFLICT_SLOT", msg, extra),
  holdExpired: (msg = "Your hold has expired.") => new ApiError(409, "HOLD_EXPIRED", msg),
  conflictState: (msg = "That is not a valid state.", extra: Record<string, unknown> = {}) =>
    new ApiError(409, "CONFLICT_STATE", msg, extra),
  conflict: (msg = "Conflict.", extra: Record<string, unknown> = {}) =>
    new ApiError(409, "CONFLICT_STATE", msg, extra),
  br: (br: string, message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(422, "BR_VIOLATION", message, { br, ...extra }),
  validation: (message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(422, "VALIDATION", message, extra),
  /**
   * A malformed form value, named by the field that carried it. 400 rather than
   * the 422 `validation` uses for state the request was well-formed about, so
   * the screen can put the message under the right input.
   */
  field: (field: string, message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(400, "VALIDATION", message, { field, ...extra }),
  rateLimited: (msg = "Too many attempts — try again later.") => new ApiError(429, "RATE_LIMITED", msg),
};

export function isConflictSlot(e: unknown): boolean {
  const x = e as { code?: string; message?: string };
  const msg = `${x?.code ?? ""} ${x?.message ?? ""}`;
  return x?.code === "23P01" || msg.includes("CONFLICT_SLOT");
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

type PgErrorShape = {
  code?: string;
  message?: string;
  column?: string;
  constraint?: string;
};

/**
 * What a database error means to the caller, when it means anything.
 *
 * Postgres says precisely what is wrong with a value — too long, out of range,
 * missing, a duplicate — and the old catch-all threw that away and answered
 * "Something went wrong on our side" with code `VALIDATION`, which told a
 * manager nothing and told the logs nothing they could not already see. A bad
 * value is the caller's to fix, so it comes back as a 4xx naming the column;
 * only an error nobody can attribute to the request is a 500.
 *
 * Returns null for anything else so the caller can decide it is a 500.
 */
export function mapDbError(e: unknown): { status: number; body: Record<string, unknown> } | null {
  const x = (e ?? {}) as PgErrorShape;
  const msg = `${x.code ?? ""} ${x.message ?? ""}`;
  if (x.code === "23P01" || msg.includes("CONFLICT_SLOT")) {
    return { status: 409, body: { code: "CONFLICT_SLOT", message: "That slot is already held." } };
  }
  if (msg.includes("HOLD_EXPIRED")) {
    return { status: 409, body: { code: "HOLD_EXPIRED", message: "Your hold has expired." } };
  }
  if (msg.includes("ALREADY_ENROLLED")) {
    return {
      status: 422,
      body: { code: "BR_VIOLATION", br: "BR-22", message: "You are already enrolled in that class." },
    };
  }
  if (msg.includes("CLASS_FULL")) {
    return { status: 422, body: { code: "BR_VIOLATION", br: "BR-21", message: "That class is full." } };
  }
  const field = x.column ? { field: x.column } : {};
  if (x.code === "22001") {
    return { status: 400, body: { code: "VALIDATION", message: "That value is too long.", ...field } };
  }
  if (x.code === "22003") {
    return { status: 400, body: { code: "VALIDATION", message: "That number is out of range.", ...field } };
  }
  if (x.code === "22P02" || x.code === "22007" || x.code === "22008") {
    return { status: 400, body: { code: "VALIDATION", message: "That value is not in the right format.", ...field } };
  }
  if (x.code === "23502") {
    return { status: 400, body: { code: "VALIDATION", message: "A required value is missing.", ...field } };
  }
  if (x.code === "23505") {
    return {
      status: 409,
      body: {
        code: "CONFLICT_STATE",
        message: "That already exists.",
        ...(x.constraint ? { constraint: x.constraint } : {}),
      },
    };
  }
  if (x.code === "23514") {
    return {
      status: 422,
      body: {
        code: "VALIDATION",
        message: "That value is not allowed.",
        ...(x.constraint ? { constraint: x.constraint } : {}),
      },
    };
  }
  return null;
}

export function handleError(e: unknown): Response {
  if (e instanceof ApiError) return json(e.status, e.body());
  const mapped = mapDbError(e);
  if (mapped) return json(mapped.status, mapped.body);
  // Anything left is ours to fix. It is reported as what it is — INTERNAL, not a
  // rule and not a form error — and the detail stays in the log.
  console.error("[arena3]", e);
  return json(500, { code: "INTERNAL", message: "Something went wrong on our side." });
}
