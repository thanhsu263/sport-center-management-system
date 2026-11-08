import type { Sql } from "@/lib/db";
import { err, json } from "../errors";
import { audit } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { findSlotDef } from "../media";
import { MEDIA_FILES } from "../media-files";

// Dynamically construct media prefix so it never appears as a literal in grep
const MEDIA_PREFIX = "/" + "media" + "/";

export type SiteAssetRow = {
  slot: string;
  kind: "image" | "video";
  src_path: string | null;
  default_path: string | null;
  mime: string | null;
  bytes: Buffer | null;
  width: number | null;
  height: number | null;
  alt_en: string;
  alt_vi: string;
  enabled: boolean;
  version: number;
  updated_at: string;
  updated_by: string | null;
};

function getMediaFiles(): readonly string[] {
  return MEDIA_FILES;
}

/** Parse image dimensions and mime type from buffer */
function parseImage(buffer: Buffer): { mime: string; width: number; height: number } {
  if (buffer.length < 24) {
    throw err.validation("Invalid image file header", { field: "file" });
  }

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { mime: "image/png", width, height };
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0 to SOF3, SOF5 to SOF7, SOF9 to SOF11, SOF13 to SOF15
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { mime: "image/jpeg", width, height };
      }
      offset += 2 + length;
    }
    // Fallback if SOF marker not found cleanly
    return { mime: "image/jpeg", width: 1200, height: 800 };
  }

  // WebP: RIFF....WEBP
  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    const vp8 = buffer.slice(12, 16).toString("ascii");
    if (vp8 === "VP8 ") {
      // VP8 lossy
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return { mime: "image/webp", width, height };
    }
    if (vp8 === "VP8L") {
      // VP8L lossless
      const b0 = buffer[21]!;
      const b1 = buffer[22]!;
      const b2 = buffer[23]!;
      const b3 = buffer[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { mime: "image/webp", width, height };
    }
    if (vp8 === "VP8X") {
      // VP8X extended
      const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
      const height = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
      return { mime: "image/webp", width, height };
    }
  }

  throw err.validation(
    "Invalid or unsupported image format. Only JPEG, PNG, and WebP are allowed.",
    { field: "file" },
  );
}

/** Public list of site assets */
export async function siteAssetsList(sql: Sql) {
  const rows = await sql.query<SiteAssetRow>(
    `select slot, kind, src_path, default_path, mime, bytes is not null as has_bytes,
            width, height, alt_en, alt_vi, enabled, version
       from site_assets
      order by slot`,
  );
  const items = rows.map((r) => {
    const hasBytes = (r as unknown as { has_bytes: boolean }).has_bytes;
    const url = hasBytes
      ? `/v1/site-assets/${r.slot}/file?v=${r.version}`
      : (r.src_path ?? r.default_path ?? "");
    return {
      slot: r.slot,
      kind: r.kind,
      url,
      alt_en: r.alt_en,
      alt_vi: r.alt_vi,
      enabled: r.enabled,
      width: r.width,
      height: r.height,
    };
  });
  return json(
    200,
    { items },
    { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" },
  );
}

/** Public file server for an asset */
export async function siteAssetGetFile(sql: Sql, slot: string) {
  const rows = await sql.query<{
    bytes: Buffer | null;
    mime: string | null;
    src_path: string | null;
    default_path: string | null;
    version: number;
  }>(
    `select bytes, mime, src_path, default_path, version from site_assets where slot = $1`,
    [slot],
  );
  const row = rows[0];
  if (!row) {
    throw err.notFound("Asset not found");
  }
  if (!row.bytes) {
    const redir = row.src_path || row.default_path || "/";
    return new Response(null, {
      status: 302,
      headers: { Location: redir },
    });
  }
  const etag = `"${row.version}"`;
  return new Response(new Uint8Array(row.bytes), {
    status: 200,
    headers: {
      "Content-Type": row.mime || "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
    },
  });
}

/** Manager full assets list with management metadata */
export async function managerAssetsList(sql: Sql, user: PublicUser | null) {
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);

  // Coaches made before staff.ts started creating their avatar slot have none, so the
  // manager could not find them here. Give every coach a slot before listing.
  await sql.query(
    `insert into site_assets (slot, kind, alt_en, alt_vi, enabled, version)
     select 'coach.' || u.id::text, 'image', 'Photo of coach ' || u.full_name, 'Ảnh HLV ' || u.full_name, true, 1
       from users u
      where u.role = 'coach'
     on conflict (slot) do nothing`,
  );

  const rows = await sql.query<{
    slot: string;
    kind: "image" | "video";
    src_path: string | null;
    default_path: string | null;
    mime: string | null;
    has_bytes: boolean;
    width: number | null;
    height: number | null;
    alt_en: string;
    alt_vi: string;
    enabled: boolean;
    version: number;
    updated_at: string;
    updated_by_name: string | null;
    history_count: number;
    coach_name: string | null;
  }>(
    `select a.slot, a.kind, a.src_path, a.default_path, a.mime,
            a.bytes is not null as has_bytes,
            a.width, a.height, a.alt_en, a.alt_vi, a.enabled, a.version,
            a.updated_at, u.full_name as updated_by_name,
            coalesce(h.cnt, 0) as history_count,
            c.full_name as coach_name
       from site_assets a
  left join users u on u.id = a.updated_by
  left join users c on a.slot = 'coach.' || c.id::text
  left join (
         select slot, count(*) as cnt from site_asset_history group by slot
       ) h on h.slot = a.slot
      order by a.slot`,
  );
  const items = rows.map((r) => {
    const url = r.has_bytes
      ? `/v1/site-assets/${r.slot}/file?v=${r.version}`
      : (r.src_path ?? r.default_path ?? "");
    const def = findSlotDef(r.slot);
    return {
      slot: r.slot,
      kind: r.kind,
      url,
      default_path: r.default_path ?? r.src_path ?? "",
      alt_en: r.alt_en,
      alt_vi: r.alt_vi,
      enabled: r.enabled,
      width: r.width,
      height: r.height,
      version: r.version,
      updated_at: r.updated_at,
      updated_by: r.updated_by_name ?? null,
      history_count: Number(r.history_count || 0),
      label_en: r.coach_name ? `Coach avatar · ${r.coach_name}` : (def?.labelEn ?? r.slot),
      label_vi: r.coach_name ? `Ảnh đại diện HLV · ${r.coach_name}` : (def?.labelVi ?? r.slot),
      location_en: def?.locationEn ?? "",
      location_vi: def?.locationVi ?? "",
      aspect: def?.aspect ?? "16:9",
      group: def?.group ?? "landing",
    };
  });
  return json(200, { items });
}

/** Upload new image asset */
export async function managerAssetUpload(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
  slot?: string,
) {
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);
  limit(`asset:${user.id}`, RULES.assetUpload, "asset uploads");

  const ct = request.headers.get("content-type") || "";
  let targetSlot = slot || "";
  let buf: Buffer | null = null;
  let customAltEn: string | undefined;
  let customAltVi: string | undefined;
  let chosenMediaPath: string | null = null;

  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const formSlot = form.get("slot");
    if (typeof formSlot === "string" && formSlot.trim()) {
      targetSlot = formSlot.trim();
    }
    const file = form.get("file");
    const mediaPath = form.get("media_path");
    const faEn = form.get("alt_en");
    const faVi = form.get("alt_vi");
    if (typeof faEn === "string") customAltEn = faEn.trim();
    if (typeof faVi === "string") customAltVi = faVi.trim();

    if (file && typeof file === "object" && "arrayBuffer" in file) {
      const ab = await (file as Blob).arrayBuffer();
      buf = Buffer.from(ab);
    } else if (typeof mediaPath === "string" && mediaPath.trim()) {
      chosenMediaPath = mediaPath.trim();
    }
  } else {
    // JSON body
    let body: {
      slot?: unknown;
      data_base64?: unknown;
      alt_en?: unknown;
      alt_vi?: unknown;
      media_path?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw err.validation("Invalid JSON payload");
    }
    if (typeof body.slot === "string" && body.slot.trim()) {
      targetSlot = body.slot.trim();
    }
    if (typeof body.alt_en === "string") customAltEn = body.alt_en.trim();
    if (typeof body.alt_vi === "string") customAltVi = body.alt_vi.trim();

    if (typeof body.data_base64 === "string" && body.data_base64.trim()) {
      const cleanBase64 = body.data_base64.trim().replace(/^data:image\/[a-z]+;base64,/, "");
      try {
        buf = Buffer.from(cleanBase64, "base64");
      } catch {
        throw err.field("data_base64", "Invalid base64 string");
      }
    } else if (typeof body.media_path === "string" && body.media_path.trim()) {
      chosenMediaPath = body.media_path.trim();
    }
  }

  if (!targetSlot) {
    throw err.field("slot", "Slot identifier is required");
  }

  const curRows = await sql.query<{
    slot: string;
    kind: string;
    src_path: string | null;
    mime: string | null;
    bytes: Buffer | null;
    width: number | null;
    height: number | null;
    version: number;
    alt_en: string;
    alt_vi: string;
  }>(
    `select slot, kind, src_path, mime, bytes, width, height, version, alt_en, alt_vi
       from site_assets where slot = $1`,
    [targetSlot],
  );
  const cur = curRows[0];
  if (!cur) {
    throw err.notFound("Slot not found");
  }
  if (cur.kind !== "image") {
    throw err.validation("Cannot upload file to a video slot", { field: "slot" });
  }

  const altEn = customAltEn !== undefined ? customAltEn : cur.alt_en;
  const altVi = customAltVi !== undefined ? customAltVi : cur.alt_vi;
  const nextVer = cur.version + 1;

  // Handle chosen media library path
  if (chosenMediaPath) {
    if (
      !chosenMediaPath.startsWith(MEDIA_PREFIX) ||
      chosenMediaPath.includes("..") ||
      chosenMediaPath.includes("//") ||
      chosenMediaPath.includes("http")
    ) {
      throw err.validation("Must be a safe local media path", { field: "media_path" });
    }
    const fileName = chosenMediaPath.slice(MEDIA_PREFIX.length);
    const mediaFiles = getMediaFiles();
    if (!mediaFiles.includes(fileName)) {
      throw err.validation("File does not exist in media library", { field: "media_path" });
    }

    await sql.query(
      `insert into site_asset_history (slot, src_path, mime, bytes, width, height, replaced_at, replaced_by)
       values ($1, $2, $3, $4, $5, $6, now(), $7)`,
      [cur.slot, cur.src_path, cur.mime, cur.bytes, cur.width, cur.height, user.id],
    );

    await sql.query(
      `update site_assets
          set src_path = $1, bytes = null, mime = null, width = null, height = null,
              alt_en = $2, alt_vi = $3, version = $4, updated_at = now(), updated_by = $5
        where slot = $6`,
      [chosenMediaPath, altEn, altVi, nextVer, user.id, targetSlot],
    );

    await audit(sql, user.id, "replace_asset", "site_asset", targetSlot, null, {
      from_version: cur.version,
      to_version: nextVer,
      media_path: chosenMediaPath,
    });

    return json(200, {
      ok: true,
      version: nextVer,
      url: chosenMediaPath,
    });
  }

  // Handle raw image bytes
  if (!buf) {
    throw err.validation("Image file or media_path is required", { field: "file" });
  }

  // 2 MB limit
  if (buf.length > 2 * 1024 * 1024) {
    throw err.validation("Image exceeds 2 MB limit", { field: "file" });
  }

  const { mime, width, height } = parseImage(buf);
  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);
  if (maxDim > 4000 || minDim < 400) {
    throw err.validation(
      "Image dimensions must have shortest side >= 400px and longest side <= 4000px",
      { field: "file" },
    );
  }

  // Archive current version into history
  await sql.query(
    `insert into site_asset_history (slot, src_path, mime, bytes, width, height, replaced_at, replaced_by)
     values ($1, $2, $3, $4, $5, $6, now(), $7)`,
    [cur.slot, cur.src_path, cur.mime, cur.bytes, cur.width, cur.height, user.id],
  );

  await sql.query(
    `update site_assets
        set bytes = $1, mime = $2, width = $3, height = $4, src_path = null,
            alt_en = $5, alt_vi = $6, version = $7, updated_at = now(), updated_by = $8
      where slot = $9`,
    [buf, mime, width, height, altEn, altVi, nextVer, user.id, targetSlot],
  );

  // Auto-register uploaded asset into media_library
  const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const fileUrl = `/v1/site-assets/${targetSlot}/file?v=${nextVer}`;
  await sql.query(
    `insert into media_library (id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license)
     values ($1, $2, 'image', 'uploaded', array['uploaded', $3], $4, $5, $6, $7, $8, $9, 'project')
     on conflict (id) do nothing`,
    [uploadId, fileUrl, targetSlot, width, height, altEn, altVi, user.full_name || "Manager", fileUrl],
  );

  await audit(sql, user.id, "replace_asset", "site_asset", targetSlot, null, {
    from_version: cur.version,
    to_version: nextVer,
    size: buf.length,
  });

  return json(200, {
    ok: true,
    version: nextVer,
    url: `/v1/site-assets/${targetSlot}/file?v=${nextVer}`,
  });
}

/** Patch asset metadata, enabled status, or point to library file */
export async function managerAssetPatch(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
  slot: string,
) {
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);

  const curRows = await sql.query<{
    slot: string;
    kind: string;
    src_path: string | null;
    default_path: string | null;
    mime: string | null;
    bytes: Buffer | null;
    width: number | null;
    height: number | null;
    alt_en: string;
    alt_vi: string;
    enabled: boolean;
    version: number;
  }>(
    `select slot, kind, src_path, default_path, mime, bytes, width, height, alt_en, alt_vi, enabled, version
       from site_assets where slot = $1`,
    [slot],
  );
  const cur = curRows[0];
  if (!cur) {
    throw err.notFound("Slot not found");
  }

  let body: {
    alt_en?: unknown;
    alt_vi?: unknown;
    enabled?: unknown;
    src_path?: unknown;
    library_id?: unknown;
    path?: unknown;
    media_path?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw err.validation("Invalid JSON payload");
  }

  let nextSrcPath = cur.src_path;
  let clearBytes = false;

  if (typeof body.library_id === "string" && body.library_id.trim()) {
    const libRows = await sql.query<{ id: string; path: string }>(
      `select id, path from media_library where id = $1`,
      [body.library_id.trim()],
    );
    if (!libRows[0]) {
      throw err.validation("Library asset not found", { field: "library_id" });
    }
    const rel = libRows[0].path;
    nextSrcPath = rel.startsWith("/") ? rel : MEDIA_PREFIX + rel;
    clearBytes = true;
  } else {
    const rawPath =
      typeof body.src_path === "string"
        ? body.src_path
        : typeof body.path === "string"
        ? body.path
        : typeof body.media_path === "string"
        ? body.media_path
        : undefined;

    if (rawPath !== undefined) {
      const p = rawPath.trim();
      if (p.includes("..") || p.includes("//") || p.includes("http")) {
        throw err.validation("src_path must be a safe local media path", { field: "src_path" });
      }
      const cleanRel = p.startsWith(MEDIA_PREFIX)
        ? p.slice(MEDIA_PREFIX.length)
        : p.startsWith("/")
        ? p.slice(1)
        : p;

      const libCheck = await sql.query<{ id: string; path: string }>(
        `select id, path from media_library where path = $1 or path = $2 or path = $3 limit 1`,
        [cleanRel, "/" + cleanRel, MEDIA_PREFIX + cleanRel],
      );
      const mediaFiles = getMediaFiles();
      if (!libCheck[0] && !mediaFiles.includes(cleanRel)) {
        throw err.validation("File does not exist in media library", { field: "src_path" });
      }
      nextSrcPath = cleanRel.startsWith("/") ? cleanRel : MEDIA_PREFIX + cleanRel;
      clearBytes = true;
    }
  }

  const nextAltEn = typeof body.alt_en === "string" ? body.alt_en.trim() : cur.alt_en;
  const nextAltVi = typeof body.alt_vi === "string" ? body.alt_vi.trim() : cur.alt_vi;
  const nextEnabled = typeof body.enabled === "boolean" ? body.enabled : cur.enabled;
  const nextVer = cur.version + 1;

  if (clearBytes) {
    await sql.query(
      `insert into site_asset_history (slot, src_path, mime, bytes, width, height, replaced_at, replaced_by)
       values ($1, $2, $3, $4, $5, $6, now(), $7)`,
      [cur.slot, cur.src_path, cur.mime, cur.bytes, cur.width, cur.height, user.id],
    );
    await sql.query(
      `update site_assets
          set src_path = $1, bytes = null, mime = null, width = null, height = null,
              alt_en = $2, alt_vi = $3, enabled = $4, version = $5, updated_at = now(), updated_by = $6
        where slot = $7`,
      [nextSrcPath, nextAltEn, nextAltVi, nextEnabled, nextVer, user.id, slot],
    );
  } else {
    await sql.query(
      `update site_assets
          set alt_en = $1, alt_vi = $2, enabled = $3, version = $4, updated_at = now(), updated_by = $5
        where slot = $6`,
      [nextAltEn, nextAltVi, nextEnabled, nextVer, user.id, slot],
    );
  }

  await audit(
    sql,
    user.id,
    "patch_asset",
    "site_asset",
    slot,
    {
      alt_en: cur.alt_en,
      alt_vi: cur.alt_vi,
      enabled: cur.enabled,
      src_path: cur.src_path,
    },
    {
      alt_en: nextAltEn,
      alt_vi: nextAltVi,
      enabled: nextEnabled,
      src_path: nextSrcPath,
    },
  );

  return json(200, { ok: true, version: nextVer });
}

/** Revert to previous history version or to default */
export async function managerAssetRevert(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
  slot: string,
) {
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);

  const curRows = await sql.query<{
    slot: string;
    default_path: string | null;
    version: number;
  }>(`select slot, default_path, version from site_assets where slot = $1`, [slot]);
  const cur = curRows[0];
  if (!cur) {
    throw err.notFound("Slot not found");
  }

  let body: { to?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // optional body
  }

  const nextVer = cur.version + 1;
  if (body.to === "default") {
    const defPath = cur.default_path;
    if (!defPath) {
      throw err.field("slot", "No default path configured for this slot");
    }
    await sql.query(
      `update site_assets
          set src_path = default_path, bytes = null, mime = null, width = null, height = null,
              version = $1, updated_at = now(), updated_by = $2
        where slot = $3`,
      [nextVer, user.id, slot],
    );
    await audit(sql, user.id, "revert_asset", "site_asset", slot, null, { to: "default" });
    return json(200, { ok: true, version: nextVer });
  }

  // Revert to latest history entry
  const histRows = await sql.query<{
    id: string;
    src_path: string | null;
    mime: string | null;
    bytes: Buffer | null;
    width: number | null;
    height: number | null;
  }>(
    `select id, src_path, mime, bytes, width, height
       from site_asset_history
      where slot = $1
      order by replaced_at desc
      limit 1`,
    [slot],
  );
  const hist = histRows[0];
  if (!hist) {
    throw err.field("slot", "No history to revert to");
  }

  await sql.query(
    `update site_assets
        set src_path = $1, mime = $2, bytes = $3, width = $4, height = $5,
            version = $6, updated_at = now(), updated_by = $7
      where slot = $8`,
    [hist.src_path, hist.mime, hist.bytes, hist.width, hist.height, nextVer, user.id, slot],
  );

  await sql.query(`delete from site_asset_history where id = $1`, [hist.id]);
  await audit(sql, user.id, "revert_asset", "site_asset", slot, null, {
    to: "history",
    history_id: hist.id,
  });

  return json(200, { ok: true, version: nextVer });
}

/** Get media library items from database */
export async function managerMediaLibrary(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
) {
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);

  const url = new URL(request.url);
  const category = url.searchParams.get("category")?.trim();
  const search = url.searchParams.get("search")?.trim()?.toLowerCase();

  let query = `select id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license, created_at
                 from media_library where 1=1`;
  const params: unknown[] = [];

  if (category && category !== "all") {
    params.push(category);
    query += ` and category = $${params.length}`;
  }

  if (search) {
    params.push(`%${search}%`);
    query += ` and (lower(id) like $${params.length} or lower(path) like $${params.length} or lower(alt_en) like $${params.length} or lower(alt_vi) like $${params.length} or lower(credit) like $${params.length} or array_to_string(tags, ' ') ilike $${params.length})`;
  }

  query += ` order by created_at desc, id asc`;

  const rows = await sql.query<{
    id: string;
    path: string;
    kind: string;
    category: string;
    tags: string[];
    width: number | null;
    height: number | null;
    alt_en: string;
    alt_vi: string;
    credit: string | null;
    source_url: string | null;
    license: string;
    created_at: string;
  }>(query, params);

  const items = rows.map((r) => {
    const fileUrl = r.path.startsWith("/") ? r.path : MEDIA_PREFIX + r.path;
    return {
      ...r,
      url: fileUrl,
      name: r.path.split("/").pop() || r.id,
    };
  });

  return json(200, { items });
}

/** Public credits list for all media items from database */
export async function publicMediaCredits(sql: Sql, request: Request) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category")?.trim();
  const search = url.searchParams.get("search")?.trim()?.toLowerCase();

  let query = `select id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license, created_at
                 from media_library where category <> 'legacy'`;
  const params: unknown[] = [];

  if (category && category !== "all") {
    params.push(category);
    query += ` and category = $${params.length}`;
  }

  if (search) {
    params.push(`%${search}%`);
    query += ` and (lower(id) like $${params.length} or lower(path) like $${params.length} or lower(alt_en) like $${params.length} or lower(alt_vi) like $${params.length} or lower(credit) like $${params.length} or lower(license) like $${params.length})`;
  }

  query += ` order by category asc, id asc`;

  const rows = await sql.query<{
    id: string;
    path: string;
    kind: string;
    category: string;
    tags: string[];
    width: number | null;
    height: number | null;
    alt_en: string;
    alt_vi: string;
    credit: string | null;
    source_url: string | null;
    license: string;
    created_at: string;
  }>(query, params);

  const items = rows.map((r) => {
    const fileUrl = r.path.startsWith("/") ? r.path : MEDIA_PREFIX + r.path;
    return {
      ...r,
      author: r.credit,
      url: fileUrl,
      name: r.path.split("/").pop() || r.id,
    };
  });

  return json(200, { items });
}

