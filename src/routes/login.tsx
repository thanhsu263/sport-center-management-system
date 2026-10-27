import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ArenaMark } from "@/components/mark";
import { Cover, HeroVideo, MediaCaption } from "@/components/media";
import { Button, Card, Field, Input } from "@/components/ui";
import { Reveal, Stagger, StaggerItem } from "@/components/motion";
import { GLBackground, Magnet, ShinyText, SplitText, SpotlightCard } from "@/components/fx";
import { ApiClientError, apiPost, homeFor, setSession, takeSessionNotice, type SessionUser } from "@/lib/arena3/client";
import { roleLabel } from "@/lib/arena3/labels";
import { LangSwitch } from "@/components/lang-switch";
import { t, tServer, tk } from "@/lib/i18n";

export const Route = createFileRoute("/login")({ component: Login });

/**
 * The seeded demo password.
 *
 * It only ever travels with a tap on one of the buttons below, and it is not
 * written anywhere a visitor can read it. Printing it under the heading — next
 * to a password box that came pre-filled with it — meant the credential for
 * every seeded account, manager included, was published on the front page, and
 * anyone registering a real account was handed it as their default.
 *
 * Set `VITE_DEMO_LOGINS=off` to ship this app with no demo accounts on show.
 */
const DEMO_PASSWORD = "ChangeMe!a3";
const DEMO_LOGINS_ON = import.meta.env.PROD
  ? import.meta.env.VITE_DEMO_LOGINS === "on"
  : import.meta.env.VITE_DEMO_LOGINS !== "off";

const DEMOS: { role: SessionUser["role"]; phone: string; name: string; note: string }[] = [
  { role: "manager", phone: "0900000001", name: "Phạm Quốc Bảo", note: tk("Pricing · classes · reports") },
  { role: "receptionist", phone: "0900000002", name: "Trần Thu Hà", note: tk("Search · take payment · walk-ins") },
  { role: "coach", phone: "0901110011", name: "Nguyễn Minh Khoa", note: tk("Badminton classes") },
  { role: "member", phone: "0901230101", name: "Nam", note: tk("All-access plan · court booked today") },
  { role: "member", phone: "0901230102", name: "Linh", note: tk("Plan expires in ~4 days") },
  { role: "member", phone: "0901230106", name: "Ha", note: tk("Expired: needs a renewal") },
];

function Login() {
  const navigate = useNavigate();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // Why the last attempt failed. Kept on the form until the next one: a toast fades after a few
  // seconds, and "wrong password" is the one message a person needs to be able to read twice.
  const [error, setError] = useState<{ message: string; credentials: boolean } | null>(null);
  // Why someone is here again: the session ran out while they were in the app. Read on the client
  // only, because session storage does not exist while the server renders this page.
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (takeSessionNotice()) setEnded(true);
  }, []);

  async function submit(e?: FormEvent, demo?: { phone: string }) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await apiPost<{ token: string; user: SessionUser }>("/auth/login", {
        login: demo?.phone ?? login,
        // The demo password rides along with the button that knows it rather
        // than sitting in the form where a visitor can read it back.
        password: demo ? DEMO_PASSWORD : password,
      });
      setSession(res.token, res.user);
      toast.success(t("Welcome, {name}", { name: res.user.full_name }), { id: "login-hello" });
      navigate({ to: homeFor(res.user.role) });
    } catch (err) {
      const msg = err instanceof Error ? tServer(err.message) : t("Could not sign you in");
      toast.error(msg, { id: "login-error-toast" });
      setError({
        message: msg,
        // Only a refused sign-in says anything about the two boxes; no signal or a busy server does not.
        credentials: err instanceof ApiClientError && (err.status === 400 || err.status === 401),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh lg:grid lg:grid-cols-2">
      <div className="grain relative hidden min-h-dvh overflow-hidden lg:block">
        <HeroVideo slot="auth.login.video" posterSlot="auth.login.image" />
        <div className="hero-scrim absolute inset-0" />
        <GLBackground
          variant="threads"
          className="opacity-55 mix-blend-screen"
          color="#e6eed9"
          amplitude={1.1}
          speed={0.5}
          opacity={0.3}
        />
        <div className="relative flex h-full flex-col justify-between p-10">
          <Link to="/" className="inline-flex items-center gap-2 self-start rounded-full bg-pass/90 px-3 py-1.5 text-pass-fg">
            <ArenaMark className="size-8" />
            <span className="font-display text-2xl">Lê Long Sport Center</span>
          </Link>
          <div className="max-w-sm rounded-[var(--radius-xl)] bg-pass/92 p-6 text-pass-fg">
            <ShinyText className="shiny-on-media text-2xs" speed={6}>
              {t("The desk is open")}
            </ShinyText>
            <SplitText
              as="p"
              text={t("One schedule for courts, classes and cash.")}
              splitBy="words"
              stagger={0.055}
              delay={0.25}
              className="mt-2 block font-display text-4xl leading-tight"
            />
          </div>
        </div>
      </div>
      <div className="relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
        <div className="absolute right-4 top-2 z-10 flex items-center gap-2 lg:top-4">
          <LangSwitch />
        </div>
        <Cover slot="auth.login.image" alt="" scrim="none" className="mb-6 h-36 rounded-[var(--radius-xl)] lg:hidden">
          <MediaCaption>
            <span className="font-display text-2xl">Lê Long Sport Center</span>
          </MediaCaption>
        </Cover>
        <div className="mb-6 flex items-center gap-2 lg:hidden">
          <ArenaMark />
          <p className="text-2xs font-medium text-muted">{t("Sports centre")}</p>
        </div>
        <h1 className="font-display text-4xl">{t("Sign in")}</h1>
        <p className="mt-1 text-sm text-muted">
          {DEMO_LOGINS_ON
            ? t("Sign in with your phone or email, or tap a demo account below.")
            : t("Sign in with your phone number or email.")}
        </p>
        {/* The live region is always there, so the line is read out when it appears. */}
        <div role="status">
          {ended ? (
            <p className="mt-4 rounded-[var(--radius-lg)] border border-hold/30 bg-hold/5 px-4 py-3 text-sm">
              {t("Your session has ended. Please sign in again to continue.")}
            </p>
          ) : null}
        </div>
        <Reveal className="mt-6" from="up">
        <SpotlightCard className="rounded-[var(--radius-xl)]" size={360} strength={0.1}>
        <Card className="relative z-[2] p-5">
          <form className="grid gap-4" onSubmit={submit}>
            <Field label={t("Phone or email")}>
              <Input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                aria-invalid={error?.credentials ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
              />
            </Field>
            <Field label={t("Password")}>
              <div className="relative">
                <Input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  aria-invalid={error?.credentials ? true : undefined}
                  aria-describedby={error ? "login-error" : undefined}
                  className="pr-12"
                />
                <button
                  type="button"
                  className="absolute right-0 top-0 grid size-11 place-items-center text-muted hover:text-fg"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? t("Hide password") : t("Show password")}
                >
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            {error ? (
              <p id="login-error" role="alert" className="text-sm text-danger">
                {error.message}
              </p>
            ) : null}
            <Magnet radius={140} pull={0.22} wrapperClassName="w-full" className="w-full">
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? t("Signing in…") : t("Sign in")}
              </Button>
            </Magnet>
          </form>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
            <Link to="/register" className="hit text-accent-2 underline underline-offset-2">
              {t("Create an account")}
            </Link>
            {/*
              The reset flow existed on the server with nothing pointing at it,
              so a member who forgot their password had to ask the desk to do
              it for them.
            */}
            <Link to="/forgot" className="hit text-muted hover:underline">
              {t("Forgot your password?")}
            </Link>
          </div>
        </Card>
        </SpotlightCard>
        </Reveal>
        {DEMO_LOGINS_ON ? (
        <>
        <p className="mt-8 text-2xs font-semibold text-muted">{t("Demo accounts")}</p>
        <Stagger className="mt-3 flex flex-wrap gap-2" gap={0.05}>
          {DEMOS.map((d) => (
            <StaggerItem key={d.phone}>
            <button
              type="button"
              title={t(d.note)}
              onClick={() => {
                setLogin(d.phone);
                void submit(undefined, d);
              }}
              className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-3 py-2 text-left transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_10px_24px_-18px_rgba(27,31,29,0.6)] active:scale-95"
            >
              <span className="text-2xs font-semibold text-accent-text">{roleLabel(d.role)}</span>
              <span className="ml-2 text-sm font-medium">{d.name}</span>
            </button>
            </StaggerItem>
          ))}
        </Stagger>
        </>
        ) : null}
      </div>
    </main>
  );
}
