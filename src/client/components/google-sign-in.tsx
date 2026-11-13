import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, type SessionUser } from "@/client/arena3/client";
import { t, useLang } from "@/client/lib/i18n";

type GoogleId = {
  initialize(opts: { client_id: string; callback: (r: { credential?: string }) => void }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
};
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";

let gisLoad: Promise<void> | null = null;

/** Google Identity Services, loaded once per page and only where the button is shown. */
function loadGis(): Promise<void> {
  gisLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoad = null;
      reject(new Error("gis"));
    };
    document.head.appendChild(s);
  });
  return gisLoad;
}

/**
 * Google's own button. It renders nothing until a client id is known, so a
 * machine without one looks the same as before. Each press hands the Google ID
 * token to `onCredential`; what it means (sign in, or link) is the caller's.
 * Pass `clientId` when the caller already has it; otherwise it is fetched.
 */
export function GoogleButton({
  onCredential,
  text = "continue_with",
  clientId: knownClientId,
}: {
  onCredential: (credential: string) => void | Promise<void>;
  text?: "continue_with" | "signin_with";
  clientId?: string | null;
}) {
  const lang = useLang();
  const box = useRef<HTMLDivElement>(null);
  const [fetchedId, setFetchedId] = useState<string | null>(null);
  const clientId = knownClientId === undefined ? fetchedId : knownClientId;
  // The latest handler, so the one-time Google callback never calls a stale closure.
  const handler = useRef(onCredential);
  handler.current = onCredential;

  useEffect(() => {
    if (knownClientId !== undefined) return;
    let live = true;
    apiGet<{ client_id: string | null }>("/auth/google", { background: true })
      .then((r) => live && setFetchedId(r.client_id))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [knownClientId]);

  useEffect(() => {
    if (!clientId) return;
    let live = true;
    loadGis()
      .then(() => {
        const id = window.google?.accounts.id;
        if (!live || !id || !box.current) return;
        id.initialize({
          client_id: clientId,
          callback: ({ credential }) => {
            if (credential) void handler.current(credential);
          },
        });
        box.current.replaceChildren();
        id.renderButton(box.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          shape: "pill",
          text,
          width: Math.min(box.current.clientWidth || 320, 400),
          locale: lang,
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [clientId, lang, text]);

  if (!clientId) return null;
  return <div ref={box} className="flex min-h-11 w-full justify-center" />;
}

/**
 * "Continue with Google" on the sign-in page. It only signs in an account
 * whose owner already linked this Google account in Account settings; Google
 * never creates an account.
 */
export function GoogleSignIn({
  onSignedIn,
  onError,
}: {
  onSignedIn: (res: { token: string; user: SessionUser }) => void;
  onError: (err: unknown) => void;
}) {
  const [clientId, setClientId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<{ client_id: string | null }>("/auth/google", { background: true })
      .then((r) => live && setClientId(r.client_id))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!clientId) return null;
  return (
    <div className="mt-4 grid gap-3">
      <div className="flex items-center gap-3 text-2xs text-muted">
        <span className="h-px flex-1 bg-line" />
        {t("or")}
        <span className="h-px flex-1 bg-line" />
      </div>
      <GoogleButton
        clientId={clientId}
        onCredential={async (credential) => {
          try {
            onSignedIn(await apiPost<{ token: string; user: SessionUser }>("/auth/google", { credential }));
          } catch (e) {
            onError(e);
          }
        }}
      />
      <p className="text-center text-2xs text-muted">{t("Link Google in Account settings first.")}</p>
    </div>
  );
}
