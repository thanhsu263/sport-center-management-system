# Arena3 — Screens Flow and Screen Descriptions

This document follows the method of sections 3.1.1 and 3.1.2 of the FreeDriver report: one **screen-flow diagram per application / actor**, followed by one **description table per actor** with the columns `# | Feature | Screen | Description`.

Arena3 is a single TanStack Start PWA. Each role has its own route prefix and its own navigation bar (`NAV` in `src/components/shell.tsx`), so each role is treated as one "application" below. After login the user is sent to the home screen of their role (`homeFor(role)` in `src/lib/arena3/client.ts`).

| Actor | Route prefix | Home screen |
|---|---|---|
| Visitor (not signed in) | `/`, `/login`, `/register`, `/forgot` | Landing Page |
| Member | `/app/*` | Member Home (`/app`) |
| Receptionist | `/desk/*` | Desk Home (`/desk`) |
| Coach | `/coach/*` | Coach Schedule (`/coach`) |
| Manager | `/manager/*` | Reports (`/manager`) |

## 3.1.1 Screens Flow

How to read the diagrams:

- A **box** is a screen (a route).
- A **box nested inside a box** is a modal, panel, tab, wizard step or form that opens on top of, or inside, that screen.
- An **arrow** is navigation or a transition. A **dotted arrow** is a conditional transition.
- Every role starts at **Login Screen** and ends up on its own home screen.
- `/account` (Account Settings) and `/alerts` (Alerts) are shared by all signed-in roles. They are drawn in each diagram that links to them.

### 3.1.1.1 Public and Authentication

![Public and Authentication screens flow](drawio/01-Public-Auth.png)

### 3.1.1.2 Member

![Member screens flow](drawio/02-Member.png)

### 3.1.1.3 Receptionist (Desk)

![Receptionist screens flow](drawio/03-Receptionist-Desk.png)

### 3.1.1.4 Coach

![Coach screens flow](drawio/04-Coach.png)

### 3.1.1.5 Manager

![Manager screens flow](drawio/05-Manager.png)

> **Manager access to other areas.** A manager can open the desk and coach routes. The Manager diagram therefore shows only the desk screens that managers reach from their own menu (Member Profile and Payments for refund sign-off). Desk and coach screens are not repeated there.

Diagram sources are the draw.io files in `docs/drawio/` (editable; regenerate with `python build_drawio.py`).

---

## 3.1.2 Screen Descriptions

### 3.1.2.1 Public and Authentication

| # | Feature | Screen | Description |
|---|---|---|---|
| 1 | Landing | Landing Page (`/`) | Public home page of the centre. Shows what the centre offers and links to Login and Register. |
| 2 | Landing | Coach Profile Modal | Opens from the coach list on the Landing Page and shows one coach's profile. |
| 3 | Login | Login Screen (`/login`) | Visitor signs in with their credentials. On success the app opens the home screen of the user's role (member, receptionist, coach or manager). If the account is flagged "must change password" (for example a staff account created by a manager), the user is sent to Account Settings first. |
| 4 | Register | Registration Form (`/register`) | New member enters their details to create an account. |
| 5 | Register | OTP Verification Step | The member enters the one-time code sent to them. After verification the account is created and the member lands on Member Home. |
| 6 | Forgot password | Request Code Step (`/forgot`) | User enters their account identifier to receive a reset code. |
| 7 | Forgot password | Code + New Password Step | User enters the code and a new password, then returns to Login. |
| 8 | Online payment | Payment Return Screen (`/pay/return`) | Landing page after the user returns from an online payment. Confirms the result and sends the user back to the screen they started from. |

### 3.1.2.2 Member

| # | Feature | Screen | Description |
|---|---|---|---|
| 1 | Home | Member Home Screen (`/app`) | Dashboard after login. Shows the member's upcoming bookings, active plan and shortcuts to every other member screen. |
| 2 | Home | Waitlist Offer Card | Appears when a spot opens on a class the member is waiting for. The member can accept or decline the offer. |
| 3 | Payment | Scan-to-Pay Modal | Shows the payment QR code and amount for an outstanding payment. Closes when the payment is confirmed. |
| 4 | Court booking | Book Court Screen (`/app/book`) | Member picks a date, court type and time slot, and pays to confirm the booking. |
| 5 | Court booking | Month Calendar View | Month overview of available days so the member can choose a date quickly. |
| 6 | Court booking | Hold Panel (5-minute timer) | Holds the selected slot for five minutes while the member pays, so nobody else can take it. |
| 7 | Court booking | Clash Confirmation | Warns the member when the new booking overlaps one of their own bookings and asks them to confirm. |
| 8 | Court booking | Alternative Slots | Suggests nearby free slots when the chosen slot is not available. |
| 9 | Court booking | Change Time Mode | Lets the member move an existing booking to a new time instead of creating a new one. |
| 10 | Court booking | Scan-to-Pay Modal | Payment QR for the booking. Online payment continues on the Payment Return Screen. |
| 11 | Classes | Classes Screen (`/app/classes`) | Lists coached classes the member can join, join the waitlist for, or leave. |
| 12 | Classes | Waitlist Offer Card | Same offer card as on the home screen, shown next to the class concerned. |
| 13 | Classes | My Attendance Panel | The member's own attendance history for the classes they are enrolled in. |
| 14 | Plans | Plans Screen (`/app/plans`) | Shows the member's current plan and the plans available to buy or renew. |
| 15 | Training | Progress Screen (`/app/train`) | Shows the member's level, the coach's session results and homework assigned to them. |
| 16 | Assistant | Assistant Screen (`/app/assistant`) | Chat assistant that answers questions using the centre's own timetable, plans and coaches. |
| 17 | Notifications | Notifications Screen (`/app/notifications`) | List of the member's notifications. |
| 18 | Notifications | Notification Detail Modal | Shows the full message and a link to the screen it relates to (booking, class, plan, progress, receipt or support). |
| 19 | Account | Account Settings Screen (`/account`) | Tabbed screen for the member's own account (shared by all roles). |
| 20 | Account | Profile Tab | View and edit personal details. |
| 21 | Account | Security Tab | Change password. |
| 22 | Account | Receipts Tab | List of payment receipts. Each receipt opens as a PDF in a new tab. |
| 23 | Account | Support Tab | Send a support request to the front desk and read replies. |
| 24 | Receipts | Receipt PDF (new tab) | Printable receipt for a payment. |

### 3.1.2.3 Receptionist (Desk)

| # | Feature | Screen | Description |
|---|---|---|---|
| 1 | Home | Desk Home Screen (`/desk`) | Front-desk dashboard for the current shift. Gives access to every desk screen. |
| 2 | Shift | Close Shift Modal | Closes the current shift and records the shift totals. |
| 3 | Onboarding | New Member Wizard | Three steps: member profile, plan selection, payment. Used to sign up a member at the counter. |
| 4 | Support | Support Request Reply | Reads a member's support request and sends a reply. |
| 5 | Check-in | Gate Check-in Screen (`/desk/gate`) | Checks members in at the gate and opens their profile. |
| 6 | Courts | Court Map Screen (`/desk/courts`) | Live map of all courts and their occupancy. |
| 7 | Courts | Occupancy Detail Modal | Shows who holds a court and for how long. |
| 8 | Courts | Walk-in Payment Form | Books and charges a walk-in customer on a free court. |
| 9 | Courts | Merge BR + BC Mode | Converts a free convertible court pair (BR and BC) into one court when both are free. |
| 10 | Classes | Classes Screen (`/desk/classes`) | Read-only list of classes and their rosters. |
| 11 | Classes | Class Detail Modal (read-only) | Shows one class's details, schedule and enrolled members. |
| 12 | Payments | Payments Screen (`/desk/payments`) | Work queues for money handled at the desk. |
| 13 | Payments | Transfers to Check | Bank transfers that the receptionist must confirm. |
| 14 | Payments | Waiting for Payment | Bookings and orders that are waiting for payment. |
| 15 | Payments | Refund Queue | Refund requests and their status. |
| 16 | Payments | Receipts List | Issued receipts. Each opens as a PDF in a new tab. |
| 17 | Payments | Scan-to-Pay Modal | Shows a payment QR to the customer at the counter. |
| 18 | Gear | Gear Screen (`/desk/gear`) | Rents gear to a member's account or to a guest by phone. Stock goes down when gear goes out and back up on return. |
| 19 | Members | Member Profile Screen (`/desk/member/:id`) | Full profile of one member: plan, bookings and payments. |
| 20 | Members | Edit Profile Modal | Corrects the member's details. |
| 21 | Members | Raise Refund Modal | Raises a refund request on one of the member's payments. |
| 22 | Alerts | Alerts Screen (`/alerts`) | List of alerts for the signed-in user (shared by all staff roles). |
| 23 | Account | Account Settings Screen (`/account`) | Own profile and password. |

### 3.1.2.4 Coach

| # | Feature | Screen | Description |
|---|---|---|---|
| 1 | Schedule | Coach Schedule Screen (`/coach`) | The coach's classes and sessions. Home screen of the coach role. |
| 2 | Attendance | Attendance Screen (`/coach/attendance`) | Everything the coach does for one session. |
| 3 | Attendance | Session Register | Marks each student present or absent. The register locks once it is submitted. |
| 4 | Attendance | Results Panel | Records session results for the students. |
| 5 | Attendance | Session Plan Panel | Writes the plan for the session. |
| 6 | Attendance | Homework Panel | Assigns homework to students. |
| 7 | Students | Student Profile Screen (`/coach/student/:id`) | Opens from the register. Shows one student's training record. |
| 8 | Students | Level | The student's current level. |
| 9 | Students | Progress Review | The student's progress over time. |
| 10 | Students | Coach Notes | The coach's private notes about the student. |
| 11 | Students | Homework History | Homework assigned to the student and its status. |
| 12 | Alerts | Alerts Screen (`/alerts`) | Alerts for the coach, for example a student with repeated absences. |
| 13 | Account | Account Settings Screen (`/account`) | Own profile and password. |

### 3.1.2.5 Manager

| # | Feature | Screen | Description |
|---|---|---|---|
| 1 | Reports | Reports Screen (`/manager`) | Home screen of the manager. Business reports for a chosen period, compared with the previous period. |
| 2 | Reports | Revenue and Occupancy Summary | Revenue and court occupancy totals. |
| 3 | Reports | Capacity Heatmap Panel | Heatmap of how full the centre is by day and hour. |
| 4 | Reports | Members and Enrolment Panel | Member counts and class enrolments. |
| 5 | Reports | Export (XLSX / PDF / CSV) | Downloads the current report. |
| 6 | Classes | Classes Screen (`/manager/classes`) | Lists classes and lets the manager manage them. |
| 7 | Classes | Create Class Form | Creates a class. |
| 8 | Classes | Class Detail Modal (manage) | Manages one class. It contains the four forms below. |
| 9 | Classes | Cancel / Move Session Form | Cancels one session or moves it to a new time. |
| 10 | Classes | Change Coach Form | Assigns a different coach to the class. |
| 11 | Classes | Edit Capacity Form | Changes the maximum number of students. |
| 12 | Classes | Cancel Class Form | Cancels the whole class. |
| 13 | Members | Members Screen (`/manager/members`) | Searchable list of all members. |
| 14 | Members | Member Profile Screen (`/desk/member/:id`) | Same profile screen as the desk. Opens from the member list. |
| 15 | Payments | Payments Screen (`/desk/payments`) | The desk payments screen, used by the manager to sign off refunds. |
| 16 | Plans | Plans Screen (`/manager/plans`) | Membership plans offered by the centre. |
| 17 | Plans | New Plan Modal | Creates a plan. |
| 18 | Plans | Plan Detail Modal | Views or edits one plan. |
| 19 | Staff | Staff Screen (`/manager/staff`) | Staff accounts. |
| 20 | Staff | Add Staff Modal | Creates a staff account. |
| 21 | Staff | Role Modal | Changes a staff member's role. |
| 22 | Staff | Hand-over Password Modal | Shows the initial password to hand to a new staff member, who must change it at first login. |
| 23 | Pricing | Pricing Screen (`/manager/prices`) | Court and service prices. |
| 24 | Audit | Audit Screen (`/manager/audit`) | Log of sensitive actions taken by staff. |
| 25 | Settings | Settings Screen (`/manager/settings`) | Feature switches, courts and centre details. |
| 26 | Alerts | Alerts Screen (`/alerts`) | Alerts for the manager. |
| 27 | Account | Account Settings Screen (`/account`) | Own profile and password. |
