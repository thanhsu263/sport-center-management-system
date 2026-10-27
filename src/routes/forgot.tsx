import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Field, Input } from "@/components/ui";
import { AnimatePresence, motion } from "@/components/motion";
import { ApiClientError, apiPost } from "@/lib/arena3/client";
import { LangSwitch } from "@/components/lang-switch";
import { t, tServer } from "@/lib/i18n";

/**
 * Recover an account with a code sent to the email on file.
 *
 * The server side of this existed and had nothing in front of it: a member who
 * forgot their password had no route back in except asking the front desk to
 * do it for them, which is both a support burden and a worse answer than a
 * code only they can read.
 *
 * Two deliberate choices about what this screen does NOT reveal:
 *
 *  - It never says whether a phone number has an account. The wording after
 *    step one is the same either way, because "no account with that number"
 *    turns this page into a way of finding out who is a member here.
 *  - It never shows the email address it sent to in full. The server returns a
 *    masked form (`ng****@example.com`), enough to remind the owner which inbox
 *    to open and not enough to hand a stranger an address.
 */

export const Route = createFileRoute("/forgot")({ component: Forgot });

/** Puts a styled node where a translated sentence has its single placeholder. */
const SLOT = "";
const slot = (text: string, node: ReactNode) => {
  const [a, b] = text.split(SLOT);
  return (
    <>
      {a}
      {node}
      {b}
    </>
  );
};

function Forgot() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"phone" | "reset">("phone");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [demoOtp, setDemoOtp] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  // Why the last attempt on this step failed, and which input it is about, kept on the form until
  // the next one: a toast fades after a few seconds, and "that code is not right" is a line a
  // person reads twice.
  const [error, setError] = useState<{ message: string; field: string | null } | null>(null);
  /** For an input: marked invalid, and tied to the message, when the last attempt faulted it. */
  const faulted = (name: string) =>
    error?.field === name ? ({ "aria-invalid": true, "aria-describedby": "forgot-error" } as const) : {};

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooWeak =
    password.length > 0 && !(password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password));

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await apiPost<{ sent_to?: string | null; otp?: string }>("/auth/password/forgot", {
        phone,
      });
      setSentTo(res.sent_to ?? null);
      setDemoOtp(res.otp ?? null);
      setStep("reset");
    } catch (err) {
      setError({
        message: err instanceof Error ? tServer(err.message) : t("Could not send a code"),
        field: err instanceof ApiClientError ? (err.body.field ?? null) : null,
      });
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError({ message: t("The two passwords do not match."), field: "confirm" });
      return;
    }
    setBusy(true);
    try {
      await apiPost("/auth/otp/verify", { phone, otp, purpose: "reset", password });
      toast.success(t("Password changed. Sign in with the new one."));
      void navigate({ to: "/login" });
    } catch (err) {
      setError({
        message: err instanceof Error ? tServer(err.message) : t("That code is not right"),
        field: err instanceof ApiClientError ? (err.body.field ?? null) : null,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto grid min-h-dvh max-w-md place-items-center px-4">
      <Card className="relative w-full p-6">
        <LangSwitch className="absolute right-4 top-4" />
        <h1 className="pr-28 font-display text-3xl">{t("Forgot your password")}</h1>

        <AnimatePresence mode="wait">
          {step === "phone" ? (
            <motion.form
              key="phone"
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="mt-6 grid gap-4"
              onSubmit={requestCode}
            >
              <p className="text-sm text-muted">
                {t("Enter the phone number on your account. We will email a code to the address we hold for it.")}
              </p>
              <Field label={t("Phone")}>
                <Input
                  required
                  value={phone}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="0901 234 567"
                  onChange={(e) => setPhone(e.target.value)}
                  {...faulted("phone")}
                />
              </Field>
              {error ? (
                <p id="forgot-error" role="alert" className="text-sm text-danger">
                  {error.message}
                </p>
              ) : null}
              <Button type="submit" disabled={busy || !phone} className="w-full">
                {busy ? t("Sending…") : t("Send the code")}
              </Button>
            </motion.form>
          ) : (
            <motion.form
              key="reset"
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="mt-6 grid gap-4"
              onSubmit={reset}
            >
              {/*
                Same wording whether or not that number has an account — this
                page must not be usable to find out who is a member here.
              */}
              <p className="rounded-[var(--radius-md)] bg-wood px-3 py-2 text-sm">
                {sentTo ? (
                  <>
                    {slot(t("If that number has an account, a code is on its way to {email}. It expires in 5 minutes.", { email: SLOT }), <span className="font-medium">{sentTo}</span>)}
                  </>
                ) : (
                  <>
                    {t("If that number has an account with an email on file, a code is on its way. It expires in 5 minutes.")}
                  </>
                )}
              </p>
              <p className="text-sm text-muted">
                {t("No email on your account, or can't open it? Ask the front desk to reset your password. They will give you a temporary one.")}
              </p>
              {demoOtp ? (
                <p className="rounded-[var(--radius-md)] border border-hold/40 px-3 py-2 text-sm text-hold">
                  {slot(t("Demo build: the code is {code}.", { code: SLOT }), <span className="font-medium tabular-nums">{demoOtp}</span>)}
                </p>
              ) : null}

              <Field label={t("6-digit code")}>
                <Input
                  required
                  value={otp}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  onChange={(e) => setOtp(e.target.value)}
                  {...faulted("otp")}
                />
              </Field>
              <Field label={t("New password")} hint={tooWeak ? t("At least 8 characters, letters and digits.") : undefined}>
                <div className="relative">
                  <Input
                    required
                    type={show ? "text" : "password"}
                    value={password}
                    autoComplete="new-password"
                    onChange={(e) => setPassword(e.target.value)}
                    className="pr-12"
                    {...faulted("password")}
                    aria-invalid={tooWeak || error?.field === "password" ? true : undefined}
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
              <Field label={t("Confirm password")} hint={mismatch ? t("The two passwords do not match.") : undefined}>
                <Input
                  required
                  type={show ? "text" : "password"}
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.target.value)}
                  {...faulted("confirm")}
                  aria-invalid={mismatch || error?.field === "confirm" ? true : undefined}
                />
              </Field>
              {error ? (
                <p id="forgot-error" role="alert" className="text-sm text-danger">
                  {error.message}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={busy || !otp || !password || mismatch || tooWeak}
                className="w-full"
              >
                {busy ? t("Changing…") : t("Change the password")}
              </Button>
            </motion.form>
          )}
        </AnimatePresence>

        <p className="mt-6 text-sm text-muted">
          {t("Remembered it?")}{" "}
          <Link to="/login" className="hit text-accent-2 underline underline-offset-2">
            {t("Sign in")}
          </Link>
        </p>
      </Card>
    </main>
  );
}
