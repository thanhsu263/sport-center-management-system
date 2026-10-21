# ĐẶC TẢ SUITE 07–13 — ARENA 3

> Bổ sung cho `docs/AGENT-TEST-INSTRUCTIONS.md`. File đó quy định luật, server, cách chạy, phân loại FAIL. File này chỉ đặc tả **cần test gì và kỳ vọng gì** cho các suite bạn tự viết.
> Bạn viết script `scripts/tests/agent/NN-*.mjs` từ đặc tả này, dùng `agent-lib.mjs`, theo template ở mục 11.0.1 của file hướng dẫn.

Đây là kiểm thử QA trên bản build cục bộ của chính dự án (`127.0.0.1:8090`), nhằm chứng minh app **từ chối đúng** và **không sập** với đầu vào/thao tác không hợp lệ.

## Quy ước chung

- **Đường dẫn route** trong file này là tên gợi ý. Đường dẫn thật lấy từ `src/lib/arena3/router.ts`. Route không tồn tại → `blocked(id, title, "route không có trong router")`, không phải FAIL.
- **Cột "Kỳ vọng"** là hành vi đúng về nghiệp vụ. Code làm khác mà không an toàn hoặc sai tiền → FAIL, không sửa kỳ vọng. Chỉ khác mã lỗi mà vẫn an toàn → đọc handler rồi chỉnh theo mục 10 của file hướng dẫn.
- **`4xx`** = chấp nhận bất kỳ 400/403/404/409/422, miễn không 2xx và không 500.
- **`không 500`** là ngầm định với mọi case.
- **`đọc lại`** = sau hành động phải GET lại tài nguyên bằng token chủ sở hữu/manager để chứng minh trạng thái đổi hay không đổi. Không tin riêng status code.
- Mỗi suite dọn trạng thái toàn cục (setting, flag, giá) về như cũ ở cuối file bằng `try/finally`, kể cả khi giữa chừng lỗi.
- Ước lượng số hội viên mới ghi ở đầu mỗi suite. Vượt 40 thì tách `NNa-`, `NNb-`.
- Ký hiệu tài khoản: `mgr`, `rec`, `rec2`, `khoa`, `lan`, `ducAnh`, `viet`, `bao` (no plan), `A`, `B` (hội viên mới có gói cầu lông 30 ngày qua `memberWithPlan`).

---

## Suite 07 — Kiểm soát truy cập & độ bền đầu vào (`07-security.mjs`, `SEC-`)

Suite này **đã được đặc tả đầy đủ ở mục 11.1 của `docs/AGENT-TEST-INSTRUCTIONS.md`** (nhóm A token, B quyền chéo, C ma trận vai trò, D độ bền đầu vào, E payload xấu, F mass assignment, G origin/CORS, H phạm vi liên hệ, I tái xác nhận F-01/F-02, J rò rỉ nội bộ). Viết suite 07 theo đúng mục đó. Dưới đây chỉ là các điểm làm rõ thêm:

- **Ma trận vai trò (nhóm C):** với mọi route trong router, gọi bằng 6 danh tính (anonymous, `A` member, `khoa` coach, `rec` receptionist, `mgr` manager, `ducAnh` coach môn khác) rồi ghi `test-output/07-role-matrix.csv` với cột `method,path,expected_roles,anon,member,coach,receptionist,manager,coach_other`. `expected_roles` suy từ ý đồ của handler: route quầy → receptionist+manager; route `/coach/*` → coach+manager; route `/me/*` → mọi người đã đăng nhập. Một ô mà vai trò ngoài `expected_roles` nhận 2xx → FAIL (HIGH nếu route ghi/xoá/tiền hoặc lộ dữ liệu cá nhân, còn lại MEDIUM).
- **Quyền chéo (nhóm B):** setup để `B` có sẵn mỗi loại tài nguyên (booking, payment, receipt, subscription, enrollment, ticket, bài tập, thông báo, điểm danh, QR), rồi `A` thử đọc/sửa/xoá/huỷ từng cái. Mọi GET phải kiểm thêm: body không chứa SĐT, id hay tên của `B`.
- **Mass assignment (nhóm F):** khi `A` tự sửa hồ sơ mà kèm `role`, `member_code`, `balance`, `price_vnd`, `id`, `created_at` thì các trường đó phải bị bỏ qua (đọc lại thấy không đổi, và `A` vẫn không gọi được route manager).
- **Trợ giảng:** `lan` là trợ giảng lớp seed nên **được** điểm danh lớp đó — nếu code chặn, ghi `NEEDS-HUMAN` chứ không coi là bug ngay.

Các suite còn lại (08–13) đặc tả chi tiết bên dưới.

---

## Suite 08 — Khuyến mãi (`08-promos.mjs`, `PR-`)

~6 hội viên mới. Đọc `src/lib/arena3/promos.ts` trước (mục 3.6 file hướng dẫn tóm tắt luật). Mã seed: `SUMMER50K`.

### 08.1 CRUD mã (manager)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| PR-01 | Manager tạo mã mới hợp lệ (code duy nhất theo `Date.now()`) | 2xx, đọc lại thấy mã |
| PR-02 | Tạo mã trùng code đã có | 409 |
| PR-03 | Tạo mã thiếu trường bắt buộc (code, loại giảm, giá trị) | 400, đúng `field` |
| PR-04 | Tạo mã `percent` > 100 | 4xx |
| PR-05 | Tạo mã `percent` hoặc `amount` âm | 4xx |
| PR-06 | Tạo mã `valid_from` sau `valid_to` | 4xx |
| PR-07 | Tạo mã `max_uses` = 0 hoặc âm | 4xx |
| PR-08 | Sửa mã (đổi giá trị giảm) | 2xx, đọc lại đúng |
| PR-09 | Tạm dừng (pause) mã | 2xx |
| PR-10 | Xoá mã | 2xx, quote mã đó sau đó → BR-40 |
| PR-11 | Receptionist tạo/sửa/xoá mã | 403 |
| PR-12 | Member CRUD mã | 403 |

### 08.2 Quote — mọi lý do BR-40

Chuẩn bị: một gói còn hiệu lực để quote, một đơn đủ lớn. Mỗi case gọi route quote (vd `POST /promos/quote`).

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| PR-20 | Code rỗng `""` | 400 field `promo_code` |
| PR-21 | Code không tồn tại | 422 BR-40 |
| PR-22 | Code đang pause | 422 BR-40 |
| PR-23 | Code chưa tới `valid_from` | 422 BR-40 |
| PR-24 | Code đã quá `valid_to` | 422 BR-40 |
| PR-25 | Code chỉ áp dụng cho plan, dùng cho court | 422 BR-40 |
| PR-26 | Code chỉ áp dụng cho court, dùng cho plan | 422 BR-40 |
| PR-27 | Code gắn môn khác với đơn | 422 BR-40 |
| PR-28 | Code gắn plan khác với plan trong đơn | 422 BR-40 |
| PR-29 | Đơn dưới `min_order_vnd` | 422 BR-40 |
| PR-30 | Code đã đạt `max_uses` toàn hệ thống | 422 BR-40 |
| PR-31 | Hội viên đã dùng đủ số lần cho phép của mã | 422 BR-40 |
| PR-32 | Giảm tính ra ≤ 0 | 422 BR-40 |
| PR-33 | Quote hợp lệ | 2xx, số tiền giảm đúng công thức |

### 08.3 Chuẩn hoá & stacking

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| PR-40 | Quote `SUMMER50K` hợp lệ | 2xx, giảm đúng |
| PR-41 | Quote `  summer50k  ` (khoảng trắng + chữ thường) | Giống PR-40 (được chuẩn hoá) |
| PR-42 | Mã không stackable + gói có giảm giá sân + không truyền `listVnd` | 422 BR-42 |
| PR-43 | Mã mà giảm giá sân của gói đã tốt hơn | 422 BR-42 |

### 08.4 Redeem & hoàn tiền (BR-41)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| PR-50 | Redeem mã trong 1 payment hợp lệ | 2xx, lượt dùng (used) tăng 1 |
| PR-51 | Redeem lại cùng payment đó (idempotent) | Không tăng used lần hai |
| PR-52 | Hoàn tiền **toàn phần** payment có mã | used giảm lại 1 (trả lại lượt) |
| PR-53 | Hoàn tiền **một phần** payment có mã | used **không** đổi |
| PR-54 | Redeem mã đã bị xoá | 422 BR-41 hoặc BR-40 |

(Race lượt cuối của mã để ở suite 12.)

---

## Suite 09 — Extras (dịch vụ phụ, thiết bị & work orders; không bao gồm vé ngày) (`09-extras.mjs`)

~8 hội viên mới. Tiền tố: `EQ-`, `LOY-`, `COM-`, `WO-`, `SER-`.

### 09.1 Thiết bị & mượn trả (`EQ-`, BR-50)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| EQ-01 | Manager tạo loại thiết bị, số lượng N | 2xx |
| EQ-02 | Tạo thiết bị số lượng âm | 4xx |
| EQ-03 | Member mượn 1 thiết bị còn hàng | 2xx, tồn kho giảm 1 |
| EQ-04 | Mượn khi hết hàng (đã mượn hết N) | 422 BR-50 |
| EQ-05 | Mượn quá số lượng cho phép mỗi người (nếu có luật) | 4xx |
| EQ-06 | Trả thiết bị đã mượn | 2xx, tồn kho tăng lại 1 |
| EQ-07 | Trả lại lần hai cùng phiếu mượn | 4xx, tồn kho không tăng quá |
| EQ-08 | Trả phiếu mượn của người khác (member) | 403/404 |
| EQ-09 | Member tạo/sửa/xoá loại thiết bị | 403 |

### 09.2 (Đã gỡ: vé ngày, v2.4)
Các test case vé ngày (DP-01..DP-05) đã được chuyển sang suite 15 (15-removed-features.mjs)
để xác nhận tính năng đã được gỡ triệt để và endpoint trả 404.

### 09.3 Điểm thưởng (`LOY-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| LOY-01 | Xem số dư điểm của chính mình | 2xx |
| LOY-02 | Tiêu điểm trong số dư | 2xx, số dư giảm đúng |
| LOY-03 | Tiêu điểm vượt số dư | 4xx, số dư **không âm** |
| LOY-04 | Tiêu điểm số âm hoặc 0 | 4xx |
| LOY-05 | Member tự cộng điểm cho mình | 403 |
| LOY-06 | Xem điểm của người khác | 403/404 |

### 09.4 Hoa hồng HLV (`COM-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| COM-01 | `khoa` xem hoa hồng của chính mình | 2xx |
| COM-02 | `khoa` xem hoa hồng của `lan` (truyền id khác) | 403/404 hoặc chỉ ra của `khoa` |
| COM-03 | Member xem báo cáo hoa hồng | 403 |
| COM-04 | Manager xem hoa hồng mọi HLV | 2xx |

### 09.5 Work order / bảo trì sân (`WO-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| WO-01 | Manager tạo work order khoá 1 sân trong 1 khung giờ | 2xx |
| WO-02 | Đặt sân đó trong khung giờ bị khoá | 4xx (không 500), đọc lại không có booking |
| WO-03 | Đặt sân đó ngoài khung giờ bị khoá | 2xx |
| WO-04 | Đóng work order, rồi đặt lại trong khung giờ cũ | 2xx |
| WO-05 | Receptionist/member tạo work order | 403 |

### 09.6 Series / lớp lặp (`SER-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| SER-01 | Tạo booking lặp (series) hợp lệ nhiều buổi | 2xx, số buổi đúng |
| SER-02 | Series đụng 1 buổi với booking đã có | Báo rõ buổi đụng, không tạo nửa vời không kiểm soát |
| SER-03 | Huỷ cả series | Mọi buổi tương lai bị huỷ, buổi quá khứ giữ nguyên |
| SER-04 | Huỷ 1 buổi trong series | Chỉ buổi đó bị huỷ |

---

## Suite 10 — Lớp học, HLV, điểm danh, check-in, at-risk (`10-classes.mjs`)

~8 hội viên mới. Tiền tố: `CLS-`, `ATT-`, `CHK-`, `RISK-`. Feature flag F4 (classes) bật trong DB mới; nếu route trả 403 BR-52 thì flag tắt → `blocked()` chứ không FAIL. Dùng lớp seed (`khoa` dạy, `lan` trợ giảng).

### 10.1 Vòng đời lớp (`CLS-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| CLS-01 | Manager tạo lớp (tên, HLV, sức chứa, lịch) | 2xx, đọc lại đúng |
| CLS-02 | Tạo lớp sức chứa ≤ 0 | 4xx |
| CLS-03 | Tạo lớp HLV không tồn tại | 4xx |
| CLS-04 | Tạo lớp gán người không phải HLV làm HLV | 4xx |
| CLS-05 | Member ghi danh lớp còn chỗ | 2xx, sĩ số +1 |
| CLS-06 | Ghi danh khi lớp đã đầy | 422 (đúng BR sức chứa) |
| CLS-07 | Ghi danh lần hai cùng lớp | 4xx, không +2 |
| CLS-08 | Huỷ ghi danh | 2xx, sĩ số -1, chỗ mở lại |
| CLS-09 | Member sửa/xoá lớp | 403 |
| CLS-10 | `khoa` sửa lớp mình dạy (nếu luật cho) | 2xx hoặc 403 nhất quán với handler |

### 10.2 Điểm danh (`ATT-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| ATT-01 | `khoa` điểm danh học viên lớp mình | 2xx, đọc lại đúng |
| ATT-02 | `lan` (trợ giảng lớp seed) điểm danh | 2xx (nếu code chặn → NEEDS-HUMAN, không phải bug) |
| ATT-03 | `ducAnh` (HLV môn khác) điểm danh lớp này | 403 |
| ATT-04 | Member tự điểm danh | 403 |
| ATT-05 | Điểm danh học viên không thuộc lớp | 4xx |
| ATT-06 | Điểm danh trùng (cùng buổi, cùng người) | Idempotent, không nhân đôi |

### 10.3 Check-in vào cổng (`CHK-`, BR-30)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| CHK-01 | Check-in hội viên có gói còn hạn | 2xx |
| CHK-02 | Check-in hội viên gói đã hết hạn | 422 BR-30 |
| CHK-03 | Check-in hội viên chưa có gói | 422 BR-30 |
| CHK-04 | Check-in hai lần liên tiếp cùng người | Theo luật chống trùng (không 500) |
| CHK-05 | Member tự check-in người khác | 403 |

### 10.4 Báo cáo at-risk (`RISK-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| RISK-01 | Manager xem danh sách hội viên at-risk | 2xx, có cấu trúc |
| RISK-02 | Receptionist xem báo cáo at-risk | 2xx hoặc 403 theo handler |
| RISK-03 | Member xem báo cáo at-risk | 403 |

---

## Suite 11 — Cấu hình & báo cáo (`11-settings-reports.mjs`)

~4 hội viên mới. Tiền tố: `SET-`, `RPT-`, `AUD-`, `LST-`.

### 11.1 Cấu hình hệ thống (`SET-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| SET-01 | Manager đọc settings | 2xx |
| SET-02 | Manager sửa settings hợp lệ (vd giờ peak, giá) | 2xx, đọc lại đúng |
| SET-03 | Đặt giá trị ngoài biên (âm, quá lớn, sai kiểu) | 4xx, đúng field |
| SET-04 | Đặt giờ peak start > end | 4xx |
| SET-05 | Receptionist/member sửa settings | 403 |
| SET-06 | Bật/tắt feature flag (vd F4 classes) | 2xx; sau khi tắt, route lớp → 403 BR-52 |

### 11.2 Báo cáo doanh thu & công suất (`RPT-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| RPT-01 | Manager xem doanh thu theo khoảng ngày | 2xx, tổng khớp các payment đã tạo |
| RPT-02 | Doanh thu với ngày bắt đầu > ngày kết thúc | 4xx |
| RPT-03 | Doanh thu định dạng ngày sai | 400 |
| RPT-04 | Báo cáo công suất sân (occupancy) | 2xx, số buổi khớp booking (đối chiếu F-14) |
| RPT-05 | Xuất CSV báo cáo | 2xx, header + ít nhất 1 dòng, không lộ cột nhạy cảm (đối chiếu F-15) |
| RPT-06 | Member xem báo cáo doanh thu | 403 |

### 11.3 Nhật ký kiểm toán (`AUD-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| AUD-01 | Manager xem audit log | 2xx |
| AUD-02 | Một hành động ghi/xoá có tạo bản ghi audit | Đọc lại thấy entry tương ứng |
| AUD-03 | Member/receptionist xem audit log | 403 |

### 11.4 Danh sách & phân trang (`LST-`)

| Id | Hành động | Kỳ vọng |
| --- | --- | --- |
| LST-01 | Manager list members không limit | 2xx, có giới hạn mặc định (không trả toàn bộ không giới hạn) |
| LST-02 | List với `limit` hợp lệ | 2xx, đúng số dòng |
| LST-03 | List với `limit` quá lớn / âm / sai kiểu | 4xx hoặc kẹp về max an toàn |
| LST-04 | List với `offset`/cursor hợp lệ | 2xx, không trùng/sót rõ ràng |
| LST-05 | Member list toàn bộ members | 403 (chỉ xem được của mình) |

---

## Suite 12 — Tác vụ nền & tương tranh (`12-jobs-races.mjs`)

Suite nặng nhất. ~10 hội viên mới. Tiền tố: `JOB-`, `RACE-`, `LIM-`. Chạy riêng, restart server trước. Gửi các yêu cầu tranh chấp bằng `Promise.all` (song song thật), rồi `đọc lại` để đếm kết quả thực tế. Nguyên tắc vàng: **đúng một** yêu cầu được phép thắng, phần còn lại nhận 409/422, và **không bao giờ** có hai bản ghi cho cùng một tài nguyên.

### 12.1 Tác vụ hết hạn (`JOB-`)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| JOB-01 | Tạo hold giữ slot, chờ qua hạn (hoặc gọi job quét) | Hold chuyển expired, slot mở lại |
| JOB-02 | Thanh toán một hold đã hết hạn | 4xx, không tạo booking |
| JOB-03 | Hàng chờ (waitlist) hết hạn khi tới lượt không nhận | Nhường người kế tiếp, không kẹt |
| JOB-04 | Đóng ca (shift close) tính đúng tổng tiền mặt | Tổng khớp các payment tiền mặt trong ca |

### 12.2 Tranh chấp (`RACE-`)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| RACE-01 | 2 người đặt cùng 1 slot cùng lúc | 1 thắng (2xx), 1 nhận 409 CONFLICT_SLOT; đọc lại chỉ 1 booking |
| RACE-02 | N người ghi danh slot lớp còn đúng 1 chỗ | Đúng 1 thành công, phần còn lại 422; sĩ số không vượt sức chứa |
| RACE-03 | 2 lần accept cùng 1 lời mời/hold | 1 thắng, 1 nhận 409 CONFLICT_STATE |
| RACE-04 | 2 request trùng `Idempotency-Key` (nếu hỗ trợ) | Cùng 1 kết quả, chỉ 1 tác dụng phụ |
| RACE-05 | N redeem lượt **cuối cùng** của một mã khuyến mãi | Đúng 1 thắng, used không vượt max_uses |
| RACE-06 | 2 lần đóng cùng 1 ca | 1 thành công, 1 báo đã đóng; tổng không nhân đôi |

### 12.3 Giới hạn & rate limit (`LIM-`)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| LIM-01 | Đăng ký liên tục tới giới hạn F-04 (~45-48) | Khi chạm limit → 4xx rõ ràng, không 500 |
| LIM-02 | Vượt rate limit đăng nhập/OTP | 429 (hoặc chặn có kiểm soát), không 500 |
| LIM-03 | Payload quá lớn / số lượng dòng quá nhiều trong 1 request | 4xx, không treo/không 500 |

---

## Suite 13 — AI, phiếu hỗ trợ, thông báo, biên lai (`13-misc.mjs`)

~4 hội viên mới. Tiền tố: `AI-`, `TKT-`, `NOTI-`, `RCP-`. SMTP/AI tắt ở server an toàn → kỳ vọng phải tính tới chế độ tắt (không coi “tắt” là bug).

### 13.1 Trợ lý AI (`AI-`)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| AI-01 | Gọi endpoint AI khi AI tắt | Thông báo tính năng tắt có kiểm soát (4xx/503), **không** 500 |
| AI-02 | Gọi AI không đăng nhập | 401 |
| AI-03 | Gửi prompt rỗng / quá dài | 4xx |

### 13.2 Phiếu hỗ trợ (`TKT-`)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| TKT-01 | Member tạo ticket hợp lệ | 2xx, đọc lại thấy |
| TKT-02 | Member xem ticket của người khác | 403/404, không lộ nội dung |
| TKT-03 | Tạo ticket thiếu trường bắt buộc | 400, đúng field |
| TKT-04 | Nhân viên/manager trả lời & đóng ticket | 2xx, trạng thái đổi đúng |
| TKT-05 | Member tự đóng ticket người khác | 403 |

### 13.3 Thông báo (`NOTI-`)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| NOTI-01 | Xem danh sách thông báo của chính mình | 2xx |
| NOTI-02 | Đánh dấu đã đọc 1 thông báo của mình | 2xx, đọc lại đã đọc |
| NOTI-03 | Đánh dấu đã đọc thông báo của người khác | 403/404 |
| NOTI-04 | Gửi email khi SMTP tắt | Không 500; xếp hàng hoặc báo tắt có kiểm soát |

### 13.4 Biên lai (`RCP-`)

| Id | Tình huống | Kỳ vọng |
| --- | --- | --- |
| RCP-01 | Lấy biên lai của một payment của chính mình | 2xx, số tiền khớp |
| RCP-02 | Lấy biên lai payment của người khác | 403/404 |
| RCP-03 | Lấy biên lai id không tồn tại | 404 |

---

## Suite 15 — Removed Features & Invariants (`15-removed-features.mjs`)

Kiểm thử hồi quy ĐẢM BẢO tính năng vé ngày và công nợ đã bị gỡ triệt để, không hồi sinh, không còn đường dẫn ngầm. Tiền tố: `RMV-`.

| Id | Tình huống | Endpoint | Method | Role | Kỳ vọng |
| --- | --- | --- | --- | --- | --- |
| RMV-01 | Bán vé ngày | /v1/day-passes | POST | receptionist | 404 NOT_FOUND |
| RMV-02 | Xem danh sách vé ngày | /v1/day-passes | GET | receptionist | 404 NOT_FOUND |
| RMV-03 | Dùng vé ngày | /v1/day-passes/:id/use | POST | receptionist | 404 NOT_FOUND |
| RMV-04 | Huỷ vé ngày | /v1/day-passes/:id/void | POST | receptionist | 404 NOT_FOUND |
| RMV-05 | Bán vé ngày với role member | /v1/day-passes | POST | member | 404 NOT_FOUND |
| RMV-06 | Bán vé ngày không auth | /v1/day-passes | POST | none | 404 NOT_FOUND (router trả 404 trước auth) |
| RMV-07 | Setting day_pass_vnd bị bỏ qua | /v1/settings | PATCH | manager | 200, nhưng GET /settings không có day_pass_vnd |
| RMV-08 | Setting day_pass_vnd không có trong GET | /v1/settings | GET | manager | 200, body không chứa key day_pass_vnd |
| RMV-09 | Màn hình UI vé ngày không tồn tại | /desk/day-passes | GET | browser/http | 404 hoặc route fallback |
| RMV-10 | Payment method quota không dùng được như tiền mặt | /v1/payments | POST | receptionist | 422 BR-44 hoặc 400 |
| RMV-11 | Directory members không có trường công nợ | /v1/directory/members | GET | receptionist | 200, không có debt_vnd/owed_vnd |
| RMV-12 | Chi tiết hội viên không có trường công nợ | /v1/members/:id | GET | receptionist | 200, không có debt_vnd/owed_vnd |
| RMV-13 | Audit log không ghi hành động vé ngày mới | /v1/audit-logs | GET | manager | 200, 0 audit log mới có action liên quan day_pass |
| RMV-14 | Báo cáo doanh thu không có dòng vé ngày | /v1/reports/revenue | GET | manager | 200, không có trường day_pass_revenue |
| RMV-15 | Dữ liệu lịch sử day_passes cũ (nếu có) không bị lỗi query | /v1/shifts/:id/summary | GET | receptionist | 200, shift summary tính đúng dù có payment cũ liên kết day_pass |

---

## Hết đặc tả 07–15

Mỗi suite kết thúc phải gọi `summary()` và dọn sạch trạng thái toàn cục (xoá mã/thiết bị/work order đã tạo nếu có route xoá). Sau khi chạy đủ, chạy `summarize-results.mjs` để gộp `test-output/RESULTS-SUMMARY.md`, rồi viết báo cáo cuối theo mục 16 của `docs/AGENT-TEST-INSTRUCTIONS.md`.
