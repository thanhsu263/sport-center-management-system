import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";

type Turnstile = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global { interface Window { turnstile?: Turnstile } }
const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

export function useCaptcha() {
  const [token, setToken] = useState("");
  const [version, setVersion] = useState(0);
  const [website, setWebsite] = useState("");
  return { token, setToken, version, website, setWebsite,
    reset: () => { setToken(""); setVersion((v) => v + 1); } };
}

/** Imported only by register and forgot; no script is loaded with the key unset. */
export function Captcha({ state }: { state: ReturnType<typeof useCaptcha> }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const { setToken, version } = state;
  useEffect(() => {
    if (!siteKey) return;
    let id: string | undefined;
    let disposed = false;
    setFailed(false);
    const script = document.createElement("script");
    const render = () => {
      if (disposed || !host.current || !window.turnstile) return;
      id = window.turnstile.render(host.current, {
        sitekey: siteKey, size: "compact", callback: setToken,
        "expired-callback": () => setToken(""),
        "error-callback": () => { setToken(""); setFailed(true); },
      });
    };
    if (window.turnstile) render();
    else {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = render;
      script.onerror = () => { if (!disposed) setFailed(true); };
      document.head.appendChild(script);
    }
    return () => {
      disposed = true;
      if (id) window.turnstile?.remove(id);
      script.remove();
    };
  }, [version, setToken]);
  return <>
    <div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
      <label>{t("Leave this field empty")}<input name="website" tabIndex={-1} autoComplete="off"
        value={state.website} onChange={(e) => state.setWebsite(e.target.value)} /></label>
    </div>
    {siteKey ? <div className="min-w-0"><div ref={host} className="flex justify-center" />{failed ? <p role="alert" className="text-sm text-danger">
      {t("Human verification could not load. Try again.")}
      <button type="button" className="hit underline" onClick={state.reset}>{t("Try again")}</button>
    </p> : null}</div> : null}
  </>;
}
