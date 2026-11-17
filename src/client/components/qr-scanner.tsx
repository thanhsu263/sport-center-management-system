/**
 * File: src/client/components/qr-scanner.tsx
 * Vai trò: Cung cấp component quét mã QR qua camera trình duyệt và hàm trích xuất mã token từ kết quả quét.
 * Vị trí trong app: Chạy ở client, phục vụ hội viên tự quét mã check-in (/app/pass) và nhân viên lễ tân quét thẻ tại quầy (/desk/gate).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui";
import { t } from "@/client/lib/i18n";

/**
 * A scanned code may be the bare token or a link that carries it (`/app/pass?d=…`, `?t=…`).
 * Both the gate and the member page send the token itself to the API.
 */
/**
 * Làm gì: Trích xuất chuỗi mã token hợp lệ từ dữ liệu quét mã QR hoặc máy quét cầm tay.
 *   Xử lý linh hoạt cả mã token trần lẫn đường link URL đầy đủ chứa tham số truy vấn (?d=... hoặc ?t=...).
 * Được gọi ở:
 * - src/routes/app.pass.tsx: hàm sendSelf (hội viên quét QR tự điểm danh tại /app/pass).
 * - src/routes/desk.gate.tsx: hàm submitScan và prop onCode của QrScanner (lễ tân quét thẻ tại /desk/gate).
 * @param raw Chuỗi ký tự thô đọc được từ camera hoặc máy quét mã vạch.
 * @returns Chuỗi token sạch dùng để gửi lên API phục vụ nghiệp vụ check-in.
 */
export function tokenFromScan(raw: string): string {
  const v = raw.trim();
  // Nếu không phải đường link URL (http:// hoặc https://), đây là mã token thuần -> trả về trực tiếp.
  if (!/^https?:\/\//i.test(v)) return v;
  try {
    const u = new URL(v);
    // Lấy mã từ tham số "d" (mã ca/check-in quầy) hoặc "t" (token cá nhân); nếu không có thì giữ nguyên chuỗi ban đầu.
    return u.searchParams.get("d") || u.searchParams.get("t") || v;
  } catch {
    return v;
  }
}

type Detect = (video: HTMLVideoElement) => Promise<string | undefined>;

/** BarcodeDetector where the browser has it (Android, macOS Chrome); jsQR everywhere else (Windows, Firefox, iOS). */
/**
 * Làm gì: Khởi tạo hàm quét mã QR tối ưu theo khả năng hỗ trợ của trình duyệt hiện tại.
 *   Ưu tiên dùng API native BarcodeDetector (Chrome Android/macOS); tự động dự phòng sang jsQR qua canvas cho các trình duyệt khác (Windows, Firefox, iOS).
 * Được gọi ở: src/client/components/qr-scanner.tsx (useEffect quản lý camera trong component QrScanner).
 * @returns Hàm Detect bất đồng bộ nhận vào phần tử HTMLVideoElement và trả về chuỗi mã QR nếu đọc thành công.
 */
async function makeDetector(): Promise<Detect> {
  // Bước 1: Ưu tiên dùng BarcodeDetector phần cứng của trình duyệt (Chrome Android, macOS) để tăng tốc độ nhận diện và tiết kiệm pin.
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (BD) {
    try {
      const d = new BD({ formats: ["qr_code"] });
      return async (v) => (await d.detect(v))[0]?.rawValue;
    } catch {
      /* fall through to jsQR */
    }
  }
  // Bước 2: Dự phòng bằng thư viện jsQR khi trình duyệt không hỗ trợ BarcodeDetector. Dynamic import giúp giảm kích thước bundle ban đầu.
  const jsQR = (await import("jsqr")).default;
  const canvas = document.createElement("canvas");
  // willReadFrequently thông báo cho trình duyệt tối ưu bộ nhớ đệm canvas phục vụ thao tác đọc pixel lặp lại liên tục bằng getImageData.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (v) => {
    if (!ctx || !v.videoWidth) return undefined;
    // Half size is plenty for a phone held up to the camera, and four times cheaper.
    const w = Math.round(v.videoWidth / 2);
    const h = Math.round(v.videoHeight / 2);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(v, 0, 0, w, h);
    // Bước 3: Đọc pixel từ canvas và giải mã bằng jsQR; dùng dontInvert để tránh thử quét màu đảo ngược, giảm 50% thời gian xử lý mỗi frame.
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data || undefined;
  };
}

/** Camera QR reader. The camera only starts on a press and stops when closed or unmounted. */
/**
 * Làm gì: Component quét mã QR bằng camera thiết bị. Chỉ kích hoạt camera khi người dùng bấm mở nhằm tiết kiệm pin và tránh tự ý chiếm quyền camera.
 * Được gọi ở:
 * - src/routes/app.pass.tsx: Trang thẻ hội viên và tự điểm danh (/app/pass).
 * - src/routes/desk.gate.tsx: Trang kiểm soát ra vào và quét thẻ tại quầy lễ tân (/desk/gate).
 * @param onCode Callback được kích hoạt ngay khi nhận diện được mã QR hợp lệ.
 * @param startLabel Nhãn tùy chỉnh hiển thị trên nút mở camera (mặc định: "Use the camera").
 * @param hint Dòng chữ gợi ý hướng dẫn hiển thị cạnh nút khi camera đang tắt.
 * @returns Khung giao diện camera kèm khung ngắm căn chỉnh và nút bấm bật/tắt camera.
 */
export function QrScanner({
  onCode,
  startLabel,
  hint,
}: {
  onCode: (code: string) => void;
  startLabel?: string;
  hint?: string;
}) {
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  // The latest handler, read at scan time, so a new parent render does not restart the camera.
  const handler = useRef(onCode);
  useEffect(() => {
    handler.current = onCode;
  });

  useEffect(() => {
    // Khi camera đang tắt: đặt trạng thái ready = false và dừng effect, không khởi tạo luồng video.
    if (!on) {
      setReady(false);
      return;
    }
    // Khởi tạo các biến kiểm soát vòng đời luồng: cờ dừng khi unmount, luồng MediaStream, timer quét frame và mã vừa đọc gần nhất.
    let stop = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    (async () => {
      try {
        // Bước 1: Kiểm tra trình duyệt có hỗ trợ API getUserMedia không; nếu không thì ném lỗi để chuyển sang chế độ nhập mã tay.
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera api");
        // Bước 2: Yêu cầu quyền truy cập camera sau (facingMode: "environment") của thiết bị để quét mã; tắt micro (audio: false).
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        // Nếu người dùng đã bấm tắt hoặc component unmount trong lúc chờ cấp quyền, lập tức giải phóng stream ngay để không bị treo đèn camera.
        if (stop) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (!video.current) return;
        // Bước 3: Gắn luồng MediaStream vào thẻ video và bắt đầu phát hình ảnh trực tiếp.
        video.current.srcObject = stream;
        await video.current.play();
        // Bước 4: Khởi tạo bộ nhận diện mã QR phù hợp nhất với trình duyệt hiện tại.
        const detect = await makeDetector();
        if (stop) return;
        // Đánh dấu camera đã sẵn sàng để ẩn thông báo "Starting camera…" trên giao diện.
        setReady(true);
        // Bước 5: Thiết lập vòng lặp quét từng khung hình từ luồng video của camera.
        const loop = async () => {
          if (stop || !video.current) return;
          try {
            const raw = await detect(video.current);
            // Cơ chế chống quét lặp: chỉ gọi callback khi đọc được mã mới khác mã vừa quét. Đặt cooldown 4 giây trước khi cho phép quét lại cùng một mã.
            if (raw && raw !== last) {
              last = raw;
              handler.current(raw);
              setTimeout(() => (last = ""), 4000);
            }
          } catch {
            /* a frame that cannot be read is skipped */
          }
          // Quét khung hình tiếp theo sau 250ms (4 lần/giây), cân bằng hoàn hảo giữa độ nhạy nhận diện và mức tiêu thụ CPU/pin.
          timer = setTimeout(() => void loop(), 250);
        };
        void loop();
      } catch (e) {
        // Bước 6: Xử lý sự cố khi không mở được camera (từ chối cấp quyền NotAllowedError/SecurityError hoặc lỗi phần cứng), thông báo qua toast và tắt camera.
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        toast.error(
          denied
            ? t("Camera permission was refused. Allow the camera in the browser, or type the code.")
            : t("The camera is not available. Type the code instead."),
        );
        setOn(false);
      }
    })();
    // Bước 7: Dọn dẹp tài nguyên khi tắt camera hoặc component unmount: hủy timer quét frame và dừng toàn bộ track của MediaStream.
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [on]);

  return (
    <div className="grid gap-2">
      {on ? (
        <div className="relative overflow-hidden rounded-[var(--radius-md)] bg-black">
          <video ref={video} muted playsInline className="aspect-video w-full object-cover" />
          {/* Frame guide: where to hold the code. Static, so nothing to honour for reduced motion. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="size-40 rounded-[var(--radius-md)] border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
          {!ready ? <p className="absolute inset-x-0 bottom-2 text-center text-xs text-white/80">{t("Starting camera…")}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOn((v) => !v)}>
          {on ? t("Turn camera off") : (startLabel ?? t("Use the camera"))}
        </Button>
        {hint && !on ? <span className="text-xs text-muted">{hint}</span> : null}
      </div>
    </div>
  );
}
