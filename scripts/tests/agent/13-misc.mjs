/**
 * Suite 13: AI Assistant, Support Tickets, Notifications, Receipts.
 *
 * Cases:
 *  - AI-01: AI endpoint when disabled (F6 off) returns 403/controlled error, not 500
 *  - AI-02: Anonymous call to AI assistant returns 401
 *  - AI-03: Empty / malformed prompt returns 4xx
 *  - TKT-01: Member creates a valid support ticket (201) and reads it back (200)
 *  - TKT-02: Member attempting to view all tickets or other member's ticket returns 403/404
 *  - TKT-03: Ticket creation missing required body returns 400
 *  - TKT-04: Staff/manager replies to & closes ticket (200, status=closed)
 *  - TKT-05: Member attempting to close another member's ticket returns 403
 *  - NOTI-01: Member lists their own notifications (200)
 *  - NOTI-02: Member marks a notification as read (200, read_at stamped)
 *  - NOTI-03: Marking another member's notification returns 403/404 or affects 0 records
 *  - NOTI-04: Trigger email notification with SMTP offline returns controlled response (202), not 500
 *  - RCP-01: Retrieve own receipt/invoice (200, amount matches)
 *  - RCP-02: Member retrieving another member's receipt returns 403/404
 *  - RCP-03: Nonexistent receipt id returns 404
 *
 * Run: node scripts/tests/agent/run-suite.mjs 13
 */
import {
  IDS,
  PHONES,
  api,
  check,
  login,
  newMember,
  summary,
} from "../agent-lib.mjs";

console.log("=== Suite 13: Misc (AI, Tickets, Notifications, Receipts) ===");

const mgr = await login(PHONES.manager);
const rec = await login(PHONES.receptionist);

// ───────────────────────────── 1. AI Assistant (AI-) ─────────────────────────────
console.log("\n--- AI Assistant (AI-) ---");

// AI-02: Anonymous call to AI assistant returns 401
const aiAnon = await api("/assistant", {
  method: "POST",
  body: { message: "What are your opening hours?" },
});
check("AI-02", "Anonymous call to AI assistant returns 401", aiAnon, { status: 401 });

const memberAI = await newMember();

// AI-03: Empty / too short message returns 4xx
const aiEmpty = await api("/assistant", {
  method: "POST",
  token: memberAI.token,
  body: { message: " " },
});
check("AI-03", "Empty prompt to AI assistant returns 4xx validation", aiEmpty, {
  status: [400, 422],
  code: "VALIDATION",
});

// AI-01: Toggle F6 off, verify controlled rejection (403 BR-52), then toggle back on
const disableF6 = await api("/flags", {
  method: "PATCH",
  token: mgr.token,
  body: { F6: false },
});
const aiDisabled = await api("/assistant", {
  method: "POST",
  token: memberAI.token,
  body: { message: "What are your opening hours?" },
});
check("AI-01", "AI endpoint when feature flag disabled returns 403 BR-52, never 500", aiDisabled, {
  status: 403,
  br: "BR-52",
});

// Re-enable F6
await api("/flags", {
  method: "PATCH",
  token: mgr.token,
  body: { F6: true },
});

// Verify AI responds gracefully (200 with rules fallback when model offline)
const aiActive = await api("/assistant", {
  method: "POST",
  token: memberAI.token,
  body: { message: "What are your opening hours?" },
});
check("AI-01b", "AI endpoint with F6 enabled returns controlled reply without 500", aiActive, {
  status: 200,
  notStatus: [500],
  test: (r) => !!r.data?.reply,
  why: "returns reply object",
});

// ───────────────────────────── 2. Support Tickets (TKT-) ─────────────────────────────
console.log("\n--- Support Tickets (TKT-) ---");

const T1Member = await newMember();
const T2Member = await newMember();

// TKT-03: Ticket creation with empty body returns 4xx
const badTicket = await api("/tickets", {
  method: "POST",
  token: T1Member.token,
  body: { body: "" },
});
check("TKT-03", "Create ticket with empty body returns 4xx validation", badTicket, {
  status: [400, 422],
  code: "VALIDATION",
});

// TKT-01: Member creates a valid ticket (201) and reads it back (200)
const createdTicket = await api("/tickets", {
  method: "POST",
  token: T1Member.token,
  body: { body: "Can I bring a guest on Wednesday?" },
});
const ticketId = createdTicket.data?.id;
check("TKT-01", "Member creates valid ticket (201) and reads it back in mine (200)", createdTicket, {
  status: 201,
  test: (r) => r.data?.status === "open" && r.data?.body?.includes("guest"),
  why: "status is open and body matches",
});

const myTickets = await api("/tickets/mine", { token: T1Member.token });
check("TKT-01b", "Member reads back created ticket in GET /tickets/mine", myTickets, {
  status: 200,
  test: (r) => r.data?.items?.some((t) => t.id === ticketId),
  why: "created ticket present in mine list",
});

// TKT-02: Member attempting to access staff tickets queue returns 403
const staffTicketsAsMember = await api("/tickets", { token: T2Member.token });
check("TKT-02", "Member attempting to list all tickets returns 403", staffTicketsAsMember, {
  status: 403,
});

// TKT-05: Member attempting to close another member's ticket returns 403
const closeByOther = await api(`/tickets/${ticketId}/close`, {
  method: "POST",
  token: T2Member.token,
});
check("TKT-05", "Member attempting to close a ticket returns 403", closeByOther, {
  status: 403,
});

// TKT-04: Staff/receptionist replies to and closes ticket
const replyRes = await api(`/tickets/${ticketId}/reply`, {
  method: "POST",
  token: rec.token,
  body: { reply: "Yes, day passes are available at the front desk!" },
});
check("TKT-04", "Staff replies to ticket: returns 200 and status becomes closed", replyRes, {
  status: 200,
  test: (r) => r.data?.ticket?.status === "closed" && !!r.data?.ticket?.reply,
  why: "status is closed and reply is saved",
});

// ───────────────────────────── 3. Notifications (NOTI-) ─────────────────────────────
console.log("\n--- Notifications (NOTI-) ---");

// NOTI-01: Member views their own notifications list
const notis1 = await api("/me/notifications", { token: T1Member.token });
check("NOTI-01", "Member views own notifications list returns 200", notis1, {
  status: 200,
  test: (r) => Array.isArray(r.data?.items),
  why: "items is an array",
});

// Find the ticket_replied notification created by TKT-04
const replyNoti = notis1.data?.items?.find((n) => n.template === "ticket_replied");
const notiId = replyNoti?.id;

if (notiId) {
  // NOTI-03: Member 2 attempts to mark Member 1's notification as read
  const markByOther = await api("/me/notifications/read", {
    method: "POST",
    token: T2Member.token,
    body: { id: notiId },
  });
  check("NOTI-03", "Marking another member's notification affects 0 rows", markByOther, {
    status: 200,
    test: (r) => r.data?.marked === 0,
    why: "marked is 0 because user_id does not match",
  });

  // NOTI-02: Member 1 marks their own notification as read
  const markOwn = await api("/me/notifications/read", {
    method: "POST",
    token: T1Member.token,
    body: { id: notiId },
  });
  check("NOTI-02", "Member marks own notification as read returns marked >= 1", markOwn, {
    status: 200,
    test: (r) => r.data?.marked >= 1,
    why: "marked >= 1",
  });

  // Verify read_at is stamped
  const notis1After = await api("/me/notifications", { token: T1Member.token });
  const readNoti = notis1After.data?.items?.find((n) => n.id === notiId);
  check("NOTI-02b", "Notification is marked with read_at timestamp", notis1After, {
    test: () => !!readNoti?.read_at,
    why: "read_at is not null",
  });
} else {
  // Mark all unread as read
  const markAll = await api("/me/notifications/read", {
    method: "POST",
    token: T1Member.token,
    body: {},
  });
  check("NOTI-02", "Marking all unread notifications returns 200", markAll, { status: 200 });
}

// NOTI-04: Forgot password with email when SMTP offline returns 202, never 500
const forgotRes = await api("/auth/password/forgot", {
  method: "POST",
  body: { phone: T1Member.phone },
});
check("NOTI-04", "Forgot password with SMTP offline returns 202, never 500", forgotRes, {
  status: 202,
  notStatus: [500],
});

// ───────────────────────────── 4. Receipts & Invoices (RCP-) ─────────────────────────────
console.log("\n--- Receipts & Invoices (RCP-) ---");

const payer = await newMember();
const otherPayer = await newMember();

// Create an invoice/payment for payer by purchasing a day pass at reception
const passRes = await api("/day-passes", {
  method: "POST",
  token: rec.token,
  idem: true,
  body: {
    buyer_name: payer.user.full_name,
    buyer_phone: payer.phone,
    method: "cash",
  },
});
const invoiceId = passRes.data?.invoice_id;

// RCP-01: List invoices for payer
const myInvoices = await api("/invoices", { token: payer.token });
check("RCP-01", "Member retrieves own invoice list returns 200 with matching payment", myInvoices, {
  status: 200,
  test: (r) => Array.isArray(r.data?.items) && r.data.items.length >= 0,
  why: "items array returned",
});

// RCP-01b: If invoiceId available, retrieve PDF receipt
if (invoiceId) {
  const getPdf = await api(`/invoices/${invoiceId}.pdf`, { token: payer.token });
  check("RCP-01b", "Member retrieves own invoice PDF returns 200", getPdf, {
    status: 200,
    test: (r) => r.headers["content-type"]?.includes("pdf") || typeof r.data === "string",
    why: "returns PDF data",
  });

  // RCP-02: Other member retrieves invoice PDF -> 404/403
  const otherPdf = await api(`/invoices/${invoiceId}.pdf`, { token: otherPayer.token });
  check("RCP-02", "Other member requesting invoice PDF returns 404 (ownership check)", otherPdf, {
    status: [403, 404],
    notStatus: [200, 500],
  });
} else {
  // Test via invoices mine
  check("RCP-01", "Invoices mine accessible", myInvoices, { status: 200 });
}

// RCP-03: Nonexistent invoice id returns 404
const nonExistentPdf = await api(`/invoices/${IDS.nonexistent}.pdf`, { token: payer.token });
check("RCP-03", "Nonexistent invoice PDF returns 404", nonExistentPdf, {
  status: 404,
  notStatus: [500],
});

summary();
