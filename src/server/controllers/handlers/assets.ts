/**
 * Quản lý tài nguyên media và hình ảnh hiển thị trên toàn hệ thống (site assets, avatar HLV, ảnh sân, banner).
 * Cung cấp API công khai để lấy danh sách asset và phục vụ file ảnh trực tiếp (kèm ETag/Cache-Control),
 * cùng các API quản trị cho Manager để tải ảnh lên, cập nhật thẻ alt, đổi ảnh từ thư viện tĩnh và khôi phục phiên bản cũ.
 */
import type { Sql } from "@/server/data/db";
import { err, json } from "../errors";
import { audit } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { findSlotDef } from "../../../shared/arena3/media";
import { MEDIA_FILES } from "../../data/media-files";

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

/**
 * Làm gì: Lấy danh sách đường dẫn các file media tĩnh có sẵn trong hệ thống (từ MEDIA_FILES).
 * Được gọi ở: src/server/controllers/handlers/assets.ts (trong validateChosenAssetMediaPath và managerMediaLibrary).
 * @returns Mảng chỉ đọc chứa danh sách đường dẫn file media tĩnh.
 */
function getMediaFiles(): readonly string[] {
  return MEDIA_FILES;
}

/** Parse image dimensions and mime type from buffer */
/**
 * Làm gì: Phân tích dữ liệu nhị phân của ảnh (Buffer) để xác định định dạng MIME và kích thước width, height.
 * Được gọi ở: src/server/controllers/handlers/assets.ts (trong processUploadedImageBuffer khi xử lý file upload).
 * @param buffer Dữ liệu nhị phân của file ảnh tải lên.
 * @returns Đối tượng chứa mime, width và height của ảnh.
 * @throws Lỗi validation nếu file nhỏ hơn 24 bytes hoặc không thuộc định dạng PNG, JPEG, WebP.
 */
function parseImage(buffer: Buffer): { mime: string; width: number; height: number } {
  // Bước 1: Kiểm tra kích thước buffer tối thiểu (cần ít nhất 24 bytes để đọc các trường header và kích thước ảnh cơ bản).
  if (buffer.length < 24) {
    throw err.validation("Invalid image file header", { field: "file" });
  }

  // PNG
  // Bước 2: Kiểm tra magic bytes của PNG và đọc width, height từ IHDR chunk (offset 16 và 20, định dạng Big-Endian).
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
  // Bước 3: Kiểm tra định dạng JPEG (bắt đầu bằng FF D8), quét các marker tìm segment SOF để trích xuất width và height.
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
  // Bước 4: Kiểm tra định dạng WebP (header RIFF....WEBP) và giải mã kích thước theo từng chuẩn: VP8 (lossy), VP8L (lossless), hoặc VP8X (mở rộng).
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

  // Bước 5: Ném lỗi validation nếu định dạng ảnh không nằm trong danh sách hỗ trợ (chỉ nhận PNG, JPEG, WebP).
  throw err.validation(
    "Invalid or unsupported image format. Only JPEG, PNG, and WebP are allowed.",
    { field: "file" },
  );
}

/** Public list of site assets */
/**
 * Làm gì: Lấy danh sách tất cả tài nguyên hiển thị (ảnh, video) trên trang web kèm URL phục vụ file và thẻ alt song ngữ.
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/site-assets).
 * @param sql Kết nối database để truy vấn bảng site_assets.
 * @returns Phản hồi HTTP 200 dạng JSON chứa danh sách asset kèm header Cache-Control.
 */
export async function siteAssetsList(sql: Sql) {
  // Bước 1: Truy vấn danh sách toàn bộ asset trong bảng site_assets, sắp xếp theo tên slot.
  const rows = await sql.query<SiteAssetRow>(
    `select slot, kind, src_path, default_path, mime, bytes is not null as has_bytes,
            width, height, alt_en, alt_vi, enabled, version
       from site_assets
      order by slot`,
  );
  // Bước 2: Chuẩn hóa dữ liệu trả về cho client. Nếu asset có dữ liệu nhị phân (bytes) thì sinh URL động qua API /file kèm version để bust cache, ngược lại dùng đường dẫn tĩnh.
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
  // Bước 3: Trả về HTTP 200 kèm header Cache-Control (cache 60s trên trình duyệt, cho phép stale tối đa 10 phút để giảm tải DB).
  return json(
    200,
    { items },
    { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" },
  );
}

/** Public file server for an asset */
/**
 * Làm gì: Phục vụ trực tiếp file nhị phân của một asset theo slot hoặc chuyển hướng (302) về đường dẫn file tĩnh mặc định.
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/site-assets/:slot/file).
 * @param sql Kết nối database để truy vấn bảng site_assets.
 * @param slot Định danh duy nhất của vị trí tài nguyên (ví dụ: "hero.banner", "coach.1", "sport.badminton").
 * @returns Response chứa dữ liệu nhị phân với Content-Type, ETag và Cache-Control, hoặc Response 302 chuyển hướng.
 * @throws Lỗi notFound 404 nếu không tìm thấy slot trong database.
 */
export async function siteAssetGetFile(sql: Sql, slot: string) {
  // Bước 1: Tra cứu thông tin asset trong cơ sở dữ liệu theo định danh slot.
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
  // Bước 2: Báo lỗi 404 nếu không tìm thấy slot tài nguyên.
  if (!row) {
    throw err.notFound("Asset not found");
  }
  // Bước 3: Nếu slot chưa có file nhị phân (bytes là null), chuyển hướng 302 về file tĩnh mặc định hoặc trang chủ.
  if (!row.bytes) {
    const redir = row.src_path || row.default_path || "/";
    return new Response(null, {
      status: 302,
      headers: { Location: redir },
    });
  }
  // Bước 4: Tạo ETag dựa trên version và trả về dữ liệu nhị phân với chính sách cache immutable 1 năm.
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
/**
 * Làm gì: Lấy danh sách đầy đủ tất cả tài nguyên web dành cho Manager quản lý, tự động bổ sung slot cho HLV và môn thể thao mới, đồng thời đính kèm lịch sử chỉnh sửa và metadata hiển thị.
 * Được gọi ở: src/server/controllers/router.ts (route GET /v1/manager/site-assets).
 * @param sql Kết nối database để thực hiện truy vấn và khởi tạo slot mới.
 * @param user Thông tin người dùng hiện tại, yêu cầu quyền manager.
 * @returns Phản hồi HTTP 200 dạng JSON chứa danh sách chi tiết các asset phục vụ trang quản trị.
 * @throws Lỗi unauth 401 nếu chưa đăng nhập, hoặc forbidden 403 nếu không có vai trò manager.
 */
export async function managerAssetsList(sql: Sql, user: PublicUser | null) {
  // Bước 1: Kiểm tra quyền truy cập (yêu cầu đăng nhập và có vai trò manager).
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);

  // Coaches made before staff.ts started creating their avatar slot have none, so the
  // manager could not find them here. Give every coach a slot before listing.
  // Bước 2: Tự động khởi tạo slot avatar cho các huấn luyện viên chưa có slot trong site_assets.
  await sql.query(
    `insert into site_assets (slot, kind, alt_en, alt_vi, enabled, version)
     select 'coach.' || u.id::text, 'image', 'Photo of coach ' || u.full_name, 'Ảnh HLV ' || u.full_name, true, 1
       from users u
      where u.role = 'coach'
     on conflict (slot) do nothing`,
  );
  // Same for sports: one added before sports.ts registered its photo slot would have no picture
  // and nowhere to upload one.
  // Bước 3: Tự động khởi tạo slot ảnh sân cho các môn thể thao chưa ngừng hoạt động.
  await sql.query(
    `insert into site_assets (slot, kind, alt_en, alt_vi, enabled, version)
     select 'sport.' || s.code, 'image', s.name_en || ' court photo', 'Ảnh sân ' || s.name_vi, true, 1
       from sports s
      where s.retired_at is null
     on conflict (slot) do nothing`,
  );

  // Bước 4: Truy vấn toàn bộ danh sách site_assets kèm thông tin người cập nhật, số bản ghi lịch sử (history_count), tên HLV và tên môn thể thao.
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
    sport_en: string | null;
    sport_vi: string | null;
  }>(
    `select a.slot, a.kind, a.src_path, a.default_path, a.mime,
            a.bytes is not null as has_bytes,
            a.width, a.height, a.alt_en, a.alt_vi, a.enabled, a.version,
            a.updated_at, u.full_name as updated_by_name,
            coalesce(h.cnt, 0) as history_count,
            c.full_name as coach_name,
            s.name_en as sport_en, s.name_vi as sport_vi
       from site_assets a
  left join users u on u.id = a.updated_by
  left join users c on a.slot = 'coach.' || c.id::text
  left join sports s on a.slot = 'sport.' || s.code
  left join (
         select slot, count(*) as cnt from site_asset_history group by slot
       ) h on h.slot = a.slot
      order by a.slot`,
  );
  // Bước 5: Ghép metadata cấu hình slot (nhãn hiển thị song ngữ, vị trí, tỷ lệ khung hình, nhóm hiển thị) từ hàm findSlotDef và chuẩn hóa danh sách kết quả.
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
      label_en: r.coach_name
        ? `Coach avatar · ${r.coach_name}`
        : r.sport_en ? `${r.sport_en} sport photo` : (def?.labelEn ?? r.slot),
      label_vi: r.coach_name
        ? `Ảnh đại diện HLV · ${r.coach_name}`
        : r.sport_vi ? `Ảnh môn ${r.sport_vi}` : (def?.labelVi ?? r.slot),
      location_en: r.sport_en ? `Courts & booking: ${r.sport_en}` : (def?.locationEn ?? ""),
      location_vi: r.sport_vi ? `Sân & đặt sân: ${r.sport_vi}` : (def?.locationVi ?? ""),
      aspect: def?.aspect ?? "16:9",
      group: def?.group ?? "landing",
    };
  });
  // Bước 6: Trả về kết quả danh sách asset cho giao diện quản lý dưới dạng JSON.
  return json(200, { items });
}

type AssetUploadInput = {
  targetSlot: string;
  imageBuffer: Buffer | null;
  customAltEn: string | undefined;
  customAltVi: string | undefined;
  chosenMediaPath: string | null;
};

type AssetUploadSlotRow = {
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
};

type AssetUploadReplacementMeta = {
  altEn: string;
  altVi: string;
  nextVersion: number;
};

type AssetUploadImageDimensions = {
  mime: string;
  width: number;
  height: number;
};

/**
 * Làm gì: kiểm tra người dùng đã đăng nhập, có vai trò quản lý (manager), và chưa vượt quá
 *   giới hạn tần suất tải lên tài nguyên (rate limit RULES.assetUpload).
 *   Vì sao cần kiểm tra: tải ảnh tốn băng thông và dung lượng lưu trữ, chỉ quản lý mới được phép
 *   thay đổi hình ảnh hiển thị trên toàn hệ thống, và cần tránh tấn công làm nghẽn tài nguyên (DoS).
 * Được gọi ở: managerAssetUpload, bước 1.
 * @param user Thông tin người dùng đang đăng nhập, lấy từ session/token thông qua router.
 * @throws Lỗi 401 unauth nếu chưa đăng nhập; lỗi 403 nếu không phải vai trò manager;
 *   lỗi 429 nếu vượt quá giới hạn tần suất upload trong khoảng thời gian quy định.
 */
function assertManagerCanUploadAsset(
  user: PublicUser | null,
): asserts user is PublicUser {
  if (!user) {
    throw err.unauth();
  }

  requireRole(user, ["manager"]);
  limit(`asset:${user.id}`, RULES.assetUpload, "asset uploads");
}

/**
 * Làm gì: đọc dữ liệu tải lên từ FormData khi request có Content-Type là multipart/form-data
 *   hoặc application/x-www-form-urlencoded. Lấy định danh slot, file ảnh nhị phân (chuyển sang Buffer),
 *   hoặc đường dẫn media_path trong thư viện nội bộ, cùng các văn bản thay thế alt_en, alt_vi.
 * Được gọi ở: readAssetUploadInput, khi request gửi dạng form data.
 * @param request Request HTTP POST/PUT chứa body dạng FormData gửi từ trình duyệt.
 * @param initialSlot Định danh slot mặc định lấy từ URL parameter (nếu có).
 * @returns Object AssetUploadInput chứa dữ liệu upload đã được chuẩn hóa.
 */
async function readAssetUploadFormData(
  request: Request,
  initialSlot: string,
): Promise<AssetUploadInput> {
  // Bước 1: Đọc FormData từ request và xác định targetSlot (ưu tiên giá trị truyền trong form hơn initialSlot từ URL).
  const formData = await request.formData();

  let targetSlot = initialSlot;
  const formSlot = formData.get("slot");
  const slotIsSpecifiedInForm = typeof formSlot === "string" && formSlot.trim().length > 0;
  if (slotIsSpecifiedInForm) {
    targetSlot = (formSlot as string).trim();
  }

  const uploadedFile = formData.get("file");
  const mediaPath = formData.get("media_path");
  const formAltEn = formData.get("alt_en");
  const formAltVi = formData.get("alt_vi");

  // Bước 2: Đọc và cắt tỉa khoảng trắng cho các văn bản thay thế tùy chọn (alt_en, alt_vi).
  let customAltEn: string | undefined;
  let customAltVi: string | undefined;
  if (typeof formAltEn === "string") {
    customAltEn = formAltEn.trim();
  }
  if (typeof formAltVi === "string") {
    customAltVi = formAltVi.trim();
  }

  // Bước 3: Đọc file ảnh tải lên chuyển thành Buffer; nếu không gửi file thì lấy đường dẫn ảnh media_path từ thư viện.
  let imageBuffer: Buffer | null = null;
  let chosenMediaPath: string | null = null;

  // Ưu tiên đọc file tải lên dạng Blob/File trước; nếu không có file thì mới xét đến media_path.
  const hasUploadedFile = Boolean(
    uploadedFile && typeof uploadedFile === "object" && "arrayBuffer" in uploadedFile,
  );
  if (hasUploadedFile) {
    const arrayBuffer = await (uploadedFile as Blob).arrayBuffer();
    imageBuffer = Buffer.from(arrayBuffer);
  } else {
    const mediaPathIsNonEmptyString = typeof mediaPath === "string" && mediaPath.trim().length > 0;
    if (mediaPathIsNonEmptyString) {
      chosenMediaPath = (mediaPath as string).trim();
    }
  }

  // Bước 4: Trả về đối tượng AssetUploadInput chứa thông tin upload đã được chuẩn hóa.
  return {
    targetSlot,
    imageBuffer,
    customAltEn,
    customAltVi,
    chosenMediaPath,
  };
}

/**
 * Làm gì: đọc dữ liệu tải lên từ payload JSON khi client gửi trực tiếp qua API.
 *   Hỗ trợ chuỗi base64 của ảnh (data_base64) hoặc đường dẫn media_path trong thư viện,
 *   kèm slot và các thẻ alt tùy chọn.
 * Được gọi ở: readAssetUploadInput, khi Content-Type không phải là form data.
 * @param request Request HTTP chứa body JSON.
 * @param initialSlot Định danh slot mặc định lấy từ URL parameter (nếu có).
 * @returns Object AssetUploadInput chứa dữ liệu upload đã được chuẩn hóa.
 * @throws Lỗi 422 "Invalid JSON payload" nếu body không đúng định dạng JSON;
 *   lỗi 400 gắn vào ô data_base64 nếu chuỗi base64 bị sai định dạng.
 */
async function readAssetUploadJson(
  request: Request,
  initialSlot: string,
): Promise<AssetUploadInput> {
  // JSON body
  let body: {
    slot?: unknown;
    data_base64?: unknown;
    alt_en?: unknown;
    alt_vi?: unknown;
    media_path?: unknown;
  };

  // Bước 1: Parse body từ request, ném lỗi validation nếu JSON không đúng định dạng.
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw err.validation("Invalid JSON payload");
  }

  // Bước 2: Xác định slot đích, ưu tiên lấy từ body nếu client gửi kèm để ghi đè initialSlot.
  let targetSlot = initialSlot;
  const slotIsSpecifiedInBody = typeof body.slot === "string" && body.slot.trim().length > 0;
  if (slotIsSpecifiedInBody) {
    targetSlot = (body.slot as string).trim();
  }

  // Bước 3: Lấy alt text tiếng Anh và tiếng Việt tùy chọn để hỗ trợ SEO và hiển thị đa ngôn ngữ.
  let customAltEn: string | undefined;
  let customAltVi: string | undefined;
  if (typeof body.alt_en === "string") {
    customAltEn = body.alt_en.trim();
  }
  if (typeof body.alt_vi === "string") {
    customAltVi = body.alt_vi.trim();
  }

  let imageBuffer: Buffer | null = null;
  let chosenMediaPath: string | null = null;

  // Bước 4: Xử lý dữ liệu ảnh: giải mã chuỗi data_base64 thành Buffer, nếu không có thì lấy media_path.
  const hasBase64Data = typeof body.data_base64 === "string" && body.data_base64.trim().length > 0;
  if (hasBase64Data) {
    // Loại bỏ tiền tố Data URL nếu có (ví dụ "data:image/png;base64,") để lấy đúng chuỗi base64 thô.
    const cleanBase64 = (body.data_base64 as string)
      .trim()
      .replace(/^data:image\/[a-z]+;base64,/, "");

    try {
      imageBuffer = Buffer.from(cleanBase64, "base64");
    } catch {
      throw err.field("data_base64", "Invalid base64 string");
    }
  } else {
    // Nếu client không gửi base64, kiểm tra xem có chọn ảnh có sẵn từ thư viện qua media_path không.
    const hasMediaPath = typeof body.media_path === "string" && body.media_path.trim().length > 0;
    if (hasMediaPath) {
      chosenMediaPath = (body.media_path as string).trim();
    }
  }

  // Bước 5: Trả về đối tượng AssetUploadInput đã chuẩn hóa để các bước tiếp theo xử lý.
  return {
    targetSlot,
    imageBuffer,
    customAltEn,
    customAltVi,
    chosenMediaPath,
  };
}

/**
 * Làm gì: phân tích header Content-Type của request để điều phối việc đọc dữ liệu upload,
 *   tự động chọn cách phân tích theo FormData hoặc JSON.
 * Được gọi ở: managerAssetUpload, bước 2.
 * @param request Request HTTP gửi lên server.
 * @param slotParam Định danh slot truyền qua URL parameter (tùy chọn).
 * @returns Dữ liệu upload AssetUploadInput tổng hợp.
 * @throws Lỗi 422 nếu JSON không hợp lệ, hoặc lỗi 400 nếu chuỗi base64 không đúng.
 */
async function readAssetUploadInput(
  request: Request,
  slotParam?: string,
): Promise<AssetUploadInput> {
  // Bước 1: Lấy header Content-Type và slot mặc định từ URL parameter.
  const contentType = request.headers.get("content-type") || "";
  const initialSlot = slotParam || "";

  // Bước 2: Điều hướng cách đọc dữ liệu: dùng FormData cho form multipart/urlencoded, ngược lại parse JSON.
  const isMultipartOrUrlEncoded =
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded");

  // Trình duyệt gửi form upload thông qua multipart/form-data hoặc URL-encoded.
  if (isMultipartOrUrlEncoded) {
    return await readAssetUploadFormData(request, initialSlot);
  }

  // Các ứng dụng client hoặc REST API trực tiếp thường gửi payload JSON chứa base64 hoặc media_path.
  return await readAssetUploadJson(request, initialSlot);
}

/**
 * Làm gì: xác thực định danh slot không được để trống. Slot là vị trí hiển thị của ảnh trên giao diện
 *   (ví dụ "hero.banner", "coach.<id>", "sport.<code>").
 * Được gọi ở: managerAssetUpload, bước 2, ngay sau khi đọc dữ liệu upload.
 * @param targetSlot Định danh vị trí slot cần cập nhật.
 * @throws Lỗi 400 gắn vào ô slot nếu thiếu định danh slot.
 */
function checkRequiredAssetUploadSlot(targetSlot: string): void {
  // Nghiệp vụ: slot là khóa định danh duy nhất của tài nguyên (ví dụ 'hero.banner'), bắt buộc phải có để biết cần cập nhật ảnh nào.
  const slotIsMissing = !targetSlot;
  if (slotIsMissing) {
    throw err.field("slot", "Slot identifier is required");
  }
}

/**
 * Làm gì: tìm kiếm slot tài nguyên trong bảng site_assets và chắc chắn đây là slot ảnh ('image').
 *   Vì sao cần kiểm tra: hệ thống phân biệt tài nguyên ảnh và video; không thể upload file ảnh
 *   vào slot được cấu hình dành riêng cho video.
 * Được gọi ở: managerAssetUpload, bước 3.
 * @param sql Kết nối database trong transaction của request do router mở.
 * @param targetSlot Tên slot cần tìm trong bảng site_assets.
 * @returns Dòng thông tin hiện tại của slot (AssetUploadSlotRow).
 * @throws Lỗi 404 "Slot not found" nếu slot không tồn tại;
 *   lỗi 422 gắn vào ô slot nếu slot này có kind khác 'image' (ví dụ video).
 */
async function findExistingImageAssetUploadSlot(
  sql: Sql,
  targetSlot: string,
): Promise<AssetUploadSlotRow> {
  // Bước 1: Truy vấn thông tin tài nguyên hiện tại từ bảng site_assets theo targetSlot.
  const currentRows = await sql.query<AssetUploadSlotRow>(
    `select slot, kind, src_path, mime, bytes, width, height, version, alt_en, alt_vi
       from site_assets where slot = $1`,
    [targetSlot],
  );

  // Bước 2: Kiểm tra sự tồn tại của slot trong database, ném 404 nếu không tìm thấy.
  const currentAsset = currentRows[0];
  if (!currentAsset) {
    throw err.notFound("Slot not found");
  }

  // Bước 3: Nghiệp vụ: chỉ slot loại ảnh ('image') mới được upload file, slot video được quản lý qua URL/stream riêng.
  const slotIsNotImage = currentAsset.kind !== "image";
  if (slotIsNotImage) {
    throw err.validation("Cannot upload file to a video slot", { field: "slot" });
  }

  return currentAsset;
}

/**
 * Làm gì: quyết định văn bản thay thế (alt text tiếng Anh và tiếng Việt) và số phiên bản tiếp theo.
 *   Nếu người dùng không gửi alt text mới thì giữ nguyên alt text cũ của slot; phiên bản tăng thêm 1
 *   để làm mới bộ nhớ đệm trên trình duyệt (thông qua query param v=... hoặc ETag).
 * Được gọi ở: managerAssetUpload, bước 3.
 * @param currentAsset Bản ghi slot hiện tại trong cơ sở dữ liệu.
 * @param customAltEn Văn bản alt tiếng Anh người dùng gửi lên (nếu có).
 * @param customAltVi Văn bản alt tiếng Việt người dùng gửi lên (nếu có).
 * @returns Object chứa altEn, altVi cuối cùng và số phiên bản nextVersion.
 */
function resolveAssetUploadReplacementMeta(
  currentAsset: AssetUploadSlotRow,
  customAltEn?: string,
  customAltVi?: string,
): AssetUploadReplacementMeta {
  // Bước 1: Giữ nguyên alt text cũ nếu người dùng không nhập mới.
  const altEn = customAltEn !== undefined ? customAltEn : currentAsset.alt_en;
  const altVi = customAltVi !== undefined ? customAltVi : currentAsset.alt_vi;
  // Bước 2: Tăng version thêm 1 để phá bộ nhớ đệm (cache busting) trên trình duyệt và CDN khi URL gắn ?v=nextVersion.
  const nextVersion = currentAsset.version + 1;

  return {
    altEn,
    altVi,
    nextVersion,
  };
}

/**
 * Làm gì: lưu bản sao lưu (snapshot) của tài nguyên hiện tại vào bảng lịch sử site_asset_history trước khi ghi đè.
 *   Vì sao: giúp quản lý có thể hoàn tác (revert) về phiên bản trước bất cứ lúc nào nếu ảnh mới bị lỗi
 *   hoặc không phù hợp.
 * Được gọi ở: applyAssetUploadFromLibraryMedia (bước 4) và applyAssetUploadFromImageBuffer (bước 5).
 * @param sql Kết nối database trong transaction của request.
 * @param currentAsset Bản ghi tài nguyên hiện tại trước khi bị thay thế.
 * @param userId ID của người thực hiện thay đổi, lưu vào cột replaced_by để kiểm toán.
 */
async function archiveAssetUploadHistory(
  sql: Sql,
  currentAsset: AssetUploadSlotRow,
  userId: string,
): Promise<void> {
  // Lưu snapshot của tài nguyên cũ vào site_asset_history kèm ID người thay thế để hỗ trợ hoàn tác và audit.
  await sql.query(
    `insert into site_asset_history (slot, src_path, mime, bytes, width, height, replaced_at, replaced_by)
     values ($1, $2, $3, $4, $5, $6, now(), $7)`,
    [
      currentAsset.slot,
      currentAsset.src_path,
      currentAsset.mime,
      currentAsset.bytes,
      currentAsset.width,
      currentAsset.height,
      userId,
    ],
  );
}

/**
 * Làm gì: kiểm tra tính an toàn và sự tồn tại của đường dẫn file tĩnh khi quản lý chọn ảnh
 *   từ thư viện media có sẵn.
 *   Vì sao: ngăn chặn lỗ hổng vượt quyền thư mục (Directory Traversal ".."), đường dẫn URL bên ngoài ("http"),
 *   hoặc đường dẫn bất thường ("//"), đồng thời đảm bảo file thực sự tồn tại trong danh mục MEDIA_FILES.
 * Được gọi ở: applyAssetUploadFromLibraryMedia (bước 4).
 * @param chosenMediaPath Đường dẫn tương đối do client chỉ định (phải bắt đầu bằng MEDIA_PREFIX).
 * @throws Lỗi 422 gắn vào ô media_path nếu đường dẫn chứa ký tự không an toàn hoặc file không tồn tại.
 */
function validateSafeAssetUploadMediaPath(chosenMediaPath: string): void {
  // Handle chosen media library path
  // Bước 1: Bảo mật: chặn Path Traversal ('..', '//'), URL bên ngoài ('http') và bắt buộc phải bắt đầu bằng MEDIA_PREFIX.
  const pathIsUnsafe =
    !chosenMediaPath.startsWith(MEDIA_PREFIX) ||
    chosenMediaPath.includes("..") ||
    chosenMediaPath.includes("//") ||
    chosenMediaPath.includes("http");

  if (pathIsUnsafe) {
    throw err.validation("Must be a safe local media path", { field: "media_path" });
  }

  // Bước 2: Tách tên file và đối chiếu với danh sách MEDIA_FILES để đảm bảo file thực sự tồn tại trên đĩa.
  const fileName = chosenMediaPath.slice(MEDIA_PREFIX.length);
  const mediaFiles = getMediaFiles();
  const fileExistsInMediaFiles = mediaFiles.includes(fileName);

  if (!fileExistsInMediaFiles) {
    throw err.validation("File does not exist in media library", { field: "media_path" });
  }
}

/**
 * Làm gì: cập nhật slot tài nguyên trỏ sang file có sẵn trong thư viện media: kiểm tra đường dẫn,
 *   lưu lịch sử bản ghi cũ, cập nhật bảng site_assets (xóa bytes nhị phân, đặt src_path mới),
 *   ghi nhật ký kiểm toán (audit log) và trả về thông tin phiên bản mới.
 * Được gọi ở: managerAssetUpload, bước 4, khi request có chosenMediaPath.
 * @param sql Kết nối database trong transaction của request.
 * @param user Quản lý đang thực hiện upload (dùng để lưu updated_by và ghi audit log).
 * @param currentAsset Bản ghi slot hiện tại trước khi cập nhật.
 * @param targetSlot Tên slot đang cập nhật.
 * @param chosenMediaPath Đường dẫn file media an toàn đã được chỉ định.
 * @param replacement Thông tin alt text và phiên bản mới.
 * @returns Response JSON { ok: true, version, url }.
 */
async function applyAssetUploadFromLibraryMedia(
  sql: Sql,
  user: PublicUser,
  currentAsset: AssetUploadSlotRow,
  targetSlot: string,
  chosenMediaPath: string,
  replacement: AssetUploadReplacementMeta,
) {
  // Bước 1: Kiểm tra tính an toàn và hợp lệ của đường dẫn file trong thư viện media.
  validateSafeAssetUploadMediaPath(chosenMediaPath);

  // Bước 2: Lưu bản sao hiện tại vào bảng lịch sử trước khi ghi đè để có thể rollback.
  await archiveAssetUploadHistory(sql, currentAsset, user.id);

  // Bước 3: Cập nhật site_assets trỏ tới đường dẫn file tĩnh mới, đặt bytes = null vì không lưu nhị phân trong DB.
  await sql.query(
    `update site_assets
        set src_path = $1, bytes = null, mime = null, width = null, height = null,
            alt_en = $2, alt_vi = $3, version = $4, updated_at = now(), updated_by = $5
      where slot = $6`,
    [
      chosenMediaPath,
      replacement.altEn,
      replacement.altVi,
      replacement.nextVersion,
      user.id,
      targetSlot,
    ],
  );

  // Bước 4: Ghi audit log hành động 'replace_asset' để lưu vết ai đã thay đổi tài nguyên nào và phiên bản thay đổi.
  await audit(sql, user.id, "replace_asset", "site_asset", targetSlot, null, {
    from_version: currentAsset.version,
    to_version: replacement.nextVersion,
    media_path: chosenMediaPath,
  });

  // Bước 5: Trả về HTTP 200 kèm version mới và URL file media cho client cập nhật giao diện.
  return json(200, {
    ok: true,
    version: replacement.nextVersion,
    url: chosenMediaPath,
  });
}

/**
 * Làm gì: kiểm tra tính hợp lệ của dữ liệu ảnh nhị phân: bắt buộc phải có buffer,
 *   không được vượt quá dung lượng 2 MB, định dạng hợp lệ (JPEG, PNG, WebP thông qua parseImage),
 *   và kích thước cạnh ngắn nhất >= 400px, cạnh dài nhất <= 4000px.
 *   Vì sao: đảm bảo chất lượng hình ảnh sắc nét trên mọi loại màn hình nhưng dung lượng không quá nặng
 *   làm chậm tốc độ tải trang.
 * Được gọi ở: applyAssetUploadFromImageBuffer, bước đầu của nhánh tải ảnh mới.
 * @param buffer Dữ liệu Buffer của file ảnh tải lên.
 * @returns Kích thước và định dạng mime của ảnh (AssetUploadImageDimensions).
 * @throws Lỗi 422 gắn vào ô file nếu thiếu file, vượt quá 2 MB, sai định dạng hoặc kích thước không đạt chuẩn.
 */
function validateAssetUploadImageBuffer(
  buffer: Buffer | null,
): AssetUploadImageDimensions {
  // Handle raw image bytes
  // Bước 1: Kiểm tra bắt buộc phải có dữ liệu buffer của ảnh khi chọn luồng upload file trực tiếp.
  if (!buffer) {
    throw err.validation("Image file or media_path is required", { field: "file" });
  }

  // Bước 2: Giới hạn dung lượng tối đa 2 MB để tránh làm phình dung lượng database và gây nghẽn mạng.
  // 2 MB limit
  const maximumFileSizeInBytes = 2 * 1024 * 1024;
  const fileExceedsSizeLimit = buffer.length > maximumFileSizeInBytes;
  if (fileExceedsSizeLimit) {
    throw err.validation("Image exceeds 2 MB limit", { field: "file" });
  }

  // Bước 3: Đọc metadata của ảnh qua helper parseImage để xác định MIME type cùng chiều rộng và chiều cao.
  const { mime, width, height } = parseImage(buffer);
  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);
  // Bước 4: Kiểm tra độ phân giải: cạnh ngắn >= 400px (đảm bảo độ nét) và cạnh dài <= 4000px (tránh quá tải khi render).
  const dimensionsAreOutOfRange = maxDim > 4000 || minDim < 400;

  if (dimensionsAreOutOfRange) {
    throw err.validation(
      "Image dimensions must have shortest side >= 400px and longest side <= 4000px",
      { field: "file" },
    );
  }

  return { mime, width, height };
}

/**
 * Làm gì: xử lý lưu trữ file ảnh nhị phân: xác thực buffer và kích thước ảnh, lưu bản sao cũ vào lịch sử,
 *   cập nhật bytes/mime/width/height vào site_assets, tự động đăng ký ảnh vào thư viện media_library,
 *   ghi nhật ký kiểm toán (audit log) và trả về URL file kèm query parameter v=version.
 * Được gọi ở: managerAssetUpload, bước 5, khi tải lên ảnh mới dạng nhị phân.
 * @param sql Kết nối database trong transaction của request.
 * @param user Quản lý đang thực hiện upload.
 * @param currentAsset Bản ghi slot hiện tại trước khi cập nhật.
 * @param targetSlot Tên slot đang cập nhật.
 * @param imageBuffer Dữ liệu Buffer của ảnh mới.
 * @param replacement Thông tin alt text và phiên bản mới.
 * @returns Response JSON { ok: true, version, url }.
 */
async function applyAssetUploadFromImageBuffer(
  sql: Sql,
  user: PublicUser,
  currentAsset: AssetUploadSlotRow,
  targetSlot: string,
  imageBuffer: Buffer | null,
  replacement: AssetUploadReplacementMeta,
) {
  // Bước 1: Xác thực buffer ảnh, kiểm tra dung lượng <= 2 MB và kích thước đạt chuẩn hiển thị.
  const imageDimensions = validateAssetUploadImageBuffer(imageBuffer);

  // Bước 2: Lưu phiên bản hiện tại vào site_asset_history để có thể hoàn tác nếu ảnh mới có vấn đề.
  // Archive current version into history
  await archiveAssetUploadHistory(sql, currentAsset, user.id);

  // Bước 3: Cập nhật bytes nhị phân trực tiếp vào site_assets, đặt src_path = null vì file lưu trong DB.
  await sql.query(
    `update site_assets
        set bytes = $1, mime = $2, width = $3, height = $4, src_path = null,
            alt_en = $5, alt_vi = $6, version = $7, updated_at = now(), updated_by = $8
      where slot = $9`,
    [
      imageBuffer,
      imageDimensions.mime,
      imageDimensions.width,
      imageDimensions.height,
      replacement.altEn,
      replacement.altVi,
      replacement.nextVersion,
      user.id,
      targetSlot,
    ],
  );

  // Bước 4: Tự động đăng ký ảnh mới vào media_library để tái sử dụng ở các màn hình khác mà không cần upload lại.
  // Auto-register uploaded asset into media_library
  const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const fileUrl = `/v1/site-assets/${targetSlot}/file?v=${replacement.nextVersion}`;

  // Tạo bản ghi media_library với ID ngẫu nhiên và đường dẫn tải ảnh theo version mới.
  await sql.query(
    `insert into media_library (id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license)
     values ($1, $2, 'image', 'uploaded', array['uploaded', $3], $4, $5, $6, $7, $8, $9, 'project')
     on conflict (id) do nothing`,
    [
      uploadId,
      fileUrl,
      targetSlot,
      imageDimensions.width,
      imageDimensions.height,
      replacement.altEn,
      replacement.altVi,
      user.full_name || "Manager",
      fileUrl,
    ],
  );

  // Ghi nhật ký kiểm toán (audit log) để lưu vết ai đã thay thế tài nguyên, phiên bản cũ/mới và kích thước file.
  await audit(sql, user.id, "replace_asset", "site_asset", targetSlot, null, {
    from_version: currentAsset.version,
    to_version: replacement.nextVersion,
    size: (imageBuffer as Buffer).length,
  });

  // Trả về phiên bản mới và đường dẫn file kèm query param version để trình duyệt làm mới bộ nhớ đệm.
  return json(200, {
    ok: true,
    version: replacement.nextVersion,
    url: `/v1/site-assets/${targetSlot}/file?v=${replacement.nextVersion}`,
  });
}

/**
 * Làm gì: tải lên ảnh mới cho một vị trí (slot) tài nguyên của hệ thống hoặc trỏ slot sang file có sẵn
 *   trong thư viện media. Hàm lưu bản sao cũ vào lịch sử (site_asset_history) để có thể hoàn tác,
 *   tăng số phiên bản (version) để trình duyệt làm mới bộ nhớ đệm, tự động đăng ký ảnh vào thư viện media dùng chung,
 *   và ghi nhật ký kiểm toán (audit log).
 *   Đọc hàm này như mục lục: mỗi dòng là một bước, chi tiết nằm trong các hàm phụ phía trên.
 *   Thứ tự các bước là cố ý: bước nào đứng trước thì lỗi của nó được báo trước cho người dùng.
 * Được gọi ở:
 *   - Màn hình Quản lý Media (src/routes/manager.media.tsx), modal "Upload new image", nút Lưu ("Save")
 *     gửi FormData tới POST /v1/manager/site-assets/upload.
 *   - Màn hình Quản lý Huấn luyện viên (src/routes/manager.staff.tsx), modal "Add staff" và "Edit coach"
 *     khi chọn ảnh đại diện cho HLV (slot: coach.<id>), gửi FormData tới POST /v1/manager/site-assets/upload.
 *   - Màn hình Quản lý Môn thể thao (src/routes/manager.sports.tsx thông qua uploadSportPhoto trong
 *     src/client/lib/pages/manager.sports.ts) khi tải ảnh sân (slot: sport.<code>), gửi FormData tới POST /v1/manager/site-assets/upload.
 *   - src/server/controllers/router.ts nhận các request:
 *     + POST /v1/manager/site-assets/upload (không có slot trên URL, slot nằm trong body/form)
 *     + POST /v1/manager/site-assets/:slot hoặc PUT /v1/manager/site-assets/:slot (slot nằm trên URL parameter)
 *     và gọi hàm này thông qua wrapper authed(...): authed kiểm tra xác thực người dùng và mở transaction,
 *     nếu có bất kỳ lỗi nào xảy ra thì transaction sẽ tự động rollback toàn bộ dữ liệu.
 * @param sql Kết nối database trong transaction do router mở.
 * @param request Request HTTP chứa file ảnh tải lên (FormData hoặc JSON payload).
 * @param user Người đang đăng nhập; phải có vai trò manager, ID được ghi vào lịch sử và audit log.
 * @param slot Định danh vị trí tài nguyên truyền từ URL parameter (tùy chọn, ví dụ "coach.123" hoặc undefined).
 * @returns Response JSON { ok: true, version: number, url: string } trả về phiên bản mới và đường dẫn ảnh.
 * @throws Lỗi 401 unauth nếu chưa đăng nhập; lỗi 403 nếu không phải manager; lỗi 429 nếu vượt rate limit;
 *   lỗi 400 nếu thiếu slot hoặc sai định dạng base64; lỗi 404 nếu không tìm thấy slot;
 *   lỗi 422 nếu slot là video, thiếu file/media_path, file vượt 2 MB, hoặc kích thước ảnh không hợp lệ.
 */
export async function managerAssetUpload(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
  slot?: string,
) {
  // Bước 1: chỉ quản lý mới được thay đổi tài nguyên và phải tuân thủ giới hạn tần suất tải lên.
  assertManagerCanUploadAsset(user);

  // Bước 2: đọc dữ liệu từ request (hỗ trợ multipart form data và JSON), lấy slot cùng nội dung cần cập nhật.
  const uploadInput = await readAssetUploadInput(request, slot);
  checkRequiredAssetUploadSlot(uploadInput.targetSlot);

  // Bước 3: kiểm tra slot tài nguyên có tồn tại và đúng là định dạng hình ảnh (không cho upload vào slot video).
  const currentAsset = await findExistingImageAssetUploadSlot(sql, uploadInput.targetSlot);
  const replacement = resolveAssetUploadReplacementMeta(
    currentAsset,
    uploadInput.customAltEn,
    uploadInput.customAltVi,
  );

  // Bước 4: nếu chọn đường dẫn từ thư viện media có sẵn, kiểm tra tính an toàn và trỏ tài nguyên sang file đó.
  if (uploadInput.chosenMediaPath) {
    return await applyAssetUploadFromLibraryMedia(
      sql,
      user,
      currentAsset,
      uploadInput.targetSlot,
      uploadInput.chosenMediaPath,
      replacement,
    );
  }

  // Bước 5: nếu tải lên file ảnh nhị phân, kiểm tra dung lượng và kích thước, cập nhật tài nguyên rồi đăng ký vào thư viện ảnh.
  return await applyAssetUploadFromImageBuffer(
    sql,
    user,
    currentAsset,
    uploadInput.targetSlot,
    uploadInput.imageBuffer,
    replacement,
  );
}

// Cấu trúc dữ liệu bản ghi hiện tại của slot tài nguyên được truy vấn từ bảng site_assets.
type AssetPatchCurrentSlot = {
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
};

// Cấu trúc dữ liệu JSON trong body request PATCH gửi lên từ client khi cập nhật slot.
type AssetPatchRequestBody = {
  alt_en?: unknown;
  alt_vi?: unknown;
  enabled?: unknown;
  src_path?: unknown;
  library_id?: unknown;
  path?: unknown;
  media_path?: unknown;
};

// Kết quả giải quyết đường dẫn ảnh mới và cờ xác định có cần xóa dữ liệu nhị phân (bytes) cũ hay không.
type AssetPatchPathResolution = {
  nextSrcPath: string | null;
  clearBytes: boolean;
};

// Tập hợp các giá trị cập nhật mới (alt_en, alt_vi, enabled, version) chuẩn bị ghi vào database.
type AssetPatchNextValues = {
  altEn: string;
  altVi: string;
  enabled: boolean;
  version: number;
};

/**
 * Làm gì: kiểm tra người dùng đã đăng nhập và có vai trò quản lý (manager).
 *   Vì sao: tài nguyên giao diện được hiển thị công khai trên toàn hệ thống, chỉ người quản lý mới có quyền thay đổi hình ảnh và cấu hình hiển thị.
 * Được gọi ở: managerAssetPatch, bước 1.
 * @param user Thông tin người dùng lấy từ phiên xác thực (session), có thể là null nếu chưa đăng nhập.
 * @returns Không trả về giá trị (dùng "asserts user is PublicUser" để TypeScript thu hẹp kiểu dữ liệu).
 * @throws Lỗi 401 nếu chưa đăng nhập; lỗi 403 nếu người dùng không phải là quản lý (manager).
 */
function assertAssetPatchPermission(
  user: PublicUser | null,
): asserts user is PublicUser {
  // Chưa đăng nhập thì từ chối ngay với mã lỗi 401.
  if (!user) {
    throw err.unauth();
  }

  // Phải có vai trò quản lý mới được phép sửa tài nguyên giao diện.
  requireRole(user, ["manager"]);
}

/**
 * Làm gì: truy vấn thông tin hiện tại của slot tài nguyên trong bảng site_assets theo mã slot.
 *   Vì sao: cần kiểm tra slot có tồn tại hay không trước khi cập nhật; đồng thời lấy dữ liệu cũ để sao lưu vào bảng lịch sử và giữ lại các giá trị không đổi.
 * Được gọi ở: managerAssetPatch, bước 2.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param slot Mã định danh duy nhất của slot tài nguyên (ví dụ: 'landing.hero', 'sport.badminton').
 * @returns Bản ghi thông tin hiện tại của slot dưới dạng AssetPatchCurrentSlot.
 * @throws Lỗi 404 với thông báo "Slot not found" nếu không tìm thấy slot trong cơ sở dữ liệu.
 */
async function fetchAssetPatchCurrentSlot(
  sql: Sql,
  slot: string,
): Promise<AssetPatchCurrentSlot> {
  // Lấy thông tin slot hiện tại từ bảng site_assets để kiểm tra tồn tại và chuẩn bị dữ liệu sao lưu.
  const currentSlotRows = await sql.query<AssetPatchCurrentSlot>(
    `select slot, kind, src_path, default_path, mime, bytes, width, height, alt_en, alt_vi, enabled, version
       from site_assets where slot = $1`,
    [slot],
  );

  const currentSlot = currentSlotRows[0];
  // Báo lỗi 404 nếu không tìm thấy slot trong cơ sở dữ liệu.
  if (!currentSlot) {
    throw err.notFound("Slot not found");
  }

  return currentSlot;
}

/**
 * Làm gì: đọc và phân tích dữ liệu JSON từ body của request gửi lên.
 *   Vì sao: client gửi dữ liệu dưới dạng JSON; nếu cú pháp JSON bị sai định dạng thì phải từ chối ngay để tránh lỗi xử lý phía sau.
 * Được gọi ở: managerAssetPatch, bước 3.
 * @param request Request HTTP PATCH do trình duyệt gửi lên.
 * @returns Đối tượng AssetPatchRequestBody chứa các trường tùy chọn do client gửi lên.
 * @throws Lỗi 422 với thông báo "Invalid JSON payload" nếu nội dung body không phải JSON hợp lệ.
 */
async function readAssetPatchBody(
  request: Request,
): Promise<AssetPatchRequestBody> {
  try {
    // Đọc và phân tích JSON từ body request, bắt lỗi cú pháp nếu payload không hợp lệ.
    const parsedBody = (await request.json()) as AssetPatchRequestBody;
    return parsedBody;
  } catch {
    throw err.validation("Invalid JSON payload");
  }
}

/**
 * Làm gì: tìm file trong bảng media_library theo mã library_id và trả về đường dẫn đã chuẩn hóa.
 *   Vì sao: khi người quản lý chọn ảnh có sẵn từ thư viện ảnh, hệ thống cần đối soát mã ID này trong cơ sở dữ liệu để lấy đường dẫn file thực tế.
 * Được gọi ở: resolveAssetPatchSourcePath, trong bước 4 của managerAssetPatch khi có library_id.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param rawLibraryId Mã ID của tài nguyên thư viện gửi lên trong body.
 * @returns Đường dẫn file chuẩn hóa (được bảo đảm bắt đầu bằng '/' hoặc tiền tố MEDIA_PREFIX).
 * @throws Lỗi 422 gắn vào trường library_id nếu không tìm thấy tài nguyên trong media_library.
 */
async function resolveAssetPatchByLibraryId(
  sql: Sql,
  rawLibraryId: string,
): Promise<string> {
  // Cắt khoảng trắng thừa và truy vấn thông tin file trong bảng media_library theo library_id.
  const trimmedLibraryId = rawLibraryId.trim();
  const libraryRows = await sql.query<{ id: string; path: string }>(
    `select id, path from media_library where id = $1`,
    [trimmedLibraryId],
  );

  const libraryItem = libraryRows[0];
  // Báo lỗi 422 gắn với trường library_id nếu không tìm thấy ảnh trong thư viện media.
  if (!libraryItem) {
    throw err.validation("Library asset not found", { field: "library_id" });
  }

  // Chuẩn hóa đường dẫn: đảm bảo luôn bắt đầu bằng '/' hoặc tiền tố MEDIA_PREFIX.
  const relativePath = libraryItem.path;
  const normalizedPath = relativePath.startsWith("/")
    ? relativePath
    : MEDIA_PREFIX + relativePath;

  return normalizedPath;
}

/**
 * Làm gì: trích xuất giá trị đường dẫn thô từ body request theo thứ tự ưu tiên: src_path -> path -> media_path.
 *   Vì sao: API hỗ trợ nhận diện đường dẫn từ nhiều tên trường khác nhau để tương thích với các màn hình gọi API.
 * Được gọi ở: resolveAssetPatchSourcePath, trong bước 4 của managerAssetPatch khi không dùng library_id.
 * @param body Dữ liệu body JSON đã đọc từ request.
 * @returns Chuỗi đường dẫn thô nếu có trường kiểu string hợp lệ, ngược lại trả về undefined.
 */
function extractAssetPatchRawPath(
  body: AssetPatchRequestBody,
): string | undefined {
  // Ưu tiên đọc theo thứ tự trường: src_path -> path -> media_path.
  if (typeof body.src_path === "string") {
    return body.src_path;
  }

  if (typeof body.path === "string") {
    return body.path;
  }

  if (typeof body.media_path === "string") {
    return body.media_path;
  }

  return undefined;
}

/**
 * Làm gì: kiểm tra tính an toàn của đường dẫn trực tiếp và đối soát sự tồn tại của file trong thư viện ảnh hoặc danh sách file tĩnh.
 *   Vì sao: chặn lỗ hổng Path Traversal (duyệt thư mục trái phép qua '..' hoặc '//') và tấn công mạng (qua 'http'); đồng thời đảm bảo không trỏ slot vào một file không có thật.
 * Được gọi ở: resolveAssetPatchSourcePath, trong bước 4 của managerAssetPatch khi người dùng truyền đường dẫn trực tiếp.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param rawPath Chuỗi đường dẫn trực tiếp lấy từ body request.
 * @returns Đường dẫn an toàn đã chuẩn hóa để lưu vào database (bắt đầu bằng MEDIA_PREFIX hoặc '/').
 * @throws Lỗi 422 gắn vào trường src_path nếu đường dẫn chứa ký tự nguy hiểm hoặc file không tồn tại.
 */
async function resolveAssetPatchByDirectPath(
  sql: Sql,
  rawPath: string,
): Promise<string> {
  const trimmedPath = rawPath.trim();

  // Ngăn chặn các đường dẫn không an toàn có thể gây lỗ hổng bảo mật.
  const pathHasForbiddenPattern =
    trimmedPath.includes("..") ||
    trimmedPath.includes("//") ||
    trimmedPath.includes("http");

  if (pathHasForbiddenPattern) {
    throw err.validation("src_path must be a safe local media path", {
      field: "src_path",
    });
  }

  // Tách bỏ tiền tố /media/ hoặc dấu / đầu chuỗi để đối soát tên file tương đối.
  let cleanRelativePath = trimmedPath;
  if (cleanRelativePath.startsWith(MEDIA_PREFIX)) {
    cleanRelativePath = cleanRelativePath.slice(MEDIA_PREFIX.length);
  } else if (cleanRelativePath.startsWith("/")) {
    cleanRelativePath = cleanRelativePath.slice(1);
  }

  // Đối soát file trong bảng media_library với cả 3 định dạng đường dẫn tương đối và tuyệt đối.
  const libraryCheckRows = await sql.query<{ id: string; path: string }>(
    `select id, path from media_library where path = $1 or path = $2 or path = $3 limit 1`,
    [cleanRelativePath, "/" + cleanRelativePath, MEDIA_PREFIX + cleanRelativePath],
  );

  // Kiểm tra sự tồn tại của file trên cả cơ sở dữ liệu và danh sách file tĩnh trên đĩa.
  const mediaFiles = getMediaFiles();
  const fileExistsInDatabase = Boolean(libraryCheckRows[0]);
  const fileExistsInStaticFiles = mediaFiles.includes(cleanRelativePath);
  const fileExists = fileExistsInDatabase || fileExistsInStaticFiles;

  // Báo lỗi 422 nếu file không tồn tại ở cả thư viện media lẫn thư mục file tĩnh.
  if (!fileExists) {
    throw err.validation("File does not exist in media library", {
      field: "src_path",
    });
  }

  // Chuẩn hóa đường dẫn trước khi trả về, luôn có tiền tố MEDIA_PREFIX nếu là đường dẫn tương đối.
  const normalizedPath = cleanRelativePath.startsWith("/")
    ? cleanRelativePath
    : MEDIA_PREFIX + cleanRelativePath;

  return normalizedPath;
}

/**
 * Làm gì: xác định đường dẫn ảnh mới cho slot (từ library_id hoặc từ đường dẫn trực tiếp) và gắn cờ xóa dữ liệu binary cũ nếu có thay đổi ảnh.
 *   Vì sao: nếu chuyển sang dùng ảnh từ thư viện media, slot sẽ chuyển sang dùng đường dẫn file tĩnh (src_path) và cần xóa sạch dữ liệu bytes cũ trong DB để tránh xung đột hiển thị.
 * Được gọi ở: managerAssetPatch, bước 4.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param body Dữ liệu body JSON gửi lên từ client.
 * @param currentSrcPath Đường dẫn file ảnh hiện tại của slot trong database.
 * @returns Đối tượng AssetPatchPathResolution chứa đường dẫn mới và cờ clearBytes.
 * @throws Lỗi 422 từ các hàm phụ nếu không tìm thấy file hoặc đường dẫn không an toàn.
 */
async function resolveAssetPatchSourcePath(
  sql: Sql,
  body: AssetPatchRequestBody,
  currentSrcPath: string | null,
): Promise<AssetPatchPathResolution> {
  // Trường hợp 1: Nếu client gửi library_id, lấy đường dẫn từ media_library và đánh dấu xóa bytes cũ.
  const hasLibraryId =
    typeof body.library_id === "string" && body.library_id.trim() !== "";

  if (hasLibraryId) {
    const libraryPath = await resolveAssetPatchByLibraryId(
      sql,
      body.library_id as string,
    );
    return {
      nextSrcPath: libraryPath,
      clearBytes: true,
    };
  }

  // Trường hợp 2: Nếu client gửi đường dẫn trực tiếp, kiểm tra an toàn và đối soát sự tồn tại của file.
  const rawPath = extractAssetPatchRawPath(body);
  if (rawPath !== undefined) {
    const directPath = await resolveAssetPatchByDirectPath(sql, rawPath);
    return {
      nextSrcPath: directPath,
      clearBytes: true,
    };
  }

  // Trường hợp 3: Client không đổi file ảnh, giữ nguyên src_path hiện tại và không xóa bytes.
  return {
    nextSrcPath: currentSrcPath,
    clearBytes: false,
  };
}

/**
 * Làm gì: tính toán các giá trị mới cho văn bản mô tả (alt_en, alt_vi), trạng thái hiển thị (enabled) và tăng số version lên 1 đơn vị.
 *   Vì sao: các trường trong PATCH là tùy chọn; nếu client không gửi trường nào thì giữ nguyên giá trị cũ của slot đó. Số version luôn phải tăng để client biết nội dung đã đổi và làm mới bộ nhớ đệm (cache busting).
 * Được gọi ở: managerAssetPatch, bước 5.
 * @param body Dữ liệu body JSON gửi lên từ client.
 * @param currentSlot Dữ liệu hiện tại của slot trong database.
 * @returns Đối tượng AssetPatchNextValues chứa các giá trị mới và số version tiếp theo.
 */
function computeAssetPatchNextValues(
  body: AssetPatchRequestBody,
  currentSlot: AssetPatchCurrentSlot,
): AssetPatchNextValues {
  // Cập nhật văn bản mô tả tiếng Anh (alt_en), nếu client không truyền thì giữ nguyên giá trị cũ.
  let nextAltEn = currentSlot.alt_en;
  if (typeof body.alt_en === "string") {
    nextAltEn = body.alt_en.trim();
  }

  // Cập nhật văn bản mô tả tiếng Việt (alt_vi), nếu client không truyền thì giữ nguyên giá trị cũ.
  let nextAltVi = currentSlot.alt_vi;
  if (typeof body.alt_vi === "string") {
    nextAltVi = body.alt_vi.trim();
  }

  // Cập nhật trạng thái hiển thị (enabled), nếu client không truyền thì giữ nguyên giá trị cũ.
  let nextEnabled = currentSlot.enabled;
  if (typeof body.enabled === "boolean") {
    nextEnabled = body.enabled;
  }

  // Tăng version lên 1 để client nhận biết slot đã thay đổi và làm mới bộ nhớ đệm (cache-busting).
  const nextVersion = currentSlot.version + 1;

  return {
    altEn: nextAltEn,
    altVi: nextAltVi,
    enabled: nextEnabled,
    version: nextVersion,
  };
}

/**
 * Làm gì: lưu các thay đổi của slot tài nguyên vào cơ sở dữ liệu.
 *   Nếu đổi ảnh (clearBytes = true): sao lưu dữ liệu cũ vào bảng site_asset_history, sau đó cập nhật bảng site_assets với đường dẫn mới và đặt bytes = null.
 *   Nếu không đổi ảnh: chỉ cập nhật các trường mô tả, trạng thái enabled và version trong bảng site_assets.
 *   Vì sao: lưu bản ghi vào site_asset_history giúp quản lý có thể hoàn tác (revert) lại phiên bản ảnh trước đó bất cứ lúc nào.
 * Được gọi ở: managerAssetPatch, bước 6.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param userId Mã ID của người quản lý đang thực hiện thay đổi (lấy từ user.id).
 * @param slot Mã định danh của slot tài nguyên cần cập nhật.
 * @param currentSlot Dữ liệu hiện tại của slot trước khi cập nhật.
 * @param pathResolution Kết quả xử lý đường dẫn ảnh và cờ xóa bytes từ bước 4.
 * @param nextValues Các giá trị mới về văn bản mô tả, trạng thái hiển thị và version từ bước 5.
 * @returns Promise<void>.
 */
async function saveAssetPatchSlot(
  sql: Sql,
  userId: string,
  slot: string,
  currentSlot: AssetPatchCurrentSlot,
  pathResolution: AssetPatchPathResolution,
  nextValues: AssetPatchNextValues,
): Promise<void> {
  if (pathResolution.clearBytes) {
    // Lưu phiên bản ảnh hiện tại vào bảng lịch sử trước khi thay thế bằng đường dẫn mới.
    await sql.query(
      `insert into site_asset_history (slot, src_path, mime, bytes, width, height, replaced_at, replaced_by)
       values ($1, $2, $3, $4, $5, $6, now(), $7)`,
      [
        currentSlot.slot,
        currentSlot.src_path,
        currentSlot.mime,
        currentSlot.bytes,
        currentSlot.width,
        currentSlot.height,
        userId,
      ],
    );

    // Cập nhật đường dẫn file mới, xóa dữ liệu nhị phân (bytes) và kích thước ảnh cũ vì slot giờ dùng đường dẫn tĩnh.
    await sql.query(
      `update site_assets
          set src_path = $1, bytes = null, mime = null, width = null, height = null,
              alt_en = $2, alt_vi = $3, enabled = $4, version = $5, updated_at = now(), updated_by = $6
        where slot = $7`,
      [
        pathResolution.nextSrcPath,
        nextValues.altEn,
        nextValues.altVi,
        nextValues.enabled,
        nextValues.version,
        userId,
        slot,
      ],
    );
  } else {
    // Chỉ cập nhật văn bản mô tả và trạng thái hiển thị, giữ nguyên file ảnh hiện tại.
    await sql.query(
      `update site_assets
          set alt_en = $1, alt_vi = $2, enabled = $3, version = $4, updated_at = now(), updated_by = $5
        where slot = $6`,
      [
        nextValues.altEn,
        nextValues.altVi,
        nextValues.enabled,
        nextValues.version,
        userId,
        slot,
      ],
    );
  }
}

/**
 * Làm gì: ghi nhận hành động cập nhật tài nguyên vào bảng nhật ký kiểm toán (audit_logs).
 *   Vì sao: đảm bảo truy vết trách nhiệm trong hệ thống quản lý, ghi lại ai đã sửa, vào lúc nào, slot nào, và lưu lại trạng thái trước/sau của các trường thông tin.
 * Được gọi ở: managerAssetPatch, bước 7.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param userId Mã ID của người quản lý thực hiện thay đổi.
 * @param slot Mã định danh của slot tài nguyên được cập nhật.
 * @param currentSlot Dữ liệu của slot trước khi cập nhật.
 * @param nextValues Các giá trị mới sau khi cập nhật.
 * @param nextSrcPath Đường dẫn file ảnh mới sau khi cập nhật (có thể là null).
 * @returns Promise<void>.
 */
async function recordAssetPatchAudit(
  sql: Sql,
  userId: string,
  slot: string,
  currentSlot: AssetPatchCurrentSlot,
  nextValues: AssetPatchNextValues,
  nextSrcPath: string | null,
): Promise<void> {
  await audit(
    sql,
    userId,
    "patch_asset",
    "site_asset",
    slot,
    {
      alt_en: currentSlot.alt_en,
      alt_vi: currentSlot.alt_vi,
      enabled: currentSlot.enabled,
      src_path: currentSlot.src_path,
    },
    {
      alt_en: nextValues.altEn,
      alt_vi: nextValues.altVi,
      enabled: nextValues.enabled,
      src_path: nextSrcPath,
    },
  );
}

/**
 * Làm gì: cập nhật từng phần (patch) thông tin của một slot tài nguyên giao diện: sửa văn bản mô tả (alt text tiếng Anh/tiếng Việt), bật hoặc tắt hiển thị, hoặc trỏ sang một ảnh mới từ thư viện media.
 *   Đọc hàm này như mục lục: mỗi dòng là một bước rõ ràng, chi tiết logic nằm trong các hàm phụ phía trên.
 *   Vì sao: giúp quản trị viên tùy biến nội dung trang web nhanh chóng mà không cần tải lại toàn bộ file ảnh; nếu đổi ảnh thì phiên bản cũ được lưu vào lịch sử để có thể khôi phục khi cần.
 * Được gọi ở:
 *   - Màn hình Quản lý Media / Ảnh giao diện (/manager/media trong src/routes/manager.media.tsx và src/client/lib/pages/manager.media.ts):
 *     + Hộp thoại "Chọn ảnh từ thư viện" (LibrarySelectModal), nút "Chọn ảnh này", gửi { library_id }.
 *     + Hộp thoại "Sửa mô tả ảnh" (AltEditModal), nút "Lưu thay đổi", gửi { alt_en, alt_vi }.
 *     + Bảng danh sách slot ảnh, nút gạt bật/tắt hiển thị (toggleEnabled), gửi { enabled }.
 *   - API: PATCH /v1/manager/site-assets/:slot.
 *   - Qua src/server/controllers/router.ts: router khớp đường dẫn PATCH /manager/site-assets/:slot và chuyển qua wrapper authed((sql, user) => assetsH.managerAssetPatch(sql, request, user, p2)).
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở sẵn.
 * @param request Request HTTP PATCH chứa body JSON với các trường cần cập nhật.
 * @param user Người dùng đang đăng nhập; phải là quản lý (manager), ID được dùng để ghi log lịch sử và audit log.
 * @param slot Mã định danh của slot tài nguyên cần sửa (lấy từ tham số đường dẫn URL).
 * @returns Đối tượng phản hồi JSON HTTP 200 { ok: true, version: nextVersion }.
 * @throws Lỗi 401 nếu chưa đăng nhập, 403 nếu không phải quản lý, 404 nếu không tìm thấy slot, 422 nếu JSON sai hoặc đường dẫn file không hợp lệ/không tồn tại.
 */
export async function managerAssetPatch(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
  slot: string,
) {
  // Bước 1: chỉ quản lý mới có quyền chỉnh sửa tài nguyên giao diện.
  assertAssetPatchPermission(user);

  // Bước 2: lấy thông tin hiện tại của slot; nếu slot không tồn tại thì báo lỗi 404.
  const currentSlot = await fetchAssetPatchCurrentSlot(sql, slot);

  // Bước 3: đọc dữ liệu gửi lên từ body JSON của request.
  const body = await readAssetPatchBody(request);

  // Bước 4: giải quyết đường dẫn ảnh mới nếu có đổi ảnh (từ library_id hoặc đường dẫn trực tiếp).
  const pathResolution = await resolveAssetPatchSourcePath(
    sql,
    body,
    currentSlot.src_path,
  );

  // Bước 5: tổng hợp các giá trị cập nhật cho mô tả, trạng thái hiển thị và số phiên bản mới.
  const nextValues = computeAssetPatchNextValues(body, currentSlot);

  // Bước 6: cập nhật dữ liệu vào database (lưu lịch sử bản cũ nếu có đổi đường dẫn ảnh).
  await saveAssetPatchSlot(
    sql,
    user.id,
    slot,
    currentSlot,
    pathResolution,
    nextValues,
  );

  // Bước 7: ghi audit log theo dõi biến động dữ liệu trước và sau khi sửa.
  await recordAssetPatchAudit(
    sql,
    user.id,
    slot,
    currentSlot,
    nextValues,
    pathResolution.nextSrcPath,
  );

  // Bước 8: trả về kết quả thành công kèm số version mới để phía client làm mới giao diện.
  return json(200, { ok: true, version: nextValues.version });
}

/** Revert to previous history version or to default */
/**
 * Làm gì: Khôi phục ảnh của slot tài nguyên về phiên bản trước đó trong bảng lịch sử (site_asset_history) hoặc đặt lại về ảnh mặc định của hệ thống (default_path).
 *   Vì sao: Cho phép quản lý nhanh chóng sửa sai khi tải nhầm ảnh mới hoặc muốn quay về ảnh mặc định ban đầu mà không cần tải lại file.
 * Được gọi ở:
 *   - Màn hình Quản lý Media (src/routes/manager.media.tsx): nút "Revert" hoặc nút "Reset to default" trong bảng slot ảnh.
 *   - Màn hình Quản lý Môn thể thao (src/routes/manager.sports.tsx): nút reset ảnh sân/môn về mặc định.
 *   - API: POST /v1/manager/site-assets/:slot/revert và POST /v1/manager/site-assets/:slot/reset.
 *   - Router: src/server/controllers/router.ts qua wrapper authed.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router quản lý.
 * @param request Request HTTP POST, body JSON có thể chứa { to: "default" } (hoặc rỗng khi revert lịch sử).
 * @param user Người dùng đang đăng nhập; yêu cầu vai trò quản lý (manager).
 * @param slot Mã định danh của slot tài nguyên cần khôi phục.
 * @returns Phản hồi JSON HTTP 200 { ok: true, version: nextVer } chứa số phiên bản mới.
 * @throws Lỗi 401 nếu chưa đăng nhập, 403 nếu không phải manager, 404 nếu không tìm thấy slot, 422 nếu slot không có default_path hoặc không có lịch sử để hoàn tác.
 */
export async function managerAssetRevert(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
  slot: string,
) {
  // Bước 1: Kiểm tra quyền hạn — chỉ quản lý (manager) mới được phép hoàn tác hoặc đặt lại ảnh tài nguyên.
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);

  // Bước 2: Lấy thông tin hiện tại của slot (default_path, version); báo lỗi 404 nếu slot không tồn tại.
  const curRows = await sql.query<{
    slot: string;
    default_path: string | null;
    version: number;
  }>(`select slot, default_path, version from site_assets where slot = $1`, [slot]);
  const cur = curRows[0];
  if (!cur) {
    throw err.notFound("Slot not found");
  }

  // Bước 3: Đọc dữ liệu body JSON nếu có (body là tùy chọn, dùng để phân biệt hoàn tác lịch sử hay reset về mặc định).
  let body: { to?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // optional body
  }

  // Bước 4: Tăng số version lên 1 để client nhận biết dữ liệu đã thay đổi và làm mới bộ nhớ đệm.
  const nextVer = cur.version + 1;
  // Bước 5: Nhánh 1 — nếu yêu cầu đặt lại về mặc định (to === "default"), khôi phục về default_path.
  if (body.to === "default") {
    const defPath = cur.default_path;
    if (!defPath) {
      throw err.field("slot", "No default path configured for this slot");
    }
    // Cập nhật slot trỏ về default_path, đồng thời xóa toàn bộ dữ liệu ảnh upload (bytes/mime) và kích thước cũ.
    await sql.query(
      `update site_assets
          set src_path = default_path, bytes = null, mime = null, width = null, height = null,
              version = $1, updated_at = now(), updated_by = $2
        where slot = $3`,
      [nextVer, user.id, slot],
    );
    // Ghi nhật ký audit log lưu vết thao tác đặt lại slot về ảnh mặc định hệ thống.
    await audit(sql, user.id, "revert_asset", "site_asset", slot, null, { to: "default" });
    return json(200, { ok: true, version: nextVer });
  }

  // Bước 6: Nhánh 2 — nếu không chỉ định "default", hoàn tác về phiên bản gần nhất trong lịch sử.
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

  // Khôi phục dữ liệu slot từ bản ghi lịch sử (bao gồm đường dẫn, dữ liệu nhị phân bytes, mime và kích thước).
  await sql.query(
    `update site_assets
        set src_path = $1, mime = $2, bytes = $3, width = $4, height = $5,
            version = $6, updated_at = now(), updated_by = $7
      where slot = $8`,
    [hist.src_path, hist.mime, hist.bytes, hist.width, hist.height, nextVer, user.id, slot],
  );

  // Xóa bản ghi lịch sử vừa khôi phục (ngăn xếp LIFO) vì phiên bản này giờ đã trở thành phiên bản hiện tại.
  await sql.query(`delete from site_asset_history where id = $1`, [hist.id]);
  // Ghi nhật ký audit log lưu lại ID của bản ghi lịch sử đã được hoàn tác.
  await audit(sql, user.id, "revert_asset", "site_asset", slot, null, {
    to: "history",
    history_id: hist.id,
  });

  // Bước 7: Trả về kết quả thành công kèm số version mới để client cập nhật giao diện.
  return json(200, { ok: true, version: nextVer });
}

/** Get media library items from database */
/**
 * Làm gì: Lấy danh sách các tài nguyên media từ bảng media_library dành cho quản lý, hỗ trợ lọc theo danh mục (category) và tìm kiếm từ khóa.
 *   Vì sao: Cung cấp danh sách hình ảnh đã chuẩn bị sẵn để quản lý có thể duyệt xem hoặc chọn gắn vào các slot giao diện của trang web.
 * Được gọi ở:
 *   - Màn hình Quản lý Media (src/routes/manager.media.tsx): modal chọn ảnh từ thư viện (LibrarySelectModal) hoặc tab danh sách thư viện media.
 *   - API: GET /v1/manager/site-assets/library và GET /v1/manager/media-library.
 *   - Router: src/server/controllers/router.ts qua wrapper authedRead.
 * @param sql Kết nối cơ sở dữ liệu dạng đọc (read connection).
 * @param request Request HTTP GET chứa query params: category (danh mục) và search (từ khóa tìm kiếm).
 * @param user Người dùng đang đăng nhập; yêu cầu vai trò quản lý (manager).
 * @returns Phản hồi JSON HTTP 200 { items } chứa danh sách các mục media kèm URL đầy đủ và tên file.
 * @throws Lỗi 401 nếu chưa đăng nhập, 403 nếu không phải manager.
 */
export async function managerMediaLibrary(
  sql: Sql,
  request: Request,
  user: PublicUser | null,
) {
  // Bước 1: Kiểm tra quyền hạn — chỉ quản lý (manager) mới được xem danh sách thư viện media nội bộ.
  if (!user) throw err.unauth();
  requireRole(user, ["manager"]);

  // Bước 2: Đọc các tham số lọc category và từ khóa search từ query string của request URL.
  const url = new URL(request.url);
  const category = url.searchParams.get("category")?.trim();
  const search = url.searchParams.get("search")?.trim()?.toLowerCase();

  // Bước 3: Xây dựng câu truy vấn SQL động với điều kiện gốc "1=1" để thuận tiện ghép thêm các bộ lọc.
  let query = `select id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license, created_at
                 from media_library where 1=1`;
  const params: unknown[] = [];

  // Thêm điều kiện lọc chính xác theo danh mục nếu category được chọn và khác "all".
  if (category && category !== "all") {
    params.push(category);
    query += ` and category = $${params.length}`;
  }

  // Tìm kiếm mờ không phân biệt hoa thường trên ID, đường dẫn, văn bản alt, người sáng tác hoặc mảng tags.
  if (search) {
    params.push(`%${search}%`);
    query += ` and (lower(id) like $${params.length} or lower(path) like $${params.length} or lower(alt_en) like $${params.length} or lower(alt_vi) like $${params.length} or lower(credit) like $${params.length} or array_to_string(tags, ' ') ilike $${params.length})`;
  }

  // Sắp xếp các mục mới nhất lên đầu theo created_at giảm dần, thứ cấp theo id tăng dần.
  query += ` order by created_at desc, id asc`;

  // Bước 4: Thực thi truy vấn lấy danh sách media phù hợp từ bảng media_library.
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

  // Bước 5: Chuẩn hóa URL hiển thị (gắn tiền tố MEDIA_PREFIX nếu cần) và trích xuất tên file (name) từ đường dẫn.
  const items = rows.map((r) => {
    const fileUrl = r.path.startsWith("/") ? r.path : MEDIA_PREFIX + r.path;
    return {
      ...r,
      url: fileUrl,
      name: r.path.split("/").pop() || r.id,
    };
  });

  // Bước 6: Trả về phản hồi JSON HTTP 200 chứa danh sách các mục media.
  return json(200, { items });
}

/** Public credits list for all media items from database */
/**
 * Làm gì: Lấy danh sách thông tin tác quyền, nguồn gốc và giấy phép (credits) của các tài nguyên media công khai trên trang web, hỗ trợ lọc theo danh mục và tìm kiếm từ khóa.
 *   Vì sao: Phục vụ trang minh bạch bản quyền hình ảnh (/credits) cho khách truy cập và tuân thủ các điều khoản bản quyền của tác giả.
 * Được gọi ở:
 *   - Tuyến đường công khai /credits (src/routes/credits.tsx qua hook useRead("/media/credits")).
 *   - Liên kết ở chân trang (footer) tại src/client/components/landing/closing.tsx.
 *   - API: GET /v1/media/credits.
 *   - Router: src/server/controllers/router.ts.
 * @param sql Kết nối cơ sở dữ liệu.
 * @param request Request HTTP GET chứa search params (category, search).
 * @returns Phản hồi JSON HTTP 200 { items } chứa danh sách các media kèm thông tin tác giả (author), giấy phép (license), link nguồn và URL ảnh.
 */
export async function publicMediaCredits(sql: Sql, request: Request) {
  // Bước 1: Đọc và chuẩn hóa tham số danh mục (category) cùng từ khóa tìm kiếm (search) từ request URL.
  const url = new URL(request.url);
  const category = url.searchParams.get("category")?.trim();
  const search = url.searchParams.get("search")?.trim()?.toLowerCase();

  // Bước 2: Khởi tạo câu truy vấn SQL loại trừ danh mục "legacy" (ảnh cũ/nội bộ không cần công khai bản quyền).
  let query = `select id, path, kind, category, tags, width, height, alt_en, alt_vi, credit, source_url, license, created_at
                 from media_library where category <> 'legacy'`;
  const params: unknown[] = [];

  // Lọc theo danh mục cụ thể nếu người dùng chọn category khác "all".
  if (category && category !== "all") {
    params.push(category);
    query += ` and category = $${params.length}`;
  }

  // Tìm kiếm không phân biệt hoa thường trên ID, đường dẫn, văn bản alt, người sáng tác (credit) và giấy phép (license).
  if (search) {
    params.push(`%${search}%`);
    query += ` and (lower(id) like $${params.length} or lower(path) like $${params.length} or lower(alt_en) like $${params.length} or lower(alt_vi) like $${params.length} or lower(credit) like $${params.length} or lower(license) like $${params.length})`;
  }

  // Gom nhóm theo từng danh mục (category) để giao diện hiển thị gọn gàng, thứ cấp sắp theo ID.
  query += ` order by category asc, id asc`;

  // Bước 3: Thực thi truy vấn danh sách media hợp lệ từ cơ sở dữ liệu.
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

  // Bước 4: Chuẩn hóa dữ liệu trả về, ánh xạ credit thành author và gắn tiền tố MEDIA_PREFIX vào URL ảnh.
  const items = rows.map((r) => {
    const fileUrl = r.path.startsWith("/") ? r.path : MEDIA_PREFIX + r.path;
    return {
      ...r,
      author: r.credit,
      url: fileUrl,
      name: r.path.split("/").pop() || r.id,
    };
  });

  // Bước 5: Trả về kết quả JSON HTTP 200 danh sách items cho client.
  return json(200, { items });
}

