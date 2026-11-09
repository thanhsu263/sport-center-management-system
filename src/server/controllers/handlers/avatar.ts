import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { audit } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { loadUser, type PublicUser } from "../session";
import { one } from "../tx";

export type SniffedAvatar = {
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
};

/**
 * Strict reader of image magic bytes and dimensions.
 * Returns null immediately on unknown format, corrupted buffer, or truncated dimensions.
 */
export function sniffAvatar(buf: Buffer): SniffedAvatar | null {
  if (!buf || buf.length < 24) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { mime: "image/png", width, height };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) return null;
      const marker = buf[offset + 1];
      if (marker === 0xd9 || marker === 0xda) return null; // EOI or SOS reached before SOF
      if (marker === 0x00 || marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        offset += 2;
        continue;
      }
      const len = buf.readUInt16BE(offset + 2);
      if (len < 2 || offset + 2 + len > buf.length) return null;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (offset + 9 > buf.length) return null;
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { mime: "image/jpeg", width, height };
      }
      offset += 2 + len;
    }
    return null;
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const vp8 = buf.subarray(12, 16).toString("ascii");
    if (vp8 === "VP8 ") {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { mime: "image/webp", width, height };
    }
    if (vp8 === "VP8L") {
      if (buf.length < 25) return null;
      const b0 = buf[21]!;
      const b1 = buf[22]!;
      const b2 = buf[23]!;
      const b3 = buf[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { mime: "image/webp", width, height };
    }
    if (vp8 === "VP8X") {
      if (buf.length < 30) return null;
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { mime: "image/webp", width, height };
    }
    return null;
  }

  return null;
}

export async function meAvatarPut(sql: Sql, request: Request, user: PublicUser | null) {
  if (!user) throw err.unauth();
  limit(`avatar:${user.id}`, RULES.avatarUpload, "photo uploads");

  const ct = request.headers.get("content-type") || "";
  let buf: Buffer | null = null;

  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const file = form.get("file");
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      buf = Buffer.from(await (file as Blob).arrayBuffer());
    }
  } else {
    let body: { data_base64?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    if (typeof body.data_base64 === "string" && body.data_base64.trim()) {
      const clean = body.data_base64.trim().replace(/^data:image\/[a-z]+;base64,/, "");
      try {
        buf = Buffer.from(clean, "base64");
      } catch {
        buf = Buffer.alloc(0);
      }
    }
  }

  if (!buf || buf.length === 0) {
    throw err.field("file", "Choose a photo to upload.");
  }
  if (buf.length > 2 * 1024 * 1024) {
    throw err.field("file", "The photo must be 2 MB or smaller.");
  }

  const sniffed = sniffAvatar(buf);
  if (!sniffed) {
    throw err.field("file", "Use a JPEG, PNG or WebP photo.");
  }
  if (sniffed.width < 64 || sniffed.width > 4096 || sniffed.height < 64 || sniffed.height > 4096) {
    throw err.field("file", "The photo must be between 64 and 4096 pixels on each side.");
  }

  await sql.query(
    `insert into user_avatars (user_id, bytes, mime, width, height)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set bytes = excluded.bytes, mime = excluded.mime, width = excluded.width,
           height = excluded.height, version = user_avatars.version + 1, updated_at = now()
     returning version`,
    [user.id, buf, sniffed.mime, sniffed.width, sniffed.height],
  );

  await audit(sql, user.id, "avatar_set", "user", user.id, null, {
    mime: sniffed.mime,
    width: sniffed.width,
    height: sniffed.height,
    bytes: buf.length,
  });

  const reloaded = await loadUser(sql, user.id);
  return { status: 200, body: { user: reloaded } };
}

export async function meAvatarDelete(sql: Sql, user: PublicUser | null) {
  if (!user) throw err.unauth();
  const deleted = await sql.query<{ user_id: string }>(
    `delete from user_avatars where user_id = $1 returning user_id`,
    [user.id],
  );
  if (deleted.length > 0) {
    await audit(sql, user.id, "avatar_removed", "user", user.id, null, null);
  }
  const reloaded = await loadUser(sql, user.id);
  return { status: 200, body: { user: reloaded } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function userAvatarGet(sql: Sql, targetId: string, user: PublicUser | null) {
  if (!user) throw err.unauth();
  if (!UUID_RE.test(targetId)) throw err.notFound();

  const isOwner = user.id === targetId;
  const isStaff = ["receptionist", "coach", "manager"].includes(user.role);

  if (!isOwner && !isStaff) {
    if (user.role === "member") {
      const conv = await one(
        sql,
        `select 1 from conversations
          where (member_id = $1 and staff_id = $2) or (member_id = $2 and staff_id = $1)
          limit 1`,
        [user.id, targetId],
      );
      if (!conv) throw err.notFound();
    } else {
      throw err.notFound();
    }
  }

  const row = await one<{ bytes: Buffer | Uint8Array; mime: string; version: number }>(
    sql,
    `select bytes, mime, version from user_avatars where user_id = $1`,
    [targetId],
  );
  if (!row) throw err.notFound();

  return new Response(new Uint8Array(row.bytes), {
    status: 200,
    headers: {
      "Content-Type": row.mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400",
      ETag: `"${row.version}"`,
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
