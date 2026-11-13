import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./ui";
import { t } from "@/client/lib/i18n";

/**
 * A scanned code may be the bare token or a link that carries it (`/app/pass?d=…`, `?t=…`).
 * Both the gate and the member page send the token itself to the API.
 */
export function tokenFromScan(raw: string): string {
  const v = raw.trim();
  if (!/^https?:\/\//i.test(v)) return v;
  try {
    const u = new URL(v);
    return u.searchParams.get("d") || u.searchParams.get("t") || v;
  } catch {
    return v;
  }
}

type Detect = (video: HTMLVideoElement) => Promise<string | undefined>;

/** BarcodeDetector where the browser has it (Android, macOS Chrome); jsQR everywhere else (Windows, Firefox, iOS). */
async function makeDetector(): Promise<Detect> {
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (BD) {
    try {
      const d = new BD({ formats: ["qr_code"] });
      return async (v) => (await d.detect(v))[0]?.rawValue;
    } catch {
      /* fall through to jsQR */
    }
  }
  const jsQR = (await import("jsqr")).default;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (v) => {
    if (!ctx || !v.videoWidth) return undefined;
    // Half size is plenty for a phone held up to the camera, and four times cheaper.
    const w = Math.round(v.videoWidth / 2);
    const h = Math.round(v.videoHeight / 2);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(v, 0, 0, w, h);
    return jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data || undefined;
  };
}

/** Camera QR reader. The camera only starts on a press and stops when closed or unmounted. */
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
    if (!on) {
      setReady(false);
      return;
    }
    let stop = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = "";
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera api");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stop) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detect = await makeDetector();
        if (stop) return;
        setReady(true);
        const loop = async () => {
          if (stop || !video.current) return;
          try {
            const raw = await detect(video.current);
            if (raw && raw !== last) {
              last = raw;
              handler.current(raw);
              setTimeout(() => (last = ""), 4000);
            }
          } catch {
            /* a frame that cannot be read is skipped */
          }
          timer = setTimeout(() => void loop(), 250);
        };
        void loop();
      } catch (e) {
        const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
        toast.error(
          denied
            ? t("Camera permission was refused. Allow the camera in the browser, or type the code.")
            : t("The camera is not available. Type the code instead."),
        );
        setOn(false);
      }
    })();
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
