/**
 * Xử lý các endpoint quản lý và phục vụ ảnh đại diện (avatar) của người dùng trong hệ thống Arena 3.
 * Bao gồm: đọc magic bytes và kích thước ảnh (PNG, JPEG, WebP), cập nhật avatar cá nhân (PUT /api/me/avatar),
 * xóa avatar (DELETE /api/me/avatar), và phục vụ file ảnh avatar kèm kiểm soát quyền truy cập và cache HTTP (GET /api/users/:id/avatar).
 */
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
/**
 * Làm gì: Đọc magic bytes từ buffer để nhận diện định dạng ảnh (PNG, JPEG, WebP) và trích xuất kích thước width, height.
 *   Trả về null ngay nếu buffer nhỏ hơn 24 bytes, sai định dạng hoặc dữ liệu kích thước bị hỏng/cắt cụt.
 * Được gọi ở: meAvatarPut (bước kiểm tra ảnh upload) và test runner (src/server/controllers/tx.test.ts).
 * @param buf Buffer nhị phân chứa nội dung file ảnh.
 * @returns Đối tượng SniffedAvatar ({ mime, width, height }) nếu hợp lệ, hoặc null nếu không thể nhận diện.
 */
export function sniffAvatar(buf: Buffer): SniffedAvatar | null {
  // Bước 1: Kiểm tra buffer tối thiểu 24 bytes (cần ít nhất 24 bytes để đọc các trường header và kích thước ảnh cơ bản).
  if (!buf || buf.length < 24) return null;

  // Bước 2: Kiểm tra 8 magic bytes của PNG và đọc width, height từ IHDR chunk (offset 16 và 20, Big-Endian).
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

  // Bước 3: Kiểm tra định dạng JPEG (bắt đầu bằng FF D8 FF) và quét các segment marker để tìm SOF lấy width, height.
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
      // Bỏ qua các marker Restart (RST0 đến RST7) vì chúng chỉ dài 2 bytes và không có payload kích thước đi kèm.
      if (marker >= 0xd0 && marker <= 0xd7) {
        offset += 2;
        continue;
      }
      const len = buf.readUInt16BE(offset + 2);
      if (len < 2 || offset + 2 + len > buf.length) return null;
      // Các marker SOF0, SOF1, SOF2 chứa kích thước: đọc chiều cao ở offset + 5 và chiều rộng ở offset + 7.
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

  // Bước 4: Kiểm tra định dạng WebP (header RIFF....WEBP) và giải mã kích thước theo từng chuẩn: VP8, VP8L hoặc VP8X.
  // WebP: RIFF....WEBP
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const vp8 = buf.subarray(12, 16).toString("ascii");
    // Chuẩn VP8 lossy: width và height 14-bit lưu tại offset 26 và 28 (áp dụng mask 0x3fff).
    if (vp8 === "VP8 ") {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { mime: "image/webp", width, height };
    }
    // Chuẩn VP8L lossless: kích thước được nén bitwise trong 4 bytes (từ byte 21 đến 24), cộng thêm 1 theo đặc tả WebP.
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
    // Chuẩn VP8X extended: width và height 24-bit (Little-Endian) lưu từ byte 24 và 27, cộng thêm 1 theo đặc tả WebP.
    if (vp8 === "VP8X") {
      if (buf.length < 30) return null;
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { mime: "image/webp", width, height };
    }
    return null;
  }

  // Bước 5: Trả về null nếu dữ liệu không khớp với bất kỳ định dạng ảnh nào được hỗ trợ.
  return null;
}

/**
 * Làm gì: Tải lên hoặc thay mới ảnh đại diện (avatar) của người dùng hiện tại (hỗ trợ FormData và base64 JSON).
 *   Kiểm tra định dạng và kích thước ảnh, lưu dữ liệu nhị phân vào bảng user_avatars, tăng version và ghi audit log.
 * Được gọi ở: src/server/controllers/router.ts (route PUT /api/me/avatar).
 * @param sql Kết nối database để thực hiện truy vấn và ghi log.
 * @param request Đối tượng Request HTTP chứa file ảnh dạng FormData (multipart) hoặc data_base64 trong body JSON.
 * @param user Thông tin người dùng hiện tại từ session/token.
 * @returns Đối tượng phản hồi { status: 200, body: { user } } chứa thông tin người dùng mới nhất kèm avatar_url.
 * @throws Lỗi 401 unauth nếu chưa đăng nhập; lỗi 429 nếu vượt rate limit RULES.avatarUpload;
 *   lỗi 400 validation nếu ảnh rỗng, dung lượng > 2 MB, sai định dạng hoặc kích thước ngoài khoảng 64x64 đến 4096x4096 px.
 */
export async function meAvatarPut(sql: Sql, request: Request, user: PublicUser | null) {
  // Bước 1: Xác thực người dùng và kiểm tra rate limit tải ảnh (theo user ID để ngăn chặn spam/DoS).
  if (!user) throw err.unauth();
  limit(`avatar:${user.id}`, RULES.avatarUpload, "photo uploads");

  const ct = request.headers.get("content-type") || "";
  let buf: Buffer | null = null;

  // Bước 2: Đọc dữ liệu nhị phân của ảnh từ request (hỗ trợ cả FormData multipart lẫn chuỗi base64 trong body JSON).
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

  // Bước 3: Kiểm tra dung lượng buffer (bắt buộc phải có dữ liệu và không được vượt quá 2 MB).
  if (!buf || buf.length === 0) {
    throw err.field("file", "Choose a photo to upload.");
  }
  if (buf.length > 2 * 1024 * 1024) {
    throw err.field("file", "The photo must be 2 MB or smaller.");
  }

  // Bước 4: Kiểm tra tính hợp lệ của ảnh qua magic bytes (chỉ nhận JPEG/PNG/WebP) và kích thước mỗi cạnh từ 64 đến 4096 pixel.
  const sniffed = sniffAvatar(buf);
  if (!sniffed) {
    throw err.field("file", "Use a JPEG, PNG or WebP photo.");
  }
  if (sniffed.width < 64 || sniffed.width > 4096 || sniffed.height < 64 || sniffed.height > 4096) {
    throw err.field("file", "The photo must be between 64 and 4096 pixels on each side.");
  }

  // Bước 5: Lưu dữ liệu ảnh vào bảng user_avatars. Nếu user đã có ảnh thì ghi đè (upsert) và tăng version để làm mới cache HTTP ở client.
  await sql.query(
    `insert into user_avatars (user_id, bytes, mime, width, height)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set bytes = excluded.bytes, mime = excluded.mime, width = excluded.width,
           height = excluded.height, version = user_avatars.version + 1, updated_at = now()
     returning version`,
    [user.id, buf, sniffed.mime, sniffed.width, sniffed.height],
  );

  // Bước 6: Ghi nhật ký kiểm toán (audit log) sự kiện avatar_set lưu lại thông số kỹ thuật của file ảnh.
  await audit(sql, user.id, "avatar_set", "user", user.id, null, {
    mime: sniffed.mime,
    width: sniffed.width,
    height: sniffed.height,
    bytes: buf.length,
  });

  // Bước 7: Tải lại thông tin người dùng từ DB để trả về user object có avatar_url mới nhất cho client.
  const reloaded = await loadUser(sql, user.id);
  return { status: 200, body: { user: reloaded } };
}

/**
 * Làm gì: Xóa ảnh đại diện của người dùng hiện tại khỏi bảng user_avatars, ghi nhận nhật ký kiểm toán và trả về thông tin user đã làm mới.
 * Được gọi ở: src/server/controllers/router.ts (route DELETE /api/me/avatar).
 * @param sql Kết nối database để thực hiện truy vấn xóa và tải lại thông tin người dùng.
 * @param user Thông tin người dùng hiện tại từ session/token.
 * @returns Đối tượng phản hồi { status: 200, body: { user } } chứa thông tin người dùng sau khi xóa avatar (avatar_url là null).
 * @throws Lỗi 401 unauth nếu người dùng chưa đăng nhập.
 */
export async function meAvatarDelete(sql: Sql, user: PublicUser | null) {
  // Bước 1: Kiểm tra người dùng đã đăng nhập.
  if (!user) throw err.unauth();
  // Bước 2: Xóa bản ghi avatar trong bảng user_avatars theo user_id, trả về user_id để biết có dòng nào bị xóa không.
  const deleted = await sql.query<{ user_id: string }>(
    `delete from user_avatars where user_id = $1 returning user_id`,
    [user.id],
  );
  // Bước 3: Nếu thực sự có avatar bị xóa, ghi log kiểm toán hành vi avatar_removed.
  if (deleted.length > 0) {
    await audit(sql, user.id, "avatar_removed", "user", user.id, null, null);
  }
  // Bước 4: Tải lại thông tin người dùng từ DB (avatar_url lúc này là null) và trả về HTTP 200.
  const reloaded = await loadUser(sql, user.id);
  return { status: 200, body: { user: reloaded } };
}

// Biểu thức chính quy kiểm tra định dạng UUID v4 hợp lệ của ID người dùng trên URL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Làm gì: Lấy file ảnh đại diện của người dùng theo targetId, kiểm tra quyền truy cập bảo mật và trả về HTTP Response nhị phân kèm header cache.
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/users/:id/avatar).
 * @param sql Kết nối database để truy vấn dữ liệu avatar và kiểm tra quyền xem.
 * @param targetId UUID của người dùng cần lấy ảnh đại diện.
 * @param user Thông tin người dùng hiện tại đang gửi yêu cầu từ session/token.
 * @returns Response HTTP 200 chứa luồng byte nhị phân của ảnh kèm Content-Type, ETag, Cache-Control và CSP bảo vệ.
 * @throws Lỗi 401 unauth nếu chưa đăng nhập; lỗi 404 notFound nếu targetId không hợp lệ, không có quyền xem hoặc không tìm thấy ảnh.
 */
export async function userAvatarGet(sql: Sql, targetId: string, user: PublicUser | null) {
  // Bước 1: Kiểm tra xác thực và định dạng UUID của targetId (tránh truy vấn database với ID không hợp lệ).
  if (!user) throw err.unauth();
  if (!UUID_RE.test(targetId)) throw err.notFound();

  // Bước 2: Kiểm tra quyền xem avatar: cho phép nếu là chính chủ hoặc nhân viên hệ thống (receptionist, coach, manager).
  const isOwner = user.id === targetId;
  const isStaff = ["receptionist", "coach", "manager"].includes(user.role);

  // Bước 3: Nếu là member khác xem, chỉ cho phép khi hai người có chung cuộc hội thoại (conversations). Giấu sự tồn tại bằng lỗi 404 thay vì 403 để tránh rò rỉ ID người dùng.
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

  // Bước 4: Truy vấn dữ liệu nhị phân (bytes), kiểu MIME và phiên bản (version) từ bảng user_avatars theo targetId.
  const row = await one<{ bytes: Buffer | Uint8Array; mime: string; version: number }>(
    sql,
    `select bytes, mime, version from user_avatars where user_id = $1`,
    [targetId],
  );
  if (!row) throw err.notFound();

  // Bước 5: Trả về Response HTTP với buffer ảnh và các header bảo mật (nosniff, CSP none) cùng HTTP cache (Cache-Control private 1 ngày, ETag theo version).
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
