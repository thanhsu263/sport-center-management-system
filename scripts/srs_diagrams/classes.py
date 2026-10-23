"""Domain class diagrams (UML 2.0 class notation, Learning UML 2.0 ch. 4 and 5).

Each class has three compartments split by <hr>: name, attributes, operations.
Attributes are private (-) and operations public (+). Associations carry a
multiplicity at both ends; a filled diamond marks composition at the whole, and a
dashed line with a hollow triangle marks realization of an interface.
Attribute names follow the PostgreSQL columns in migrations/ in camelCase.
"""

from lib import Diagram, LINE, INK, CHAR_W

CLASS = ("verticalAlign=top;align=left;overflow=fill;fontSize=12;fontFamily=Helvetica;html=1;whiteSpace=wrap;"
         "fillColor=#f8fafc;strokeColor=#475569;")
IFACE = CLASS.replace("fillColor=#f8fafc", "fillColor=#eef2ff")
ENUM = CLASS.replace("fillColor=#f8fafc", "fillColor=#ffffff")
MULT = "text;html=1;align=center;verticalAlign=middle;fontFamily=Helvetica;fontSize=11;fontColor=" + INK + ";"
_LINE = ("html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";strokeWidth=1.2;fontFamily=Helvetica;"
         "fontSize=11;fontColor=" + INK + ";labelBackgroundColor=#ffffff;")
ASSOC = _LINE + "endArrow=none;"
COMPOSE = _LINE + "startArrow=diamondThin;startFill=1;startSize=16;endArrow=none;"
REALIZE = _LINE + "endArrow=block;endFill=0;endSize=12;dashed=1;"
USES = _LINE + "endArrow=open;endSize=10;dashed=1;"
GENERAL = _LINE + "endArrow=block;endFill=0;endSize=12;"

W = 250
COLS = [40, 365, 690, 1015, 1340]
LINE_PX = 14.4
HR_PX = 14
PAD_PX = 6


def lines_of(attrs, ops):
    return len(attrs) + len(ops)


def cls(d, cid, name, attrs, ops, x, y, w=W, kind="class"):
    """A class box sized to its compartments; returns the id. An empty operation compartment is suppressed."""
    if kind == "interface":
        head, style, head_lines = "&laquo;interface&raquo;<br><b>" + name + "</b>", IFACE, 2
        comps = [ops]
    elif kind == "enum":
        head, style, head_lines = "&laquo;enumeration&raquo;<br><b>" + name + "</b>", ENUM, 2
        comps = [attrs]
    else:
        head, style, head_lines = "<b>" + name + "</b>", CLASS, 1
        comps = [attrs, ops] if ops else [attrs]
    value = '<p style="margin:0px;margin-top:4px;text-align:center;">' + head + "</p>"
    for items in comps:
        value += '<hr><p style="margin:0px;margin-left:6px;">' + "<br>".join(items) + "</p>"
    n = head_lines + sum(len(c) for c in comps)
    h = round(4 + LINE_PX * n + HR_PX * len(comps) + PAD_PX)
    longest = max([len(name) + (14 if kind != "class" else 0)] + [len(s) for s in attrs + ops])
    need = longest * CHAR_W + 16
    assert need <= w, f"{name}: needs width {need:.0f} > {w}"
    return d.vertex(value, style, x, y, w, h, id=cid)


def box(d, cid):
    c = d.by_id[cid]
    return c["x"], c["y"], c["w"], c["h"]


def at(d, cid, side, v):
    """Anchor on a side: L/R take an absolute y, T/B take an absolute x."""
    x, y, w, h = box(d, cid)
    if side == "L":
        return (0, (v - y) / h)
    if side == "R":
        return (1, (v - y) / h)
    if side == "T":
        return ((v - x) / w, 0)
    return ((v - x) / w, 1)


def point(d, cid, rel):
    x, y, w, h = box(d, cid)
    return (x + rel[0] * w, y + rel[1] * h)


def mult_label(d, text, p, q, flip=False):
    """Multiplicity beside the end p of a segment p->q: above a horizontal line (below when flipped),
    right of a vertical one (left when flipped)."""
    w = len(text) * CHAR_W * 11 / 12 + 14
    h = 16
    if abs(q[1] - p[1]) < 1:
        s = 1 if q[0] > p[0] else -1
        x = p[0] + 3 if s > 0 else p[0] - 3 - w
        y = p[1] + 3 if flip else p[1] - 3 - h
    else:
        s = 1 if q[1] > p[1] else -1
        y = p[1] + 3 if s > 0 else p[1] - 3 - h
        x = p[0] - 3 - w if flip else p[0] + 3
    d.vertex(text, MULT, x, y, w, h, role="label")


def link(d, a, b, ma, mb, ea, eb, style=ASSOC, name="", points=(), flip_a=False, flip_b=None,
         name_x=None, name_off=None):
    """Association a -> b with multiplicities ma (at a) and mb (at b); ea/eb are (side, coord) anchors."""
    ra, rb = at(d, a, *ea), at(d, b, *eb)
    pa, pb = point(d, a, ra), point(d, b, rb)
    path = [pa] + list(points) + [pb]
    if ma:
        mult_label(d, ma, path[0], path[1], flip_a)
    if mb:
        if flip_b is None:
            flip_b = len(path) == 2 and abs(pa[1] - pb[1]) < 1
        mult_label(d, mb, path[-1], path[-2], flip_b)
    return d.edge(a, b, name, style, points=points, exit=ra, entry=rb, label_x=name_x, label_offset=name_off)


def x_mid(col):
    return COLS[col] + W / 2


# ---------------------------------------------------------------- diagrams


def booking_payment():
    d = Diagram("20-cd-booking-payment")
    c0, c1, c2, c3, c4 = COLS
    cls(d, "rule", "PriceRule",
        ["- sport: SportKind", "- dayKind: DayKind", "- startLocal: Time", "- endLocal: Time",
         "- priceVnd: Integer", "- isPeak: Boolean"],
        ["+ priceFor(slot: TimeSlot): Integer"], c0, 40)
    cls(d, "court", "Court",
        ["- courtCode: String", "- sport: SportKind", "- status: CourtStatus"],
        ["+ isFree(start, end): Boolean", "+ setStatus(status): void"], c1, 40)
    cls(d, "occ", "Occupancy",
        ["- startAt: DateTime", "- endAt: DateTime", "- kind: OccupancyKind", "- refId: UUID", "- reason: String"],
        ["+ overlaps(start, end): Boolean"], c2, 40)
    cls(d, "bstat", "BookingStatus",
        ["hold", "confirmed", "in_use", "completed", "cancelled", "no_show"], [], c0, 468, kind="enum")
    cls(d, "pstat", "PayStatus",
        ["pending", "posted", "expired", "failed", "refund_pending", "refund_rejected"], [], c2, 920, kind="enum")
    cls(d, "booking", "CourtBooking",
        ["- code: String", "- startAt: DateTime", "- endAt: DateTime", "- status: BookingStatus",
         "- channel: String", "- priceVnd: Integer", "- depositVnd: Integer", "- paidVnd: Integer",
         "- holdUntil: DateTime", "- quotaHours: Decimal"],
        ["+ hold(): void", "+ confirm(): void", "+ reschedule(newStart): void", "+ cancel(): RefundQuote",
         "+ checkIn(): void", "+ markNoShow(): void"], c1, 236)
    cls(d, "series", "BookingSeries",
        ["- code: String", "- weekday: Integer", "- startLocal: Time", "- weeks: Integer", "- startsOn: Date",
         "- discountPct: Integer", "- status: SeriesStatus"],
        ["+ generateBookings(): void", "+ cancel(): void"], c0, 270)
    cls(d, "payable", "Payable", [], ["+ amountDue(): Integer", "+ settle(payment: Payment): void"],
        c2, 300, kind="interface")
    cls(d, "method", "PayMethod", ["cash", "transfer", "card", "gateway", "quota"], [], c3, 920, kind="enum")
    cls(d, "user", "User",
        ["- memberCode: String", "- fullName: String", "- phone: String", "- email: String",
         "- role: UserRole", "- status: UserStatus"],
        ["+ signIn(phone, password): Session", "+ changePassword(old, new): void"], c1, 600)
    cls(d, "cshift", "CashierShift",
        ["- openedAt: DateTime", "- closedAt: DateTime", "- cashDeclaredVnd: Integer"],
        ["+ open(): void", "+ close(cashDeclared): ShiftSummary"], c0, 620)
    cls(d, "pay", "Payment",
        ["- code: String", "- method: PayMethod", "- amountVnd: Integer", "- vatRate: Decimal",
         "- status: PayStatus", "- provider: String", "- providerOrderCode: Long", "- paidAt: DateTime"],
        ["+ post(): void", "+ verifyOnline(): PayStatus", "+ refund(amount, reason): Payment",
         "+ approveRefund(by: User): void", "+ rejectRefund(by: User): void"], c2, 470)
    cls(d, "redeem", "PromotionRedemption",
        ["- discountVnd: Integer", "- status: RedemptionStatus", "- restoredAt: DateTime"],
        ["+ restore(): void"], c3, 480)
    cls(d, "promo", "Promotion",
        ["- code: String", "- kind: PromoKind", "- value: Integer", "- maxDiscountVnd: Integer",
         "- minOrderVnd: Integer", "- startsAt: DateTime", "- endsAt: DateTime", "- maxUses: Integer",
         "- maxPerMember: Integer", "- status: PromoStatus"],
        ["+ quote(amount, member): Integer"], c4, 430)
    cls(d, "inv", "Invoice",
        ["- code: String", "- formNo: String", "- serialNo: String", "- buyerName: String",
         "- buyerTaxCode: String", "- subtotalVnd: Integer", "- vatVnd: Integer", "- totalVnd: Integer",
         "- issuedAt: DateTime"],
        ["+ export(): File"], c3, 650)
    cls(d, "line", "InvoiceLine",
        ["- description: String", "- unit: String", "- qty: Integer", "- unitVnd: Integer", "- amountVnd: Integer"],
        [], c4, 720)

    link(d, "rule", "court", "0..*", "0..1", ("R", 100), ("L", 100))
    link(d, "court", "occ", "1", "0..*", ("R", 100), ("L", 100))
    link(d, "court", "booking", "1", "0..*", ("B", x_mid(1)), ("T", x_mid(1)))
    link(d, "booking", "occ", "0..1", "0..1", ("R", 256), ("B", 780), points=[(780, 256)])
    link(d, "series", "booking", "0..1", "1..*", ("R", 370), ("L", 370))
    link(d, "booking", "payable", "", "", ("R", 349), ("L", 349), style=REALIZE)
    link(d, "user", "booking", "0..1", "0..*", ("T", x_mid(1)), ("B", x_mid(1)))
    link(d, "cshift", "user", "0..*", "1", ("R", 680), ("L", 680))
    link(d, "pay", "user", "0..*", "0..1", ("L", 640), ("R", 640))
    link(d, "pay", "payable", "0..*", "1", ("T", x_mid(2)), ("B", x_mid(2)), name="pays for")
    link(d, "pay", "cshift", "0..*", "0..1", ("B", x_mid(2)), ("B", x_mid(0)),
         points=[(x_mid(2), 860), (x_mid(0), 860)], name="is taken in", name_x=0)
    link(d, "pay", "redeem", "1", "0..1", ("R", 530), ("L", 530))
    link(d, "redeem", "promo", "0..*", "1", ("R", 530), ("L", 530))
    link(d, "pay", "inv", "1", "0..1", ("R", 690), ("L", 690))
    link(d, "inv", "line", "1", "1..*", ("R", 780), ("L", 780), style=COMPOSE)
    link(d, "booking", "bstat", "", "", ("L", 500), ("R", 500), style=USES)
    link(d, "pay", "pstat", "", "", ("B", 870), ("T", 870), style=USES)
    link(d, "pay", "method", "", "", ("B", 915), ("T", x_mid(3)), style=USES, points=[(915, 890), (x_mid(3), 890)])
    return d


def membership_classes():
    d = Diagram("21-cd-membership-classes")
    c0, c1, c2, c3, c4 = COLS
    cls(d, "payable", "Payable", [], ["+ amountDue(): Integer", "+ settle(payment: Payment): void"],
        c1, 40, kind="interface")
    cls(d, "plan", "MembershipPlan",
        ["- name: String", "- sportScope: SportKind", "- durationDays: Integer", "- sessionQuota: Integer",
         "- courtHours: Integer", "- courtDiscountPct: Integer", "- priceVnd: Integer", "- isOnSale: Boolean",
         "- carryOverHours: Boolean"],
        ["+ sell(member: User): Subscription", "+ setOnSale(flag: Boolean): void"], c0, 235)
    cls(d, "sub", "Subscription",
        ["- sportScope: SportKind", "- startOn: Date", "- endOn: Date", "- status: SubStatus",
         "- courtHoursLeft: Decimal", "- sessionLeft: Integer", "- frozenDays: Integer",
         "- promoDiscountVnd: Integer"],
        ["+ activate(): void", "+ decline(): void", "+ freeze(days: Integer): void", "+ unfreeze(): void",
         "+ useSession(): void"], c1, 220)
    cls(d, "user", "User",
        ["- memberCode: String", "- fullName: String", "- phone: String", "- role: UserRole"],
        ["+ loyaltyPoints(): Integer"], c2, 280)
    cls(d, "enrol", "Enrollment",
        ["- status: EnrollStatus", "- waitlistPos: Integer"],
        ["+ cancel(): void", "+ offerSeat(): WaitlistOffer"], c3, 290)
    cls(d, "tclass", "TrainingClass",
        ["- sport: SportKind", "- level: String", "- capacity: Integer", "- enrolledCount: Integer",
         "- rrule: String", "- durationMin: Integer", "- startOn: Date", "- endOn: Date",
         "- status: ClassStatus"],
        ["+ publish(): void", "+ generateSessions(): void", "+ enrol(member: User): Enrollment",
         "+ assignCoach(coach: User): void", "+ cancel(reason: String): void"], c4, 230)
    cls(d, "offer", "WaitlistOffer",
        ["- expiresAt: DateTime", "- status: OfferStatus"],
        ["+ accept(): void", "+ expire(): void"], c3, 470)
    cls(d, "court", "Court",
        ["- courtCode: String", "- sport: SportKind", "- status: CourtStatus"], [], c3, 640)
    cls(d, "csession", "ClassSession",
        ["- startAt: DateTime", "- endAt: DateTime", "- status: SessionStatus", "- originalStartAt: DateTime",
         "- changeReason: String"],
        ["+ cancel(reason: String): void", "+ reschedule(newStart): void"], c4, 580)
    cls(d, "att", "Attendance",
        ["- kind: AttendanceKind", "- result: AttendanceResult", "- at: DateTime", "- method: String",
         "- flagged: Boolean", "- reason: String"],
        ["+ correct(result, reason): void"], c2, 520)
    cls(d, "substat", "SubStatus", ["pending", "active", "expired", "frozen"], [], c0, 520, kind="enum")
    cls(d, "enrstat", "EnrollStatus", ["confirmed", "waitlisted", "cancelled"], [], c3, 80, kind="enum")
    cls(d, "clsstat", "ClassStatus", ["draft", "open", "closed", "cancelled"], [], 1405, 80, w=185, kind="enum")
    cls(d, "attres", "AttendanceResult", ["present", "late", "absent", "excused"], [], c1, 540, kind="enum")

    link(d, "sub", "payable", "", "", ("T", x_mid(1)), ("B", x_mid(1)), style=REALIZE)
    link(d, "plan", "sub", "1", "0..*", ("R", 340), ("L", 340))
    link(d, "sub", "user", "0..*", "1", ("R", 340), ("L", 340))
    link(d, "user", "enrol", "1", "0..*", ("R", 340), ("L", 340))
    link(d, "enrol", "tclass", "0..*", "1", ("R", 340), ("L", 340))
    link(d, "user", "tclass", "1", "0..*", ("T", 890), ("T", 1355), points=[(890, 30), (1355, 30)],
         name="teaches")
    link(d, "enrol", "offer", "1", "0..*", ("B", x_mid(3)), ("T", x_mid(3)))
    link(d, "tclass", "csession", "1", "1..*", ("B", x_mid(4)), ("T", x_mid(4)), style=COMPOSE)
    link(d, "tclass", "court", "0..*", "1", ("L", 460), ("R", 670), points=[(1300, 460), (1300, 670)])
    link(d, "csession", "court", "0..*", "1", ("L", 710), ("R", 710))
    link(d, "user", "att", "1", "0..*", ("B", x_mid(2)), ("T", x_mid(2)))
    link(d, "att", "csession", "0..*", "0..1", ("B", x_mid(2)), ("B", x_mid(4)),
         points=[(x_mid(2), 800), (x_mid(4), 800)], name="records")
    link(d, "sub", "substat", "", "", ("L", 430), ("R", 570), style=USES, points=[(327, 430), (327, 570)])
    link(d, "enrol", "enrstat", "", "", ("T", 1100), ("B", 1100), style=USES)
    link(d, "tclass", "clsstat", "", "", ("T", 1500), ("B", 1500), style=USES)
    link(d, "att", "attres", "", "", ("L", 610), ("R", 610), style=USES)
    return d


def coaching():
    """Coach and Member specialise User; the users.role column is the discriminator."""
    d = Diagram("22-cd-coaching")
    c0, c1, c2, c3, c4 = COLS
    cls(d, "skill", "SkillLevel", ["beginner", "intermediate", "advanced"], [], c4, 175, kind="enum")
    cls(d, "user", "User",
        ["- memberCode: String", "- fullName: String", "- phone: String", "- role: UserRole"],
        ["+ signIn(phone, password): Session"], c2, 40)
    cls(d, "level", "MemberLevel",
        ["- sport: SportKind", "- level: SkillLevel", "- updatedAt: DateTime"],
        ["+ assess(level, by: User): void"], c4, 40)
    cls(d, "coach", "Coach",
        ["- sports: SportKind[1..*]"],
        ["+ mySchedule(): ClassSession[*]", "+ markAttendance(session): void", "+ recordResult(session): void",
         "+ assignHomework(target): Homework", "+ writeNote(member, body): void", "+ reviewProgress(member): void",
         "+ assessLevel(member, sport): void", "+ draftPlan(scope): TrainingPlan"], c1, 190)
    cls(d, "member", "Member",
        ["- dateOfBirth: Date", "- guardianName: String", "- guardianPhone: String", "- healthNotes: String",
         "- goal: TrainingGoal"],
        ["+ isMinor(): Boolean", "+ myPlan(): TrainingPlan", "+ tickHomework(item): void",
         "+ reviews(sport): ProgressReview[*]"], c3, 190)
    cls(d, "rate", "CoachRate",
        ["- perSessionVnd: Integer", "- perStudentVnd: Integer", "- updatedAt: DateTime"],
        ["+ payFor(month: String): Integer"], c0, 160)
    cls(d, "payout", "CoachPayout",
        ["- period: String", "- sessions: Integer", "- students: Integer", "- amountVnd: Integer",
         "- status: PayoutStatus", "- closedAt: DateTime", "- paidAt: DateTime"],
        ["+ markPaid(): void"], c0, 290)
    cls(d, "note", "CoachNote", ["- body: String", "- createdAt: DateTime"], [], c2, 190)
    cls(d, "review", "ProgressReview",
        ["- sport: SportKind", "- periodWeeks: Integer", "- technique: Integer", "- fitness: Integer",
         "- attitude: Integer", "- comment: String", "- createdAt: DateTime"],
        ["+ average(): Decimal"], c2, 280)
    cls(d, "result", "SessionResult",
        ["- planPct: Integer", "- metrics: JSON", "- note: String", "- recordedAt: DateTime"],
        ["+ amend(planPct, note): void"], c4, 300)
    cls(d, "csession", "ClassSession",
        ["- startAt: DateTime", "- endAt: DateTime", "- status: SessionStatus"], [], c4, 480)
    cls(d, "tplan", "TrainingPlan",
        ["- scope: PlanScope", "- source: PlanSource", "- title: String", "- version: Integer",
         "- published: Boolean", "- isTemplate: Boolean", "- payload: JSON"],
        ["+ publish(): void", "+ saveVersion(by: User): void", "+ copyAsTemplate(): TrainingPlan"], c1, 440)
    cls(d, "tpver", "TrainingPlanVersion",
        ["- version: Integer", "- title: String", "- payload: JSON", "- createdAt: DateTime"],
        ["+ restore(): void"], c0, 480)
    cls(d, "hw", "Homework",
        ["- title: String", "- body: String", "- checklist: String[*]", "- dueOn: Date", "- createdAt: DateTime"],
        ["+ assignTo(target): void"], c2, 490)
    cls(d, "hwr", "HomeworkRecipient",
        ["- doneItems: Integer[*]", "- completedAt: DateTime"],
        ["+ tick(item: Integer): void", "+ isComplete(): Boolean"], c3, 510)
    cls(d, "tclass", "TrainingClass",
        ["- sport: SportKind", "- level: String", "- capacity: Integer", "- status: ClassStatus"], [], c2, 690)

    link(d, "coach", "user", "", "", ("T", x_mid(1)), ("L", 100), style=GENERAL, points=[(x_mid(1), 100)])
    link(d, "member", "user", "", "", ("T", x_mid(3)), ("R", 100), style=GENERAL, points=[(x_mid(3), 100)])
    link(d, "coach", "rate", "1", "0..1", ("L", 230), ("R", 230))
    link(d, "coach", "payout", "1", "0..*", ("L", 330), ("R", 330))
    link(d, "coach", "note", "1", "0..*", ("R", 220), ("L", 220))
    link(d, "note", "member", "0..*", "1", ("R", 220), ("L", 220))
    link(d, "coach", "review", "1", "0..*", ("R", 310), ("L", 310))
    link(d, "review", "member", "0..*", "1", ("R", 310), ("L", 310))
    link(d, "coach", "hw", "1", "0..*", ("R", 360), ("L", 560), points=[(650, 360), (650, 560)], flip_b=True)
    link(d, "hw", "hwr", "1", "1..*", ("R", 560), ("L", 560), style=COMPOSE)
    link(d, "hwr", "member", "0..*", "1", ("T", x_mid(3)), ("B", x_mid(3)))
    link(d, "member", "level", "1", "0..*", ("T", 1230), ("L", 95), points=[(1230, 95)])
    link(d, "level", "skill", "", "", ("B", x_mid(4)), ("T", x_mid(4)), style=USES)
    link(d, "member", "result", "1", "0..*", ("R", 330), ("L", 330))
    link(d, "result", "csession", "0..*", "1", ("B", x_mid(4)), ("T", x_mid(4)))
    link(d, "coach", "tplan", "1", "0..*", ("B", x_mid(1)), ("T", x_mid(1)))
    link(d, "tplan", "tpver", "1", "1..*", ("L", 540), ("R", 540), style=COMPOSE)
    link(d, "hw", "tclass", "0..*", "0..1", ("B", x_mid(2)), ("T", x_mid(2)))
    link(d, "tplan", "tclass", "0..*", "0..1", ("B", x_mid(1)), ("L", 740), points=[(x_mid(1), 740)],
         name="is planned for", name_x=0.2)
    link(d, "tclass", "csession", "1", "1..*", ("R", 740), ("B", x_mid(4)), points=[(x_mid(4), 740)],
         style=COMPOSE)
    return d


def operations():
    d = Diagram("23-cd-operations")
    c0, c1, c2, c3, c4 = COLS
    cls(d, "otp", "OtpChallenge",
        ["- phone: String", "- purpose: String", "- otpHash: String", "- expiresAt: DateTime",
         "- attempts: Integer"],
        ["+ verify(code: String): Boolean"], c0, 40)
    cls(d, "token", "CheckinToken", ["- jti: UUID", "- usedAt: DateTime"], ["+ consume(): void"], c1, 100)
    cls(d, "notify", "Notification",
        ["- channel: String", "- template: String", "- payload: JSON", "- dedupeKey: String",
         "- attempts: Integer", "- sentAt: DateTime", "- readAt: DateTime"],
        ["+ send(): void", "+ markRead(): void"], c2, 40)
    cls(d, "settings", "CenterSettings",
        ["- openTime: Time", "- closeTime: Time", "- slotMinutes: Integer", "- holdMinutes: Integer",
         "- bookAheadDays: Integer", "- maxSlotsPerDay: Integer", "- cancelCourtHours: Integer",
         "- refundManagerVnd: Integer", "- depositPct: Integer", "- freezeMaxDaysYear: Integer",
         "- gateDedupMinutes: Integer", "- loyaltyEarnVnd: Integer",
         "- vatRate: Decimal"],
        ["+ current(): CenterSettings", "+ update(patch): void"], c3, 40)
    cls(d, "flag", "FeatureFlag", ["- key: String", "- enabled: Boolean"], ["+ toggle(): void"], c4, 40)
    cls(d, "user", "User",
        ["- memberCode: String", "- fullName: String", "- phone: String", "- role: UserRole",
         "- status: UserStatus"],
        ["+ loyaltyPoints(): Integer", "+ issueGateToken(): CheckinToken", "+ isAtRisk(): Boolean"], c1, 250)
    cls(d, "loyal", "LoyaltyAdjustment",
        ["- points: Integer", "- reason: AdjustReason", "- note: String", "- createdAt: DateTime"],
        ["+ apply(): void"], c0, 270)
    cls(d, "ticket", "SupportTicket",
        ["- body: String", "- status: TicketStatus", "- reply: String", "- createdAt: DateTime",
         "- repliedAt: DateTime"],
        ["+ answer(text: String): void", "+ close(): void"], c2, 270)
    cls(d, "contact", "ContactLog",
        ["- reason: ContactReason", "- channel: String", "- outcome: String", "- note: String",
         "- createdAt: DateTime"], [], c1, 500)
    cls(d, "audit", "AuditLog",
        ["- at: DateTime", "- action: String", "- entity: String", "- entityId: UUID", "- before: JSON",
         "- after: JSON"], [], c2, 480)
    cls(d, "court", "Court",
        ["- courtCode: String", "- sport: SportKind", "- status: CourtStatus"],
        ["+ setStatus(status): void"], c3, 350)
    cls(d, "wo", "WorkOrder",
        ["- code: String", "- title: String", "- priority: Priority", "- status: WorkStatus",
         "- blocksCourt: Boolean", "- assignee: String", "- costVnd: Integer", "- resolution: String",
         "- closedAt: DateTime"],
        ["+ start(): void", "+ close(resolution): void"], c4, 200)
    cls(d, "booking", "CourtBooking",
        ["- code: String", "- startAt: DateTime", "- endAt: DateTime", "- status: BookingStatus"], [], c3, 530)
    cls(d, "loan", "EquipmentLoan",
        ["- phone: String", "- qty: Integer", "- status: LoanStatus", "- dueAt: DateTime",
         "- returnedAt: DateTime"],
        ["+ markReturned(): void", "+ markLost(): void"], c4, 500)
    cls(d, "item", "EquipmentItem",
        ["- sku: String", "- name: String", "- sport: SportKind", "- stock: Integer", "- rentVnd: Integer"],
        ["+ lend(qty, phone): EquipmentLoan"], c4, 730)
    cls(d, "loanstat", "LoanStatus", ["out", "returned", "lost"], [], c3, 720, kind="enum")

    link(d, "user", "token", "1", "0..*", ("T", x_mid(1)), ("B", x_mid(1)))
    link(d, "user", "loyal", "1", "0..*", ("L", 330), ("R", 330))
    link(d, "user", "contact", "1", "0..*", ("B", x_mid(1)), ("T", x_mid(1)))
    link(d, "user", "notify", "0..1", "0..*", ("R", 270), ("L", 120), points=[(650, 270), (650, 120)],
         flip_a=True, flip_b=False)
    link(d, "user", "ticket", "0..1", "0..*", ("R", 350), ("L", 350))
    link(d, "user", "audit", "0..1", "0..*", ("R", 400), ("L", 560), points=[(650, 400), (650, 560)],
         flip_b=True, name="acts in", name_off=None)
    link(d, "court", "wo", "0..1", "0..*", ("R", 380), ("L", 380))
    link(d, "court", "booking", "1", "0..*", ("B", x_mid(3)), ("T", x_mid(3)))
    link(d, "booking", "loan", "0..1", "0..*", ("R", 580), ("L", 580))
    link(d, "item", "loan", "1", "0..*", ("T", x_mid(4)), ("B", x_mid(4)))
    link(d, "loan", "loanstat", "", "", ("L", 640), ("R", 740), style=USES, points=[(1302, 640), (1302, 740)])
    return d


def build():
    return [booking_payment(), membership_classes(), coaching(), operations()]
