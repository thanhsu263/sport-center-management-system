/**
 * File: src/server/controllers/router.ts
 * Vai trò: Bộ điều phối (router) trung tâm tiếp nhận và phân luồng mọi HTTP request đến backend từ các route catch-all /api/* và /v1/*.
 * Vị trí trong app: Đứng sau TanStack Router (src/routes/api.$.ts, src/routes/v1.$.ts); chịu trách nhiệm kiểm tra phiên đăng nhập (session), áp dụng giao dịch (transaction), kiểm soát chống trùng lặp (idempotency) và ủy quyền cho từng handler xử lý theo nghiệp vụ cụ thể.
 */
import { getSql } from "@/server/data/db";
import { ApiError, err, handleError, json } from "./errors";
import { withIdempotency } from "./helpers";
import { startJobLoop } from "../data/jobs";
import { authFromRequest, optionalAuth, requireRole, staffRoles, type PublicUser } from "./session";
import { withTx } from "./tx";
import * as authH from "./handlers/auth";
import * as googleH from "./handlers/google";
import * as memberH from "./handlers/members";
import * as planH from "./handlers/plans";
import * as bookH from "./handlers/bookings";
import * as classH from "./handlers/classes";
import * as deskH from "./handlers/desk";
import * as reportH from "./handlers/reports";
import * as onlineH from "./handlers/online";
import * as opsH from "./handlers/ops";
import * as staffH from "./handlers/staff";
import * as trainH from "./handlers/training";
import * as checkinH from "./handlers/checkin";
import * as promoH from "./handlers/promos";
import * as attH from "./handlers/attendance";
import * as xH from "./handlers/extras";
import * as assetsH from "./handlers/assets";
import * as courtH from "./handlers/courts";
import * as sportsH from "./handlers/sports";
import * as chatH from "./handlers/chat";
import * as avatarH from "./handlers/avatar";
import * as certH from "./handlers/certificates";
import { liveStreamHandler } from "./handlers/live";

type Result = { status: number; body: unknown };

/**
 * Làm gì: Phân tích Request URL, tách bỏ tiền tố /v1 hoặc /api, chuẩn hóa HTTP method thành chữ hoa và tách đường dẫn thành các segment để phục vụ định tuyến.
 * Được gọi ở: src/server/controllers/router.ts (trong hàm dispatch).
 * @param request HTTP Request gửi đến cần phân tích đường dẫn và method.
 * @returns Đối tượng gồm method in hoa, mảng các phần đường dẫn parts, và đối tượng URL đầy đủ.
 */
function pathOf(request: Request): { method: string; parts: string[]; url: URL } {
  const url = new URL(request.url);
  // Bỏ tiền tố /v1 hoặc /api và dấu gạch chéo cuối để trích xuất các segment đường dẫn chuẩn
  const raw = url.pathname.replace(/^\/(?:v1|api)\/?/, "").replace(/\/+$/, "");
  const parts = raw ? raw.split("/") : [];
  return { method: request.method.toUpperCase(), parts, url };
}

/**
 * Làm gì: Bộ điều phối trung tâm cho toàn bộ API backend; kiểm tra HTTP method và các đoạn đường dẫn để phân luồng request đến handler phù hợp, đồng thời quản lý xác thực phiên đăng nhập, giao dịch cơ sở dữ liệu và kiểm soát trùng lặp.
 * Được gọi ở: src/server/controllers/router.ts (trong hàm handleApi).
 * @param request HTTP Request gửi đến từ client.
 * @returns Phản hồi HTTP dạng Response (ví dụ SSE stream) hoặc Result chứa status và body.
 * @throws ApiError Ném lỗi NOT_FOUND nếu không khớp route nào, hoặc các mã lỗi xác thực/nghiệp vụ khác từ handler.
 */
async function dispatch(request: Request): Promise<Response | Result> {
  // Bước 1: Kích hoạt background job loop xử lý tác vụ định kỳ (hết hạn giữ chỗ, nhắc nhở...) và phân tích đường dẫn URL
  startJobLoop();
  const { method, parts, url } = pathOf(request);
  const p0 = parts[0] ?? "";
  const p1 = parts[1] ?? "";
  const p2 = parts[2] ?? "";
  const p3 = parts[3] ?? "";

  /**
   * Làm gì: Helper bọc thực thi nghiệp vụ trong một transaction kèm kiểm tra khóa chống lặp (Idempotency-Key) nhằm ngăn chặn việc gửi trùng lặp request khi thay đổi dữ liệu.
   * Được gọi ở: Các route tạo mới hoặc sửa đổi dữ liệu quan trọng trong hàm dispatch (ví dụ POST /series).
   * @param userId ID người dùng thực hiện thao tác (hoặc null nếu thao tác ẩn danh).
   * @param fn Hàm callback chứa logic nghiệp vụ cần thực thi trong database.
   * @returns Kết quả Result trả về từ handler sau khi đã đảm bảo tính lũy kế (idempotency).
   */
  const idem = (userId: string | null, fn: () => Promise<Result>) =>
    withTx(async (sql) => {
      const r = await withIdempotency(sql, request, userId, true, fn);
      return r;
    });

  // Bước 2: Xử lý luồng sự kiện thời gian thực (Server-Sent Events) cho các màn hình cần cập nhật tức thì (live status, lịch thi đấu, bảng điểm)
  // Server-Sent Events live update stream
  if (method === "GET" && p0 === "live" && !p1) {
    const sql = await getSql();
    // Lấy thông tin user nếu có token hợp lệ; không bắt buộc đăng nhập để khách vãng lai vẫn nhận được cập nhật công khai
    const user = await optionalAuth(sql, request);
    return liveStreamHandler(request, sql, user);
  }

  // Bước 3: Định tuyến tín hiệu WebRTC (Signaling Relay) phục vụ tính năng cuộc gọi video/âm thanh trực tiếp giữa các người dùng
  // WebRTC Signaling Relay
  if (p0 === "rtc" && !p1) {
    if (method === "GET") {
      // Polling nhận tín hiệu RTC chờ xử lý của người dùng hiện tại
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.rtcPollHandler(sql, user, request);
        return { status: 200, body: data };
      });
    }
    // Gửi tín hiệu WebRTC (SDP offer/answer hoặc ICE candidate) đến người nhận
    if (method === "POST") {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.rtcSignalHandler(sql, user, request);
        return { status: 200, body: data };
      });
    }
  }

  // Bước 4: Xử lý các endpoint chat hai chiều (Two-way Chat) giữa hội viên, lễ tân và huấn luyện viên
  // Two-way Chat
  if (p0 === "conversations") {
    // GET /conversations/contacts: Tìm kiếm danh bạ hội viên hoặc nhân viên để bắt đầu hội thoại mới
    if (method === "GET" && p1 === "contacts" && !p2) {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        return { status: 200, body: await chatH.searchContacts(sql, user, url) };
      });
    }
    // GET /conversations: Lấy danh sách các cuộc hội thoại mà người dùng hiện tại tham gia
    if (method === "GET" && !p1) {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.listConversations(sql, user);
        return { status: 200, body: data };
      });
    }
    // POST /conversations: Mở cuộc hội thoại mới hoặc lấy lại cuộc hội thoại đã tồn tại giữa hai người dùng
    if (method === "POST" && !p1) {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.createOrGetConversation(sql, user, request);
        return { status: 201, body: data };
      });
    }
    if (p1) {
      const convId = p1;
      // GET /conversations/:id/messages: Lấy lịch sử tin nhắn trong một cuộc hội thoại kèm phân trang theo thời gian
      if (method === "GET" && p2 === "messages") {
        return withTx(async (sql) => {
          const user = await authFromRequest(sql, request);
          const data = await chatH.listMessages(sql, user, convId, url);
          return { status: 200, body: data };
        });
      }
      // POST /conversations/:id/messages: Gửi tin nhắn mới vào cuộc hội thoại
      if (method === "POST" && p2 === "messages") {
        return withTx(async (sql) => {
          const user = await authFromRequest(sql, request);
          const data = await chatH.sendMessage(sql, user, convId, request);
          return { status: 201, body: data };
        });
      }
      // POST /conversations/:id/read: Đánh dấu tất cả tin nhắn trong cuộc hội thoại là đã đọc
      if (method === "POST" && p2 === "read") {
        return withTx(async (sql) => {
          const user = await authFromRequest(sql, request);
          const data = await chatH.markConversationRead(sql, user, convId);
          return { status: 200, body: data };
        });
      }
    }
  }

  // Bước 5: Endpoint kiểm tra trạng thái hoạt động của server (Health Check) không yêu cầu kết nối DB
  // "Is the server there?" — what the connection banner's retry button asks. No session and no
  // database on purpose: it answers whenever the app itself is running, which is the whole question.
  if (method === "GET" && p0 === "health" && !p1) {
    return { status: 200, body: { ok: true } };
  }

  // Bước 6: Các endpoint xác thực công khai (Public Auth) không cần đăng nhập trước
  // Public auth
  // Đăng ký tài khoản hội viên mới qua email và mật khẩu
  if (method === "POST" && p0 === "auth" && p1 === "register") {
    return withTx((sql) => authH.register(sql, request));
  }
  // Xác thực mã OTP gửi về email để hoàn tất đăng ký hoặc kích hoạt tài khoản
  if (method === "POST" && p0 === "auth" && p1 === "otp" && p2 === "verify") {
    return withTx((sql) => authH.verifyOtp(sql, request));
  }
  // Đăng nhập hệ thống bằng email và mật khẩu
  if (method === "POST" && p0 === "auth" && p1 === "login") {
    return withTx((sql) => authH.login(sql, request));
  }
  // Trả về Google Client ID công khai để trình duyệt khởi tạo nút đăng nhập Google
  if (method === "GET" && p0 === "auth" && p1 === "google" && !p2) {
    return googleH.googleConfig();
  }
  // Đăng nhập hoặc tạo mới tài khoản bằng Google ID token được client gửi lên
  if (method === "POST" && p0 === "auth" && p1 === "google" && !p2) {
    return withTx((sql) => googleH.googleLogin(sql, request));
  }
  // Bước 7: Webhook thanh toán trực tuyến payOS và khôi phục mật khẩu
  /*
   * payOS calling to say a link was paid.
   *
   * Public because payOS carries no session, and deliberately NOT wrapped in
   * `idem()`: that helper requires an `Idempotency-Key` header and throws
   * without one, which payOS has no way to send. Replay safety comes from the
   * unique index on `(provider, provider_txn_id)` and from the payment's own
   * status, not from a header.
   */
  // The order-sequence high-water mark, readable without a session: whoever is
  // migrating the database needs it precisely when nobody can sign in yet.
  if (method === "GET" && p0 === "payments" && p1 === "online" && p2 === "sequence") {
    return withTx((sql) => onlineH.onlineSequence(sql));
  }
  if (method === "POST" && p0 === "payments" && p1 === "online" && p2 === "webhook") {
    return withTx((sql) => onlineH.payosWebhook(sql, request));
  }
  // Yêu cầu đặt lại mật khẩu: sinh mã OTP gửi đến email người dùng
  if (method === "POST" && p0 === "auth" && p1 === "password" && p2 === "forgot") {
    return withTx((sql) => authH.forgot(sql, request));
  }

  // Bước 8: Các API tra cứu dữ liệu công khai (danh mục gói tập, sân bãi, lớp học, bảng giá, media, chứng chỉ)
  // Lấy danh sách các gói tập hội viên đang phát hành (kèm trạng thái đăng ký nếu user đã đăng nhập)
  if (method === "GET" && p0 === "plans" && !p1) {
    const sql = await getSql();
    const user = await optionalAuth(sql, request);
    return planH.plansList(sql, user);
  }
  // Lấy danh sách sân thể thao và trạng thái hoạt động công khai
  if (method === "GET" && p0 === "courts" && !p1) {
    const sql = await getSql();
    return bookH.courtsList(sql);
  }
  // Lấy danh sách các lớp học nhóm đang mở đăng ký (hỗ trợ lọc theo môn, ngày)
  if (method === "GET" && p0 === "classes" && !p1) {
    const sql = await getSql();
    const user = await optionalAuth(sql, request);
    return classH.classesList(sql, request, user);
  }
  // Lấy bảng quy tắc giá dịch vụ theo khung giờ và ngày trong tuần
  if (method === "GET" && p0 === "price-rules" && !p1) {
    const sql = await getSql();
    return deskH.priceRulesGet(sql);
  }
  // Lấy danh sách tài nguyên hình ảnh/banner tĩnh của hệ thống
  if (method === "GET" && p0 === "site-assets" && !p1) {
    const sql = await getSql();
    return assetsH.siteAssetsList(sql);
  }
  // Tải tệp hình ảnh/tài nguyên tĩnh theo ID tài nguyên
  if (method === "GET" && p0 === "site-assets" && p1 && p2 === "file") {
    const sql = await getSql();
    return assetsH.siteAssetGetFile(sql, p1);
  }
  // Trả về thông tin bản quyền và nguồn gốc hình ảnh media sử dụng trên trang
  if (method === "GET" && p0 === "media" && p1 === "credits") {
    const sql = await getSql();
    return assetsH.publicMediaCredits(sql, request);
  }
  // Lấy danh mục các môn thể thao (badminton, pickleball, tennis...) được hỗ trợ
  if (method === "GET" && p0 === "sports" && !p1) {
    const sql = await getSql();
    return sportsH.publicSportsList(sql);
  }

  // Lấy danh sách công khai các bằng cấp, chứng chỉ chuyên môn của đội ngũ huấn luyện viên
  if (method === "GET" && p0 === "coaches" && p1 === "certifications" && !p2) {
    const sql = await getSql();
    return certH.coachCertificationsPublic(sql);
  }
  // Tra cứu và xác thực tính hợp lệ của chứng nhận hoàn thành khóa học theo ID công khai
  if (method === "GET" && p0 === "certificates" && p1 && !p2) {
    const sql = await getSql();
    return certH.certificateVerify(sql, p1);
  }

  // Authenticated
  /**
   * Làm gì: Bọc việc thực thi route có xác thực người dùng trong một transaction; tự động kiểm tra token session và rollback nếu gặp sự cố.
   * Được gọi ở: Tất cả các route ghi/thay đổi dữ liệu (POST, PATCH, DELETE, PUT) yêu cầu đăng nhập trong hàm dispatch.
   * @param fn Hàm callback nhận kết nối database trong transaction và thông tin người dùng đã xác thực.
   * @returns Phản hồi Result hoặc Response trả về từ handler sau khi commit transaction thành công.
   * @throws ApiError Ném lỗi UNAUTHENTICATED nếu thiếu session hoặc session không hợp lệ.
   */
  const authed = async (fn: (sql: Awaited<ReturnType<typeof getSql>>, user: PublicUser) => Promise<Result | Response>) => {
    return withTx(async (sql) => {
      const user = await authFromRequest(sql, request);
      return fn(sql, user);
    });
  };

  // Same authentication, no transaction. Every handler reached through this is
  // a pure `select` — verified one by one — so a BEGIN/COMMIT buys nothing and
  // costs real time: it takes a connection out of the pool and spends two extra
  // round trips on it. That is cheap when the app and the database share a
  // region and brutal when they don't — against a database a continent away it
  // was half a second per read.
  /**
   * Làm gì: Bọc việc thực thi route chỉ đọc (read-only) có xác thực người dùng mà không mở transaction, giúp tiết kiệm kết nối pool và giảm độ trễ mạng.
   * Được gọi ở: Tất cả các route GET yêu cầu đăng nhập trong hàm dispatch.
   * @param fn Hàm callback nhận kết nối database trực tiếp và thông tin người dùng đã xác thực.
   * @returns Phản hồi Result hoặc Response trả về từ handler.
   * @throws ApiError Ném lỗi UNAUTHENTICATED nếu thiếu session hoặc session không hợp lệ.
   */
  const authedRead = async (fn: (sql: Awaited<ReturnType<typeof getSql>>, user: PublicUser) => Promise<Result | Response>) => {
    const sql = await getSql();
    const user = await authFromRequest(sql, request);
    return fn(sql, user);
  };

  // Bước 9: Các API tài khoản cá nhân (/me) cho người dùng đã đăng nhập (hồ sơ, avatar, chứng chỉ, mật khẩu, thông báo)
  // Đăng xuất và hủy bỏ token phiên làm việc hiện tại
  if (method === "POST" && p0 === "auth" && p1 === "logout") {
    return authed((sql, user) => authH.logout(sql, request, user));
  }
  // Lấy thông tin tóm tắt của tài khoản đang đăng nhập để hiển thị trên header/navbar
  if (method === "GET" && p0 === "me" && !p1) {
    return authedRead((sql, user) => authH.meGet(sql, user));
  }
  // Lấy chi tiết hồ sơ cá nhân của người dùng hiện tại
  if (method === "GET" && p0 === "me" && p1 === "profile" && !p2) {
    return authedRead((sql, user) => authH.meProfile(sql, request, user));
  }
  // Lấy danh sách các chứng chỉ khóa học đã hoàn thành của hội viên hiện tại
  if (method === "GET" && p0 === "me" && p1 === "certificates" && !p2) {
    return authedRead((sql, user) => certH.meCertificates(sql, user));
  }
  // Cấp chứng chỉ khóa học theo mẫu cho hội viên sau khi hoàn thành yêu cầu đào tạo
  if (method === "POST" && p0 === "me" && p1 === "certificates" && p2 && !p3) {
    return authed((sql, user) => certH.meCertificateIssue(sql, p2, user));
  }
  // Lấy danh sách bằng cấp/chứng chỉ của một huấn luyện viên cụ thể
  if (method === "GET" && p0 === "coaches" && p1 && p2 === "certifications" && !p3) {
    return authedRead((sql, user) => certH.coachCertificationsList(sql, p1, user));
  }
  // Thêm chứng chỉ chuyên môn mới cho huấn luyện viên
  if (method === "POST" && p0 === "coaches" && p1 && p2 === "certifications" && !p3) {
    return authed((sql, user) => certH.coachCertificationCreate(sql, p1, request, user));
  }
  // Xóa chứng chỉ của huấn luyện viên theo ID chứng chỉ
  if (method === "DELETE" && p0 === "certifications" && p1 && !p2) {
    return authed((sql, user) => certH.coachCertificationDelete(sql, p1, user));
  }
  // Lấy lịch sử và danh sách các lượt đặt sân cá nhân của hội viên hiện tại
  if (method === "GET" && p0 === "me" && p1 === "bookings" && !p2) {
    return authedRead((sql, user) => bookH.meBookings(sql, user));
  }
  // Lấy lịch sử điểm danh vào sân / lớp học của hội viên
  if (method === "GET" && p0 === "me" && p1 === "attendance" && !p2) {
    return authedRead((sql, user) => opsH.meAttendance(sql, user));
  }
  // Cập nhật thông tin hồ sơ cá nhân (họ tên, số điện thoại, ghi chú)
  if (method === "PATCH" && p0 === "me" && !p1) {
    return authed((sql, user) => authH.mePatch(sql, request, user));
  }
  // Kiểm tra trạng thái liên kết tài khoản Google của người dùng
  if (method === "GET" && p0 === "me" && p1 === "google" && !p2) {
    return authedRead((sql, user) => googleH.googleLinkGet(sql, user));
  }
  // Liên kết tài khoản hiện tại với Google thông qua Google credential token
  if (method === "POST" && p0 === "me" && p1 === "google" && !p2) {
    return authed((sql, user) => googleH.googleLink(sql, request, user));
  }
  // Hủy liên kết tài khoản Google khỏi tài khoản hệ thống
  if (method === "DELETE" && p0 === "me" && p1 === "google" && !p2) {
    return authed((sql, user) => googleH.googleUnlink(sql, user));
  }
  // Cập nhật ảnh đại diện người dùng dưới dạng dữ liệu nhị phân hoặc multipart
  if (method === "PUT" && p0 === "me" && p1 === "avatar" && !p2) {
    return authed((sql, user) => avatarH.meAvatarPut(sql, request, user));
  }
  // Xóa ảnh đại diện hiện tại và quay về ảnh đại diện mặc định
  if (method === "DELETE" && p0 === "me" && p1 === "avatar" && !p2) {
    return authed((sql, user) => avatarH.meAvatarDelete(sql, user));
  }
  // Tải ảnh đại diện của một người dùng bất kỳ theo userId
  if (method === "GET" && p0 === "users" && p1 && p2 === "avatar" && !parts[3]) {
    return authedRead((sql, user) => avatarH.userAvatarGet(sql, p1, user));
  }
  // Lấy danh sách thông báo cá nhân (thanh toán, lịch đặt sân, lớp học) kèm phân trang
  if (method === "GET" && p0 === "me" && p1 === "notifications" && !p2) {
    return authedRead((sql, user) => authH.meNotifications(sql, request, user));
  }
  // Đánh dấu các thông báo đã được đọc
  if (method === "POST" && p0 === "me" && p1 === "notifications" && p2 === "read") {
    return authed((sql, user) => authH.meNotificationsRead(sql, request, user));
  }
  // Đổi mật khẩu tài khoản yêu cầu xác thực mật khẩu hiện tại
  if (method === "POST" && p0 === "me" && p1 === "password") {
    return authed((sql, user) => authH.mePassword(sql, request, user));
  }
  // Đăng xuất khỏi tất cả các thiết bị khác, chỉ giữ lại phiên làm việc hiện tại
  if (method === "POST" && p0 === "me" && p1 === "sessions" && p2 === "sign-out-others" && !parts[3]) {
    return authed((sql, user) => authH.meSignOutOthers(sql, request, user));
  }
  // Bước 10: Quản lý tình trạng sử dụng sân và kiểm tra lịch trống (Occupancy & Availability)
  // Lấy chi tiết lịch chiếm dụng sân theo từng khung giờ và từng sân phục vụ màn hình sơ đồ sân
  if (method === "GET" && p0 === "occupancy" && p1 === "detail") {
    return authedRead((sql, user) => bookH.occupancyDetail(sql, request, user));
  }
  // Kiểm tra các khung giờ còn trống của sân theo ngày và môn thể thao phục vụ việc đặt chỗ
  if (method === "GET" && p0 === "availability" && !p1) {
    return authedRead((sql, user) => bookH.availabilityGet(sql, request, user));
  }
  // Lấy tỷ lệ lấp đầy sân tổng quan phục vụ thống kê hiển thị nhanh
  if (method === "GET" && p0 === "occupancy" && !p1) {
    return authedRead((sql) => bookH.occupancyGet(sql, request));
  }
  // Cập nhật thông tin cấu hình hoặc trạng thái hoạt động của sân (bảo trì, mở cửa)
  if (method === "PATCH" && p0 === "courts" && p1 && !p2) {
    return authed((sql, user) => bookH.courtsPatch(sql, p1, request, user));
  }

  // Bước 11: Quản lý tài khoản nhân viên (Staff Management) — phân quyền cho lễ tân, HLV do Quản lý (Manager) kiểm soát
  // Staff accounts — the manager is the only one who issues them (R-01…R-03).
  // Danh sách toàn bộ nhân viên (Lễ tân, Huấn luyện viên, Quản lý) kèm quyền hạn và trạng thái
  if (method === "GET" && p0 === "staff" && !p1) {
    return authedRead((sql, user) => staffH.staffList(sql, request, user));
  }
  // Tạo tài khoản nhân viên mới và gán vai trò ban đầu
  if (method === "POST" && p0 === "staff" && !p1) {
    return authed((sql, user) => staffH.staffCreate(sql, request, user));
  }
  // Cập nhật thông tin nhân viên hoặc điều chỉnh vai trò/trạng thái kích hoạt
  if (method === "PATCH" && p0 === "staff" && p1 && !p2) {
    return authed((sql, user) => staffH.staffPatch(sql, p1, request, user));
  }
  // Quản lý chủ động cấp lại mật khẩu tạm thời cho nhân viên
  if (method === "POST" && p0 === "staff" && p1 && p2 === "reset-password") {
    return authed((sql, user) => staffH.staffResetPassword(sql, p1, user));
  }
  // Thu hồi ngay lập tức mọi phiên làm việc đang hoạt động của một nhân viên (khi nghỉ việc hoặc sự cố bảo mật)
  if (method === "POST" && p0 === "staff" && p1 && p2 === "revoke-sessions") {
    return authed((sql, user) => staffH.staffRevokeSessions(sql, p1, user));
  }

  // Bước 12: Quản lý hội viên (Member Management) — tra cứu danh bạ, tìm kiếm hồ sơ và cập nhật thông tin hội viên
  // Tra cứu danh bạ hội viên với thông tin tóm tắt cho nhân viên lễ tân hỗ trợ khách
  if (method === "GET" && p0 === "directory" && p1 === "members") {
    return authedRead((sql, user) => memberH.membersDirectory(sql, request, user));
  }
  // Tìm kiếm hội viên theo từ khóa (tên, số điện thoại, email, mã hội viên)
  if (method === "GET" && p0 === "members" && !p1) {
    return authedRead((sql, user) => memberH.membersSearch(sql, request, user));
  }
  // Lễ tân tạo hồ sơ hội viên mới trực tiếp tại quầy
  if (method === "POST" && p0 === "members" && !p1) {
    return authed((sql, user) => memberH.membersCreate(sql, request, user));
  }
  // Xem chi tiết hồ sơ hội viên bao gồm gói tập hiện tại, số dư điểm thưởng và lịch sử giao dịch
  if (method === "GET" && p0 === "members" && p1 && !p2) {
    return authedRead((sql, user) => memberH.memberGet(sql, p1, user));
  }
  // Đặt lại mật khẩu tài khoản hội viên theo yêu cầu trực tiếp tại quầy lễ tân
  if (method === "POST" && p0 === "members" && p1 && p2 === "reset-password") {
    return authed((sql, user) => memberH.memberResetPassword(sql, p1, user));
  }
  // Cập nhật thông tin hội viên hoặc chuyển trạng thái tài khoản
  if (method === "PATCH" && p0 === "members" && p1 && !p2) {
    return authed((sql, user) => memberH.membersUpdate(sql, p1, request, user));
  }

  // Bước 13: Quản lý gói tập (Membership Plans) và đăng ký mua gói (Subscriptions)
  // Quản lý tạo mới gói tập hội viên (thời hạn, quyền lợi đặt sân, mức giá)
  if (method === "POST" && p0 === "plans" && !p1) {
    return authed((sql, user) => planH.plansCreate(sql, request, user));
  }
  // Lấy chi tiết thông tin và điều kiện của một gói tập theo planId
  if (method === "GET" && p0 === "plans" && p1 && !p2) {
    return authedRead((sql, user) => planH.plansGet(sql, p1, user));
  }
  // Điều chỉnh thông tin hoặc tạm dừng phát hành gói tập
  if (method === "PATCH" && p0 === "plans" && p1 && !p2) {
    return authed((sql, user) => planH.plansPatch(sql, p1, request, user));
  }
  // Tạo đơn đăng ký mua gói tập hội viên mới (cho hội viên tự mua hoặc lễ tân đăng ký hộ)
  if (method === "POST" && p0 === "subscriptions" && !p1) {
    return authed((sql, user) => planH.subscriptionsCreate(sql, request, user));
  }

  // Bước 14: Quản lý quy trình đặt sân (Court Bookings) — giữ chỗ, xác nhận thanh toán, chuyển nhượng, hủy đặt và check-in
  // Giữ chỗ sân tạm thời trong một khoảng thời gian giới hạn (hold slot) chờ thanh toán, dùng idempotency chống giữ trùng
  if (method === "POST" && p0 === "bookings" && !p1) {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, true, () => bookH.bookingsHold(sql, request, user)),
    );
  }
  // Xác nhận đặt sân sau khi thanh toán thành công chuyển từ trạng thái HOLD sang CONFIRMED
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "confirm") {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, true, () => bookH.bookingsConfirm(sql, p1, request, user)),
    );
  }
  // Người nhận chấp nhận yêu cầu chuyển nhượng lịch đặt sân từ người khác
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "transfer-confirm") {
    return authed((sql, user) => bookH.bookingsTransferConfirm(sql, p1, user));
  }
  // Từ chối yêu cầu chuyển nhượng lịch đặt sân
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "transfer-reject") {
    return authed((sql, user) => bookH.bookingsTransferReject(sql, p1, request, user));
  }
  // Hủy đặt sân và xử lý hoàn tiền hoặc phạt phí theo chính sách
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "cancel") {
    return authed((sql, user) => bookH.bookingsCancel(sql, p1, user, request));
  }
  // Tính toán số tiền hoàn dự kiến trước khi xác nhận hủy đặt sân
  if (method === "GET" && p0 === "bookings" && p1 && p2 === "cancel-quote") {
    return authedRead((sql, user) => bookH.bookingsCancelQuote(sql, p1, request, user));
  }
  // Thu nốt khoản tiền còn thiếu đối với các lịch đặt cọc trước
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "collect-balance") {
    return authed((sql, user) => bookH.bookingsCollectBalance(sql, p1, request, user));
  }
  // Đổi lịch đặt sang khung giờ hoặc ngày khác (nếu còn trống)
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "reschedule") {
    return authed((sql, user) => bookH.bookingsReschedule(sql, p1, request, user));
  }
  // Lễ tân xác nhận khách đến nhận sân (Check-in)
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "check-in") {
    return authed((sql, user) => bookH.bookingsCheckIn(sql, p1, user));
  }
  // Lấy chi tiết thông tin một đơn đặt sân theo bookingId
  if (method === "GET" && p0 === "bookings" && p1 && !p2) {
    return authedRead((sql, user) => bookH.bookingGet(sql, p1, user));
  }
  // Khách vãng lai (walk-in) đặt và thanh toán trực tiếp tại quầy thu ngân mà không cần tài khoản từ trước
  if (method === "POST" && p0 === "walk-in") {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, true, () => bookH.walkIn(sql, request, user)),
    );
  }

  // Bước 15: Quản lý ca trực lễ tân (Front Desk Shifts) — mở ca, theo dõi doanh thu trong ca và chốt két kết ca
  // Nhân viên lễ tân mở ca làm việc mới kèm ghi nhận số tiền đầu ca
  if (method === "POST" && p0 === "shifts" && p1 === "open") {
    return authed((sql, user) => deskH.shiftOpen(sql, user));
  }
  // Lấy thông tin ca trực hiện tại của nhân viên cùng tổng kết giao dịch tạm tính
  if (method === "GET" && p0 === "shifts" && p1 === "current") {
    return authedRead((sql, user) => deskH.shiftCurrent(sql, user, request));
  }
  // Đóng ca trực, đối soát số tiền thực thu với sổ sách và kết chuyển dữ liệu
  if (method === "POST" && p0 === "shifts" && p1 && p2 === "close") {
    return authed((sql, user) => deskH.shiftClose(sql, p1, request, user));
  }

  // Bước 16: Quản lý lớp học thể thao (Sports Classes) — tạo lớp, xuất bản, ghi danh học viên và phân công huấn luyện viên
  // Tạo lớp học mới ở trạng thái nháp (draft)
  if (method === "POST" && p0 === "classes" && !p1) {
    return authed((sql, user) => classH.classesCreate(sql, request, user));
  }
  // Xuất bản (publish) lớp học để bắt đầu mở nhận đăng ký từ học viên
  if (method === "POST" && p0 === "classes" && p1 && p2 === "publish") {
    return authed((sql, user) => classH.classesPublish(sql, p1, user));
  }
  // Ghi danh hội viên vào lớp học và trừ số buổi hoặc tính học phí tương ứng
  if (method === "POST" && p0 === "classes" && p1 && p2 === "enroll") {
    return authed((sql, user) => classH.classesEnroll(sql, p1, request, user));
  }
  // Tính toán trước học phí hoặc số buổi cần trừ cho hội viên khi đăng ký lớp
  if (method === "GET" && p0 === "classes" && p1 && p2 === "quote") {
    return authedRead((sql, user) => classH.classQuote(sql, p1, request, user));
  }
  // Lấy thông tin chi tiết của lớp học bao gồm lộ trình, lịch các buổi học và HLV phụ trách
  if (method === "GET" && p0 === "classes" && p1 && !p2) {
    return authedRead((sql, user) => classH.classDetail(sql, p1, user));
  }
  // Lấy danh sách điểm danh (roster) các học viên trong lớp
  if (method === "GET" && p0 === "classes" && p1 && p2 === "roster") {
    return authedRead((sql, user) => classH.classRoster(sql, p1, user));
  }
  // Cập nhật thông tin cấu hình lớp học (lịch học, sức chứa tối đa, ghi chú)
  if (method === "PATCH" && p0 === "classes" && p1 && !p2) {
    return authed((sql, user) => classH.classesPatch(sql, p1, request, user));
  }
  // Phân công hoặc thay đổi huấn luyện viên phụ trách lớp học
  if (method === "POST" && p0 === "classes" && p1 && p2 === "coach") {
    return authed((sql, user) => classH.classesAssignCoach(sql, p1, request, user));
  }
  // POST /v1/sessions/:id/cancel: Huỷ một buổi học cụ thể của lớp và thông báo cho học viên/HLV liên quan
  if (method === "POST" && p0 === "sessions" && p1 && p2 === "cancel") {
    return authed((sql, user) => classH.sessionCancel(sql, p1, request, user));
  }
  // POST /v1/sessions/:id/reschedule: Dời lịch buổi học (ngày/giờ/sân tập) và cập nhật lịch cho các bên liên quan
  if (method === "POST" && p0 === "sessions" && p1 && p2 === "reschedule") {
    return authed((sql, user) => classH.sessionReschedule(sql, p1, request, user));
  }
  // GET /v1/coach/schedule: Lấy lịch dạy chi tiết theo ngày/tuần của huấn luyện viên đang đăng nhập
  if (method === "GET" && p0 === "coach" && p1 === "schedule") {
    return authedRead((sql, user) => classH.coachSchedule(sql, user));
  }
  // GET /v1/coach/classes: Danh sách tất cả các lớp học do huấn luyện viên hiện tại phụ trách
  if (method === "GET" && p0 === "coach" && p1 === "classes") {
    return authedRead((sql, user) => classH.coachClasses(sql, user));
  }
  // POST /v1/enrollments/:id/transfer: Chuyển học viên từ lớp học này sang lớp học khác tương đương
  if (method === "POST" && p0 === "enrollments" && p1 && p2 === "transfer") {
    return authed((sql, user) => classH.enrollmentTransfer(sql, p1, user));
  }
  // DELETE /v1/enrollments/:id: Huỷ đăng ký lớp học của học viên và hoàn trả lại suất trống cho lớp
  if (method === "DELETE" && p0 === "enrollments" && p1) {
    return authed((sql, user) => classH.enrollmentDelete(sql, p1, user));
  }

  // GET /v1/payments/pending: Danh sách các khoản thanh toán đang chờ xử lý tại quầy lễ tân
  if (method === "GET" && p0 === "payments" && p1 === "pending") {
    return authedRead((sql, user) => deskH.paymentsPending(sql, request, user));
  }
  // Raise a payOS link — the member on their phone, or reception showing the
  // QR to a customer standing at the counter.
  if (method === "POST" && p0 === "payments" && p1 === "online" && !p2) {
    return authed((sql, user) => onlineH.onlineCreate(sql, request, user));
  }
  // Ask payOS whether it has been paid. Deliberately idempotent rather than
  // idempotency-keyed: the return page, reception's screen and the job loop all
  // poll the same link, and none of them can supply a shared key.
  if (method === "POST" && p0 === "payments" && p1 === "online" && p2 && parts[3] === "verify") {
    return authed((sql, user) => onlineH.onlineVerify(sql, p2, user));
  }
  // POST /v1/payments: Tạo giao dịch thanh toán tại quầy (tiền mặt/chuyển khoản). Sử dụng withIdempotency để tránh trừ tiền trùng khi nhân viên nhấn đúp
  if (method === "POST" && p0 === "payments" && !p1) {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, true, () => deskH.paymentsCreate(sql, request, user)),
    );
  }
  // POST /v1/payments/:id/refund: Tạo yêu cầu hoàn tiền cho giao dịch thanh toán đã thực hiện
  if (method === "POST" && p0 === "payments" && p1 && p2 === "refund") {
    return authed((sql, user) => deskH.paymentsRefund(sql, p1, request, user));
  }
  // POST /v1/payments/:id/approve-refund: Quản lý phê duyệt yêu cầu hoàn tiền
  if (method === "POST" && p0 === "payments" && p1 && p2 === "approve-refund") {
    return authed((sql, user) => deskH.paymentsApproveRefund(sql, p1, request, user));
  }
  // POST /v1/payments/:id/pay-out-refund: Thực hiện chi tiền hoàn trả cho khách hàng và hoàn tất phiếu hoàn tiền
  if (method === "POST" && p0 === "payments" && p1 && p2 === "pay-out-refund") {
    return authed((sql, user) => deskH.paymentsPayOutRefund(sql, p1, user));
  }
  // POST /v1/payments/:id/reject-refund: Quản lý từ chối yêu cầu hoàn tiền kèm lý do
  if (method === "POST" && p0 === "payments" && p1 && p2 === "reject-refund") {
    return authed((sql, user) => deskH.paymentsRejectRefund(sql, p1, request, user));
  }
  // Ordered before the `.pdf` case only for readability — the two cannot collide.
  // Fixed weekly bookings.
  // POST /v1/series/preview: Xem trước danh sách ngày giờ và tính tổng học phí/tiền sân cho chuỗi đặt sân cố định hàng tuần
  if (method === "POST" && p0 === "series" && p1 === "preview") {
    return authed((sql, user) => xH.seriesPreview(sql, request, user));
  }
  // POST /v1/series: Tạo chuỗi đặt sân định kỳ cố định hàng tuần (kèm kiểm tra chống trùng lặp withIdempotency)
  if (method === "POST" && p0 === "series" && !p1) {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, false, () => xH.seriesCreate(sql, request, user)),
    );
  }
  // GET /v1/series: Danh sách tất cả các chuỗi đặt sân cố định theo tuần của trung tâm
  if (method === "GET" && p0 === "series" && !p1) {
    return authedRead((sql, user) => xH.seriesList(sql, request, user));
  }
  // POST /v1/series/:id/cancel: Huỷ toàn bộ các buổi chưa diễn ra trong chuỗi đặt sân cố định
  if (method === "POST" && p0 === "series" && p1 && p2 === "cancel") {
    return authed((sql, user) => xH.seriesCancel(sql, p1, request, user));
  }
  // Loyalty points.
  // GET /v1/me/points: Hội viên xem số dư điểm thưởng tích luỹ và lịch sử giao dịch điểm của mình
  if (method === "GET" && p0 === "me" && p1 === "points") {
    return authedRead((sql, user) => xH.meLoyalty(sql, request, user));
  }
  // POST /v1/me/points/redeem: Hội viên đổi điểm tích luỹ lấy voucher giảm giá hoặc quà tặng
  if (method === "POST" && p0 === "me" && p1 === "points" && p2 === "redeem") {
    return authed((sql, user) => xH.loyaltyRedeem(sql, request, user));
  }
  // GET /v1/members/:id/points: Nhân viên tra cứu điểm thưởng và lịch sử điểm của một hội viên cụ thể
  if (method === "GET" && p0 === "members" && p1 && p2 === "points") {
    return authedRead((sql, user) => xH.memberLoyalty(sql, p1, user));
  }
  // POST /v1/members/:id/points: Nhân viên điều chỉnh tăng/giảm điểm thưởng của hội viên (kèm lý do phục vụ kiểm toán)
  if (method === "POST" && p0 === "members" && p1 && p2 === "points") {
    return authed((sql, user) => xH.loyaltyAdjust(sql, p1, request, user));
  }
  // Coach commission.
  // GET /v1/commission: Báo cáo tổng hợp tiền hoa hồng của tất cả huấn luyện viên trong kỳ tính lương
  if (method === "GET" && p0 === "commission" && !p1) {
    return authedRead((sql, user) => xH.commissionReport(sql, request, user));
  }
  // POST /v1/commission/close: Chốt sổ kỳ hoa hồng huấn luyện viên, khóa số liệu không cho sửa đổi
  if (method === "POST" && p0 === "commission" && p1 === "close") {
    return authed((sql, user) => xH.commissionClose(sql, request, user));
  }
  // PATCH /v1/commission/rates/:coachId: Cập nhật tỷ lệ % hoặc mức hoa hồng cố định cho từng huấn luyện viên
  if (method === "PATCH" && p0 === "commission" && p1 === "rates" && p2) {
    return authed((sql, user) => xH.commissionRate(sql, p2, request, user));
  }
  // POST /v1/commission/pay/:id: Xác nhận đã thanh toán tiền hoa hồng cho huấn luyện viên
  if (method === "POST" && p0 === "commission" && p1 === "pay" && p2) {
    return authed((sql, user) => xH.commissionPay(sql, p2, request, user));
  }
  // GET /v1/me/earnings: Huấn luyện viên xem thu nhập và bảng kê chi tiết hoa hồng cá nhân
  if (method === "GET" && p0 === "me" && p1 === "earnings") {
    return authedRead((sql, user) => xH.coachEarnings(sql, request, user));
  }
  // Maintenance work orders.
  // GET /v1/work-orders: Danh sách các phiếu yêu cầu bảo trì, sửa chữa sân bãi và trang thiết bị
  if (method === "GET" && p0 === "work-orders" && !p1) {
    return authedRead((sql, user) => xH.workOrdersList(sql, request, user));
  }
  // POST /v1/work-orders: Tạo phiếu yêu cầu bảo trì mới khi phát hiện sự cố cơ sở vật chất
  if (method === "POST" && p0 === "work-orders" && !p1) {
    return authed((sql, user) => xH.workOrdersCreate(sql, request, user));
  }
  // PATCH /v1/work-orders/:id: Cập nhật tiến độ thực hiện, chi phí hoặc đánh dấu hoàn thành phiếu bảo trì
  if (method === "PATCH" && p0 === "work-orders" && p1) {
    return authed((sql, user) => xH.workOrdersPatch(sql, p1, request, user));
  }
  // E-invoice export (before the `.pdf` case: "export" is not an id).
  // GET /v1/invoices/export-list: Lấy danh sách hóa đơn sẵn sàng để xuất hóa đơn điện tử hàng loạt
  if (method === "GET" && p0 === "invoices" && p1 === "export-list") {
    return authedRead((sql, user) => xH.invoiceExportList(sql, request, user));
  }
  // GET /v1/invoices/export: Xuất gói dữ liệu hóa đơn điện tử phục vụ truyền nhận với cơ quan thuế
  if (method === "GET" && p0 === "invoices" && p1 === "export") {
    return authed((sql, user) => xH.invoiceExport(sql, request, user));
  }
  // GET /v1/invoices/:id.xml: Tải file XML hóa đơn điện tử hợp chuẩn (Thông tư 78/2021/TT-BTC)
  if (method === "GET" && p0 === "invoices" && p1?.endsWith(".xml")) {
    // Tách bỏ phần mở rộng .xml để lấy id hóa đơn cần truy vấn trong cơ sở dữ liệu
    const id = p1.replace(/.xml$/, "");
    return authedRead((sql, user) => xH.invoiceXmlOne(sql, id, user));
  }
  // GET /v1/invoices: Danh sách hóa đơn của người dùng hiện tại hoặc toàn bộ hóa đơn quầy thu ngân
  if (method === "GET" && p0 === "invoices" && !p1) {
    return authedRead((sql, user) => deskH.invoicesMine(sql, request, user));
  }
  // GET /v1/invoices/:id.pdf: Xuất và tải file PDF hóa đơn thanh toán để in hoặc gửi cho khách hàng
  if (method === "GET" && p0 === "invoices" && p1?.endsWith(".pdf")) {
    // Tách bỏ phần mở rộng .pdf để lấy id hóa đơn tạo file PDF
    const id = p1.replace(/\.pdf$/, "");
    return authedRead((sql, user) => deskH.invoicePdf(sql, id, request, user));
  }

  // GET /v1/reports/attendance: Báo cáo thống kê lượt điểm danh và mức độ chuyên cần của học viên
  if (method === "GET" && p0 === "reports" && p1 === "attendance" && !p2) {
    return authedRead((sql, user) => attH.reportsAttendance(sql, request, user));
  }
  // GET /v1/at-risk: Phân tích danh sách hội viên có nguy cơ bỏ tập (lâu không đến trung tâm, gói tập sắp hết hạn)
  if (method === "GET" && p0 === "at-risk" && !p1) {
    return authedRead((sql, user) => attH.atRiskList(sql, user));
  }
  // POST /v1/contacts: Ghi nhận lượt tương tác chăm sóc khách hàng (gọi điện hỏi thăm, nhắn tin tư vấn)
  if (method === "POST" && p0 === "contacts" && !p1) {
    return authed((sql, user) => attH.contactCreate(sql, request, user));
  }
  // GET /v1/members/:id/contacts: Xem lịch sử các lần liên hệ, chăm sóc của một hội viên cụ thể
  if (method === "GET" && p0 === "members" && p1 && p2 === "contacts") {
    return authedRead((sql, user) => attH.contactList(sql, p1, user));
  }
  // GET /v1/reports/:kind/export: Xuất dữ liệu báo cáo thống kê ra file Excel/CSV theo danh mục
  if (method === "GET" && p0 === "reports" && p1 && p2 === "export") {
    return authedRead((sql, user) => reportH.reportsExport(sql, request, user, p1));
  }
  // GET /v1/reports/revenue: Báo cáo doanh thu tài chính tổng hợp của trung tâm
  if (method === "GET" && p0 === "reports" && p1 === "revenue") {
    return authedRead((sql, user) => {
      // Bắt buộc quyền manager: bảo mật số liệu tài chính nhạy cảm của doanh nghiệp
      requireRole(user, ["manager"]);
      return deskH.reportsRevenue(sql, request, user);
    });
  }
  // GET /v1/reports/capacity hoặc /v1/manager/capacity: Báo cáo công suất vận hành sân bãi và mức độ khai thác
  if (
    (method === "GET" && p0 === "reports" && p1 === "capacity") ||
    (method === "GET" && p0 === "manager" && p1 === "capacity")
  ) {
    return authedRead((sql, user) => reportH.reportsCapacity(sql, request, user));
  }
  // GET /v1/reports/members: Báo cáo phát triển hội viên: số lượng mở mới, gia hạn và hủy gói
  if (method === "GET" && p0 === "reports" && p1 === "members") {
    return authedRead((sql, user) => reportH.reportsMembers(sql, request, user));
  }
  // GET /v1/reports/occupancy: Báo cáo tỷ lệ lấp đầy sân theo khung giờ, hỗ trợ tối ưu giá và sắp xếp lịch
  if (method === "GET" && p0 === "reports" && p1 === "occupancy") {
    return authedRead((sql, user) => deskH.reportsOccupancy(sql, request, user));
  }
  // GET /v1/settings: Đọc toàn bộ cấu hình hoạt động của trung tâm từ bảng center_settings
  if (method === "GET" && p0 === "settings" && !p1) {
    return authedRead((sql, user) => deskH.settingsGet(sql, user));
  }
  // PATCH /v1/settings: Quản lý cập nhật thiết lập trung tâm (giờ mở cửa, chính sách huỷ/đổi lịch, hoàn tiền)
  if (method === "PATCH" && p0 === "settings" && !p1) {
    return authed((sql, user) => deskH.settingsPatch(sql, request, user));
  }
  // PUT /v1/price-rules: Cập nhật bảng quy tắc tính giá sân theo khung giờ vàng và các ngày trong tuần
  if (method === "PUT" && p0 === "price-rules") {
    return authed((sql, user) => deskH.priceRulesPut(sql, request, user));
  }
  // GET /v1/audit: Tra cứu danh sách nhật ký kiểm toán (audit_logs) để phục vụ kiểm tra và rà soát hệ thống
  if (method === "GET" && p0 === "audit") {
    return authedRead((sql, user) => deskH.auditList(sql, request, user));
  }

  // POST /v1/subscriptions/:id/freeze: Tạm dừng (đóng băng) gói tập của hội viên khi có yêu cầu hợp lệ
  if (method === "POST" && p0 === "subscriptions" && p1 && p2 === "freeze") {
    return authed((sql, user) => opsH.subscriptionFreeze(sql, p1, request, user));
  }
  // POST /v1/subscriptions/:id/unfreeze: Mở đóng băng gói tập và tự động gia hạn thêm số ngày đã tạm dừng
  if (method === "POST" && p0 === "subscriptions" && p1 && p2 === "unfreeze") {
    return authed((sql, user) => opsH.subscriptionUnfreeze(sql, p1, user));
  }
  // POST /v1/subscriptions/:id/decline: Lễ tân từ chối hoặc hủy đăng ký gói tập chưa hoàn tất thanh toán
  if (method === "POST" && p0 === "subscriptions" && p1 && p2 === "decline") {
    return authed((sql, user) => deskH.subscriptionDecline(sql, p1, user));
  }
  // POST /v1/waitlist/:id/accept: Chấp nhận người trong danh sách chờ vào suất tập chính thức khi có chỗ trống
  if (method === "POST" && p0 === "waitlist" && p1 && p2 === "accept") {
    return authed((sql, user) => opsH.waitlistAccept(sql, p1, user));
  }
  // GET /v1/equipment: Lấy danh mục dụng cụ và trang thiết bị tập luyện tại trung tâm
  if (method === "GET" && p0 === "equipment" && !p1) {
    return authedRead((sql) => opsH.equipmentList(sql));
  }
  // POST /v1/equipment: Thêm mới mã trang thiết bị hoặc dụng cụ vào kho
  if (method === "POST" && p0 === "equipment" && !p1) {
    return authed((sql, user) => opsH.equipmentCreate(sql, request, user));
  }
  // GET /v1/equipment/loans: Tra cứu danh sách các lượt mượn dụng cụ đang mở (chưa hoàn trả)
  if (method === "GET" && p0 === "equipment" && p1 === "loans") {
    return authedRead((sql, user) => opsH.loansOpen(sql, user));
  }
  // POST /v1/equipment/loans: Tạo phiếu cho hội viên hoặc huấn luyện viên mượn dụng cụ tập luyện
  if (method === "POST" && p0 === "equipment" && p1 === "loans" && !p2) {
    return authed((sql, user) => opsH.equipmentLoan(sql, request, user));
  }
  // POST /v1/equipment/loans/:id/return: Ghi nhận hoàn trả dụng cụ về kho sau khi sử dụng
  if (method === "POST" && p0 === "equipment" && p1 === "loans" && parts[3] === "return") {
    return authed((sql, user) => opsH.equipmentReturn(sql, p2, user));
  }
  // GET /v1/sessions/:id/attendance: Lấy danh sách điểm danh học viên của buổi học cụ thể
  if (method === "GET" && p0 === "sessions" && p1 && p2 === "attendance") {
    return authedRead((sql, user) => opsH.sessionAttendanceGet(sql, p1, user));
  }
  // POST /v1/sessions/:id/attendance: Huấn luyện viên hoặc lễ tân cập nhật trạng thái điểm danh buổi học
  if (method === "POST" && p0 === "sessions" && p1 && p2 === "attendance") {
    return authed((sql, user) => opsH.sessionAttendancePost(sql, p1, request, user));
  }
  // GET /v1/training-plans: Danh sách các giáo án huấn luyện của các lớp học hoặc cá nhân
  if (method === "GET" && p0 === "training-plans" && !p1) {
    return authedRead((sql, user) => opsH.trainingList(sql, request, user));
  }
  // POST /v1/training-plans: Tạo giáo án huấn luyện mới cho khóa học hoặc học viên
  if (method === "POST" && p0 === "training-plans" && !p1) {
    return authed((sql, user) => trainH.trainingCreate(sql, request, user));
  }
  // Before the /:id routes, or "suggest" is read as a plan id.
  // POST /v1/training-plans/suggest: Gợi ý giáo án và bài tập phù hợp với thể trạng học viên bằng AI
  if (method === "POST" && p0 === "training-plans" && p1 === "suggest") {
    return authed((sql, user) => opsH.trainingSuggest(sql, request, user));
  }
  // GET /v1/training-plans/templates: Lấy danh sách các bài tập và giáo án mẫu chuẩn để tái sử dụng
  if (method === "GET" && p0 === "training-plans" && p1 === "templates") {
    return authedRead((sql, user) => trainH.templatesList(sql, request, user));
  }
  // POST /v1/training-plans/from-template: Khởi tạo nhanh giáo án huấn luyện mới từ mẫu có sẵn
  if (method === "POST" && p0 === "training-plans" && p1 === "from-template") {
    return authed((sql, user) => trainH.plansFromTemplate(sql, request, user));
  }
  // POST /v1/training-plans/:id/save-template: Lưu giáo án hiện tại thành mẫu chuẩn để áp dụng cho các lớp sau
  if (method === "POST" && p0 === "training-plans" && p1 && p2 === "save-template") {
    return authed((sql, user) => trainH.templateSave(sql, p1, request, user));
  }
  // GET /v1/training-plans/:id/versions: Xem lịch sử các phiên bản sửa đổi của giáo án huấn luyện
  if (method === "GET" && p0 === "training-plans" && p1 && p2 === "versions") {
    return authedRead((sql, user) => trainH.planVersions(sql, p1, user));
  }
  // PATCH /v1/training-plans/:id: Chỉnh sửa nội dung chi tiết bài tập hoặc mục tiêu của giáo án
  if (method === "PATCH" && p0 === "training-plans" && p1 && !p2) {
    return authed((sql, user) => trainH.trainingPatch(sql, p1, request, user));
  }
  // POST /v1/classes/:id/plans/duplicate-week: Sao chép toàn bộ kế hoạch bài tập của tuần trước sang tuần sau
  if (method === "POST" && p0 === "classes" && p1 && p2 === "plans" && parts[3] === "duplicate-week") {
    return authed((sql, user) => trainH.plansDuplicateWeek(sql, p1, request, user));
  }
  // GET /v1/sessions/:id/results: Lấy bảng điểm đánh giá kỹ năng của học viên trong buổi học
  if (method === "GET" && p0 === "sessions" && p1 && p2 === "results") {
    return authedRead((sql, user) => trainH.sessionResultsGet(sql, p1, user));
  }
  // PUT /v1/sessions/:id/results: Huấn luyện viên nhập kết quả kiểm tra và đánh giá chỉ số kỹ thuật buổi học
  if (method === "PUT" && p0 === "sessions" && p1 && p2 === "results") {
    return authed((sql, user) => trainH.sessionResultsPut(sql, p1, request, user));
  }
  // GET /v1/students/:id/profile: Xem hồ sơ năng lực, lịch sử học tập và biểu đồ tiến bộ của học viên
  if (method === "GET" && p0 === "students" && p1 && p2 === "profile") {
    return authedRead((sql, user) => trainH.studentProfile(sql, p1, user));
  }
  // PUT /v1/students/:id/level: Cập nhật cấp độ/trình độ chuyên môn (level) cho học viên
  if (method === "PUT" && p0 === "students" && p1 && p2 === "level") {
    return authed((sql, user) => trainH.studentLevelPut(sql, p1, request, user));
  }
  // POST /v1/students/:id/notes: Thêm ghi chú nhận xét riêng của huấn luyện viên về học viên
  if (method === "POST" && p0 === "students" && p1 && p2 === "notes") {
    return authed((sql, user) => trainH.studentNotePost(sql, p1, request, user));
  }
  // POST /v1/students/:id/reviews: Gửi nhận xét và đánh giá tổng kết định kỳ về học viên
  if (method === "POST" && p0 === "students" && p1 && p2 === "reviews") {
    return authed((sql, user) => trainH.studentReviewPost(sql, p1, request, user));
  }
  // GET /v1/homework: Danh sách các bài tập về nhà đã giao cho học viên tự luyện tập
  if (method === "GET" && p0 === "homework" && !p1) {
    return authedRead((sql, user) => trainH.homeworkList(sql, request, user));
  }
  // POST /v1/homework: Huấn luyện viên tạo bài tập về nhà mới kèm yêu cầu và hạn nộp
  if (method === "POST" && p0 === "homework" && !p1) {
    return authed((sql, user) => trainH.homeworkCreate(sql, request, user));
  }
  // GET /v1/me/training: Học viên tự xem lộ trình và kế hoạch tập luyện cá nhân
  if (method === "GET" && p0 === "me" && p1 === "training" && !p2) {
    return authedRead((sql, user) => trainH.meTraining(sql, user));
  }
  // PUT /v1/me/training-goal: Học viên thiết lập hoặc cập nhật mục tiêu rèn luyện cá nhân
  if (method === "PUT" && p0 === "me" && p1 === "training-goal") {
    return authed((sql, user) => trainH.meTrainingGoal(sql, request, user));
  }
  // GET /v1/me/homework: Học viên xem danh sách các bài tập về nhà được giao
  if (method === "GET" && p0 === "me" && p1 === "homework" && !p2) {
    return authedRead((sql, user) => trainH.meHomework(sql, user));
  }
  // PUT /v1/me/homework/:id: Học viên nộp bài làm hoặc cập nhật tiến độ hoàn thành bài tập về nhà
  if (method === "PUT" && p0 === "me" && p1 === "homework" && p2) {
    return authed((sql, user) => trainH.meHomeworkPut(sql, p2, request, user));
  }
  // Door check-in (SRS v1.4.1 FR-TRN-02, BR-30/72): QR scan, manual with a reason, optional self check-in.
  // POST /v1/desk/gate-checkin: Tiếp nhận tín hiệu quét mã QR từ cổng kiểm soát barrier tự động để mở cửa
  if (method === "POST" && p0 === "desk" && p1 === "gate-checkin") {
    return authed((sql, user) => checkinH.gateCheckin(sql, request, user));
  }
  // POST /v1/desk/scan: Lễ tân quét mã QR hoặc check-in thủ công cho khách tại quầy
  if (method === "POST" && p0 === "desk" && p1 === "scan") {
    return authed((sql, user) => checkinH.deskScan(sql, request, user));
  }
  // GET /v1/desk/checkin-qr: Lấy mã QR tĩnh của quầy lễ tân để khách tự quét check-in bằng điện thoại
  if (method === "GET" && p0 === "desk" && p1 === "checkin-qr") {
    return authedRead((sql, user) => checkinH.deskCheckinCode(sql, user));
  }
  // GET /v1/desk/gate-checkins: Danh sách lịch sử các lượt quét qua cổng kiểm soát ra vào trung tâm
  if (method === "GET" && p0 === "desk" && p1 === "gate-checkins") {
    return authedRead((sql, user) => checkinH.gateCheckins(sql, request, user));
  }
  // GET /v1/me/checkin-token: Sinh mã token / mã QR định danh cá nhân của hội viên để quét tại cổng
  if (method === "GET" && p0 === "me" && p1 === "checkin-token") {
    return authedRead((sql, user) => checkinH.meCheckinToken(sql, user));
  }
  // GET /v1/me/bookings/:id/checkin-token: Sinh mã QR check-in riêng theo lượt đặt sân cụ thể
  if (method === "GET" && p0 === "me" && p1 === "bookings" && p2 && parts[3] === "checkin-token") {
    return authedRead((sql, user) => checkinH.meBookingCheckinToken(sql, p2, user));
  }
  // POST /v1/me/self-checkin: Hội viên tự check-in bằng cách quét mã QR hiển thị tại trung tâm
  if (method === "POST" && p0 === "me" && p1 === "self-checkin") {
    return authed((sql, user) => checkinH.meSelfCheckin(sql, request, user));
  }
  // Promotions (FR-PAY-03, BR-40..43). "validate" before the /:id routes.
  // GET /v1/promotions: Danh sách tất cả các chương trình và mã khuyến mãi đang áp dụng
  if (method === "GET" && p0 === "promotions" && !p1) {
    return authedRead((sql, user) => promoH.promosList(sql, user));
  }
  // POST /v1/promotions/validate: Kiểm tra mã ưu đãi: tính hợp lệ, thời hạn, giới hạn sử dụng và tính số tiền giảm
  if (method === "POST" && p0 === "promotions" && p1 === "validate") {
    return authedRead((sql, user) => promoH.promosValidate(sql, request, user));
  }
  // POST /v1/promotions: Quản lý tạo mã ưu đãi / voucher khuyến mãi mới
  if (method === "POST" && p0 === "promotions" && !p1) {
    return authed((sql, user) => promoH.promosCreate(sql, request, user));
  }
  // PATCH /v1/promotions/:id: Cập nhật thông tin mã ưu đãi (hạn dùng, số lượng voucher, trạng thái bật/tắt)
  if (method === "PATCH" && p0 === "promotions" && p1 && !p2) {
    return authed((sql, user) => promoH.promosPatch(sql, p1, request, user));
  }
  // GET /v1/promotions/:id/redemptions: Xem lịch sử danh sách các lần mã ưu đãi đã được khách sử dụng
  if (method === "GET" && p0 === "promotions" && p1 && p2 === "redemptions") {
    return authedRead((sql, user) => promoH.promosRedemptions(sql, p1, user));
  }
  // POST /v1/assistant: Tương tác và giải đáp thắc mắc thông minh với trợ lý AI của trung tâm
  // Not `authed`: a model call takes seconds, and inside a transaction it held
  // a connection (on PGlite, the only one) for the whole wait. The exception
  // to the pure-select rule above: the handler opens its own short transaction
  // for the ticket and its audit row, and writes only the chat audit row on its
  // own, after the model has answered.
  if (method === "POST" && p0 === "assistant") {
    return authedRead((sql, user) => opsH.assistantChat(sql, request, user));
  }
  // Before the bare /tickets read, or "mine" is matched as a ticket id.
  // GET /v1/tickets/mine: Người dùng xem danh sách các phiếu hỗ trợ/khiếu nại do chính mình gửi
  if (method === "GET" && p0 === "tickets" && p1 === "mine") {
    return authedRead((sql, user) => opsH.ticketsMine(sql, request, user));
  }
  // GET /v1/tickets: Nhân viên xem toàn bộ danh sách phiếu yêu cầu hỗ trợ từ khách hàng
  if (method === "GET" && p0 === "tickets" && !p1) {
    return authedRead((sql, user) => opsH.ticketsList(sql, request, user));
  }
  // POST /v1/tickets: Tạo phiếu yêu cầu hỗ trợ hoặc phản ánh dịch vụ mới
  if (method === "POST" && p0 === "tickets" && !p1) {
    return authed((sql, user) => opsH.ticketsCreate(sql, request, user));
  }
  // POST /v1/tickets/:id/reply: Trả lời hoặc trao đổi thêm thông tin trong phiếu hỗ trợ
  if (method === "POST" && p0 === "tickets" && p1 && p2 === "reply") {
    return authed((sql, user) => opsH.ticketReply(sql, p1, request, user));
  }
  // POST /v1/tickets/:id/close: Đóng phiếu hỗ trợ sau khi đã giải quyết xong vấn đề cho khách
  if (method === "POST" && p0 === "tickets" && p1 && p2 === "close") {
    return authed((sql, user) => opsH.ticketClose(sql, p1, user));
  }
  // GET /v1/bank-transfer: Lấy thông tin tài khoản ngân hàng chính thức của trung tâm phục vụ chuyển khoản
  if (method === "GET" && p0 === "bank-transfer" && !p1) {
    return authedRead((_sql, user) => opsH.bankTransferGet(user));
  }
  // GET /v1/flags: Lấy danh sách các cờ tính năng (Feature flags) công khai để điều khiển hiển thị trên UI
  if (method === "GET" && p0 === "flags") {
    const sql = await getSql();
    return opsH.flagsGet(sql);
  }
  // PATCH /v1/flags: Bật hoặc tắt các cờ tính năng trong hệ thống (chỉ dành cho quản trị viên)
  if (method === "PATCH" && p0 === "flags") {
    return authed((sql, user) => opsH.flagsPatch(sql, request, user));
  }

  // DELETE /v1/payments: Chặn tuyệt đối hành vi xoá bản ghi thanh toán; theo nguyên tắc kế toán, bắt buộc hoàn tiền (refund)
  if (method === "DELETE" && p0 === "payments") {
    return authed(async () => {
      throw err.forbidden("Payments cannot be deleted — issue a refund instead.");
    });
  }

  // Manager site assets & media library
  // GET /v1/manager/site-assets/library hoặc /v1/manager/media-library: Thư viện media tĩnh và các file tải lên
  if (
    (method === "GET" && p0 === "manager" && p1 === "site-assets" && p2 === "library") ||
    (method === "GET" && p0 === "manager" && p1 === "media-library" && !p2)
  ) {
    return authedRead((sql, user) => assetsH.managerMediaLibrary(sql, request, user));
  }
  // GET /v1/manager/site-assets: Danh sách tất cả các vị trí hiển thị hình ảnh (slots) trên website
  if (method === "GET" && p0 === "manager" && p1 === "site-assets" && !p2) {
    return authedRead((sql, user) => assetsH.managerAssetsList(sql, user));
  }
  // POST /v1/manager/site-assets/upload: Tải file hình ảnh mới lên hệ thống lưu trữ media
  if (method === "POST" && p0 === "manager" && p1 === "site-assets" && p2 === "upload") {
    return authed((sql, user) => assetsH.managerAssetUpload(sql, request, user));
  }
  // PUT/POST /v1/manager/site-assets/:key: Thay thế ảnh hiển thị cho vị trí (slot) cụ thể trên trang web
  if ((method === "PUT" || method === "POST") && p0 === "manager" && p1 === "site-assets" && p2 && !parts[3]) {
    return authed((sql, user) => assetsH.managerAssetUpload(sql, request, user, p2));
  }
  // PATCH /v1/manager/site-assets/:key: Cập nhật văn bản mô tả (alt text song ngữ) cho tài nguyên ảnh
  if (method === "PATCH" && p0 === "manager" && p1 === "site-assets" && p2 && !parts[3]) {
    return authed((sql, user) => assetsH.managerAssetPatch(sql, request, user, p2));
  }
  // POST /v1/manager/site-assets/:key/revert: Khôi phục ảnh vị trí này về phiên bản trước đó trong lịch sử
  if (method === "POST" && p0 === "manager" && p1 === "site-assets" && p2 && parts[3] === "revert") {
    return authed((sql, user) => assetsH.managerAssetRevert(sql, request, user, p2));
  }
  // POST /v1/manager/site-assets/:key/reset: Đặt lại ảnh mặc định ban đầu do hệ thống cung cấp (to: "default")
  if (method === "POST" && p0 === "manager" && p1 === "site-assets" && p2 && parts[3] === "reset") {
    return authed((sql, user) =>
      assetsH.managerAssetRevert(
        sql,
        new Request(request.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: "default" }),
        }),
        user,
        p2,
      ),
    );
  }

  // Manager courts
  // GET /v1/manager/courts: Quản lý xem danh sách tất cả các sân tập (bao gồm cả sân đang tạm ngừng hoạt động)
  if (method === "GET" && p0 === "manager" && p1 === "courts" && !p2) {
    return authedRead((sql, user) => courtH.managerCourtsList(sql, user));
  }
  // POST /v1/manager/courts: Tạo thêm sân tập mới và thiết lập bộ môn, cấu hình mặt sân
  if (method === "POST" && p0 === "manager" && p1 === "courts" && !p2) {
    return authed((sql, user) => courtH.managerCourtCreate(sql, request, user));
  }
  // PATCH /v1/manager/courts/:id: Chỉnh sửa thông tin sân tập (tên sân, thứ tự hiển thị, môn thể thao)
  if (method === "PATCH" && p0 === "manager" && p1 === "courts" && p2 && !parts[3]) {
    return authed((sql, user) => bookH.courtsPatch(sql, p2, request, user));
  }
  // POST /v1/manager/courts/:id/retire: Tạm dừng khai thác sân tập (retire/soft delete), ẩn khỏi màn hình đặt sân của khách
  if (method === "POST" && p0 === "manager" && p1 === "courts" && p2 && parts[3] === "retire") {
    return authed((sql, user) => courtH.managerCourtRetire(sql, p2, request, user));
  }
  // POST /v1/manager/courts/:id/restore: Khôi phục sân tập đã tạm dừng trở lại hoạt động bình thường
  if (method === "POST" && p0 === "manager" && p1 === "courts" && p2 && parts[3] === "restore") {
    return authed((sql, user) => courtH.managerCourtRestore(sql, p2, user));
  }

  // Manager sports
  // GET /v1/manager/sports: Quản lý xem toàn bộ danh mục các bộ môn thể thao (kể cả bộ môn đã ngừng kinh doanh)
  if (method === "GET" && p0 === "manager" && p1 === "sports" && !p2) {
    return authedRead((sql, user) => sportsH.managerSportsList(sql, user));
  }
  // POST /v1/manager/sports: Khai báo thêm môn thể thao mới tại trung tâm (Pickleball, Cầu lông, Bóng bàn)
  if (method === "POST" && p0 === "manager" && p1 === "sports" && !p2) {
    return authed((sql, user) => sportsH.managerSportCreate(sql, request, user));
  }
  // PATCH /v1/manager/sports/:id: Chỉnh sửa thông tin tên, mô tả hoặc biểu tượng của môn thể thao
  if (method === "PATCH" && p0 === "manager" && p1 === "sports" && p2 && !parts[3]) {
    return authed((sql, user) => sportsH.managerSportPatch(sql, p2, request, user));
  }
  // POST /v1/manager/sports/:id/retire: Ngừng kinh doanh môn thể thao (ẩn khỏi danh mục công khai)
  if (method === "POST" && p0 === "manager" && p1 === "sports" && p2 && parts[3] === "retire") {
    return authed((sql, user) => sportsH.managerSportRetire(sql, p2, user));
  }
  // POST /v1/manager/sports/:id/restore: Khôi phục môn thể thao đã bị ẩn để tiếp tục phục vụ khách
  if (method === "POST" && p0 === "manager" && p1 === "sports" && p2 && parts[3] === "restore") {
    return authed((sql, user) => sportsH.managerSportRestore(sql, p2, user));
  }
  // DELETE /v1/manager/sports/:id: Xoá vĩnh viễn môn thể thao (chỉ thành công nếu chưa có sân bãi hoặc lớp học nào gắn kèm)
  if (method === "DELETE" && p0 === "manager" && p1 === "sports" && p2 && !parts[3]) {
    return authed((sql, user) => sportsH.managerSportDelete(sql, p2, user));
  }

  // Tham chiếu các biến trợ giúp đã khai báo nhưng không dùng để tránh cảnh báo biên dịch TypeScript
  void staffRoles;
  void idem;
  // Ném lỗi 404 (Not Found) nếu HTTP method và URL không khớp với bất kỳ endpoint nào đã đăng ký
  throw err.notFound(`No route for ${method} /v1/${parts.join("/")}`);
}

/**
 * Làm gì: Cổng tiếp nhận và xử lý tập trung (entrypoint) cho mọi HTTP request API (/api/*, /v1/*), điều phối qua dispatch và chuẩn hoá kết quả/lỗi thành Web Response.
 * Được gọi ở: src/routes/api.$.ts (catch-all route /api/$), src/routes/v1.$.ts (catch-all route /v1/$).
 * @param request Đối tượng Web Request gửi đến từ client.
 * @returns Web Response chứa dữ liệu JSON, luồng SSE hoặc file tải về tương ứng.
 */
export async function handleApi(request: Request): Promise<Response> {
  try {
    // Bước 1: Điều phối HTTP request đến controller handler tương ứng qua hàm dispatch
    const result = await dispatch(request);
    // Bước 2: Trả về trực tiếp nếu handler sinh sẵn Web Response (ví dụ: luồng SSE live updates hoặc file nhị phân PDF/XML)
    if (result instanceof Response) return result;
    // Bước 3: Mã trạng thái 204 No Content không được phép chứa body theo chuẩn giao thức HTTP
    if (result.status === 204) return new Response(null, { status: 204 });
    // Bước 4: Chuyển đổi mã trạng thái và dữ liệu kết quả thành Response JSON tiêu chuẩn
    return json(result.status, result.body);
  } catch (e) {
    // Bước 5: Bắt lỗi nghiệp vụ ApiError có kiểm soát để đóng gói mã trạng thái và thông điệp lỗi dạng JSON
    if (e instanceof ApiError) return json(e.status, e.body());
    // Chuyển các lỗi hệ thống không lường trước (500) sang handleError để log chi tiết và ẩn thông tin nhạy cảm
    return handleError(e);
  }
}
