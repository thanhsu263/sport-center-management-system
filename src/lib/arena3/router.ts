import { getSql } from "@/lib/db";
import { ApiError, err, handleError, json } from "./errors";
import { withIdempotency } from "./helpers";
import { startJobLoop } from "./jobs";
import { authFromRequest, optionalAuth, staffRoles, type PublicUser } from "./session";
import { withTx } from "./tx";
import * as authH from "./handlers/auth";
import * as memberH from "./handlers/members";
import * as planH from "./handlers/plans";
import * as bookH from "./handlers/bookings";
import * as deskH from "./handlers/desk";
import * as sportsH from "./handlers/sports";
import * as assetsH from "./handlers/assets";
import * as attH from "./handlers/attendance";
import * as courtH from "./handlers/courts";
import * as staffH from "./handlers/staff";
import * as trainH from "./handlers/training";
import * as chatH from "./handlers/chat";
import * as opsH from "./handlers/ops";
import * as classH from "./handlers/classes";
import * as xH from "./handlers/extras";

type Result = { status: number; body: unknown };

function pathOf(request: Request): { method: string; parts: string[]; url: URL } {
  const url = new URL(request.url);
  const raw = url.pathname.replace(/^\/(?:v1|api)\/?/, "").replace(/\/+$/, "");
  const parts = raw ? raw.split("/") : [];
  return { method: request.method.toUpperCase(), parts, url };
}

async function dispatch(request: Request): Promise<Response | Result> {
  startJobLoop();
  const { method, parts, url } = pathOf(request);
  const p0 = parts[0] ?? "";
  const p1 = parts[1] ?? "";
  const p2 = parts[2] ?? "";

  const idem = (userId: string | null, fn: () => Promise<Result>) =>
    withTx(async (sql) => {
      const r = await withIdempotency(sql, request, userId, true, fn);
      return r;
    });

  // Server-Sent Events live update stream
  if (method === "GET" && p0 === "live" && !p1) {
    const sql = await getSql();
    const user = await optionalAuth(sql, request);
    return liveStreamHandler(request, sql, user);
  }

  // WebRTC Signaling Relay
  if (p0 === "rtc" && !p1) {
    if (method === "GET") {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.rtcPollHandler(sql, user, request);
        return { status: 200, body: data };
      });
    }
    if (method === "POST") {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.rtcSignalHandler(sql, user, request);
        return { status: 200, body: data };
      });
    }
  }

  // Two-way Chat
  if (p0 === "conversations") {
    if (method === "GET" && !p1) {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.listConversations(sql, user);
        return { status: 200, body: data };
      });
    }
    if (method === "POST" && !p1) {
      return withTx(async (sql) => {
        const user = await authFromRequest(sql, request);
        const data = await chatH.createOrGetConversation(sql, user, request);
        return { status: 201, body: data };
      });
    }
    if (p1) {
      const convId = p1;
      if (method === "GET" && p2 === "messages") {
        return withTx(async (sql) => {
          const user = await authFromRequest(sql, request);
          const data = await chatH.listMessages(sql, user, convId, url);
          return { status: 200, body: data };
        });
      }
      if (method === "POST" && p2 === "messages") {
        return withTx(async (sql) => {
          const user = await authFromRequest(sql, request);
          const data = await chatH.sendMessage(sql, user, convId, request);
          return { status: 201, body: data };
        });
      }
      if (method === "POST" && p2 === "read") {
        return withTx(async (sql) => {
          const user = await authFromRequest(sql, request);
          const data = await chatH.markConversationRead(sql, user, convId);
          return { status: 200, body: data };
        });
      }
    }
  }

  // "Is the server there?" — what the connection banner's retry button asks. No session and no
  // database on purpose: it answers whenever the app itself is running, which is the whole question.
  if (method === "GET" && p0 === "health" && !p1) {
    return { status: 200, body: { ok: true } };
  }

  // Public auth
  if (method === "POST" && p0 === "auth" && p1 === "register") {
    return withTx((sql) => authH.register(sql, request));
  }
  if (method === "POST" && p0 === "auth" && p1 === "otp" && p2 === "verify") {
    return withTx((sql) => authH.verifyOtp(sql, request));
  }
  if (method === "POST" && p0 === "auth" && p1 === "login") {
    return withTx((sql) => authH.login(sql, request));
  }
  if (method === "POST" && p0 === "auth" && p1 === "password" && p2 === "forgot") {
    return withTx((sql) => authH.forgot(sql, request));
  }

  if (method === "GET" && p0 === "plans" && !p1) {
    const sql = await getSql();
    const user = await optionalAuth(sql, request);
    return planH.plansList(sql, user);
  }
  if (method === "GET" && p0 === "courts" && !p1) {
    const sql = await getSql();
    return bookH.courtsList(sql);
  }

  if (method === "GET" && p0 === "site-assets" && !p1) {
    const sql = await getSql();
    return assetsH.siteAssetsList(sql);
  }
  if (method === "GET" && p0 === "site-assets" && p1 && p2 === "file") {
    const sql = await getSql();
    return assetsH.siteAssetGetFile(sql, p1);
  }
  if (method === "GET" && p0 === "media" && p1 === "credits") {
    const sql = await getSql();
    return assetsH.publicMediaCredits(sql, request);
  }
  if (method === "GET" && p0 === "sports" && !p1) {
    const sql = await getSql();
    return sportsH.publicSportsList(sql);
  }
  if (method === "GET" && p0 === "classes" && !p1) {
    const sql = await getSql();
    const user = await optionalAuth(sql, request);
    return classH.classesList(sql, request, user);
  }
  if (method === "GET" && p0 === "price-rules" && !p1) {
    const sql = await getSql();
    return deskH.priceRulesGet(sql);
  }

  // Authenticated
  const authed = async (
    fn: (sql: Awaited<ReturnType<typeof getSql>>, user: PublicUser) => Promise<Result | Response>,
  ) => {
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
  const authedRead = async (
    fn: (sql: Awaited<ReturnType<typeof getSql>>, user: PublicUser) => Promise<Result | Response>,
  ) => {
    const sql = await getSql();
    const user = await authFromRequest(sql, request);
    return fn(sql, user);
  };

  if (method === "POST" && p0 === "auth" && p1 === "logout") {
    return authed((sql, user) => authH.logout(sql, request, user));
  }
  if (method === "GET" && p0 === "me" && !p1) {
    return authedRead((sql, user) => authH.meGet(sql, user));
  }
  if (method === "GET" && p0 === "me" && p1 === "bookings" && !p2) {
    return authedRead((sql, user) => bookH.meBookings(sql, user));
  }
  if (method === "PATCH" && p0 === "me" && !p1) {
    return authed((sql, user) => authH.mePatch(sql, request, user));
  }
  if (method === "GET" && p0 === "me" && p1 === "notifications" && !p2) {
    return authedRead((sql, user) => authH.meNotifications(sql, request, user));
  }
  if (method === "POST" && p0 === "me" && p1 === "notifications" && p2 === "read") {
    return authed((sql, user) => authH.meNotificationsRead(sql, request, user));
  }
  if (method === "POST" && p0 === "me" && p1 === "password") {
    return authed((sql, user) => authH.mePassword(sql, request, user));
  }
  if (method === "GET" && p0 === "occupancy" && p1 === "detail") {
    return authedRead((sql, user) => bookH.occupancyDetail(sql, request, user));
  }
  if (method === "GET" && p0 === "availability" && !p1) {
    return authedRead((sql, user) => bookH.availabilityGet(sql, request, user));
  }
  if (method === "GET" && p0 === "occupancy" && !p1) {
    return authedRead((sql) => bookH.occupancyGet(sql, request));
  }
  if (method === "PATCH" && p0 === "courts" && p1 && !p2) {
    return authed((sql, user) => bookH.courtsPatch(sql, p1, request, user));
  }

  // Staff accounts — the manager is the only one who issues them (R-01…R-03).
  if (method === "GET" && p0 === "staff" && !p1) {
    return authedRead((sql, user) => staffH.staffList(sql, request, user));
  }
  if (method === "POST" && p0 === "staff" && !p1) {
    return authed((sql, user) => staffH.staffCreate(sql, request, user));
  }
  if (method === "PATCH" && p0 === "staff" && p1 && !p2) {
    return authed((sql, user) => staffH.staffPatch(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "staff" && p1 && p2 === "reset-password") {
    return authed((sql, user) => staffH.staffResetPassword(sql, p1, user));
  }
  if (method === "POST" && p0 === "staff" && p1 && p2 === "revoke-sessions") {
    return authed((sql, user) => staffH.staffRevokeSessions(sql, p1, user));
  }

  if (method === "GET" && p0 === "directory" && p1 === "members") {
    return authedRead((sql, user) => memberH.membersDirectory(sql, request, user));
  }
  if (method === "GET" && p0 === "members" && !p1) {
    return authedRead((sql, user) => memberH.membersSearch(sql, request, user));
  }
  if (method === "POST" && p0 === "members" && !p1) {
    return authed((sql, user) => memberH.membersCreate(sql, request, user));
  }
  if (method === "GET" && p0 === "members" && p1 && !p2) {
    return authedRead((sql, user) => memberH.memberGet(sql, p1, user));
  }
  if (method === "POST" && p0 === "members" && p1 && p2 === "reset-password") {
    return authed((sql, user) => memberH.memberResetPassword(sql, p1, user));
  }
  if (method === "PATCH" && p0 === "members" && p1 && !p2) {
    return authed((sql, user) => memberH.membersUpdate(sql, p1, request, user));
  }

  if (method === "POST" && p0 === "plans" && !p1) {
    return authed((sql, user) => planH.plansCreate(sql, request, user));
  }
  if (method === "GET" && p0 === "plans" && p1 && !p2) {
    return authedRead((sql, user) => planH.plansGet(sql, p1, user));
  }
  if (method === "PATCH" && p0 === "plans" && p1 && !p2) {
    return authed((sql, user) => planH.plansPatch(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "subscriptions" && !p1) {
    return authed((sql, user) => planH.subscriptionsCreate(sql, request, user));
  }

  if (method === "POST" && p0 === "bookings" && !p1) {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, true, () => bookH.bookingsHold(sql, request, user)),
    );
  }
  if (method === "POST" && p0 === "bookings" && p1 && p2 === "confirm") {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, true, () => bookH.bookingsConfirm(sql, p1, request, user)),
    );
  }

  if (method === "POST" && p0 === "shifts" && p1 === "open") {
    return authed((sql, user) => deskH.shiftOpen(sql, user));
  }
  if (method === "GET" && p0 === "shifts" && p1 === "current") {
    return authedRead((sql, user) => deskH.shiftCurrent(sql, user, request));
  }
  if (method === "POST" && p0 === "shifts" && p1 && p2 === "close") {
    return authed((sql, user) => deskH.shiftClose(sql, p1, request, user));
  }
  if (method === "GET" && p0 === "payments" && p1 === "pending") {
    return authedRead((sql, user) => deskH.paymentsPending(sql, request, user));
  }
  if (method === "POST" && p0 === "payments" && !p1) {
    return authed((sql, user) =>
      withIdempotency(sql, request, user.id, true, () => deskH.paymentsCreate(sql, request, user)),
    );
  }
  if (method === "POST" && p0 === "payments" && p1 && p2 === "refund") {
    return authed((sql, user) => deskH.paymentsRefund(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "payments" && p1 && p2 === "approve-refund") {
    return authed((sql, user) => deskH.paymentsApproveRefund(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "payments" && p1 && p2 === "reject-refund") {
    return authed((sql, user) => deskH.paymentsRejectRefund(sql, p1, request, user));
  }

  // Training plans, sessions results, students, homework (F4)
  if (method === "GET" && p0 === "invoices" && !p1) {
    return authedRead((sql, user) => deskH.invoicesMine(sql, request, user));
  }
  if (method === "GET" && p0 === "invoices" && p1?.endsWith(".pdf")) {
    const id = p1.replace(/\.pdf$/, "");
    return authedRead((sql, user) => deskH.invoicePdf(sql, id, request, user));
  }
  if (method === "GET" && p0 === "reports" && p1 === "attendance" && !p2) {
    return authedRead((sql, user) => attH.reportsAttendance(sql, request, user));
  }
  if (method === "GET" && p0 === "at-risk" && !p1) {
    return authedRead((sql, user) => attH.atRiskList(sql, user));
  }
  if (method === "POST" && p0 === "contacts" && !p1) {
    return authed((sql, user) => attH.contactCreate(sql, request, user));
  }
  if (method === "GET" && p0 === "members" && p1 && p2 === "contacts") {
    return authedRead((sql, user) => attH.contactList(sql, p1, user));
  }
  if (method === "GET" && p0 === "reports" && p1 === "revenue") {
    return authedRead((sql, user) => {
      requireRole(user, ["manager"]);
      return deskH.reportsRevenue(sql, request, user);
    });
  }
  if (method === "GET" && p0 === "reports" && p1 === "occupancy") {
    return authedRead((sql, user) => deskH.reportsOccupancy(sql, request, user));
  }
  if (method === "GET" && p0 === "settings" && !p1) {
    return authedRead((sql, user) => deskH.settingsGet(sql, user));
  }
  if (method === "PATCH" && p0 === "settings" && !p1) {
    return authed((sql, user) => deskH.settingsPatch(sql, request, user));
  }
  if (method === "PUT" && p0 === "price-rules") {
    return authed((sql, user) => deskH.priceRulesPut(sql, request, user));
  }
  if (method === "GET" && p0 === "audit") {
    return authedRead((sql, user) => deskH.auditList(sql, request, user));
  }

  if (method === "POST" && p0 === "subscriptions" && p1 && p2 === "freeze") {
    return authed((sql, user) => opsH.subscriptionFreeze(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "subscriptions" && p1 && p2 === "unfreeze") {
    return authed((sql, user) => opsH.subscriptionUnfreeze(sql, p1, user));
  }
  if (method === "POST" && p0 === "subscriptions" && p1 && p2 === "decline") {
    return authed((sql, user) => deskH.subscriptionDecline(sql, p1, user));
  }
  if (method === "POST" && p0 === "waitlist" && p1 && p2 === "accept") {
    return authed((sql, user) => opsH.waitlistAccept(sql, p1, user));
  }
  if (method === "POST" && p0 === "training-plans" && !p1) {
    return authed((sql, user) => trainH.trainingCreate(sql, request, user));
  }
  if (method === "GET" && p0 === "training-plans" && p1 === "templates") {
    return authedRead((sql, user) => trainH.templatesList(sql, request, user));
  }
  if (method === "POST" && p0 === "training-plans" && p1 === "from-template") {
    return authed((sql, user) => trainH.plansFromTemplate(sql, request, user));
  }
  if (method === "POST" && p0 === "training-plans" && p1 && p2 === "save-template") {
    return authed((sql, user) => trainH.templateSave(sql, p1, request, user));
  }
  if (method === "GET" && p0 === "training-plans" && p1 && p2 === "versions") {
    return authedRead((sql, user) => trainH.planVersions(sql, p1, user));
  }
  if (method === "PATCH" && p0 === "training-plans" && p1 && !p2) {
    return authed((sql, user) => trainH.trainingPatch(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "classes" && !p1) {
    return authed((sql, user) => classH.classesCreate(sql, request, user));
  }
  if (method === "POST" && p0 === "classes" && p1 && p2 === "publish") {
    return authed((sql, user) => classH.classesPublish(sql, p1, user));
  }
  if (method === "POST" && p0 === "classes" && p1 && p2 === "enroll") {
    return authed((sql, user) => classH.classesEnroll(sql, p1, request, user));
  }
  if (method === "GET" && p0 === "classes" && p1 && !p2) {
    return authedRead((sql, user) => classH.classDetail(sql, p1, user));
  }
  if (method === "GET" && p0 === "classes" && p1 && p2 === "roster") {
    return authedRead((sql, user) => classH.classRoster(sql, p1, user));
  }
  if (method === "PATCH" && p0 === "classes" && p1 && !p2) {
    return authed((sql, user) => classH.classesPatch(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "classes" && p1 && p2 === "coach") {
    return authed((sql, user) => classH.classesAssignCoach(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "sessions" && p1 && p2 === "cancel") {
    return authed((sql, user) => classH.sessionCancel(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "sessions" && p1 && p2 === "reschedule") {
    return authed((sql, user) => classH.sessionReschedule(sql, p1, request, user));
  }
  if (method === "GET" && p0 === "coach" && p1 === "schedule") {
    return authedRead((sql, user) => classH.coachSchedule(sql, user));
  }
  if (method === "GET" && p0 === "coach" && p1 === "classes") {
    return authedRead((sql, user) => classH.coachClasses(sql, user));
  }
  if (method === "DELETE" && p0 === "enrollments" && p1) {
    return authed((sql, user) => classH.enrollmentDelete(sql, p1, user));
  }
  if (
    method === "POST" &&
    p0 === "classes" &&
    p1 &&
    p2 === "plans" &&
    parts[3] === "duplicate-week"
  ) {
    return authed((sql, user) => trainH.plansDuplicateWeek(sql, p1, request, user));
  }
  if (method === "GET" && p0 === "sessions" && p1 && p2 === "results") {
    return authedRead((sql, user) => trainH.sessionResultsGet(sql, p1, user));
  }
  if (method === "PUT" && p0 === "sessions" && p1 && p2 === "results") {
    return authed((sql, user) => trainH.sessionResultsPut(sql, p1, request, user));
  }
  if (method === "GET" && p0 === "students" && p1 && p2 === "profile") {
    return authedRead((sql, user) => trainH.studentProfile(sql, p1, user));
  }
  if (method === "PUT" && p0 === "students" && p1 && p2 === "level") {
    return authed((sql, user) => trainH.studentLevelPut(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "students" && p1 && p2 === "notes") {
    return authed((sql, user) => trainH.studentNotePost(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "students" && p1 && p2 === "reviews") {
    return authed((sql, user) => trainH.studentReviewPost(sql, p1, request, user));
  }
  if (method === "GET" && p0 === "homework" && !p1) {
    return authedRead((sql, user) => trainH.homeworkList(sql, request, user));
  }
  if (method === "POST" && p0 === "homework" && !p1) {
    return authed((sql, user) => trainH.homeworkCreate(sql, request, user));
  }
  if (method === "GET" && p0 === "me" && p1 === "training" && !p2) {
    return authedRead((sql, user) => trainH.meTraining(sql, user));
  }
  if (method === "PUT" && p0 === "me" && p1 === "training-goal") {
    return authed((sql, user) => trainH.meTrainingGoal(sql, request, user));
  }
  if (method === "GET" && p0 === "me" && p1 === "homework" && !p2) {
    return authedRead((sql, user) => trainH.meHomework(sql, user));
  }
  if (method === "PUT" && p0 === "me" && p1 === "homework" && p2) {
    return authed((sql, user) => trainH.meHomeworkPut(sql, p2, request, user));
  }
  if (method === "POST" && p0 === "assistant") {
    return authed((sql, user) => opsH.assistantChat(sql, request, user));
  }
  // Before the bare /tickets read, or "mine" is matched as a ticket id.
  if (method === "GET" && p0 === "tickets" && p1 === "mine") {
    return authedRead((sql, user) => opsH.ticketsMine(sql, request, user));
  }
  if (method === "GET" && p0 === "tickets" && !p1) {
    return authedRead((sql, user) => opsH.ticketsList(sql, request, user));
  }
  if (method === "POST" && p0 === "tickets" && !p1) {
    return authed((sql, user) => opsH.ticketsCreate(sql, request, user));
  }
  if (method === "POST" && p0 === "tickets" && p1 && p2 === "reply") {
    return authed((sql, user) => opsH.ticketReply(sql, p1, request, user));
  }
  if (method === "POST" && p0 === "tickets" && p1 && p2 === "close") {
    return authed((sql, user) => opsH.ticketClose(sql, p1, user));
  }

  if (method === "GET" && p0 === "flags") {
    const sql = await getSql();
    return opsH.flagsGet(sql);
  }
  if (method === "PATCH" && p0 === "flags") {
    return authed((sql, user) => opsH.flagsPatch(sql, request, user));
  }

  // Manager courts
  if (method === "GET" && p0 === "manager" && p1 === "courts" && !p2) {
    return authedRead((sql, user) => courtH.managerCourtsList(sql, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "courts" && !p2) {
    return authed((sql, user) => courtH.managerCourtCreate(sql, request, user));
  }
  if (method === "PATCH" && p0 === "manager" && p1 === "courts" && p2 && !parts[3]) {
    return authed((sql, user) => bookH.courtsPatch(sql, p2, request, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "courts" && p2 && parts[3] === "retire") {
    return authed((sql, user) => courtH.managerCourtRetire(sql, p2, request, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "courts" && p2 && parts[3] === "restore") {
    return authed((sql, user) => courtH.managerCourtRestore(sql, p2, user));
  }

  // Manager sports
  if (method === "GET" && p0 === "manager" && p1 === "sports" && !p2) {
    return authedRead((sql, user) => sportsH.managerSportsList(sql, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "sports" && !p2) {
    return authed((sql, user) => sportsH.managerSportCreate(sql, request, user));
  }
  if (method === "PATCH" && p0 === "manager" && p1 === "sports" && p2 && !parts[3]) {
    return authed((sql, user) => sportsH.managerSportPatch(sql, p2, request, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "sports" && p2 && parts[3] === "retire") {
    return authed((sql, user) => sportsH.managerSportRetire(sql, p2, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "sports" && p2 && parts[3] === "restore") {
    return authed((sql, user) => sportsH.managerSportRestore(sql, p2, user));
  }
  if (method === "DELETE" && p0 === "manager" && p1 === "sports" && p2 && !parts[3]) {
    return authed((sql, user) => sportsH.managerSportDelete(sql, p2, user));
  }

  // Manager site assets & media library
  if (
    (method === "GET" && p0 === "manager" && p1 === "site-assets" && p2 === "library") ||
    (method === "GET" && p0 === "manager" && p1 === "media-library" && !p2)
  ) {
    return authedRead((sql, user) => assetsH.managerMediaLibrary(sql, request, user));
  }
  if (method === "GET" && p0 === "manager" && p1 === "site-assets" && !p2) {
    return authedRead((sql, user) => assetsH.managerAssetsList(sql, user));
  }
  if (method === "POST" && p0 === "manager" && p1 === "site-assets" && p2 === "upload") {
    return authed((sql, user) => assetsH.managerAssetUpload(sql, request, user));
  }
  if (
    (method === "PUT" || method === "POST") &&
    p0 === "manager" &&
    p1 === "site-assets" &&
    p2 &&
    !parts[3]
  ) {
    return authed((sql, user) => assetsH.managerAssetUpload(sql, request, user, p2));
  }
  if (method === "PATCH" && p0 === "manager" && p1 === "site-assets" && p2 && !parts[3]) {
    return authed((sql, user) => assetsH.managerAssetPatch(sql, request, user, p2));
  }
  if (
    method === "POST" &&
    p0 === "manager" &&
    p1 === "site-assets" &&
    p2 &&
    parts[3] === "revert"
  ) {
    return authed((sql, user) => assetsH.managerAssetRevert(sql, request, user, p2));
  }
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

  // Maintenance work orders.
  if (method === "GET" && p0 === "work-orders" && !p1) {
    return authedRead((sql, user) => xH.workOrdersList(sql, request, user));
  }
  if (method === "POST" && p0 === "work-orders" && !p1) {
    return authed((sql, user) => xH.workOrdersCreate(sql, request, user));
  }
  if (method === "PATCH" && p0 === "work-orders" && p1) {
    return authed((sql, user) => xH.workOrdersPatch(sql, p1, request, user));
  }

  void staffRoles;
  void idem;
  throw err.notFound(`No route for ${method} /v1/${parts.join("/")}`);
}

export async function handleApi(request: Request): Promise<Response> {
  try {
    const result = await dispatch(request);
    if (result instanceof Response) return result;
    if (result.status === 204) return new Response(null, { status: 204 });
    return json(result.status, result.body);
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, e.body());
    return handleError(e);
  }
}
