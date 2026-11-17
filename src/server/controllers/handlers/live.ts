/**
 * File: src/server/controllers/handlers/live.ts
 * Vai trò: Xử lý kết nối thời gian thực (realtime) qua Server-Sent Events (SSE) cho toàn bộ hệ thống Arena3.
 * Vị trí trong app:
 * - Được điều phối từ GET /api/live (hoặc /v1/live) thông qua router (src/server/controllers/router.ts).
 * - Phục vụ hook useLive phía client (src/client/lib/use-live.tsx) trên các màn hình sơ đồ sân, lớp học, điểm danh, thông báo, thanh toán và chat.
 * - Cơ chế: Định kỳ polling (mỗi 2s) kiểm tra chuỗi phiên bản (version timestamp) của từng topic trong database, tự động phát sự kiện SSE khi có thay đổi dữ liệu, và chủ động ngắt kết nối an toàn sau tối đa 25s để client tự kết nối lại, phù hợp với môi trường serverless (Vercel).
 */
import type { Sql } from "@/server/data/db";
import { flagOn } from "../../services/flags";
import type { PublicUser } from "../session";
import { one } from "../tx";

/**
 * Reads a cheap "version" string for a topic.
 * Returns a timestamp string or a compact hash/state string.
 */
/**
 * Làm gì: Truy vấn chuỗi phiên bản (version) gọn nhẹ của một topic từ database (mốc thời gian mới nhất hoặc trạng thái thanh toán) để phát hiện biến động dữ liệu.
 * Được gọi ở: fetchLiveStreamInitialVersions (bước 3) và checkLiveStreamTopicUpdates (bước 3) trong file này khi khởi tạo stream và trong vòng lặp polling 2s.
 * @param sql Kết nối cơ sở dữ liệu để thực thi các câu lệnh SQL truy vấn mốc thời gian hoặc trạng thái.
 * @param topic Tên chủ đề cần lấy phiên bản (ví dụ: "courts", "classes", "class:<id>", "notifications", "payment:<id>", "attendance", "chat:<id>").
 * @param user Thông tin người dùng hiện tại (hoặc null), dùng để lọc dữ liệu riêng tư như thông báo in-app.
 * @returns Chuỗi phiên bản đại diện (chuỗi timestamp ISO hoặc giá trị trạng thái thanh toán); trả về "0" nếu không có dữ liệu hoặc lỗi.
 * @throws Không ném lỗi; toàn bộ hàm được bọc trong khối try/catch an toàn và fallback về "0".
 */
async function getTopicVersion(sql: Sql, topic: string, user: PublicUser | null): Promise<string> {
  try {
    // Topic "courts": Lấy mốc thời gian lớn nhất từ audit_logs, court_bookings và occupancies để phát hiện mọi biến động về sơ đồ sân
    if (topic === "courts") {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from audit_logs where entity in ('court', 'booking', 'hold', 'occupancy')), '1970-01-01'::timestamptz),
          coalesce((select max(created_at) from court_bookings), '1970-01-01'::timestamptz),
          coalesce((select max(start_at) from occupancies), '1970-01-01'::timestamptz)
        )::text as v`,
      );
      return row?.v ?? "0";
    }

    // Topic "classes": Lấy mốc thời gian mới nhất từ audit_logs và sessions để phát hiện cập nhật danh sách lớp và lịch học
    if (topic === "classes") {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from audit_logs where entity in ('class', 'enrollment', 'session', 'attendance')), '1970-01-01'::timestamptz),
          coalesce((select max(start_at) from sessions), '1970-01-01'::timestamptz)
        )::text as v`,
      );
      return row?.v ?? "0";
    }

    // Topic "class:<classId>": Theo dõi riêng 1 lớp học cụ thể, kiểm tra audit_logs (lớp, enrollment, session) và bảng sessions
    if (topic.startsWith("class:")) {
      const classId = topic.slice(6);
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from audit_logs where entity = 'class' and entity_id::text = $1), '1970-01-01'::timestamptz),
          coalesce((select max(at) from audit_logs where entity in ('enrollment', 'session') and (before->>'class_id' = $1 or after->>'class_id' = $1)), '1970-01-01'::timestamptz),
          coalesce((select max(start_at) from sessions where class_id::text = $1), '1970-01-01'::timestamptz)
        )::text as v`,
        [classId],
      );
      return row?.v ?? "0";
    }

    // Topic "notifications": Chỉ truy vấn khi có user; đọc mốc tạo thông báo in-app mới nhất trong outbox hoặc nhật ký audit_logs của chính user đó
    if (topic === "notifications" && user) {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(created_at) from outbox where user_id = $1 and channel = 'inapp'), '1970-01-01'::timestamptz),
          coalesce((select max(at) from audit_logs where actor_id = $1 and action like '%notification%'), '1970-01-01'::timestamptz)
        )::text as v`,
        [user.id],
      );
      return row?.v ?? "0";
    }

    // Topic "payment:<paymentId>": Trả về cột status làm phiên bản thay vì timestamp; client sẽ nhận biết ngay khi trạng thái đổi (ví dụ: pending -> paid)
    if (topic.startsWith("payment:")) {
      const paymentId = topic.slice(8);
      const row = await one<{ v: string }>(
        sql,
        `select coalesce(status, 'unknown')::text as v from payments where id::text = $1 or ref_id::text = $1 limit 1`,
        [paymentId],
      );
      return row?.v ?? "0";
    }

    // Topic "attendance": Lấy mốc thời gian điểm danh gần nhất từ bảng attendance và audit_logs phục vụ màn hình điểm danh của HLV và cổng soát vé
    if (topic === "attendance" || topic.startsWith("attendance:")) {
      const row = await one<{ v: string }>(
        sql,
        `select greatest(
          coalesce((select max(at) from attendance), '1970-01-01'::timestamptz),
          coalesce((select max(at) from audit_logs where entity = 'attendance'), '1970-01-01'::timestamptz)
        )::text as v`,
      );
      return row?.v ?? "0";
    }

    // Topic "chat:<convId>": Lấy thời điểm tạo tin nhắn mới nhất trong cuộc trò chuyện; bọc catch riêng để tránh gián đoạn nếu bảng messages chưa sẵn sàng
    if (topic.startsWith("chat:")) {
      const convId = topic.slice(5);
      const row = await one<{ v: string }>(
        sql,
        `select coalesce(max(created_at), '1970-01-01'::timestamptz)::text as v from messages where conversation_id::text = $1`,
        [convId],
      ).catch(() => ({ v: "0" }));
      return row?.v ?? "0";
    }
  } catch {
    // If table does not exist or query fails, return default version
  }
  return "0";
}

/**
 * Filter topics to only those the requester is permitted to see.
 *
 * `chatOn` is passed in rather than looked up here: one stream asks for several
 * topics at once, and a flag read per topic would be a query per topic.
 */
/**
 * Làm gì: Lọc danh sách topic yêu cầu, chỉ giữ lại những topic mà người dùng hiện tại có đủ quyền hạn và tính năng đang được bật.
 *   Vì sao: Khách vãng lai chỉ được xem dữ liệu công khai (sân, lớp, đơn thanh toán cụ thể);
 *   dữ liệu cá nhân (thông báo, điểm danh) yêu cầu đăng nhập; chat yêu cầu cả đăng nhập và cờ tính năng F6 bật.
 * Được gọi ở: resolveLiveStreamAllowedTopics (bước 2 của liveStreamHandler trong file này).
 * @param topics Mảng danh sách tên các topic mà client yêu cầu theo dõi.
 * @param user Thông tin người dùng đăng nhập hiện tại (hoặc null nếu là khách vãng lai).
 * @param chatOn Cờ boolean cho biết tính năng chat F6 có đang bật hay không (truyền vào từ ngoài để tránh query DB nhiều lần).
 * @returns Mảng danh sách các topic hợp lệ mà client được phép theo dõi.
 * @throws Không ném lỗi.
 */
function filterAllowedTopics(topics: string[], user: PublicUser | null, chatOn: boolean): string[] {
  return topics.filter((t) => {
    // Dữ liệu công khai: Khách vãng lai cũng có thể xem lịch sân, lịch lớp học và theo dõi đơn thanh toán của mình
    if (t === "courts" || t === "classes" || t.startsWith("class:") || t.startsWith("payment:")) {
      return true;
    }
    // Dữ liệu cá nhân: Thông báo in-app bắt buộc phải đăng nhập để xác định đúng user_id nhận tin
    if (t === "notifications") {
      return !!user;
    }
    if (t === "attendance" || t.startsWith("attendance:")) {
      // Attendance is visible to staff (coach, receptionist, manager) or authenticated users
      return !!user;
    }
    // Chat realtime: Bắt buộc đã đăng nhập và cờ tính năng chat F6 đang được bật trong hệ thống
    if (t.startsWith("chat:")) {
      return !!user && chatOn;
    }
    return false;
  });
}

// Maximum lifetime for a single serverless stream (25 seconds) before clean close
const LIVE_STREAM_MAX_DURATION_MS = 25_000;
// Chu kỳ kiểm tra thay đổi dữ liệu trong database (2 giây), cân bằng giữa độ trễ realtime và tải DB
const LIVE_STREAM_POLL_INTERVAL_MS = 2_000;
// Chu kỳ gửi gói tin heartbeat (10 giây) để duy trì kết nối HTTP, tránh bị proxy/gateway ngắt kết nối do rảnh rỗi
const LIVE_STREAM_HEARTBEAT_INTERVAL_MS = 10_000;

// Bảng ánh xạ giữa tên topic và chuỗi phiên bản hiện tại trong bộ nhớ để so sánh cập nhật
type LiveStreamTopicVersions = Map<string, string>;

// Ngữ cảnh kết nối stream SSE, gom nhóm các thông tin cần thiết trong suốt vòng đời kết nối
type LiveStreamConnectionContext = {
  request: Request;
  sql: Sql;
  user: PublicUser | null;
  allowedTopics: string[];
};

/**
 * Làm gì: trích xuất danh sách tên các topic cần theo dõi từ query parameter "topics" trên URL của request.
 *   Tách chuỗi theo dấu phẩy, cắt bỏ khoảng trắng thừa ở hai đầu và loại bỏ các phần tử rỗng.
 * Được gọi ở: liveStreamHandler, bước 1.
 * @param request Đối tượng Request HTTP gửi đến máy chủ, lấy từ tham số request của liveStreamHandler.
 * @returns Mảng danh sách tên các topic đã được chuẩn hóa và loại bỏ chuỗi rỗng.
 * @throws Không ném lỗi; nếu query param trống hoặc không có thì trả về mảng rỗng.
 */
function parseLiveStreamRequestedTopics(request: Request): string[] {
  const requestUrl = new URL(request.url);
  const rawTopicsParameter = requestUrl.searchParams.get("topics") ?? "";
  const separatedTokens = rawTopicsParameter.split(",");
  const cleanedTopics: string[] = [];

  for (const token of separatedTokens) {
    const trimmedToken = token.trim();
    const tokenIsNotEmpty = trimmedToken.length > 0;
    if (tokenIsNotEmpty) {
      cleanedTopics.push(trimmedToken);
    }
  }

  return cleanedTopics;
}

/**
 * Làm gì: xác định danh sách các topic mà kết nối được phép theo dõi. Kiểm tra cờ tính năng chat F6
 *   nếu có yêu cầu topic chat, sau đó lọc danh sách theo quyền hạn và trạng thái đăng nhập của người dùng.
 *   Vì sao: một kết nối stream có thể theo dõi đồng thời nhiều topic (sân, lớp học, thanh toán, thông báo).
 *   Khi module chat bị tắt qua cờ F6, hệ thống chỉ bỏ qua các topic chat mà vẫn tiếp tục duy trì stream
 *   cho các topic còn lại, thay vì ném lỗi 403 làm gián đoạn toàn bộ kết nối của các màn hình đang hoạt động.
 * Được gọi ở: liveStreamHandler, bước 2.
 * @param sql Kết nối cơ sở dữ liệu để truy vấn trạng thái cờ tính năng F6 qua flagOn.
 * @param requestedTopics Mảng danh sách các topic người dùng yêu cầu, lấy từ parseLiveStreamRequestedTopics ở bước 1.
 * @param user Thông tin người dùng đăng nhập hiện tại, lấy từ tham số user của liveStreamHandler (hoặc null nếu chưa đăng nhập).
 * @returns Mảng các topic hợp lệ mà người dùng có quyền theo dõi.
 * @throws Không ném lỗi; nếu việc kiểm tra cờ gặp lỗi thì flagOn xử lý an toàn.
 */
async function resolveLiveStreamAllowedTopics(
  sql: Sql,
  requestedTopics: string[],
  user: PublicUser | null,
): Promise<string[]> {
  let hasChatTopic = false;
  for (const topic of requestedTopics) {
    if (topic.startsWith("chat:")) {
      hasChatTopic = true;
      break;
    }
  }

  // A stream carries several topics, and the others (courts, classes, payments,
  // notifications) have nothing to do with F6 — so a switched-off module drops
  // the chat topics and leaves the rest streaming, rather than 403-ing the
  // whole connection out from under screens that are still working.
  let chatFeatureEnabled = false;
  if (hasChatTopic) {
    chatFeatureEnabled = await flagOn(sql, "F6");
  }

  return filterAllowedTopics(requestedTopics, user, chatFeatureEnabled);
}

/**
 * Làm gì: đóng bộ điều khiển luồng ReadableStream một cách an toàn bằng cách bọc lời gọi close() trong khối try/catch.
 *   Vì sao: nếu luồng stream đã bị đóng trước đó (ví dụ do client ngắt kết nối đột ngột hoặc các sự kiện ngắt
 *   chạy đồng thời), việc gọi controller.close() sẽ văng lỗi ngoại lệ. Bắt lỗi này giúp việc giải phóng tài nguyên kết thúc êm đẹp.
 * Được gọi ở: createLiveStreamReadableStream (ở bước 3 của liveStreamHandler), khi client ngắt kết nối hoặc luồng chạm mốc 25 giây.
 * @param controller Bộ điều khiển ReadableStreamDefaultController nhận từ hàm start của ReadableStream.
 * @returns Không trả về giá trị (void).
 * @throws Không bao giờ ném lỗi ra ngoài.
 */
function closeLiveStreamControllerSafely(
  controller: ReadableStreamDefaultController,
): void {
  try {
    controller.close();
  } catch {
    // Luồng đã được đóng trước đó, bỏ qua lỗi để tránh crash ứng dụng.
    /* stream already closed */
  }
}

/**
 * Làm gì: truy vấn phiên bản cơ sở dữ liệu hiện tại của từng topic trong danh sách cho phép để làm mốc so sánh ban đầu.
 * Được gọi ở: createLiveStreamReadableStream (ở bước 3 của liveStreamHandler), khi luồng stream bắt đầu khởi chạy.
 * @param sql Kết nối cơ sở dữ liệu để đọc phiên bản topic qua getTopicVersion.
 * @param allowedTopics Danh sách topic hợp lệ mà client được phép theo dõi, lấy từ kết quả của bước 2.
 * @param user Thông tin người dùng hiện tại (hoặc null), dùng để đọc phiên bản dữ liệu cá nhân như notifications.
 * @returns Map ánh xạ giữa tên topic và chuỗi phiên bản ban đầu.
 * @throws Không ném lỗi; getTopicVersion đã tự bọc try/catch và trả về "0" nếu có lỗi.
 */
async function fetchLiveStreamInitialVersions(
  sql: Sql,
  allowedTopics: string[],
  user: PublicUser | null,
): Promise<LiveStreamTopicVersions> {
  // Initial versions map
  const topicVersions: LiveStreamTopicVersions = new Map();

  for (const topic of allowedTopics) {
    const initialVersion = await getTopicVersion(sql, topic, user);
    topicVersions.set(topic, initialVersion);
  }

  return topicVersions;
}

/**
 * Làm gì: duyệt qua từng topic được phép, đọc phiên bản mới nhất từ database và so sánh với phiên bản đã lưu trong Map.
 *   Nếu phát hiện phiên bản thay đổi, cập nhật mốc phiên bản mới và phát sự kiện SSE thông báo cho client cập nhật giao diện.
 * Được gọi ở: createLiveStreamReadableStream (ở bước 3 của liveStreamHandler), trong vòng lặp polling mỗi 2 giây.
 * @param sql Kết nối cơ sở dữ liệu để truy vấn phiên bản hiện tại qua getTopicVersion.
 * @param allowedTopics Danh sách các topic đang được theo dõi trong phiên stream này.
 * @param user Thông tin người dùng hiện tại hoặc null nếu là khách vãng lai.
 * @param currentVersions Bảng Map lưu phiên bản trước đó của các topic; hàm sẽ cập nhật trực tiếp Map này khi có thay đổi.
 * @param sendEvent Hàm gửi chuỗi dữ liệu sự kiện đã mã hóa UTF-8 vào luồng SSE.
 * @param isStreamEnded Hàm kiểm tra xem luồng stream đã kết thúc hay chưa để ngắt sớm vòng lặp.
 * @returns Promise hoàn tất khi đã duyệt và kiểm tra xong tất cả các topic trong danh sách.
 * @throws Không ném lỗi; lỗi truy vấn cơ sở dữ liệu được bắt ở getTopicVersion.
 */
async function checkLiveStreamTopicUpdates(
  sql: Sql,
  allowedTopics: string[],
  user: PublicUser | null,
  currentVersions: LiveStreamTopicVersions,
  sendEvent: (eventData: string) => void,
  isStreamEnded: () => boolean,
): Promise<void> {
  // Check for version changes
  for (const topic of allowedTopics) {
    // Nếu kết nối stream đã đóng giữa chừng, ngắt sớm vòng lặp để tránh truy vấn cơ sở dữ liệu không cần thiết
    const streamHasEnded = isStreamEnded();
    if (streamHasEnded) {
      break;
    }

    const currentVersion = await getTopicVersion(sql, topic, user);
    const previousVersion = currentVersions.get(topic);
    const versionHasChanged = currentVersion !== previousVersion;

    // Khi phát hiện topic có phiên bản mới: cập nhật Map nội bộ và gửi sự kiện data SSE về client
    if (versionHasChanged) {
      currentVersions.set(topic, currentVersion);
      sendEvent(`data: ${JSON.stringify({ topic, version: currentVersion })}\n\n`);
    }
  }
}

/**
 * Làm gì: gửi dòng comment SSE ": heartbeat\n\n" nếu đã qua chu kỳ 10 giây kể từ lần gửi heartbeat gần nhất.
 *   Vì sao: giúp duy trì kết nối HTTP luôn hoạt động (keep-alive) qua các proxy trung gian (Vercel edge, Nginx)
 *   tránh bị đóng kết nối do hết thời gian chờ rảnh rỗi (idle timeout).
 * Được gọi ở: createLiveStreamReadableStream (ở bước 3 của liveStreamHandler), trong vòng lặp polling sau khi kiểm tra phiên bản topic.
 * @param lastHeartbeatTime Mốc thời gian gửi heartbeat gần nhất tính bằng mili-giây (epoch timestamp).
 * @param sendEvent Hàm gửi dữ liệu sự kiện vào luồng SSE.
 * @returns Mốc thời gian gửi heartbeat mới nhất (nếu vừa gửi), hoặc giữ nguyên mốc cũ (nếu chưa đến hạn 10 giây).
 * @throws Không ném lỗi.
 */
function sendLiveStreamHeartbeatIfNeeded(
  lastHeartbeatTime: number,
  sendEvent: (eventData: string) => void,
): number {
  const currentTimestamp = Date.now();
  const timeSinceLastHeartbeat = currentTimestamp - lastHeartbeatTime;
  const heartbeatIsDue = timeSinceLastHeartbeat >= LIVE_STREAM_HEARTBEAT_INTERVAL_MS;

  if (heartbeatIsDue) {
    // Heartbeat
    sendEvent(": heartbeat\n\n");
    return currentTimestamp;
  }

  return lastHeartbeatTime;
}

/**
 * Làm gì: khởi tạo đối tượng ReadableStream quản lý vòng đời của Server-Sent Events. Thiết lập gửi thông điệp chào mừng
 *   ban đầu (: connected\n\n), lấy mốc phiên bản ban đầu của các topic, đăng ký lắng nghe sự kiện client hủy kết nối
 *   để dọn dẹp tài nguyên, và kích hoạt vòng lặp polling mỗi 2 giây cũng như ngắt kết nối an toàn trước giới hạn 25 giây.
 * Được gọi ở: liveStreamHandler, bước 3.
 * @param context Đối tượng LiveStreamConnectionContext gom nhóm request, sql, user và danh sách allowedTopics.
 * @returns Đối tượng ReadableStream phát các byte dữ liệu UTF-8 qua controller.
 * @throws Không ném lỗi; các lỗi trong luồng đều được xử lý an toàn.
 */
function createLiveStreamReadableStream(
  context: LiveStreamConnectionContext,
): ReadableStream {
  let streamEnded = false;
  const textEncoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      // Bước 1: Định nghĩa hàm sendEvent an toàn để mã hóa UTF-8 và đẩy chuỗi dữ liệu SSE vào controller
      const sendEvent = (eventData: string): void => {
        if (streamEnded) {
          return;
        }
        try {
          controller.enqueue(textEncoder.encode(eventData));
        } catch {
          // Khi controller văng lỗi (client đã ngắt kết nối), đánh dấu dừng stream để không enqueue tiếp
          streamEnded = true;
        }
      };

      // Initial connection greeting
      sendEvent(": connected\n\n");

      // Bước 2: Đọc mốc phiên bản ban đầu của các topic được phép để làm căn cứ so sánh biến động
      // Initial versions map
      const versions = await fetchLiveStreamInitialVersions(
        context.sql,
        context.allowedTopics,
        context.user,
      );

      const streamStartTime = Date.now();
      let lastHeartbeatTime = Date.now();

      // Bước 3: Định nghĩa vòng lặp polling kiểm tra cập nhật phiên bản định kỳ mỗi 2 giây và gửi heartbeat
      const pollingLoop = async (): Promise<void> => {
        const streamAlreadyEnded = streamEnded || context.request.signal.aborted;
        // Ngắt sớm vòng lặp và đóng controller nếu stream đã kết thúc hoặc client chủ động hủy kết nối
        if (streamAlreadyEnded) {
          streamEnded = true;
          closeLiveStreamControllerSafely(controller);
          return;
        }

        // Close cleanly before Vercel timeout so EventSource reconnects gracefully
        const streamExceededMaxDuration =
          Date.now() - streamStartTime >= LIVE_STREAM_MAX_DURATION_MS;

        if (streamExceededMaxDuration) {
          sendEvent(": timeout-reconnect\n\n");
          streamEnded = true;
          closeLiveStreamControllerSafely(controller);
          return;
        }

        // Check for version changes
        await checkLiveStreamTopicUpdates(
          context.sql,
          context.allowedTopics,
          context.user,
          versions,
          sendEvent,
          () => streamEnded,
        );

        // Heartbeat
        lastHeartbeatTime = sendLiveStreamHeartbeatIfNeeded(
          lastHeartbeatTime,
          sendEvent,
        );

        // Nếu kết nối vẫn bình thường, lên lịch chạy lần polling tiếp theo sau 2 giây
        const canScheduleNextPoll = !streamEnded && !context.request.signal.aborted;
        if (canScheduleNextPoll) {
          setTimeout(() => void pollingLoop(), LIVE_STREAM_POLL_INTERVAL_MS);
        }
      };

      // Bước 4: Đăng ký lắng nghe sự kiện abort từ request để đóng luồng an toàn khi client rời trang hoặc đóng tab
      context.request.signal.addEventListener("abort", () => {
        streamEnded = true;
        closeLiveStreamControllerSafely(controller);
      });

      // Bước 5: Kích hoạt lần thăm dò dữ liệu đầu tiên sau 2 giây (LIVE_STREAM_POLL_INTERVAL_MS)
      // Start polling loop
      setTimeout(() => void pollingLoop(), LIVE_STREAM_POLL_INTERVAL_MS);
    },
  });
}

/**
 * Làm gì: đóng gói luồng ReadableStream vào Response HTTP với các header chuẩn Server-Sent Events:
 *   Content-Type là text/event-stream, tắt cache và vô hiệu hóa đệm phản hồi phía proxy trung gian (X-Accel-Buffering: no).
 * Được gọi ở: liveStreamHandler, bước 4.
 * @param stream Luồng dữ liệu ReadableStream đã khởi tạo và cấu hình đầy đủ ở bước 3.
 * @returns Đối tượng Response HTTP mang mã 200 sẵn sàng trả về cho client.
 * @throws Không ném lỗi.
 */
function buildLiveStreamResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Báo cho reverse proxy (như Nginx) không được đệm (buffer) dữ liệu, đảm bảo sự kiện SSE được gửi ngay về client
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Làm gì: thiết lập kết nối Server-Sent Events (SSE) để truyền dữ liệu và thông báo thay đổi theo thời gian thực (realtime)
 *   cho trình duyệt client theo danh sách các topic được yêu cầu.
 *   Vì sao dùng SSE: cho phép máy chủ chủ động đẩy các sự kiện thay đổi dữ liệu đến trình duyệt mà không cần client
 *   liên tục gửi request thăm dò (polling) gây quá tải máy chủ.
 *   Vì sao giới hạn tối đa 25 giây: môi trường serverless (như Vercel function) có giới hạn thời gian thực thi (execution timeout);
 *   việc chủ động gửi thông điệp timeout-reconnect và đóng luồng êm dịu trước 25 giây giúp EventSource phía trình duyệt
 *   tự động kết nối lại liền mạch mà không gặp lỗi mạng.
 *   Vì sao kiểm tra cờ F6: tính năng chat realtime nằm sau cờ tính năng F6; nếu cờ tắt, hệ thống chỉ lọc bỏ topic chat
 *   mà vẫn duy trì kết nối cho các topic khác để không làm gián đoạn màn hình người dùng.
 * Được gọi ở:
 *   - Các màn hình đăng ký lắng nghe realtime qua hook useLive (src/client/lib/use-live.tsx):
 *     + Màn hình quản lý lớp học: /manager/classes (src/routes/manager.classes.tsx), /desk/classes (src/routes/desk.classes.tsx), /coach/classes (src/routes/coach.classes.tsx) với topic "classes" hoặc "class:<id>".
 *     + Màn hình sơ đồ sân lễ tân: /desk/courts (src/routes/desk.courts.tsx) với topic "courts".
 *     + Màn hình điểm danh & cổng: /coach/attendance (src/routes/coach.attendance.tsx), /desk/gate (src/routes/desk.gate.tsx) với topic "attendance".
 *     + Màn hình thông báo & chuông báo: /alerts (src/routes/alerts.tsx), /app/notifications (src/routes/app.notifications.tsx), /chat (src/routes/chat.tsx) với topic "notifications".
 *     + Màn hình chat: /chat (src/routes/chat.tsx) với topic "chat:<conversationId>".
 *     + Màn hình trạng thái thanh toán với topic "payment:<id>".
 *   - API: GET /api/live?topics=... hoặc GET /v1/live?topics=...
 *   - Điều phối qua src/server/controllers/router.ts: hàm dispatch khớp URL (nhánh method === "GET" && p0 === "live" && !p1),
 *     lấy kết nối cơ sở dữ liệu sql qua getSql(), lấy thông tin người dùng qua optionalAuth(sql, request),
 *     và gọi trực tiếp liveStreamHandler(request, sql, user).
 * @param request Đối tượng Request HTTP gửi đến endpoint /live, chứa URL, query param topics và tín hiệu hủy request.signal.
 * @param sql Kết nối cơ sở dữ liệu lấy từ pool qua hàm getSql() trong router.ts.
 * @param user Thông tin người dùng đăng nhập hiện tại lấy từ optionalAuth(sql, request) trong router.ts, hoặc null nếu là khách vãng lai.
 * @returns Đối tượng Response HTTP mang mã 200 với body là ReadableStream mang header text/event-stream.
 * @throws Không chủ động ném lỗi HTTP; mọi lỗi kết nối hoặc truy vấn đều được xử lý an toàn để tránh ngắt đột ngột tiến trình server.
 */
export async function liveStreamHandler(
  request: Request,
  sql: Sql,
  user: PublicUser | null,
): Promise<Response> {
  // Bước 1: Trích xuất danh sách các topic cần theo dõi từ query parameter của URL request.
  const requestedTopics = parseLiveStreamRequestedTopics(request);

  // Bước 2: Kiểm tra feature flag chat và lọc danh sách các topic mà người dùng được phép theo dõi.
  const allowedTopics = await resolveLiveStreamAllowedTopics(
    sql,
    requestedTopics,
    user,
  );

  // Bước 3: Khởi tạo luồng ReadableStream dạng Server-Sent Events để gửi dữ liệu và kiểm tra thay đổi theo chu kỳ.
  const stream = createLiveStreamReadableStream({
    request,
    sql,
    user,
    allowedTopics,
  });

  // Bước 4: Đóng gói luồng dữ liệu vào Response HTTP với các header chuẩn Server-Sent Events.
  return buildLiveStreamResponse(stream);
}
