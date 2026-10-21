# Quy tắc bắt buộc: chỉnh SRS Arena 3 theo FPT template

Tài liệu này là **ràng buộc** cho mọi lần sửa SRS Arena 3, gồm Claude Docs project `ef2ef169-beab-4a4d-8c61-e3a8ad8ea5f8` và bản PDF `docs/Arena3-SRS-v*.pdf`.

- **PHẢI** = bắt buộc.
- **KHÔNG ĐƯỢC** = cấm.
- Thứ gì không được nêu ở mục 10 "Mở rộng được phép" thì không được thêm.

Nguồn chuẩn, theo thứ tự ưu tiên:

1. `docs/FPT template/4488_..._Report7_FinalReport (1).pdf`, gọi tắt là **R7**:
   - Part III "Software Requirement Specification", trang 19–146: khung chính.
   - Part IV "Software Design Description", trang 147–170: dùng cho class diagram và sequence diagram.
2. `docs/FPT template/Scientific Journal Publication Trend Tracking System.pdf`, gọi tắt là **SJ**. Chỉ dùng cho định dạng bảng đặc tả use case chi tiết (SJ trang 24–25).
3. `CLAUDE.md`: quy tắc vẽ sơ đồ draw.io.
4. `docs/book/OReilly.Learning.UML.2.0.2006.4.pdf`: ký hiệu UML 2.0.

Khi R7 và SJ khác nhau, **R7 thắng**.

---

## 0. Nguyên tắc chung

- **0.1** Đây là việc **cấu trúc lại và định dạng lại**, không phải viết lại yêu cầu.
  - Tất cả UC, BR, NFR, message, screen, entity và job hiện có **PHẢI** còn đủ sau khi sửa: chỉ được di chuyển, đổi tên tiêu đề hoặc đổi định dạng.
  - Số lượng hiện tại (rev 27) phải giữ nguyên: 9 actor, 44 UC (UC-01..UC-44), 53 BR (BR-01..BR-53), 26 NFR, 21 message, 44 screen, 11 non-screen function, 17 entity, 27 figure.
  - Nếu số lượng đổi sau khi sửa thì sai, trừ khi có hình mới theo mục 6 và mục 8.
- **0.2** **KHÔNG ĐƯỢC** bịa dữ liệu. Thông tin nhóm chỉ lấy đúng từ mục 1.1. Thông tin không có ở đó (MSSV, Leader, Ext Supervisor, mã đề tài) thì **bỏ hẳn**, không ghi `[TBD]` và không tự điền.
- **0.3** Mọi nội dung trong tài liệu **PHẢI** là tiếng Anh học thuật theo giáo trình SE FPT. Riêng nhãn nút hoặc màn hình trên UI tiếng Việt thì trích nguyên văn trong ngoặc kép. R7 cũng làm vậy, ví dụ: When clicking the "Tiện Nghi" button.
- **0.4** Trang **PHẢI** là A4 dọc (portrait).
  - **KHÔNG ĐƯỢC** xoay ngang trang hay xoay hình.
  - Hình quá rộng thì vẽ lại cho vừa khổ dọc.
- **0.5** Tiêu đề mục **PHẢI** viết Title Case và đúng chữ như R7, ví dụ "Screen Authorization", không viết "Screen authorization".

---

## 1. Phần đầu tài liệu (front matter)

Phải theo đúng thứ tự sau:

| # | Mục | Quy tắc |
|---|---|---|
| 1 | **Cover** | Theo R7 trang 1. Trên cùng: logo FPT University (lấy từ R7 trang 1) và dòng "MINISTRY OF EDUCATION AND TRAINING". Kế đến: "FPT UNIVERSITY", rồi "Software Requirement Specification" thay cho "Capstone Project Document", rồi tên đề tài "Sport Center Management System". Bảng 2 cột chỉ gồm hai hàng: Group Members và Supervisor, dữ liệu theo mục 1.1. Dòng cuối trang: `- HCM, 10/2026 -`. |
| 2 | **Record of Changes** | Giữ bảng hiện có (Date, Version, A/M/D, In charge, Description), dòng mới nhất ở trên. **PHẢI** thêm chú thích ngay dưới bảng: `*A – Added, M – Modified, D – Deleted`. |
| 3 | **Table of Contents** | Tự sinh, liệt kê tới cấp 4 (ví dụ 3.1.1.1), có số trang. |
| 4 | **List of Figures** | Tự sinh từ caption. |
| 5 | **Definition and Acronyms** | **Bắt buộc, hiện đang thiếu.** Bảng 2 cột `Acronym \| Definition` theo R7 trang 6. Tối thiểu có: API, BR, ERD, NFR, OTP, QR, SDD, SRS, UC, UI, VND, SMTP, AI, JSON, HTTPS. Bổ sung mọi viết tắt khác xuất hiện trong thân tài liệu. |

### 1.1 Thông tin nhóm (do người dùng cung cấp, đã đủ)

| Hàng | Giá trị |
|---|---|
| Project name | Sport Center Management System |
| Group Members | Nguyễn Văn Trọng Hiếu<br>Đặng Trang Thanh Sử<br>Nguyễn Trọng Toàn<br>Phạm Duy Tân<br>Nguyễn Hoàng Phúc |
| Supervisor | Tôn Thất Hoàng Minh |

- Họ tên **PHẢI** giữ nguyên dấu tiếng Việt và đúng thứ tự trên.
- **KHÔNG** thêm MSSV, nhãn "(Leader)", hàng Ext Supervisor hay hàng Capstone Project code.
- Tên đề tài chỉ dùng ở trang bìa và tiêu đề tài liệu. Trong thân tài liệu vẫn gọi hệ thống là "Arena 3"; chính tả "Centre" trong thân giữ nguyên.

**KHÔNG ĐƯỢC** thêm Acknowledgement. Mục đó chỉ có ở Final Report, SRS không cần.

---

## 2. Khung mục bắt buộc (heading tree)

Thân tài liệu gồm **hai part**, đánh số La Mã:

- Part I là R7 Part III.
- Part II là R7 Part IV.

Bên trong mỗi part đánh số Ả Rập, sâu tối đa 4 cấp.

**KHÔNG ĐƯỢC** thêm, bớt hay đổi thứ tự các mục đánh dấu ★ (tiêu đề cố định theo template).

```
I. Software Requirement Specification
  1. Product Overview ★
  2. User Requirements ★
     2.1 Actors ★
     2.2 Use Cases ★
        2.2.1 Diagram(s) ★
           2.2.1.1 Account and Access
           2.2.1.2 Member Court Booking and Payment
           2.2.1.3 Member Classes and Training
           2.2.1.4 Front Desk Sales
           2.2.1.5 Front Desk Operations
           2.2.1.6 Coach
           2.2.1.7 Manager Setup
           2.2.1.8 Manager Oversight
        2.2.2 Descriptions ★
  3. Functional Requirements ★
     3.1 System Functional Overview ★
        3.1.1 Screens Flow ★
           3.1.1.1 Public Site
           3.1.1.2 Member Portal
           3.1.1.3 Front Desk Portal
           3.1.1.4 Coach Portal
           3.1.1.5 Manager Portal
        3.1.2 Screen Descriptions ★
           3.1.2.1 Public Site … 3.1.2.5 Manager Portal   (same order as 3.1.1)
        3.1.3 Screen Authorization ★
        3.1.4 Non-Screen Functions ★
        3.1.5 Entity Relationship Diagram ★
           3.1.5.1 Conceptual Entity Relationship Diagram ★
           3.1.5.2 Logical Entity Relationship Diagram ★
           Entities Description ★   (unnumbered sub-heading, as in R7 p.39)
     3.2 Account and Access                 -> 3.2.1 … 3.2.6  = UC-01 … UC-06
     3.3 Member Court Booking and Payment   -> 3.3.1 … 3.3.6  = UC-07 … UC-12
     3.4 Member Classes and Training        -> 3.4.1 … 3.4.5  = UC-13 … UC-17
     3.5 Front Desk Sales                   -> 3.5.1 … 3.5.7  = UC-18 … UC-24
     3.6 Front Desk Operations              -> 3.6.1 … 3.6.5  = UC-25 … UC-29
     3.7 Coach Teaching and Earnings        -> 3.7.1 … 3.7.6  = UC-30 … UC-35
     3.8 Manager Setup                      -> 3.8.1 … 3.8.5  = UC-36 … UC-40
     3.9 Manager Oversight                  -> 3.9.1 … 3.9.4  = UC-41 … UC-44
  4. Non-Functional Requirements ★
     4.1 External Interfaces ★
        4.1.1 User Interface ★
        4.1.2 Communications Interfaces ★
     4.2 Quality Attributes ★
        4.2.1 Usability ★
        4.2.2 Reliability ★
        4.2.3 Performance ★
        4.2.4 Security
        4.2.5 Auditability
        4.2.6 Maintainability
  5. Requirement Appendix ★
     5.1 Business Rules ★
     5.2 Common Requirements ★
     5.3 Application Messages List ★

II. Software Design Description
  1. System Design ★
     1.1 System Architecture ★
     1.2 Package Diagram ★
        Package Descriptions ★   (unnumbered sub-heading, as in R7 p.148)
  2. Database Design ★
     Table Descriptions ★
  3. Detailed Design ★
     3.1 Booking and Payment
     3.2 Membership and Classes
     3.3 Coaching and Training
     3.4 Centre Operations
        (mỗi mục 3.x có: 3.x.1 Class Diagram ★, 3.x.2 Sequence Diagram ★)
```

- Tiêu đề 3.x.y (mỗi UC một mục) **PHẢI** là tên use case ở dạng Title Case, **không kèm** mã UC. Ví dụ: `3.3.2 Book a Court and Pay`. Mã UC ghi trong khối đặc tả theo mục 5.
- Tên mỗi use case **PHẢI** trùng từng chữ (không tính hoa/thường) ở ba nơi: oval trong use case diagram, bảng 2.2.2 và tiêu đề 3.x.y.

---

## 3. Ánh xạ bắt buộc từ cấu trúc hiện tại sang cấu trúc mới

| Hiện tại (rev 27) | Chuyển tới | Việc phải làm |
|---|---|---|
| I.1 Product overview (đoạn văn, bảng Portal, đoạn Out of scope) | I.1 Product Overview | Giữ nguyên nội dung. "Out of scope" giữ thành đoạn cuối. |
| I.2 Context diagram (Figure 1 và bảng luồng dữ liệu) | I.1 Product Overview, đặt ngay sau đoạn mở đầu | Không có heading con riêng. Giữ bảng External entity. |
| I.3 Main workflows (4 activity diagram, Figure 2–5) | Mục "Function Details" của UC tương ứng: 3.2.2 (UC-02), 3.3.2 (UC-08), 3.4.1 (UC-13), 3.5.7 (UC-24) | Xóa heading "Main workflows". Đoạn mô tả đi kèm hình cũng chuyển theo. |
| II.1 Actors (bảng `#, Actor, Kind, Description`) | I.2.1 Actors | Bảng **PHẢI** đúng 3 cột `# \| Actor \| Description`. Kind đưa vào đầu cột Description (xem mục 4.1). |
| II.2 Use case diagrams 2.1–2.8 | I.2.2.1 Diagram(s), mục 2.2.1.1–2.2.1.8 | Giữ hình, đổi tên heading như mục 2. |
| II.3 Use case list (`ID, Use case, Primary actor, Figure`) | I.2.2.2 Descriptions | Bảng **PHẢI** đúng 4 cột `ID \| Use Case \| Actors \| Use Case Description` theo R7 trang 21. Actors gồm primary và secondary actor. Description lấy từ dòng "Description" của bảng UC spec. Bỏ cột Figure. |
| III.1.1 Screens flow (Figure 14–18) | I.3.1.1, mục 3.1.1.1–3.1.1.5 | Mỗi portal một heading con chứa đúng một hình. |
| III.1.2 Screen descriptions (`#, Feature, Screen, Route, Description`) | I.3.1.2, tách 5 bảng theo portal | Mỗi bảng **PHẢI** đúng 4 cột `# \| Feature \| Screen \| Description`. Route ghi sau tên màn hình, ví dụ `Book a court (/app/book)`. Số thứ tự đánh lại từ 1 ở mỗi bảng. |
| III.1.3 Screen authorization (bảng màn hình × vai trò, bảng Action/Allowed roles/Refused with) | Bảng 1 sang I.3.1.3. Bảng 2 sang I.5.2 Common Requirements | Định dạng theo mục 4.3. |
| III.1.4 Non-screen functions (`#, Function, Trigger, Description`) | I.3.1.4 | Bảng **PHẢI** đúng 4 cột `# \| Feature \| System Function \| Description`. Trigger (chu kỳ chạy) chuyển thành câu đầu của Description. Đoạn văn về job loop giữ dưới bảng. |
| III.1.5 ERD (Figure 19 và bảng `#, Entity, Table, Description`) | I.3.1.5.1 (hình). Bảng sang "Entities Description" | **Thiếu** Logical ERD 3.1.5.2: phải vẽ mới theo mục 6. Bảng theo mục 4.5. |
| III.1.6 Class diagrams (Figure 20–23) | II.3.x.1 Class Diagram | Booking & payment sang 3.1. Membership & classes sang 3.2. Coaching & training sang 3.3. Centre operations sang 3.4. Đoạn "Figure N covers…" đi kèm hình. |
| III.2 Use case specifications 2.1–2.44 (bảng Field/Detail và các flow) | I.3.2–I.3.9, mỗi UC một mục 3.x.y | Định dạng theo mục 5. |
| Sequence diagrams (Figure 24–27, đang nằm trong UC spec) | II.3.x.2 Sequence Diagram | Register sang 3.4.2. Book & pay sang 3.1.2. Refund sang 3.1.2. Gate check-in sang 3.4.2. Thiếu sequence cho 3.2 và 3.3: phải vẽ mới theo mục 6. |
| IV.1.1 User interfaces | I.4.1.1 User Interface | Giữ nguyên. |
| IV.1.2 Software interfaces (bảng) | I.4.1.2 Communications Interfaces | Giữ bảng. |
| IV.1.3 API error codes (bảng) | I.5.2 Common Requirements, heading con "Error Responses" (không đánh số) | Giữ nguyên. |
| IV.2.1 Correctness and reliability | I.4.2.2 Reliability | Giữ mã NFR. |
| IV.2.2 Performance | I.4.2.3 Performance | |
| IV.2.3 Usability | I.4.2.1 Usability | |
| IV.2.5 Security and privacy | I.4.2.4 Security | |
| IV.2.4 Auditability | I.4.2.5 Auditability | |
| IV.2.6 Maintainability | I.4.2.6 Maintainability | |
| V.1 Business rules (`ID, Category, Rule statement, Type, Applies to`) | I.5.1 Business Rules | Định dạng theo mục 4.6. |
| V.2 Centre settings | I.5.2 Common Requirements, heading con "Configurable Settings" | Giữ bảng. |
| V.3 Common requirements | I.5.2 Common Requirements | Mở đầu bằng 2 gạch đầu dòng giống R7 trang 144: User Login, User Authorization. Sau đó là bảng hiện có. |
| V.4 Application messages (`#, Code, Type, Message`) | I.5.3 Application Messages List | Định dạng theo mục 4.7. |
| *(chưa có)* | II.1.1, II.1.2, II.2 | Vẽ hoặc viết mới theo mục 6 và mục 8. |

---

## 4. Định dạng bảng (chỉ được dùng đúng các cột sau)

Quy định chung cho mọi bảng:

- Có hàng tiêu đề in đậm, nền tô màu.
- Viền đủ cả bốn phía.
- Không có ô trống. Ô không có nội dung thì ghi `None` hoặc `N/A`.
- Không có caption cho bảng: R7 không dùng caption bảng.

### 4.1 Actors
`# | Actor | Description`.
- Giữ đủ 9 actor hiện có, theo thứ tự: Guest, Registered User, Member, Receptionist, Coach, Manager, payOS, Mail delivery (SMTP), Gemini AI.
- Kind (Human, Abstract, Staff hoặc System) đưa vào đầu cột Description. Ví dụ: "Abstract actor. Any signed-in person…".

### 4.2 Use Case Descriptions (2.2.2)
`ID | Use Case | Actors | Use Case Description`.
- ID ghi dạng `UC-01`.
- Đủ 44 hàng, theo thứ tự UC.

### 4.3 Screen Authorization (3.1.3)
Theo R7 trang 34–37.
- Cột: `Screen | Guest | Member | Receptionist | Coach | Manager`.
- Mỗi màn hình có một hàng tiêu đề dạng `<<Screen Name>>`.
- Ngay dưới là các hàng chức năng của màn hình đó, thụt lề.
- Đánh dấu bằng `x` chữ thường. Ô không có quyền để trống: đây là ngoại lệ duy nhất cho quy tắc không có ô trống.
- Đủ 44 màn hình.

### 4.4 Non-Screen Functions (3.1.4)
`# | Feature | System Function | Description`.

### 4.5 Entities Description và Table Descriptions
Theo R7 trang 40–42.
- Cột: `# | Entity | Description`.
- Trong ô Description:
  - Câu mô tả, bắt đầu bằng "Store …".
  - Gạch đầu dòng `Primary Key: …`.
  - Gạch đầu dòng `Foreign Key: …` (để trống sau dấu hai chấm nếu không có).
- Tên bảng vật lý (cột "Table" hiện tại) đưa vào câu mô tả. Ví dụ: "Store every person with an account (table `users`)."
- PK và FK **PHẢI** lấy đúng từ `src/lib/db.ts`, không suy đoán.
- Ở II.2 Table Descriptions: cùng định dạng, liệt kê **tất cả** bảng vật lý trong `src/lib/db.ts`, không chỉ 17 entity lõi.

### 4.6 Business Rules (5.1)
Theo R7 trang 143.
- Đúng 2 cột `ID | Rule Definition`.
- ID giữ nguyên BR-01..BR-53.
- Trước khi bỏ các cột Category, Type và Applies to, **PHẢI** kiểm tra mỗi BR đã được ít nhất một UC dẫn chiếu trong dòng "Business Rules" của khối đặc tả. BR nào chưa được dẫn chiếu thì thêm vào UC phù hợp. Không được làm mất liên kết truy vết.
- Công thức tính tiền ghi trên nhiều dòng trong cùng một ô, như BR-14 của R7.

### 4.7 Application Messages List (5.3)
Theo R7 trang 144–146.
- Đúng 4 cột `Message ID | Message Text | Message Type | Context/Trigger`.
- Message ID **PHẢI** có dạng `<PREFIX>_<AREA>_<NN>`:
  - PREFIX ∈ {MSG (success), ERR (error/validation), INFO (information), WARN (warning)}.
  - AREA ∈ {AUTH, PROF, BOOK, PAY, PLAN, CLASS, CHECKIN, GEAR, MAINT, SUPPORT, COACH, ADMIN, REPORT}.
  - Ví dụ: `ERR_BOOK_01`.
- Message Type ∈ {Success, Error, Validation, Information, Warning}.
- Context/Trigger dạng `<Screen> (<action>)`.
- Mã cũ (MSG01…) và mã BR liên quan ghi trong ngoặc ở cuối Context/Trigger. Ví dụ: `(was MSG01; BR-01)`.
- Mọi chỗ trong tài liệu nhắc mã cũ **PHẢI** đổi sang mã mới.

### 4.8 Quality Attributes (4.2.x)
Giữ bảng `ID | Requirement` với mã NFR-nn hiện có. Mỗi mục mở đầu bằng một câu nói rõ mục đích, như R7 trang 142.

---

## 5. Khối đặc tả chức năng (mỗi mục 3.x.y)

Mỗi UC **PHẢI** có đúng 5 khối sau, đúng thứ tự, đúng nhãn. Đây là định dạng R7 trang 42–45 và 88.

```
● Function Trigger: <hành động cụ thể trên UI hoặc sự kiện; nhãn nút tiếng Việt trích nguyên văn>
● Function Description:
    + Use Case ID: UC-nn
    + Actors: <primary>; Secondary: <secondary hoặc None>
    + Purpose: <một câu>
    + Interface: <tên màn hình (route)> — phải khớp bảng 3.1.2
● Data Processing:
    + Data Collect: <dữ liệu nhập/đọc>
    + Data Computation: <xử lý, kiểm tra, công thức; dẫn chiếu BR-nn>
    + Data Storage: <ghi gì vào bảng nào>   (dùng "Data Binding" nếu chức năng chỉ đọc)
● Screen Layout:
    <ảnh chụp màn hình thật của Interface>
● Function Details:
    <bảng Field | Detail hiện có>
    Normal Flow / Alternative Flows / Exceptions (giữ nguyên nội dung hiện có)
    <activity diagram nếu UC có — xem mục 3>
```

- **5.1** Bảng Field/Detail giữ đủ 11 dòng hiện có. Nhãn dòng sửa cho khớp SJ trang 24:
  - `ID and Name`
  - `Created By`
  - `Date Created`
  - `Primary Actor`
  - `Secondary Actors`
  - `Trigger`
  - `Description`
  - `Preconditions`
  - `Postconditions`
  - `Priority`
  - `Frequency of Use`
  - `Business Rules`

  Dòng "Created by / date" hiện tại **PHẢI** tách thành hai dòng `Created By` và `Date Created`.
- **5.2** Preconditions và Postconditions **PHẢI** đánh mã `PRE-1, PRE-2…` và `POST-1…`, theo SJ.
- **5.3** Các flow theo cách đánh số của SJ:
  - Normal Flow có tiêu đề `n.0 <tên>` và các bước 1, 2, 3…
  - Alternative Flows đánh số `n.1, n.2…`, mỗi nhánh kết thúc bằng "Return to step k of the Normal Flow." hoặc nêu rõ điểm kết thúc.
  - Exceptions đánh mã `n.0.E1…`, bước liên quan ghi `(see n.0.E1)`.
- **5.4** Lỗi nhắc tới trong flow **PHẢI** dẫn chiếu Message ID ở 5.3 hoặc mã BR. Không được ghi câu thông báo tự do mà không có mã.
- **5.5** Screen Layout:
  - Ảnh chụp từ bản chạy local (localhost, dữ liệu seed) hoặc do nhóm cung cấp, khổ ngang trong trang dọc.
  - Ảnh **không** đánh số Figure, theo R7. Alt text **KHÔNG ĐƯỢC** bắt đầu bằng "Figure" để pipeline không đánh số nhầm.
  - UC không có màn hình riêng thì ghi `N/A – <lý do>`.

---

## 6. Hình vẽ

- **6.1** Mọi sơ đồ **PHẢI** tuân `CLAUDE.md`:
  - Chỉ dùng draw.io XML, **KHÔNG** dùng Mermaid, không có XML comment.
  - Mọi cell có mxGeometry, đỉnh có `vertex="1"`, cạnh có `edge="1"`.
  - ID duy nhất, source và target của cạnh đều tồn tại, không có gì chồng lên nhau.
  - Nhãn tiếng Anh.
- **6.2** Sơ đồ sinh bằng `python scripts/srs_diagrams/build.py`, xuất ra `docs/diagrams/srs/`.
  - Hình mới **PHẢI** thêm module vào builder và qua được bộ kiểm tra của `lib.py` (overlap, crossing, nhãn đè lên hình).
  - **KHÔNG ĐƯỢC** vẽ tay ngoài builder.
- **6.3** Ký hiệu UML 2.0 theo Learning UML 2.0:
  - Use case:
    - Actor ở ngoài boundary.
    - Association không có mũi tên.
    - Oval là cụm động từ chỉ mục tiêu, không ghi mã UC.
  - Class:
    - Có ngăn `<hr>`.
    - Visibility dùng + - #.
    - Enum nối bằng dependency nét đứt.
  - Sequence:
    - Lifeline có thanh activation.
    - Message không đánh số.
    - Dùng combined fragment alt/opt.
  - Activity:
    - Có initial node và final node.
    - Rẽ nhánh bằng decision node, gộp nhánh bằng merge node.
- **6.4** Hình phải vẽ mới:

  | Hình | Mục | Nội dung bắt buộc |
  |---|---|---|
  | Logical ERD | I.3.1.5.2 | Mọi bảng trong `src/lib/db.ts`, ký hiệu crow's foot, ghi PK và FK |
  | System Architecture | II.1.1 | Browser (4 portal) → TanStack Start (SSR + `/v1` JSON API) → database; các external system: payOS, SMTP, Gemini; job loop |
  | Package Diagram | II.1.2 | Gói thật trong `src/` (`routes`, `components`, `lib/arena3/handlers`, `lib/arena3`, `lib/i18n`…), kèm bảng `No \| Package Name \| Description` theo R7 trang 149 |
  | Sequence: Enrol in a class | II.3.2.2 | Gồm nhánh waitlist |
  | Sequence: Take session attendance | II.3.3.2 | |

- **6.5** Caption:
  - Đặt **dưới** hình, căn giữa, dạng `Figure N. <Title>`.
  - N đánh liên tục toàn tài liệu theo thứ tự xuất hiện.
  - Mọi hình **PHẢI** được nhắc trong văn bản trước khi hình xuất hiện.
  - Khi đổi vị trí hình, mọi chỗ "Figure N" trong văn bản và trong List of Figures **PHẢI** được cập nhật.
- **6.6** Hình phải nằm vừa chiều rộng trang A4 dọc và đọc được ở 100%, chữ nhỏ nhất khoảng 9pt khi in.

---

## 7. Văn phong

- Câu ngắn, thể chủ động. Chủ ngữ là "The system", "The member"…
- Yêu cầu dùng "must". **Không** dùng "should", "may" hay "etc." trong yêu cầu.
- Mỗi thuật ngữ chỉ dùng một tên trong toàn tài liệu: Guest, Registered User, Member, Receptionist, Coach, Manager, payOS, "Mail delivery (SMTP)", "Gemini AI". Không trộn với "user", "staff", "admin".
- Tiền tệ ghi `1,000,000 VND` hoặc `1,000,000đ`, chọn một dạng và dùng thống nhất. Thời gian dùng định dạng 24 giờ. Ngày ghi `YYYY-MM-DD`.
- Không đổi nội dung nghiệp vụ, trừ khi sửa cho khớp với code hiện tại. Mọi thay đổi như vậy **PHẢI** được ghi vào Record of Changes.

---

## 8. Quy trình thực hiện (bắt buộc theo thứ tự)

1. Đọc doc hiện tại qua Claude Docs MCP. Chép các số đếm ở mục 0.1 vào ghi chú làm mốc so sánh.
2. Vẽ các hình mới ở mục 6.4 bằng builder, rồi báo đường dẫn file `.drawio`.
3. Sửa doc trên Claude Docs theo thứ tự mục 1 → 2 → 3 → 4 → 5.
   - Mỗi lần `update` tối đa 64 op.
   - `replace` phải có `ifHash`/`ifRev`.
   - Ảnh mới upload một file mỗi lần, rồi tạo blob.
4. Thêm một dòng mới vào Record of Changes, Version tăng 0.1. Ví dụ: "Restructured to the FPT SRS/SDD template".
5. Xuất PDF bằng pipeline trong scratchpad: `make_html.py` → `print.js` → `find_pages.py` → `merge.py`. Cập nhật `cover.html` theo mục 1.
6. Chạy checklist ở mục 9. Mục nào chưa đạt thì sửa rồi chạy lại, không giao bản lỗi.

---

## 9. Checklist nghiệm thu (tất cả phải đạt)

- [ ] Cover đúng bố cục R7 trang 1 và đúng dữ liệu ở mục 1.1. Không có MSSV, Leader, Ext Supervisor hay mã đề tài.
- [ ] Có Definition and Acronyms. Mọi viết tắt trong thân tài liệu đều có trong bảng.
- [ ] Cây heading khớp 100% mục 2: tên, số thứ tự, thứ tự. Không còn heading cũ nào ("Overall requirements", "Main workflows", "Use case list", "Use case specifications", "Centre settings"…).
- [ ] Đếm lại sau khi sửa: 9 actor, 44 UC, 53 BR, 26 NFR, 21 message, 44 screen, 11 non-screen function. Số entity ≥ 17. Số figure = 27 + số hình mới.
- [ ] Tên mỗi UC khớp ở ba nơi: oval, bảng 2.2.2, tiêu đề 3.x.y.
- [ ] Mỗi mục 3.x.y có đủ 5 khối, đúng thứ tự và đúng nhãn ở mục 5. Interface khớp bảng 3.1.2.
- [ ] Mọi bảng có đúng số cột quy định ở mục 4.
- [ ] Mỗi BR được ít nhất một UC dẫn chiếu. Mỗi Message ID được ít nhất một flow dẫn chiếu.
- [ ] Không còn mã message cũ (MSG01…) trong thân tài liệu, trừ phần "(was …)" trong bảng 5.3.
- [ ] Figure đánh số liên tục từ 1, caption ở dưới hình, mọi hình đều được nhắc trước trong văn bản, List of Figures khớp.
- [ ] Mọi file `.drawio` qua bộ kiểm tra của builder. Không có Mermaid.
- [ ] Mọi trang của PDF là A4 dọc (595×842). Footer "Page N of M" đúng. Không có hình bị xoay.
- [ ] Record of Changes có dòng cho lần sửa này.

---

## 10. Mở rộng được phép (ngoài template)

Chỉ được phép có các phần sau:

- Record of Changes, List of Figures.
- Bảng Portal và bảng luồng dữ liệu của context diagram trong I.1.
- Dòng `Use Case ID` trong Function Description.
- Bảng Field/Detail và các flow trong Function Details.
- Activity diagram trong Function Details của UC-02, UC-08, UC-13, UC-24.
- Các mục 4.2.4–4.2.6.
- Các heading con không đánh số "Error Responses" và "Configurable Settings" trong 5.2.

Mọi phần khác ngoài template **PHẢI** được người dùng đồng ý trước khi thêm.
